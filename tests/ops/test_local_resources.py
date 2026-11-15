"""手算阈值及容量读取异常，不依赖当前机器磁盘大小。"""

import unittest
from types import SimpleNamespace

from ops.deploy.deployment_state import DeploymentError
from ops.maintenance.resources import GIB, check_resources


class ResourceTests(unittest.TestCase):
    def evaluate(self, **changes):
        values = dict(f_blocks=1000, f_bavail=500, f_frsize=GIB, f_files=1000, f_favail=500)
        values.update(changes)
        return check_resources(statvfs=lambda _: SimpleNamespace(**values))

    def test_normal_and_recovery(self):
        self.assertEqual(self.evaluate()["status"], "ok")
        self.assertEqual(self.evaluate(f_bavail=201, f_favail=201)["status"], "ok")

    def test_percent_thresholds_are_inclusive(self):
        for field in ("f_bavail", "f_favail"):
            for remaining, level in ((201, "ok"), (200, "warning"), (101, "warning"), (100, "critical")):
                with self.subTest(field=field, remaining=remaining):
                    result = self.evaluate(**{field: remaining})
                    check = result["checks"][0 if field == "f_bavail" else 2]
                    self.assertEqual(check["level"], level)

    def test_free_bytes_independent_of_percent(self):
        for available, level in ((3, "ok"), (2, "warning"), (1, "critical"), (0, "critical")):
            result = self.evaluate(f_blocks=10, f_bavail=available)
            self.assertEqual(result["checks"][1]["level"], level)
            self.assertNotIn("bytes", str(result))

    def test_invalid_or_unreadable_capacity_is_not_success(self):
        for changes in ({"f_blocks": 0}, {"f_files": 0}, {"f_bavail": -1}, {"f_frsize": 0}, {"f_bavail": 1001}):
            with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_RESOURCE_DATA"):
                self.evaluate(**changes)
        def failed(_path):
            raise OSError("private path")
        result = check_resources(statvfs=failed)
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("private path", str(result))
