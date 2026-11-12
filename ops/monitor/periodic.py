"""每日/每周/月度检查组合；reader 接线前不提供可绕过服务器证据的命令入口。"""

import json
import os
import secrets
import stat
import subprocess
import time
from pathlib import Path

from ops.monitor.bound_probe import run_bound_sample, validate_evidence
from ops.monitor.bounded_process import ProcessOutputLimit, run_process
from ops.monitor.public_health import HealthError, canonical, digest, private_json, require, utc


ENVIRONMENT = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "CI", "GITHUB_ACTIONS",
               "GITHUB_REF", "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_WORKSPACE")
OUTPUT_LIMIT = 8 * 1024 * 1024


def run_command(arguments, *, cwd, env, timeout):
    try:
        return run_process(arguments, cwd=cwd, env=env, timeout=timeout, output_limit=OUTPUT_LIMIT)
    except ProcessOutputLimit:
        raise HealthError("PERIODIC_OUTPUT_LIMIT") from None


def check_experiences(root):
    def identity(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
                info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def pairs(items):
        require(len(items) == len(dict(items)), "PERIODIC_PROJECT_REGISTRY")
        return dict(items)

    path = Path(root) / "docs/contracts/project-experiences.json"
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= 1024 * 1024, "PERIODIC_PROJECT_REGISTRY")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            raw = source.read(1024 * 1024 + 1)
        require(len(raw) <= 1024 * 1024 and identity(os.fstat(descriptor)) == identity(info)
                and identity(path.lstat()) == identity(info),
                "PERIODIC_PROJECT_REGISTRY")
        registry = json.loads(raw, object_pairs_hook=pairs)
    finally:
        os.close(descriptor)
    require(isinstance(registry, dict) and registry.get("kind") == "axial_muse_project_experiences"
            and isinstance(registry.get("experiences"), list), "PERIODIC_PROJECT_REGISTRY")
    for experience in registry["experiences"]:
        require(isinstance(experience, dict) and experience.get("status") in (
            "planned", "provisioning", "live", "paused", "retired"), "PERIODIC_PROJECT_REGISTRY")
        require(experience["status"] != "live", "PERIODIC_LIVE_EXPERIENCE_UNSUPPORTED")


