"""定时监测入口：认证活动 release、独立策略和完整周期失败回执。"""

import argparse
import json
import os
import secrets
import shutil
import time
import re
from pathlib import Path

from ops.monitor.bound_probe import evidence_time, validate_evidence
from ops.monitor.periodic import run_period
from ops.monitor.public_health import HealthError, require, utc, validate_baseline, write_receipt
from ops.monitor.tat_transport import COMMAND_SHA256, TatTransport, decode_json
from ops.maintenance.resources import RESOURCE_FAILURE_CODES
from ops.monitor.resource_protocol import Observations, failed_check, drill_valid, sha256, timestamp, PHASES, SCENARIOS
from ops.monitor.bounded_process import run_process


def check_resource_failure(bundle):
    if isinstance(bundle, dict) and "resourceFailure" in bundle:
        require(set(bundle) == {"schema", "resourceFailure"} and type(bundle["schema"]) is int
                and bundle["schema"] == 1 and isinstance(bundle["resourceFailure"], str)
                and bundle["resourceFailure"] in RESOURCE_FAILURE_CODES, "MONITOR_BUNDLE")
        raise HealthError(bundle["resourceFailure"])


def baseline_from_bundle(bundle, policy, checked_at):
    check_resource_failure(bundle)
    require(isinstance(bundle, dict) and set(bundle) == {"schema", "observedAtUtc", "snapshot", "release"}
            and type(bundle["schema"]) is int and bundle["schema"] == 1, "MONITOR_BUNDLE")
    snapshot, release = bundle["snapshot"], bundle["release"]
    require(isinstance(snapshot, dict) and isinstance(release, dict)
            and set(release) == {"files", "pages", "rules"}, "MONITOR_BUNDLE")
    require(isinstance(policy, dict) and set(policy) == {
        "schema", "csp", "hsts", "addressDigest", "minimumCertificateDays",
    } and type(policy["schema"]) is int and policy["schema"] == 1, "MONITOR_POLICY")
    require("identity" in snapshot and "ledgerSha256" in snapshot, "MONITOR_BUNDLE")
    baseline = {"schema": 1, "identity": snapshot["identity"], "ledgerSha256": snapshot["ledgerSha256"],
                **release, **{key: policy[key] for key in ("csp", "hsts", "addressDigest", "minimumCertificateDays")}}
    validate_baseline(baseline)
    challenge = secrets.token_hex(32)
    envelope = {"schema": 1, "challenge": challenge, "observedAtUtc": bundle["observedAtUtc"],
                "snapshot": snapshot}
    validate_evidence(envelope, challenge, baseline, checked_at)
    return baseline


def run_maintenance(period, transport, policy, *, root, node=None, expiry=None, monthly_output=None,
                    now=time.time, monotonic=time.monotonic, runner=run_period, observations=None):
    observations = observations if observations is not None else Observations()

    def fetch(phase, baseline=None):
        started_at, started = now(), monotonic()
        observation = transport.fetch_observation()
        checked = evidence_time(started_at, started, now(), monotonic())
        require(isinstance(observation, dict) and set(observation) == {"payload", "evidence"}, "MONITOR_TAT_EVIDENCE")
        bundle = observation["payload"]
        link = observations.failure(bundle, phase, observation["evidence"], checked, baseline)
        # 健康读取在完整载荷校验后登记，失败封套在抛出结构化异常前登记。
        baseline_from_bundle(bundle, policy, checked)
        observations.server_reads.append(link)
        return bundle, checked

    bundle, checked_at = fetch("bootstrap")
    baseline = baseline_from_bundle(bundle, policy, checked_at)
    snapshot, release = bundle["snapshot"], bundle["release"]

    def reader(challenge, *, phase="before"):
        current, _ = fetch(phase, baseline)
        require(current["snapshot"] == snapshot and current["release"] == release, "MONITOR_SNAPSHOT_DRIFT")
        # 无参数云命令通过精确 invocation/instance/command 绑定本轮；随机量由认证 reader 包装。
        return {"schema": 1, "challenge": challenge, "observedAtUtc": current["observedAtUtc"],
                "snapshot": current["snapshot"]}

    reader.phased = True
    receipt = runner(period, baseline, reader, root=root, node=node, expiry=expiry, monthly_output=monthly_output)
    return observations.merge(receipt)


def failure(period, code):
    check = failed_check("monitor-bootstrap", code, "MONITOR_SETUP_FAILED") if isinstance(code, Exception) else {
        "check": "monitor-bootstrap", "status": "failed", "code": code}
    return {"schema": 1, "period": period, "status": "failed", "checks": [check],
        "failedCount": 1, "checkCount": 1, "serverLedgerInspected": False,
        "productionMutationsPerformed": False, "localQualityCommandsExecuted": 0, "completedAtUtc": utc()}


