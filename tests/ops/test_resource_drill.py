"""真实文件系统、进程死亡与合成判定；不连接生产或云接口。"""

import copy
import io
import json
import base64
import contextlib
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from ops.deploy.deployment_state import DeploymentError
from ops.maintenance import resource_drill as module
from ops.maintenance.resource_drill import ResourceDrills, fixture_failure
from ops.monitor.resource_protocol import SCENARIOS


class ResourceDrillTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "drills"
        self.wall, self.elapsed, self.boot = 1800000000, 5000000000, "12345678-1234-1234-1234-123456789abc"
        self.state = ResourceDrills(self.root, os.geteuid(), wall=lambda: self.wall,
                                    elapsed=lambda: self.elapsed, boot=lambda: self.boot)
        self.binding = {"runtimeSha256": "c" * 64, "ledgerSha256": "d" * 64, "siteIdentity": {
            "workflow_run_id": "1", "artifact_id": "2", "commit_sha": "a" * 40,
            "artifact_digest": "b" * 64, "release_content_sha256": "e" * 64}}
        self.bundle = {"snapshot": {"identity": self.binding["siteIdentity"], "ledgerSha256": "d" * 64}}
        self.state.initialize()

    def arm(self, authorization="fixture-approval", scenario="disk-free-warning", ttl=60):
        return self.state.arm(scenario, ttl, authorization, self.binding)

    def observe(self, bundle=None, runtime=None):
        return self.state.observe(self.bundle if bundle is None else bundle, runtime or "c" * 64)

    def test_all_scenarios_have_independent_expected_threshold_code(self):
        for scenario, code in SCENARIOS.items():
            with self.subTest(scenario=scenario):
                self.assertEqual(fixture_failure(scenario), code)
        with patch.object(module, "check_resources", return_value={"status": "ok", "checks": []}):
            with self.assertRaisesRegex(DeploymentError, "MONITOR_DRILL_FIXTURE"):
                fixture_failure("disk-free-warning")

    def test_default_off_repeated_reads_disarm_and_idempotency(self):
        self.assertEqual(self.observe(), self.bundle)
        record = self.arm()
        identifier = record["request"]["drillId"]
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        before = {str(p): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        for _ in range(2):
            value = self.observe()
            self.assertEqual(value["resourceFailure"], "MAINTENANCE_DISK_FREE_WARNING")
            self.assertEqual(value["drill"]["id"], identifier)
            self.assertNotIn("bootId", value["drill"])
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob("*") if p.is_file()})
        stopped = self.state.disarm(identifier)
        self.assertEqual(stopped, self.state.disarm(identifier))
        self.assertEqual(self.observe(), self.bundle)
        status = self.state.status()
        self.assertEqual(status["state"], "inactive")
        self.assertEqual(status["disarmedRequests"][0]["disarmReceiptSha256"], stopped["disarmReceiptSha256"])
        self.assertEqual(self.arm(), stopped)  # 相同授权只能返回旧请求，不能重新启用。
        self.assertEqual(self.observe(), self.bundle)

    def test_replay_never_renews_and_changed_parameters_reject(self):
        first = self.arm()
        self.wall += 10
        self.elapsed += 10_000_000_000
        self.assertEqual(self.arm(), first)
        with self.assertRaisesRegex(DeploymentError, "MONITOR_DRILL_REPLAY"):
            self.arm(ttl=61)
        with self.assertRaisesRegex(DeploymentError, "MONITOR_DRILL_ACTIVE"):
            self.arm("other")
        self.wall += 60
        self.assertEqual(self.observe(), self.bundle)
        self.assertEqual(self.arm(), first)

    def test_either_deadline_reboot_backwards_wall_and_identity_expire(self):
        self.arm()
        initial = self.wall, self.elapsed, self.boot
        for kind in ("wall", "elapsed", "boot", "backward", "runtime", "identity", "ledger"):
            with self.subTest(kind=kind):
                self.wall, self.elapsed, self.boot = initial
                bundle = copy.deepcopy(self.bundle)
                runtime = "c" * 64
                if kind == "wall":
                    self.wall += 60
                elif kind == "elapsed":
                    self.elapsed += 60_000_000_000
                elif kind == "boot":
                    self.boot = "aaaaaaaa-1234-1234-1234-123456789abc"
                elif kind == "backward":
                    self.wall -= 1
                elif kind == "runtime":
                    runtime = "f" * 64
                elif kind == "identity":
                    bundle["snapshot"]["identity"]["commit_sha"] = "f" * 40
                else:
                    bundle["snapshot"]["ledgerSha256"] = "f" * 64
                self.assertEqual(self.observe(bundle, runtime), bundle)
        self.wall, self.elapsed, self.boot = initial
        self.elapsed -= 1
        with self.assertRaisesRegex(DeploymentError, "MONITOR_DRILL_STATE"):
            self.observe()

    def test_missing_corrupt_extra_hardlink_symlink_and_permissions_fail_closed(self):
        self.arm()
        target = self.root / "active.json"
        original = target.read_bytes()
        for corruption in (b'{}\n', b'{"drillId":"x","drillId":"y"}\n'):
            target.write_bytes(corruption)
            with self.assertRaises(DeploymentError):
                self.observe()
        target.write_bytes(original)
        for mode in (0o644, 0o666):
            target.chmod(mode)
            with self.assertRaises(DeploymentError):
                self.observe()
        target.chmod(0o600)
        os.link(target, self.root / "link")
        with self.assertRaises(DeploymentError):
            self.observe()
        (self.root / "link").unlink()
        target.unlink()
        target.symlink_to("schema")
        with self.assertRaises((OSError, DeploymentError)):
            self.observe()

    def test_unknown_id_and_lock_contention_preserve_state(self):
        self.arm()
        with self.assertRaisesRegex(DeploymentError, "MONITOR_DRILL_UNKNOWN"):
            self.state.disarm("f" * 32)
        with self.state.locked():
            with self.assertRaisesRegex(DeploymentError, "MONITOR_DRILL_BUSY"):
                self.observe()
        self.assertEqual(self.observe()["schema"], 2)

    def test_management_command_arms_under_snapshot_lock_and_disarms_unhealthy_release(self):
        from ops.maintenance import resource_drill_command as command
        from test_release_transaction import ReleaseFixture
        fixture = ReleaseFixture(self.temp.name)
        stage, identity = fixture.stage("a" * 40)
        fixture.approve(identity)
        fixture.engine.execute(identity=identity, stage=stage)
        def run(arguments, *, verifier_broken=False):
            output = io.BytesIO()
            with patch.object(command.os, "geteuid", return_value=0), \
                    patch.object(command, "DeploymentState", return_value=fixture.state), \
                    patch.object(command, "ReleaseStore", return_value=fixture.store), \
                    patch.object(command, "ResourceDrills", return_value=self.state), \
                    patch.object(command, "verifier_lock", contextlib.nullcontext), \
                    patch.object(command, "runtime_identity", return_value="c" * 64), \
                    patch.object(command, "load_verifier", side_effect=AssertionError if verifier_broken else None), \
                    patch.object(command.sys, "stdout", SimpleNamespace(buffer=output)):
                self.assertEqual(command.main(arguments), 0)
            return json.loads(output.getvalue())
        record = run(["--arm", "--scenario", "disk-free-warning", "--ttl-seconds", "60", "--authorization-id", "cli-test"])
        (fixture.store.releases / ("a" * 40) / "payload/index.html").write_bytes(b"damaged release")
        stopped = run(["--disarm", record["request"]["drillId"]], verifier_broken=True)
        self.assertIsNotNone(stopped["receipt"])
        self.assertEqual(run(["--status"], verifier_broken=True)["state"], "inactive")
        with patch.object(command.os, "geteuid", return_value=1000), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(command.main(["--status"]), 1)

    def test_prepared_partial_bytes_never_arm_and_missing_layout_fails(self):
        folder = self.root / "requests" / (".preparing-" + "a" * 32)
        folder.mkdir(mode=0o700)
        (folder / "request.json").write_bytes(b'{"partial":')
        (folder / "request.json").chmod(0o600)
        self.assertEqual(self.observe(), self.bundle)
        (self.root / "schema").unlink()
        with self.assertRaises(DeploymentError):
            self.observe()

    def test_real_sigkill_after_disarm_publication_stops_injection_and_can_resume(self):
        identifier = self.arm()["request"]["drillId"]
        program = """
import os, signal, sys
from pathlib import Path
from ops.maintenance import resource_drill as m
original = m.publish_new
def publish(path, data):
    original(path, data)
    os.kill(os.getpid(), signal.SIGKILL)
m.publish_new = publish
m.ResourceDrills(Path(sys.argv[1]), os.geteuid()).disarm(sys.argv[2])
"""
        process = subprocess.run([sys.executable, "-B", "-c", program, str(self.root), identifier],
                                 capture_output=True, timeout=10)
        self.assertEqual(process.returncode, -signal.SIGKILL)
        self.assertTrue((self.root / "active.json").exists())
        self.assertEqual(self.observe(), self.bundle)
        first = self.state.records()[identifier]
        self.assertEqual(self.state.disarm(identifier), first)
        self.assertFalse((self.root / "active.json").exists())

    def test_arm_interrupt_before_active_marker_is_durable_but_never_injects(self):
        with patch.object(module, "publish_new", side_effect=OSError("fixture interruption")):
            with self.assertRaises(OSError):
                self.arm()
        records = self.state.records()
        self.assertEqual(len(records), 1)
        self.assertEqual(self.observe(), self.bundle)
        self.assertEqual(self.arm(), next(iter(records.values())))
        self.assertEqual(self.observe(), self.bundle)

    def test_real_sigkill_at_each_arm_publication_boundary(self):
        for point in ("request", "active"):
            with self.subTest(point=point):
                root = Path(self.temp.name) / point
                state = ResourceDrills(root, os.geteuid())
                state.initialize()
                program = """
import json, os, signal, sys
from pathlib import Path
from ops.maintenance import resource_drill as m
if sys.argv[2] == 'request':
    original = m.rename_new
    def rename(source, target):
        original(source, target)
        os.kill(os.getpid(), signal.SIGKILL)
    m.rename_new = rename
else:
    original = m.publish_new
    def publish(path, data):
        original(path, data)
        os.kill(os.getpid(), signal.SIGKILL)
    m.publish_new = publish
m.ResourceDrills(Path(sys.argv[1]), os.geteuid()).arm('disk-free-warning', 60, 'kill-test', json.loads(sys.argv[3]))
"""
                process = subprocess.run([sys.executable, "-B", "-c", program, str(root), point, json.dumps(self.binding)],
                                         capture_output=True, timeout=10)
                self.assertEqual(process.returncode, -signal.SIGKILL)
                self.assertEqual(len(state.records()), 1)
                observed = state.observe(self.bundle, "c" * 64)
                self.assertEqual(observed == self.bundle, point == "request")
                record = next(iter(state.records().values()))
                state.disarm(record["request"]["drillId"])
                self.assertEqual(state.observe(self.bundle, "c" * 64), self.bundle)

    def test_real_failure_precedes_control_and_disarm_needs_no_health(self):
        from test_release_transaction import ReleaseFixture
        from ops.monitor.server_evidence import release_bundle
        fixture = ReleaseFixture(self.temp.name)
        with patch("ops.monitor.server_evidence.check_resources", return_value={"checks": [
                {"code": "MAINTENANCE_INODE_USED_CRITICAL", "level": "critical"}]}):
            with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_INODE_USED_CRITICAL"):
                release_bundle(fixture.store, drill=lambda _: self.fail("真实失败后不能读取演练状态"))
        self.state.disarm(self.arm()["request"]["drillId"])

    def test_control_snapshot_tat_validation_runner_failure_disarm_and_fresh_restore(self):
        from ops.monitor import installed_snapshot
        from ops.monitor.server_evidence import release_bundle
        from ops.monitor.tat_transport import TatTransport, COMMAND, COMMAND_SHA256
        from ops.monitor.maintenance_runner import run_maintenance
        from ops.monitor.bound_probe import run_bound_sample
        from ops.monitor.public_health import HealthError, canonical, digest
        from ops.monitor.resource_protocol import Observations
        from test_release_transaction import ReleaseFixture
        from test_artifact_verifier import digest_public_routes, default_rules
        fixture = ReleaseFixture(self.temp.name)
        stage, identity = fixture.stage("a" * 40, extra_payload={"payload/writing/index.html": b"<!doctype html>writing\n"},
            rules=default_rules() + [{"kind": "canonical-slash", "from": "/writing", "to": "/writing/"}],
            metadata_transform=lambda metadata: {**metadata, "publicRoutesSha256": digest_public_routes(
                ("/", "/projects/", "/writing/"))})
        fixture.approve(identity, published_routes=("/", "/projects/", "/writing/"),
                        rules=default_rules() + [{"kind": "canonical-slash", "from": "/writing", "to": "/writing/"}])
        fixture.engine.execute(identity=identity, stage=stage)
        healthy = release_bundle(fixture.store)
        self.binding.update(siteIdentity=identity, ledgerSha256=healthy["snapshot"]["ledgerSha256"])
        command = {"CommandId": "cmd-abcdefgh", "EnableParameter": False, "CommandType": "SHELL",
                   "Username": "axial-monitor", "Content": base64.b64encode(COMMAND).decode(), "OutputCOSBucketUrl": "",
                   "Timeout": 30, "WorkingDirectory": "/"}
        invocation = [0]
        def cloud(action, _body, _deadline):
            if action == "DescribeCommands":
                return {"TotalCount": 1, "CommandSet": [command]}
            if action == "InvokeCommand":
                invocation[0] += 1
                return {"InvocationId": f"inv-{invocation[0]:08d}"}
            stream = io.BytesIO()
            with patch.object(installed_snapshot, "DeploymentState", return_value=fixture.state), \
                    patch.object(installed_snapshot, "ReleaseStore", return_value=fixture.store), \
                    patch.object(installed_snapshot, "load_verifier", return_value=None), \
                    patch.object(installed_snapshot, "verifier_lock", contextlib.nullcontext), \
                    patch.object(installed_snapshot, "installed_observation", side_effect=lambda b: self.state.observe(b, "c" * 64)), \
                    patch.object(installed_snapshot.sys, "argv", ["snapshot"]), \
                    patch.object(installed_snapshot.sys, "stdout", SimpleNamespace(buffer=stream)):
                status = installed_snapshot.main()
            self.assertEqual(status, 0)
            task = {"InvocationId": f"inv-{invocation[0]:08d}", "CommandId": "cmd-abcdefgh", "InstanceId": "lhins-abcdefgh",
                    "CreatedTime": datetime.now(timezone.utc).isoformat(), "TaskStatus": "SUCCESS", "CommandDocument": command,
                    "TaskResult": {"ExitCode": status, "Dropped": 0, "Output": base64.b64encode(stream.getvalue()).decode()}}
            return {"TotalCount": 1, "InvocationTaskSet": [task]}
        transport = TatTransport("cmd-abcdefgh", "lhins-abcdefgh", COMMAND_SHA256, "fixture", "fixture", call=cloud)
        policy = {"schema": 1, "csp": "default-src 'none'", "hsts": None,
                  "addressDigest": "e" * 64, "minimumCertificateDays": 21}
        # 注入采样时间使用真实 UTC，与接收端新鲜度检查一致。
        # 冻结时钟须与 ISO 回执同为微秒精度，避免创建时间向上舍入后落在“未来”。
        self.wall = datetime.now(timezone.utc).timestamp()
        record = self.arm()
        collector = Observations()
        with self.assertRaises(HealthError):
            run_maintenance("daily", transport, policy, root=Path(self.temp.name), observations=collector)
        self.assertEqual(collector.drills[0]["drill"]["id"], record["request"]["drillId"])
        self.state.disarm(record["request"]["drillId"])
        def probe(baseline, **_kwargs):
            return {"identity": baseline["identity"], "baselineSha256": digest(canonical(baseline)),
                    "serverLedgerInspected": False, "checks": [{"check": "fixture-public", "status": "passed"}],
                    "checkCount": 1, "failedCount": 0, "status": "passed"}
        def runner(_period, baseline, reader, **_kwargs):
            return run_bound_sample(baseline, reader, probe=probe)
        restored = run_maintenance("daily", transport, policy, root=Path(self.temp.name), runner=runner)
        self.assertEqual(restored["status"], "passed")
        self.assertEqual(restored["drillObservations"], [])
        self.assertEqual(restored["resourceObservations"], [])
        self.assertEqual(len(restored["serverReadEvidence"]), 3)


if __name__ == "__main__":
    unittest.main()