def run_period(period, baseline, read_evidence, *, root=None, node=None, expiry=None, monthly_output=None,
               probe_runner=run_bound_sample, command_runner=run_command):
    require(period in ("daily", "weekly", "monthly"), "PERIODIC_PERIOD")
    root = Path(root) if root is not None else Path(__file__).resolve().parents[2]
    try:
        require(root.is_absolute() and root.resolve() == root, "PERIODIC_ROOT")
        check_experiences(root)
    except Exception as error:
        return {"schema": 1, "period": period, "status": "failed", "checks": [
            {"check": "project-experiences", "status": "failed", "code": str(error)
             if isinstance(error, HealthError) else "PERIODIC_PROJECT_REGISTRY"}],
            "failedCount": 1, "checkCount": 1, "productionMutationsPerformed": False,
            "localQualityCommandsExecuted": 0, "serverLedgerInspected": False, "completedAtUtc": utc()}
    options = {"internal_links": True, "dns": True, "external_links": True} if period == "weekly" else {}
    receipt = probe_runner(baseline, read_evidence, **options)
    receipt["checks"].append({"check": "project-experiences", "status": "passed"})
    receipt["checkCount"] += 1
    receipt["period"] = period
    receipt["productionMutationsPerformed"] = False
    receipt.pop("mutationsPerformed", None)
    receipt["localQualityCommandsExecuted"] = 0
    if period != "monthly" or receipt["status"] != "passed":
        return receipt
    checks = receipt["checks"]
    environment = {key: os.environ[key] for key in ENVIRONMENT if key in os.environ}

    def command(name, arguments, *, report=False):
        if name in ("install", "quality", "history", "typecheck", "test", "build"):
            receipt["localQualityCommandsExecuted"] += 1
        try:
            result = command_runner(arguments, cwd=root, env=environment, timeout=2700)
        except subprocess.TimeoutExpired:
            raise HealthError("PERIODIC_COMMAND_TIMEOUT") from None
        except OSError:
            raise HealthError("PERIODIC_COMMAND_START") from None
        require(isinstance(result.stdout, bytes) and isinstance(result.stderr, bytes)
                and len(result.stdout) + len(result.stderr) <= OUTPUT_LIMIT, "PERIODIC_OUTPUT_LIMIT")
        checks.append({"check": "monthly-command:" + name,
                       "status": "passed" if result.returncode == 0 else "failed", "exitCode": result.returncode,
                       **({"code": "PERIODIC_COMMAND_FAILED"} if result.returncode else {})})
        require(result.returncode in (0, 1) if report else result.returncode == 0, "PERIODIC_COMMAND_FAILED")
        return result if report else result.stdout

    try:
        require(all(isinstance(path, (str, Path)) and Path(path).is_absolute()
                    for path in (root, node, expiry, monthly_output)), "PERIODIC_MONTHLY_OPTIONS")
        require(Path(root).resolve() == Path(root), "PERIODIC_ROOT")
        require(not os.path.lexists(monthly_output), "PERIODIC_OUTPUT_EXISTS")
        version = (Path(root) / ".nvmrc").read_bytes()
        require(command("runtime", [str(node), "--version"]) == b"v" + version, "PERIODIC_NODE_VERSION")
        require(command("source", ["git", "rev-parse", "HEAD"]).strip().decode("ascii")
                == baseline["identity"]["commit_sha"], "PERIODIC_SOURCE_IDENTITY")
        require(not command("clean", ["git", "status", "--porcelain=v1", "--untracked-files=all"]).strip(),
                "PERIODIC_DIRTY_SOURCE")
        command("install", [str(node), "scripts/quality/run-isolated-npm.mjs", "ci"])
        report_result = command("report", [str(node), "scripts/maintenance/monthly-report.mjs", "--expiry", str(expiry),
                                          "--output", str(monthly_output)], report=True)
        report = private_json(monthly_output)
        require(isinstance(report, dict) and report.get("schema") == 1 and report.get("scope") == "local-checkout"
                and isinstance(report.get("checks"), list) and report.get("checkCount") == len(report["checks"])
                and all(isinstance(c, dict) and c.get("status") in ("passed", "failed")
                        for c in report["checks"]), "PERIODIC_MONTHLY_REPORT")
        failures = sum(c["status"] == "failed" for c in report["checks"])
        require(report.get("failedCount") == failures
                and report.get("status") == ("failed" if failures else "passed")
                and report_result.returncode == (1 if failures else 0), "PERIODIC_MONTHLY_REPORT")
        required = {"expiry:verification", "expiry:domain", "expiry:instance"}
        require(isinstance(report.get("content"), list)
                and all(isinstance(record, dict) and isinstance(record.get("kind"), str)
                        and isinstance(record.get("id"), str) for record in report["content"]),
                "PERIODIC_MONTHLY_REPORT")
        required.update("content:" + record["kind"] + ":" + record["id"] for record in report["content"])
        require(all(isinstance(c.get("check"), str) for c in report["checks"])
                and {c["check"] for c in report["checks"]} == required
                and len(report["checks"]) == len(required), "PERIODIC_MONTHLY_REPORT")
        for check in report["checks"]:
            codes = {"MONTHLY_CONTENT_FUTURE"} if check["check"].startswith("content:") else (
                {"MONTHLY_EXPIRY_VERIFICATION"} if check["check"] == "expiry:verification" else
                {"MONTHLY_EXPIRED", "MONTHLY_EXPIRY_APPROACHING"})
            require("code" not in check if check["status"] == "passed" else check.get("code") in codes,
                    "PERIODIC_MONTHLY_REPORT")
        checks.extend(report["checks"])
        receipt["content"] = report["content"]
        require(failures == 0, "PERIODIC_COMMAND_FAILED")
        for name, arguments in (
            ("quality", ["scripts/quality/run-isolated-npm.mjs", "run-script", "quality"]),
            ("history", ["scripts/quality/run-content-history.mjs"]),
            ("typecheck", ["scripts/quality/run-isolated-npm.mjs", "run-script", "typecheck"]),
            ("test", ["scripts/quality/run-isolated-npm.mjs", "run-script", "test"]),
            ("build", ["scripts/quality/run-isolated-npm.mjs", "run-script", "build"]),
        ):
            command(name, [str(node), *arguments])
        require(command("source-final", ["git", "rev-parse", "HEAD"]).strip().decode("ascii")
                == baseline["identity"]["commit_sha"], "PERIODIC_SOURCE_IDENTITY")
        require(not command("clean-final", ["git", "status", "--porcelain=v1", "--untracked-files=all"]).strip(),
                "PERIODIC_DIRTY_SOURCE")
        challenge = secrets.token_hex(32)
        final = validate_evidence(read_evidence(challenge), challenge, baseline, time.time())
        require(digest(canonical(final)) == receipt["serverSnapshotSha256"], "MONITOR_SNAPSHOT_DRIFT")
        checks.append({"check": "monthly-final-evidence", "status": "passed"})
    except Exception as error:
        checks.append({"check": "monthly-complete", "status": "failed", "code": str(error)
                       if isinstance(error, HealthError) else "PERIODIC_MONTHLY_FAILED"})
    failed = sum(c["status"] == "failed" for c in checks)
    receipt.update({"status": "failed" if failed else "passed", "failedCount": failed,
                    "checkCount": len(checks), "completedAtUtc": utc()})
    return receipt