def public_receipt(receipt):
    """共享工件只保存运行结论与失败代码，不传播私有到期日期或剩余天数。"""
    keys = ("schema", "period", "status", "identity", "baselineSha256", "observedAtUtc", "completedAtUtc",
            "checkCount", "failedCount", "serverLedgerInspected", "productionMutationsPerformed",
            "localQualityCommandsExecuted", "workflowSourceSha")
    result = {key: receipt[key] for key in keys if key in receipt}
    result["checks"] = [{key: check[key] for key in ("check", "status", "code", "exitCode",
                        "resourceObservationSha256", "drillObservationSha256") if key in check}
                        for check in receipt["checks"]]
    for name in ("serverReadEvidence", "resourceObservations", "drillObservations"):
        require(name in receipt and isinstance(receipt[name], list), "MONITOR_RECEIPT_DIAGNOSTIC")
        result[name] = []
        for value in receipt[name]:
            require(isinstance(value, dict) and value.get("phase") in PHASES
                    and sha256(value.get("transportEvidenceSha256")), "MONITOR_RECEIPT_DIAGNOSTIC")
            fields = {"phase", "transportEvidenceSha256"}
            if name == "resourceObservations":
                fields |= {"resourceFailure", "level", "scope", "receivedAtUtc"}
                require(value.get("resourceFailure") in RESOURCE_FAILURE_CODES
                        and value.get("level") in ("warning", "critical", "unknown")
                        and value.get("scope") == "root-filesystem", "MONITOR_RECEIPT_DIAGNOSTIC")
                timestamp(value.get("receivedAtUtc"))
            elif name == "drillObservations":
                fields |= {"resourceFailure", "observedAtUtc", "drill"}
                drill_valid(value.get("drill"))
                require(value.get("resourceFailure") == SCENARIOS[value["drill"]["scenario"]], "MONITOR_RECEIPT_DIAGNOSTIC")
                timestamp(value.get("observedAtUtc"))
            require(set(value) == fields, "MONITOR_RECEIPT_DIAGNOSTIC")
            result[name].append({key: value[key] for key in fields})
    return result


def verified_source_sha(root):
    source = os.environ.get("GITHUB_SHA", "")
    require(isinstance(source, str) and re.fullmatch(r"[0-9a-f]{40}", source), "MONITOR_SOURCE_IDENTITY")
    result = run_process(["git", "rev-parse", "HEAD"], cwd=root, timeout=10, output_limit=1024,
                         env={"PATH": "/usr/bin:/bin", "LANG": "C"})
    require(result.returncode == 0 and result.stdout == (source + "\n").encode(), "MONITOR_SOURCE_IDENTITY")
    return source


def report_drills(receipt):
    lines = [f"受控演练 phase={d['phase']} id={d['drill']['id']} scenario={d['drill']['scenario']} code={d['resourceFailure']}"
             for d in receipt["drillObservations"]]
    for line in lines:
        print(line)
    if lines and os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
            stream.write("\n".join(lines) + "\n")


def main(arguments=None):
    parser = argparse.ArgumentParser(description="运行已认证的周期站点监测。")
    parser.add_argument("--period", required=True, choices=("daily", "weekly", "monthly"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--monthly-output")
    args = parser.parse_args(arguments)
    output = Path(args.output)
    observations = Observations()
    source = None
    try:
        root = Path(args.root)
        require(root.is_absolute() and root.resolve() == root and output.is_absolute(), "MONITOR_PATH")
        policy_raw = os.environ.pop("MONITOR_POLICY_JSON", "")
        require(0 < len(policy_raw.encode()) <= 16384, "MONITOR_POLICY")
        policy = decode_json(policy_raw)
        secret_id = os.environ.pop("MONITOR_TAT_SECRET_ID", "")
        secret_key = os.environ.pop("MONITOR_TAT_SECRET_KEY", "")
        transport = TatTransport(os.environ.get("MONITOR_TAT_COMMAND_ID", ""),
                                 os.environ.get("MONITOR_TAT_INSTANCE_ID", ""), COMMAND_SHA256,
                                 secret_id, secret_key)
        source = verified_source_sha(root)
        expiry, monthly_output, node = None, None, None
        if args.period == "monthly":
            require(args.monthly_output and Path(args.monthly_output).is_absolute(), "MONITOR_PATH")
            node_name = shutil.which("node")
            require(node_name is not None, "MONITOR_NODE")
            node = str(Path(node_name).resolve())
            monthly_output = Path(args.monthly_output)
            expiry = monthly_output.with_name(monthly_output.name + ".expiry.json")
            raw = os.environ.pop("MONITOR_EXPIRY_JSON", "")
            require(0 < len(raw.encode()) <= 16384, "MONITOR_EXPIRY")
            value = decode_json(raw)
            write_receipt(expiry, value)
        receipt = run_maintenance(args.period, transport, policy, root=root, node=node,
                                  expiry=expiry, monthly_output=monthly_output, observations=observations)
    except Exception as error:
        receipt = failure(args.period, error)
    observations.merge(receipt)
    receipt["workflowSourceSha"] = source
    try:
        write_receipt(output, public_receipt(receipt))
        report_drills(receipt)
    except Exception:
        print(json.dumps({"status": "failed", "code": "MONITOR_RECEIPT_WRITE"}))
        return 1
    print(json.dumps({"status": receipt["status"], "period": args.period,
                      "checkCount": receipt["checkCount"], "failedCount": receipt["failedCount"]}))
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
