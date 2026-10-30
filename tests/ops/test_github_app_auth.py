import base64
import datetime
import json
import unittest
from unittest import mock

from ops.deploy import github_app_auth


def scoped_response(**changes):
    result = {
        "token": "ghs_" + "x" * 32,
        "expires_at": (
            datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(minutes=50)
        ).isoformat(),
        "permissions": {"actions": "read", "metadata": "read"},
        "repositories": [{"full_name": "lyty1997/AxialMuseWebsite"}],
    }
    result.update(changes)
    return result


class GitHubAppAuthTests(unittest.TestCase):
    def test_jwt_uses_short_rs256_window_and_app_id(self):
        token = github_app_auth.build_app_jwt(
            "12345", now=1_800_000_000, sign=lambda message: b"signature"
        )
        header, payload, signature = token.split(".")
        def decode(part):
            return json.loads(base64.urlsafe_b64decode(part + "=="))
        self.assertEqual(decode(header), {"alg": "RS256", "typ": "JWT"})
        self.assertEqual(decode(payload), {
            "iat": 1_799_999_940,
            "exp": 1_800_000_540,
            "iss": "12345",
        })
        self.assertEqual(base64.urlsafe_b64decode(signature + "=="), b"signature")

    def test_installation_request_narrows_repository_and_permission(self):
        observed = {}

        def request(endpoint, jwt, body):
            observed["endpoint"] = endpoint
            observed["jwt"] = jwt
            observed["body"] = json.loads(body)
            return scoped_response()

        with mock.patch.object(github_app_auth.os, "geteuid", return_value=0):
            token = github_app_auth.create_installation_token(
                identity={"appId": "12345", "installationId": "67890"},
                now=1_800_000_000,
                sign=lambda message: b"signature",
                request=request,
            )
        self.assertTrue(token.startswith("ghs_"))
        self.assertEqual(
            observed["endpoint"],
            "https://api.github.com/app/installations/67890/access_tokens",
        )
        self.assertEqual(observed["body"], {
            "repositories": ["AxialMuseWebsite"],
            "permissions": {"actions": "read"},
        })

    def test_broad_or_wrong_scope_and_unprivileged_context_fail(self):
        identity = {"appId": "12345", "installationId": "67890"}
        with mock.patch.object(github_app_auth.os, "geteuid", return_value=1000):
            with self.assertRaises(github_app_auth.GitHubAppAuthError):
                github_app_auth.create_installation_token(identity=identity)
        for response in (
            scoped_response(permissions={"actions": "write"}),
            scoped_response(repositories=[{"full_name": "other/repo"}]),
            scoped_response(repositories=[]),
            scoped_response(expires_at="2020-01-01T00:00:00Z"),
        ):
            with self.subTest(response=response.get("permissions")):
                with mock.patch.object(github_app_auth.os, "geteuid", return_value=0):
                    with self.assertRaises(github_app_auth.GitHubAppAuthError):
                        github_app_auth.create_installation_token(
                            identity=identity,
                            now=1_800_000_000,
                            sign=lambda message: b"signature",
                            request=lambda endpoint, jwt, body: response,
                        )


if __name__ == "__main__":
    unittest.main()
