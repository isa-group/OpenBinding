"""The synthetic keys never reach stdout, stderr, logs, exceptions or tracebacks."""

from __future__ import annotations

import asyncio
import json
import logging
import traceback

import httpx
import pytest

import _remote_common as common
import remote_probe
import remote_provision
from fakes import BASE_YAML, ENV, NOW, SPACE_KEY, SPHERE_KEY, FakeRemotes, production_world

ARGS = [
    "--apply", "--base-pricing-slug", "openbinding", "--base-version", "1.0.0", "--base-digest", common.sha256_digest(BASE_YAML),
    "--dev-slug", "lab-dev-pricing", "--dev-service-name", "lab-dev-service", "--prod-slug", "openbinding",
    "--prod-service-name", "openbinding",
]


def assert_clean(*texts: str) -> None:
    for text in texts:
        assert SPACE_KEY not in text and SPHERE_KEY not in text


def test_every_remote_error_that_echoes_the_credential_is_scrubbed_from_provision_output(capsys, caplog):
    caplog.set_level(logging.DEBUG)
    fake = production_world()
    # Error bodies and headers that repeat the key the request was authenticated with.
    fake.statuses[("sphere.test", "POST", "/api/v1/pricings/sphere-org-0002")] = 500
    code = remote_provision.main(ARGS, environ=ENV, transport=fake.transport(), now=NOW)
    captured = capsys.readouterr()
    assert code == 4
    body = json.loads(captured.out)["steps"][0]["request"]["body"]
    assert "denied; request authenticated with [REDACTED]" in body
    assert_clean(captured.out, captured.err, caplog.text)


def test_space_rejection_echoing_the_key_is_scrubbed_too(capsys):
    fake = production_world()
    fake.statuses[("space.test", "POST", "/api/v1/services")] = 403
    code = remote_provision.main(ARGS, environ=ENV, transport=fake.transport(), now=NOW)
    captured = capsys.readouterr()
    assert code == 4
    assert json.loads(captured.out)["steps"][-1]["request"]["status"] == 403
    assert_clean(captured.out, captured.err)


def test_an_unexpected_exception_carrying_a_key_is_reported_redacted_without_traceback(capsys):
    fake = production_world()
    fake.raise_on[("space.test", "GET", "/api/v1/services")] = RuntimeError(f"bug while using {SPACE_KEY} and {SPHERE_KEY}")
    code = remote_provision.main(ARGS, environ=ENV, transport=fake.transport(), now=NOW)
    captured = capsys.readouterr()
    assert code == 5 and captured.out == ""
    assert "RuntimeError: bug while using [REDACTED] and [REDACTED]" in captured.err
    assert "Traceback" not in captured.err
    assert_clean(captured.out, captured.err)


def test_probe_scrubs_keys_from_transport_errors_and_unexpected_exceptions(capsys):
    fake = production_world()
    fake.raise_on[("space.test", "GET", "/api/v1/services")] = httpx.ConnectError(f"refused {SPACE_KEY}")
    fake.raise_on[("sphere.test", "GET", "/api/v1/orgs/*")] = ValueError(f"oops {SPHERE_KEY}")
    code = remote_probe.main([], environ=ENV, transport=fake.transport())
    captured = capsys.readouterr()
    assert code == 0
    assert_clean(captured.out, captured.err)
    assert "[REDACTED]" in captured.out


def test_sdk_errors_that_echo_the_key_come_back_redacted():
    async def attempt():
        fake = FakeRemotes()
        fake.statuses[("space.test", "GET", "/api/v1/contracts/u-1")] = 500
        fake.raise_on[("space.test", "GET", "/api/v1/healthcheck")] = OSError(f"socket error {SPACE_KEY}")
        space = common.SpaceRemote(common.load_env(ENV), transport=fake.transport())
        try:
            status, contract, error = await space.get_contract("u-1")
            health = await space.healthcheck()
        finally:
            await space.aclose()
        return status, contract, error, health

    status, contract, error, health = asyncio.run(attempt())
    assert (status, contract) == ("error", None)
    assert "[REDACTED]" in error and "[REDACTED]" in health["error"] and health["ok"] is False
    assert_clean(error, health["error"])


def test_remote_error_messages_and_tracebacks_never_contain_a_key():
    async def attempt():
        env = common.load_env(ENV)
        sphere = common.SphereRemote(env, transport=FakeRemotes().transport())
        try:
            await sphere.upload_private(slug="openbinding", version="0.1.0", saas_name="x", content=b"x", endpoint="create",
                                        protected_slugs=["openbinding"])
        finally:
            await sphere.aclose()

    with pytest.raises(common.RemoteError) as caught:
        asyncio.run(attempt())
    rendered = "".join(traceback.format_exception(caught.value))
    assert_clean(str(caught.value), repr(caught.value), rendered)


def test_configuration_errors_do_not_echo_credentials_or_urls_with_credentials():
    bad = {**ENV, "SPACE_URL": f"https://user:{SPACE_KEY}@space.test"}
    with pytest.raises(common.ConfigError) as caught:
        common.load_env(bad)
    assert_clean(str(caught.value), repr(caught.value))
    assert "user:" not in str(caught.value)
    with pytest.raises(common.ConfigError) as caught:
        common.load_env({**ENV, "SPHERE_API_KEY": f"{SPHERE_KEY} with space"})
    assert_clean(str(caught.value))


def test_emit_json_scrubs_values_and_secret_looking_names(capsys):
    redactor = common.Redactor([SPACE_KEY])
    common.emit_json({"note": f"x {SPACE_KEY} y", "headers": {"x-api-key": SPACE_KEY, "authorization": "Bearer abc"}}, redactor)
    out = capsys.readouterr().out
    assert_clean(out)
    assert json.loads(out) == {"note": "x [REDACTED] y", "headers": {"x-api-key": "[REDACTED]", "authorization": "[REDACTED]"}}


def test_seed_lab_never_prints_the_password_or_derived_keys_unless_asked(capsys):
    import seed_lab

    password = "synthetic-demo-password"
    full, _, _ = seed_lab.api_key_for(password, "lab-owner")
    common.emit_json({"log": f"{password} {full}"}, common.Redactor([password, full]))
    out = capsys.readouterr().out
    assert password not in out and full not in out
