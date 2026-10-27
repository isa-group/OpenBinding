"""Dramatiq workers must not receive the session-signing secret."""

from __future__ import annotations

import pytest
import yaml

from _repo import REPO_ROOT

SECRET = "GATEWAY_JWT_SECRET"
COMPOSE_FILES = ("docker-compose.yml", "experimentation/qacobench/compose.yaml")


def _load(relative: str) -> dict:
    path = REPO_ROOT / relative
    if not path.is_file():
        pytest.skip(f"{relative} not found under repo root {REPO_ROOT}")
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _env_names(service: dict) -> set[str]:
    env = service.get("environment") or {}
    if isinstance(env, dict):
        return set(env)
    return {str(item).split("=", 1)[0] for item in env}


def _command_text(service: dict) -> str:
    command = service.get("command") or ""
    return command if isinstance(command, str) else " ".join(map(str, command))


@pytest.mark.parametrize("relative", COMPOSE_FILES)
def test_dramatiq_services_do_not_get_jwt_secret(relative: str) -> None:
    services = _load(relative)["services"]
    workers = {n: s for n, s in services.items() if "dramatiq" in _command_text(s)}
    assert workers, f"no dramatiq services found in {relative}"
    for name, service in workers.items():
        assert SECRET not in _env_names(service), f"{relative}:{name} defines {SECRET}"


def test_worker_and_worker_dev_run_dramatiq_without_the_jwt_secret() -> None:
    services = _load("docker-compose.yml")["services"]
    for name in ("worker", "worker-dev"):
        assert name in services
        assert "dramatiq" in _command_text(services[name])
        assert SECRET not in _env_names(services[name]), f"{name} defines {SECRET}"


# [utest->req~lab-deployment-no-analysis-worker~1]
@pytest.mark.parametrize("relative", ("docker-compose.yml", "deploy/compose/production/compose.yaml"))
def test_no_worker_serves_the_analysis_queue(relative: str) -> None:
    services = _load(relative)["services"]
    assert not [name for name in services if "analysis" in name]
    for name, service in services.items():
        if "dramatiq" in _command_text(service):
            assert "analysis" not in _command_text(service), f"{relative}:{name} serves the analysis queue"


@pytest.mark.parametrize("name", ["gateway", "gateway-dev"])
def test_gateway_services_keep_jwt_secret(name: str) -> None:
    services = _load("docker-compose.yml")["services"]
    assert SECRET in _env_names(services[name])


def test_qacobench_gateway_keeps_jwt_secret() -> None:
    services = _load("experimentation/qacobench/compose.yaml")["services"]
    assert SECRET in _env_names(services["gateway"])
