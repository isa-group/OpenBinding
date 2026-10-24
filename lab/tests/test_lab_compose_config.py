"""Expanded `docker compose config` of the lab Compose files for the loopback port."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILES = ["compose.lab.json", "compose.lab-process.json"]
PUBLIC_ORIGIN = "https://demo.example.org"
TIMEOUT_SECONDS = 60

DUMMY_ENV = {
    "DEMO_PG_PASSWORD": "dummy-pg",
    "DEMO_BIM_TOKEN": "dummy-bim-token",
    "DEMO_JWT_SECRET": "dummy-jwt-secret",
    "DEMO_FERNET_KEY": "dummy-fernet-key",
    "DEMO_PUBLIC_ORIGIN": PUBLIC_ORIGIN,
    "DEMO_SPACE_ENABLED": "false",
    "DEMO_SPACE_DEV_SERVICE": "dummy-service",
    "DEMO_SPACE_DEV_PLAN": "dummy-plan",
    "DEMO_SPACE_PRICING_VERSION": "dummy-version",
    "DEMO_SPACE_DEFAULT_PLAN": "dummy-plan",
    "DEMO_SEED_TOOL": "seed.py",
    "DEMO_SEED_ARGS": "",
    "DEMO_SEED_PASSWORD": "dummy-seed-password",
    "DEMO_E2E": "0",
    "SPACE_URL": "",
    "SPACE_API_KEY": "",
    "SPACE_ORGANIZATION_ID": "",
    "SPHERE_URL": "",
    "SPHERE_API_KEY": "",
    "SPHERE_ORGANIZATION_ID": "",
}

# `${NAME}` or `${NAME:-default}`; the `$$` escapes are removed before matching.
REFERENCE_NAME = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)")


# [utest->req~lab-deployment-single-loopback-port~2]
@pytest.mark.parametrize("name", COMPOSE_FILES)
def test_every_reference_but_the_port_has_a_dummy_value(name: str) -> None:
    text = (REPO_ROOT / name).read_text(encoding="utf-8").replace("$$", "")
    referenced = set(REFERENCE_NAME.findall(text)) - {"DEMO_LAB_PORT"}
    assert referenced, name
    missing = referenced - set(DUMMY_ENV)
    assert not missing, f"{name} references variables with no dummy value: {sorted(missing)}"


# [utest->req~lab-deployment-single-loopback-port~2]
@pytest.mark.skipif(
    os.environ.get("OPENBINDING_COMPOSE_CONFIG") != "1",
    reason="set OPENBINDING_COMPOSE_CONFIG=1 to run docker compose config",
)
@pytest.mark.parametrize("port", [None, "", "18101", "18199"], ids=["unset", "empty", "18101", "18199"])
@pytest.mark.parametrize("name", COMPOSE_FILES)
def test_compose_config_expands_port_image_and_cors(name: str, port: str | None) -> None:
    docker = shutil.which("docker")
    assert docker is not None, "docker missing: the docker binary is required"

    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
        **DUMMY_ENV,
    }
    if port is not None:
        env["DEMO_LAB_PORT"] = port
    expected = port or "18100"

    try:
        result = subprocess.run(
            [docker, "compose", "-f", str(REPO_ROOT / name), "--profile", "seed", "config", "--format", "json"],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        pytest.fail(f"docker compose config of {name} took more than {TIMEOUT_SECONDS} s")
    assert result.returncode == 0, f"docker compose config failed ({result.returncode}): {result.stderr}"

    services = json.loads(result.stdout)["services"]

    ports = services["web"]["ports"]
    assert len(ports) == 1, f"web ports: {ports}"
    assert str(ports[0]["published"]) == expected
    assert ports[0]["host_ip"] == "127.0.0.1"

    for service in ("gateway", "worker", "seed"):
        assert services[service]["image"] == f"openbinding-lab-gateway:{expected}", service

    assert services["gateway"]["environment"]["CORS_ALLOW_ORIGINS"] == (
        f"http://localhost:{expected},http://127.0.0.1:{expected},{PUBLIC_ORIGIN}"
    )
