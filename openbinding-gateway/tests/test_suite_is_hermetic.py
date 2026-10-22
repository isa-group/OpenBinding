"""The unit suite does not see the configuration of the place it runs in.

The gateway container ships its deployment in the environment (``JOB_DISPATCH_MODE=dramatiq``,
``SPACE_ENABLED=false``, ``FEDERATION_REQUIRE_HTTPS=false``, ``DATABASE_URL``, ``REDIS_URL``...). ``tests/conftest.py``
used to ``setdefault`` its own values, so whatever the deployment already set won: jobs stayed ``QUEUED`` waiting
for a worker that does not exist and a handful of settings tests asserted against the wrong defaults. ``conftest``
now removes every variable ``Settings`` reads before the gateway is imported and then pins only what the suite
needs; these tests state that contract, including against an environment full of deployment values.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

from _paths import GATEWAY_ROOT, TESTS_DIR

from openbinding_gateway.core.settings import Settings

#: Variables the suite sets itself, with the value it needs (``None``: any non-empty value).
SUITE_VALUES = {
    "JOB_DISPATCH_MODE": "inline",
    "BIM_MODE": "inproc",
    "SPHERE_ENABLED": "false",
    "SPACE_PRICING_VERSION": "0.1.0",
    "SPACE_DEFAULT_PLAN": "BASIC",
    "GATEWAY_JWT_SECRET": None,
    "SCHEMAS_DIR": None,
}

ADMIN_VARIABLES = {
    "BOOTSTRAP_ADMIN_USERNAME": "deployment-admin",
    "BOOTSTRAP_ADMIN_PASSWORD": "deployment-password",
    "BOOTSTRAP_ADMIN_EMAIL": "deployment-admin@example.org",
    "SEED_DEFAULT_ADMIN": "true",
}

#: Read by the gateway outside ``Settings`` (``Settings.engine_urls``, ``services.engines``).
EXTRA_DEPLOYMENT_PATTERN = re.compile(r"ENGINE_[A-Z0-9_]+_URL|ENGINE_CANCELLATION_BUILTIN")


def settings_variables() -> set[str]:
    """The environment names ``Settings`` reads (``case_sensitive=False``, no prefix, no alias)."""
    assert Settings.model_config["case_sensitive"] is False
    assert not Settings.model_config.get("env_prefix")
    names = set()
    for name, field in Settings.model_fields.items():
        assert field.alias is None and field.validation_alias is None, name
        names.add(name.upper())
    return names


def leaked(environ) -> dict[str, str]:
    """Deployment variables in ``environ`` that the suite did not set itself."""
    names = settings_variables()
    return {
        key: value
        for key, value in environ.items()
        if (key.upper() in names and key not in SUITE_VALUES)
        or (key.upper() in names and key in SUITE_VALUES and SUITE_VALUES[key] is not None and value != SUITE_VALUES[key])
        or EXTRA_DEPLOYMENT_PATTERN.fullmatch(key.upper())
    }


def test_settings_variables_are_derived_from_the_settings_fields() -> None:
    names = settings_variables()
    assert {"JOB_DISPATCH_MODE", "SPACE_ENABLED", "FEDERATION_REQUIRE_HTTPS", "DATABASE_URL", "REDIS_URL"} <= names
    assert set(SUITE_VALUES) <= names


def test_the_environment_of_the_suite_carries_no_deployment_setting() -> None:
    assert leaked(os.environ) == {}
    for name, expected in SUITE_VALUES.items():
        assert os.environ.get(name), name
        if expected is not None:
            assert os.environ[name] == expected


def test_the_gateway_reads_the_values_of_the_suite_not_the_defaults_of_a_deployment() -> None:
    settings = Settings(_env_file=None)
    assert settings.job_dispatch_mode == "inline"
    assert settings.bim_mode == "inproc"
    assert settings.database_url is None
    assert settings.redis_url == "redis://redis:6379/0"
    assert settings.federation_require_https is True
    assert settings.space_enabled is False


def test_conftest_discards_a_contaminated_environment_and_keeps_the_admin_for_integration() -> None:
    contaminated = {name: "contaminated" for name in settings_variables()}
    contaminated.update(
        JOB_DISPATCH_MODE="dramatiq",
        SPACE_ENABLED="false",
        FEDERATION_REQUIRE_HTTPS="false",
        DATABASE_URL="postgresql://deployment:deployment@db.invalid/deployment",
        REDIS_URL="redis://redis.invalid:6379/0",
        BIM_MODE="http",
        SPHERE_ENABLED="true",
        SPACE_PRICING_VERSION="9.9.9",
        SPACE_DEFAULT_PLAN="ENTERPRISE",
        APP_ENV="prod",
        job_dispatch_mode="dramatiq",
        ENGINE_MINIZINC_URL="http://deployment.invalid:3000",
        ENGINE_CANCELLATION_BUILTIN="deployment",
        TEST_DATABASE_URL="postgresql://test:test@db.invalid/test",
        **ADMIN_VARIABLES,
    )
    environment = {key: value for key, value in os.environ.items() if key.upper() not in settings_variables()}
    environment.update(contaminated)
    script = (
        "import json, os, sys\n"
        f"sys.path[:0] = [{str(TESTS_DIR)!r}, {str(GATEWAY_ROOT / 'src')!r}]\n"
        "import conftest\n"
        "print('<<' + json.dumps({'environ': dict(os.environ), 'admin': conftest._CAPTURED_ADMIN_ENVIRONMENT}) + '>>')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        env=environment,
        cwd=GATEWAY_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(re.search(r"<<(.*)>>", result.stdout, re.DOTALL).group(1))

    assert leaked(payload["environ"]) == {}
    for name, expected in SUITE_VALUES.items():
        assert payload["environ"].get(name), name
        if expected is not None:
            assert payload["environ"][name] == expected
    # The administrator the stack was started with still reaches the integration tests ...
    assert payload["admin"] == ADMIN_VARIABLES
    # ... but not the unit tests' settings, and the one variable that is not a gateway setting survives.
    assert not set(ADMIN_VARIABLES) & set(payload["environ"])
    assert payload["environ"]["TEST_DATABASE_URL"] == contaminated["TEST_DATABASE_URL"]
