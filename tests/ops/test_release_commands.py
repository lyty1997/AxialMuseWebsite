"""固定命令语法和执行前边界，不依赖生产凭证。"""

import contextlib
import io
import unittest
from unittest.mock import patch

from ops.deploy import release_commands as command
from ops.deploy.deployment_state import DeploymentError
from ops.deploy.nginx_activation import LocalNginx, local_site_config


class ReleaseCommandsTests(unittest.TestCase):
    def test_exact_five_parameters_and_no_path_or_shell_inputs(self):
        values = ["1", "2", "a" * 40, "b" * 64, "c" * 64]
        args = [value for pair in zip(command.FLAGS, values) for value in pair]
        self.assertEqual(command.parse_deploy(args)["artifact_id"], "2")
        for wrong in (args + ["--path", "/tmp"], args[2:] + args[:2],
                      args[:1] + ["1;id"] + args[2:], args[:5] + ["../bad"] + args[6:]):
            with self.assertRaises(DeploymentError):
                command.parse_deploy(wrong)

    def test_nonroot_fails_without_lock_or_download(self):
        output = io.StringIO()
        with patch.object(command.os, "geteuid", return_value=1000), \
                patch.object(command, "verifier_lock", side_effect=AssertionError("lock reached")), \
                contextlib.redirect_stderr(output):
            self.assertEqual(command.main([], "axialmuse-deploy"), 1)
        self.assertIn("DEPLOY_CONTEXT", output.getvalue())

    def test_invalid_root_invocation_fails_before_lock(self):
        for executable, args in (("axialmuse-rollback", ["--commit-sha", "latest"]),
                                 ("axialmuse-deploy-init", []), ("arbitrary", [])):
            with self.subTest(executable=executable), \
                    patch.object(command.os, "geteuid", return_value=0), \
                    patch.object(command, "verifier_lock", side_effect=AssertionError("lock reached")), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(command.main(args, executable), 1)

    def test_initial_site_block_is_loopback_only_and_same_current_include(self):
        content = local_site_config("/srv/axialmuse").decode()
        self.assertEqual(content.count("listen "), 1)
        self.assertIn("listen 127.0.0.1:18080;", content)
        self.assertIn("include /srv/axialmuse/current/config/site-release.conf;", content)
        self.assertIn("access_log off;", content)
        self.assertNotIn("return 301", content)

    def test_new_workers_do_not_hide_old_generation_still_alive(self):
        nginx = LocalNginx(None)
        old_worker = iter((200, None))
        def identity(pid):
            return 100 if pid == 1 else next(old_worker)
        with patch.object(nginx, "process_identity", side_effect=identity), \
                patch.object(nginx, "workers", return_value={3: 300}), \
                patch("ops.deploy.nginx_activation.time.sleep") as sleep:
            nginx.wait_old_workers(1, 100, {2: 200})
        sleep.assert_called_once()

    def test_replaced_master_is_not_a_successful_reload(self):
        nginx = LocalNginx(None)
        with patch.object(nginx, "process_identity", return_value=101):
            with self.assertRaisesRegex(DeploymentError, "DEPLOY_NGINX_MASTER"):
                nginx.wait_old_workers(1, 100, {2: 200})


if __name__ == "__main__":
    unittest.main()
