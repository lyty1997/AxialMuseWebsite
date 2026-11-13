"""定时监测入口：认证活动 release、独立策略和完整周期失败回执。"""

import argparse
import json
import os
import secrets
import shutil
import time
from pathlib import Path

from ops.monitor.bound_probe import evidence_time, validate_evidence
from ops.monitor.periodic import run_period
from ops.monitor.public_health import HealthError, require, utc, validate_baseline, write_receipt
from ops.monitor.tat_transport import COMMAND_SHA256, TatTransport, decode_json


def baseline_from_bundle(bundle, policy, checked_at):
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
                    now=time.time, monotonic=time.monotonic, runner=run_period):
    started_at, started = now(), monotonic()
    bundle = transport.fetch()
    checked_at = evidence_time(started_at, started, now(), monotonic())
    baseline = baseline_from_bundle(bundle, policy, checked_at)
    snapshot, release = bundle["snapshot"], bundle["release"]

    def reader(challenge):
        current = transport.fetch()
        require(isinstance(current, dict) and set(current) == {"schema", "observedAtUtc", "snapshot", "release"}
                and type(current["schema"]) is int and current["schema"] == 1, "MONITOR_BUNDLE")
        require(current["snapshot"] == snapshot and current["release"] == release, "MONITOR_SNAPSHOT_DRIFT")
        # 无参数云命令通过精确 invocation/instance/command 绑定本轮；随机量由认证 reader 包装。
        return {"schema": 1, "challenge": challenge, "observedAtUtc": current["observedAtUtc"],
                "snapshot": current["snapshot"]}

    return runner(period, baseline, reader, root=root, node=node, expiry=expiry, monthly_output=monthly_output)


def failure(period, code):
    return {"schema": 1, "period": period, "status": "failed", "checks": [
        {"check": "monitor-bootstrap", "status": "failed", "code": code}],
        "failedCount": 1, "checkCount": 1, "serverLedgerInspected": False,
        "productionMutationsPerformed": False, "localQualityCommandsExecuted": 0, "completedAtUtc": utc()}


def public_receipt(receipt):
    """共享工件只保存运行结论与失败代码，不传播私有到期日期或剩余天数。"""
    keys = ("schema", "period", "status", "identity", "baselineSha256", "observedAtUtc", "completedAtUtc",
            "checkCount", "failedCount", "serverLedgerInspected", "productionMutationsPerformed",
            "localQualityCommandsExecuted")
    result = {key: receipt[key] for key in keys if key in receipt}
    result["checks"] = [{key: check[key] for key in ("check", "status", "code", "exitCode") if key in check}
                        for check in receipt["checks"]]
    return result


def main(arguments=None):
    parser = argparse.ArgumentParser(description="运行已认证的周期站点监测。")
    parser.add_argument("--period", required=True, choices=("daily", "weekly", "monthly"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--monthly-output")
    args = parser.parse_args(arguments)
    output = Path(args.output)
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
                                  expiry=expiry, monthly_output=monthly_output)
    except Exception as error:
        code = str(error) if isinstance(error, HealthError) else "MONITOR_SETUP_FAILED"
        receipt = failure(args.period, code)
    try:
        write_receipt(output, public_receipt(receipt))
    except Exception:
        print(json.dumps({"status": "failed", "code": "MONITOR_RECEIPT_WRITE"}))
        return 1
    print(json.dumps({"status": receipt["status"], "period": args.period,
                      "checkCount": receipt["checkCount"], "failedCount": receipt["failedCount"]}))
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
