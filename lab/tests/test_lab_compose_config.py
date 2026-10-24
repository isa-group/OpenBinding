"""Expanded `docker compose config` of compose.lab.json for the loopback port."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = REPO_ROOT / "compose.lab.json"
PUBLIC_ORIGIN = "https://demo.example.org"

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


# [utest->req~lab-deployment-single-loopback-port~2]
@pytest.mark.skipif(
    os.environ.get("OPENBINDING_COMPOSE_CONFIG") != "1",
    reason="set OPENBINDING_COMPOSE_CONFIG=1 to run docker compose config",
)
@pytest.mark.parametrize("port", [None, "18101", "18199"], ids=["unset", "18101", "18199"])
def test_compose_config_expands_port_image_and_cors(port: str | None) -> None:
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

    result = subprocess.run(
        [docker, "compose", "-f", str(COMPOSE_FILE), "--profile", "seed", "config", "--format", "json"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, f"docker compose config failed ({result.returncode}): {result.stderr}"

    services = json.loads(result.stdout)["services"]

    ports = services["web"]["ports"]
    assert len(ports) == 1, f"web ports: {ports}"
    assert str(ports[0]["published"]) == expected
    assert ports[0]["host_ip"] == "127.0.0.1"

    for name in ("gateway", "worker", "seed"):
        assert services[name]["image"] == f"openbinding-lab-gateway:{expected}", name

    assert services["gateway"]["environment"]["CORS_ALLOW_ORIGINS"] == (
        f"http://localhost:{expected},http://127.0.0.1:{expected},{PUBLIC_ORIGIN}"
    )
