"""公网候选的 CSP、模式及续期失败边界。"""

import contextlib
import io
import ssl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from ops.deploy.deployment_state import DeploymentError, canonical, write_new
from ops.deploy import release_commands
from ops.deploy.public_activation import PublicNginx, load_public_mode
from ops.deploy.public_site import (
    InlinePolicy, bootstrap_config, content_hash, csp_for_store, public_config,
    public_hsts_max_age, security_headers,
)
from ops.deploy.renew_public_certificate import record_success, renew, renewal_context
from test_release_transaction import ReleaseFixture


class PublicSiteTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="axial-public-unit-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.fixture = ReleaseFixture(self.root)
        self.sha = "a" * 40
        stage, identity = self.fixture.stage(self.sha, payload_index=b"<script>abc</script>")
        self.fixture.approve(identity)
        self.fixture.engine.execute(identity=identity, stage=stage)

    def test_inline_hash_golden_and_html_newline_normalization(self):
        self.assertEqual(content_hash("abc"), "'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='")
        self.assertEqual(content_hash("a\r\nb\rc"), content_hash("a\nb\nc"))
        csp = csp_for_store(self.fixture.store, self.sha)
        self.assertIn(content_hash("abc"), csp)
        for forbidden in ("unsafe-inline", "unsafe-eval", "*", "http:"):
            self.assertNotIn(forbidden, csp)
        self.assertIn("frame-ancestors 'none'", csp)

    def test_next_generation_gets_its_own_inline_hash(self):
        stage, identity = self.fixture.stage("b" * 40, payload_index=b"<script>next</script>")
        self.fixture.engine.execute(identity=identity, stage=stage)
        first, second = (csp_for_store(self.fixture.store, sha) for sha in (self.sha, "b" * 40))
        self.assertIn(content_hash("next"), second)
        self.assertNotIn(content_hash("abc"), second)
        self.assertNotEqual(first, second)

    def test_external_active_resource_and_inline_attributes_rejected(self):
        for html in ('<script src="https://outside.invalid/a.js"></script>',
                     '<link rel="preload" href="//outside.invalid/font.woff2">',
                     '<button onclick="doSomething()">x</button>', '<p style="color:red">x</p>',
                     '<iframe src="/private"></iframe>', '<base href="https://outside.invalid">',
                     '<script src="/one.js" src="/two.js"></script>'):
            with self.subTest(html=html), self.assertRaises(DeploymentError):
                InlinePolicy().feed(html)

    def test_only_observed_hidden_sprite_style_gets_an_attribute_hash(self):
        parser = InlinePolicy()
        parser.feed('<svg style="display: none;"></svg>')
        self.assertEqual(parser.style_attributes, {content_hash("display: none;")})
        for html in ('<svg style="display: block;"></svg>', '<p style="display: none;"></p>'):
            with self.assertRaisesRegex(DeploymentError, "PUBLIC_INLINE_ATTRIBUTE"):
                InlinePolicy().feed(html)

    def test_mode_never_silently_ignores_existing_public_config(self):
        configuration = self.root / "public.conf"
        self.assertIsNone(load_public_mode(self.fixture.state, configuration))
        write_new(configuration, b"managed", 0o644)
        with self.assertRaisesRegex(DeploymentError, "PUBLIC_MODE_MISSING"):
            load_public_mode(self.fixture.state, configuration)
        mode = self.fixture.state.root / "public-site.json"
        write_new(mode, canonical({"schema": 1, "hsts": False}))
        self.assertEqual(load_public_mode(self.fixture.state, configuration), {"schema": 1, "hsts": False})
        mode.write_bytes(canonical({"schema": True, "hsts": False}))
        with self.assertRaisesRegex(DeploymentError, "PUBLIC_MODE"):
            load_public_mode(self.fixture.state, configuration)

    def test_configuration_paths_and_hsts_are_explicit(self):
        config = public_config(self.fixture.store, self.sha).decode()
        self.assertIn(f"releases/{self.sha}/config/site-release.conf", config)
        self.assertNotIn("Strict-Transport-Security", config)
        self.assertNotIn("includeSubDomains", config)
        self.assertIn("ssl_reject_handshake on", config)
        self.assertIn("Strict-Transport-Security", public_config(self.fixture.store, self.sha, hsts=True).decode())
        with self.assertRaisesRegex(DeploymentError, "PUBLIC_PATH"):
            public_config(self.fixture.store, self.sha, lineage="/tmp/cert;injected")
        self.assertNotIn("return 301", bootstrap_config().decode())
        self.assertIn("return 503", bootstrap_config().decode())

    def test_public_mode_preserves_legacy_and_accepts_only_approved_trial(self):
        modes = (({"schema": 1, "hsts": False}, 0), ({"schema": 1, "hsts": True}, 15552000),
                 ({"schema": 2, "hstsMaxAge": 0}, 0), ({"schema": 2, "hstsMaxAge": 300}, 300))
        path = self.fixture.state.root / "public-site.json"
        for mode, expected in modes:
            with self.subTest(mode=mode):
                path.write_bytes(canonical(mode))
                path.chmod(0o600)
                self.assertEqual(load_public_mode(self.fixture.state), mode)
                self.assertEqual(public_hsts_max_age(mode), expected)
                self.assertEqual(PublicNginx(self.fixture.store, mode=mode).render(self.sha),
                                 public_config(self.fixture.store, self.sha, hsts_max_age=expected))
        self.assertEqual(public_config(self.fixture.store, self.sha),
                         public_config(self.fixture.store, self.sha, hsts_max_age=0))
        self.assertEqual(public_config(self.fixture.store, self.sha, hsts=True),
                         public_config(self.fixture.store, self.sha, hsts_max_age=15552000))

    def test_unknown_or_ambiguous_modes_never_render_or_invoke_commands(self):
        invalid = (None, [], {}, {"schema": True, "hsts": False}, {"schema": 1, "hsts": 0},
                   {"schema": 1, "hsts": False, "hstsMaxAge": 300},
                   {"schema": 2, "hsts": True}, {"schema": 3, "hstsMaxAge": 300})
        invalid += tuple({"schema": 2, "hstsMaxAge": age} for age in
                         (False, True, 300.0, "300", None, -1, 301, 3600, 15552000))
        invalid += ({"schema": 2, "hstsMaxAge": 300, "preload": True},)
        path = self.fixture.state.root / "public-site.json"
        for mode in invalid:
            with self.subTest(mode=mode):
                path.write_bytes(canonical(mode))
                path.chmod(0o600)
                with self.assertRaisesRegex(DeploymentError, "PUBLIC_MODE"):
                    load_public_mode(self.fixture.state)
                command = Mock()
                with self.assertRaisesRegex(DeploymentError, "PUBLIC_MODE"):
                    PublicNginx(self.fixture.store, mode=mode, run=command)
                command.assert_not_called()

    def test_trial_headers_are_only_on_two_known_https_servers(self):
        config = public_config(self.fixture.store, self.sha, hsts_max_age=300).decode()
        exact = 'add_header Strict-Transport-Security "max-age=300" always;'
        self.assertEqual(config.count(exact), 2)
        self.assertNotIn("15552000", config)
        self.assertNotIn("includeSubDomains", config)
        self.assertNotIn("preload", config)
        for block in config.split("server {")[1:]:
            self.assertEqual(exact in block, "ssl_certificate " in block)
        for age in (False, True, 300.0, "300", -1, 301):
            with self.assertRaisesRegex(DeploymentError, "PUBLIC_MODE"):
                security_headers("default-src 'none'", hsts_max_age=age)
        with self.assertRaisesRegex(DeploymentError, "PUBLIC_MODE"):
            security_headers("default-src 'none'", True, hsts_max_age=300)

    def test_mode_config_mismatch_blocks_renewal_without_reload(self):
        configuration = self.root / "public.conf"
        write_new(configuration, public_config(self.fixture.store, self.sha), 0o644)
        command = Mock()
        target = PublicNginx(self.fixture.store, mode={"schema": 2, "hstsMaxAge": 300},
                             public_configuration=configuration, run=command)
        before = self.fixture.state.read_ledger()[0]
        with self.assertRaisesRegex(DeploymentError, "PUBLIC_CONFIG_DRIFT"):
            renew(self.fixture.store, target)
        command.assert_not_called()
        self.assertEqual(self.fixture.store.current(), self.sha)
        self.assertEqual(self.fixture.state.read_ledger()[0], before)
        self.assertEqual(configuration.read_bytes(), public_config(self.fixture.store, self.sha))

    def test_tls_verification_cannot_be_disabled(self):
        insecure = ssl._create_unverified_context()
        with self.assertRaisesRegex(DeploymentError, "PUBLIC_TLS_CONTEXT"):
            PublicNginx(self.fixture.store, mode={"schema": 1, "hsts": False}, tls_context=insecure)

    def test_certificate_key_mismatch_fails_before_command_or_reload(self):
        nginx = PublicNginx(self.fixture.store, mode={"schema": 1, "hsts": False}, run=Mock())
        with patch("ops.deploy.public_activation.ssl.SSLContext") as context:
            context.return_value.load_cert_chain.side_effect = ssl.SSLError("fixture mismatch")
            with self.assertRaisesRegex(DeploymentError, "PUBLIC_CERTIFICATE_KEY"):
                nginx.check_certificate()
        nginx.run.assert_not_called()

    def test_acme_root_under_private_parent_is_rejected_before_nginx(self):
        private = self.root / "private"
        private.mkdir(mode=0o700)
        webroot = private / "challenge"
        webroot.mkdir(mode=0o755)
        nginx = PublicNginx(self.fixture.store, mode={"schema": 1, "hsts": False}, webroot=webroot, run=Mock())
        with patch.object(nginx, "check_certificate"):
            with self.assertRaisesRegex(DeploymentError, "PUBLIC_WEBROOT_TRAVERSE"):
                nginx.validate(self.sha)
        nginx.run.assert_not_called()

    def test_fixed_command_selects_public_adapter_only_with_explicit_mode(self):
        values = ["1", "2", "a" * 40, "b" * 64, "c" * 64]
        arguments = [v for pair in zip(release_commands.FLAGS, values) for v in pair]
        for mode in (None, {"schema": 1, "hsts": False},
                     {"schema": 2, "hstsMaxAge": 0}, {"schema": 2, "hstsMaxAge": 300}):
            with self.subTest(mode=mode), \
                    patch.object(release_commands.os, "geteuid", return_value=0), \
                    patch.object(release_commands, "verifier_lock", return_value=contextlib.nullcontext()), \
                    patch.object(release_commands, "DeploymentState"), \
                    patch.object(release_commands, "check_directory"), \
                    patch.object(release_commands, "load_verifier"), \
                    patch.object(release_commands, "ReleaseStore"), \
                    patch.object(release_commands, "ReleaseTransaction") as transaction, \
                    patch.object(release_commands, "LocalNginx") as local, \
                    patch("ops.deploy.public_activation.load_public_mode", return_value=mode), \
                    patch("ops.deploy.public_activation.PublicNginx") as public, \
                    contextlib.redirect_stdout(io.StringIO()):
                transaction.return_value.execute.return_value = {"status": "local-accepted"}
                self.assertEqual(release_commands.main(arguments, "axialmuse-deploy"), 0)
                self.assertEqual(public.call_count, int(mode is not None))
                self.assertEqual(local.call_count, int(mode is None))
                self.assertEqual(transaction.return_value.execute.call_args.kwargs["identity"]["artifact_id"], "2")

    def test_renew_hook_rejects_other_lineage_or_duplicate_domains(self):
        valid = {"RENEWED_DOMAINS": "axialmuse.com www.axialmuse.com",
                 "RENEWED_LINEAGE": "/etc/letsencrypt/live/axialmuse.com"}
        renewal_context(valid)
        for change in ({"RENEWED_LINEAGE": "/tmp/arbitrary"},
                       {"RENEWED_DOMAINS": "axialmuse.com axialmuse.com"},
                       {"RENEWED_DOMAINS": "axialmuse.com www.axialmuse.com api.axialmuse.com"}):
            with self.assertRaises(DeploymentError):
                renewal_context({**valid, **change})

    def test_renew_validation_failure_never_reloads_or_changes_state(self):
        nginx = Mock()
        nginx.public_configuration = self.root / "public.conf"
        nginx.render.return_value = b"expected generation"
        write_new(nginx.public_configuration, nginx.render.return_value, 0o644)
        nginx.validate.side_effect = DeploymentError("CERTIFICATE_REJECTED")
        before = self.fixture.state.read_ledger()[0]
        with self.assertRaisesRegex(DeploymentError, "CERTIFICATE_REJECTED"):
            renew(self.fixture.store, nginx)
        nginx.activate.assert_not_called()
        self.assertEqual(self.fixture.store.current(), self.sha)
        self.assertEqual(self.fixture.state.read_ledger()[0], before)

    def test_renew_configuration_drift_never_reloads(self):
        nginx = Mock()
        nginx.public_configuration = self.root / "public.conf"
        write_new(nginx.public_configuration, b"unknown config", 0o644)
        nginx.render.return_value = b"expected config"
        with self.assertRaisesRegex(DeploymentError, "PUBLIC_CONFIG_DRIFT"):
            renew(self.fixture.store, nginx)
        nginx.validate.assert_not_called()
        nginx.activate.assert_not_called()

    def test_renewal_receipts_are_new_private_files(self):
        import json
        result = {"status": "certificate-reload-local-accepted", "currentSha": self.sha,
                  "ledgerSha256": "b" * 64, "certificateSha256": "c" * 64, "publicAcceptance": False}
        for _ in range(2):
            record_success(self.fixture.state, result, 1)
        directory = self.fixture.state.root / "certificate-renewals"
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        records = list(directory.iterdir())
        self.assertEqual(len(records), 2)
        for path in records:
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text())["certificateSha256"], "c" * 64)


if __name__ == "__main__":
    unittest.main()
