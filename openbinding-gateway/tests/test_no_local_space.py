"""SPACE and SPHERE are remote: no local SPACE deployment may come back."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from _repo import REPO_ROOT

ROOT = REPO_ROOT
COMPOSE = ROOT / "docker-compose.yml"
# Assembled from parts so a repository-wide search for the retired key finds no
# literal here; the key itself must not come back anywhere in the stacks.
FORBIDDEN_KEY = "SPACE_" + "DESTRUCTIVE_API_KEY"


def _compose() -> dict:
    if not COMPOSE.is_file():
        pytest.skip(f"docker-compose.yml not found under repo root {ROOT}")
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))


def _env(service: dict) -> dict[str, str]:
    env = service.get("environment") or {}
    if isinstance(env, dict):
        return {str(k): "" if v is None else str(v) for k, v in env.items()}
    return {
        str(item).split("=", 1)[0]: str(item).split("=", 1)[1] if "=" in str(item) else ""
        for item in env
    }


def test_no_space_services_or_profile() -> None:
    services = _compose()["services"]
    assert not [name for name in services if name.startswith("space")]
    for name, service in services.items():
        assert "space" not in (service.get("profiles") or []), name
        assert "space" not in (service.get("networks") or []), name


def test_no_space_network_or_volumes() -> None:
    compose = _compose()
    assert "space" not in (compose.get("networks") or {})
    assert not [v for v in (compose.get("volumes") or {}) if v.startswith("space")]


@pytest.mark.parametrize(
    "relative",
    ["space/prepare.sh", "deploy/kubernetes/space", "deploy/kubernetes/overlays/with-space"],
)
def test_local_space_paths_are_gone(relative: str) -> None:
    assert not (ROOT / relative).exists()


def _k8s_text() -> list[tuple[Path, str]]:
    return [
        (p, p.read_text(encoding="utf-8"))
        for p in (ROOT / "deploy" / "kubernetes").rglob("*")
        if p.is_file()
    ]


def test_destructive_key_is_not_referenced() -> None:
    assert FORBIDDEN_KEY not in COMPOSE.read_text(encoding="utf-8")
    for relative in (".env.example", "openbinding-gateway/.env.example"):
        path = ROOT / relative
        if path.is_file():
            assert FORBIDDEN_KEY not in path.read_text(encoding="utf-8"), relative
    for path, text in _k8s_text():
        assert FORBIDDEN_KEY not in text, str(path)


def test_remote_space_defaults_without_keys() -> None:
    services = _compose()["services"]
    # Production services default to the real SPACE (APP_ENV=prod refuses the
    # open gate); the development ones default to the stateless open gate.
    defaults = {"gateway": "true", "worker": "true", "gateway-dev": "false", "worker-dev": "false"}
    for name, enabled in defaults.items():
        env = _env(services[name])
        assert env["SPACE_URL"] == "${SPACE_URL:-https://space.score.us.es}", name
        assert env["SPACE_API_KEY"] == "${SPACE_API_KEY:-}", name
        assert env["SPACE_ENABLED"] == f"${{SPACE_ENABLED:-{enabled}}}", name
    for name, service in services.items():
        env = _env(service)
        for key in ("SPACE_API_KEY", "SPHERE_API_KEY"):
            if key in env:
                assert env[key] == f"${{{key}:-}}", f"{name}:{key}"


def test_openbinding_data_services_remain() -> None:
    services = _compose()["services"]
    assert services["postgres"]["image"].startswith("postgres:")
    assert services["redis"]["image"].startswith("redis:")
