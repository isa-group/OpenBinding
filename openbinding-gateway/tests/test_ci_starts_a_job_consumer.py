"""The CI stack must run something that consumes the jobs the gateway queues.

``gateway-dev`` runs with ``JOB_DISPATCH_MODE=dramatiq``: ``POST /v1/jobs``
commits a QUEUED row, publishes it to Redis and answers 202. Only a Dramatiq
worker moves it on. ``docker compose up <services>`` starts the named services
and what they depend on, never what depends on them, and ``worker-dev`` depends
on ``gateway-dev`` rather than the other way round, so naming only the gateway
leaves every solve job queued for good.
"""

from __future__ import annotations

import shlex

import pytest
import yaml

from _repo import REPO_ROOT

WORKFLOW = ".github/workflows/ci.yml"
COMPOSE = "docker-compose.yml"
CONSUMED_QUEUE = "default"


def _load(relative: str) -> dict:
    path = REPO_ROOT / relative
    if not path.is_file():
        pytest.skip(f"{relative} not found under repo root {REPO_ROOT}")
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _environment(service: dict) -> dict[str, str]:
    env = service.get("environment") or {}
    if isinstance(env, dict):
        return {str(key): str(value) for key, value in env.items()}
    return {
        str(item).split("=", 1)[0]: str(item).split("=", 1)[1]
        for item in env
        if "=" in str(item)
    }


def _command(service: dict) -> list[str]:
    command = service.get("command") or []
    return shlex.split(command) if isinstance(command, str) else [str(part) for part in command]


def _requested_services(workflow: dict, job: str, step_name: str) -> list[str]:
    step = next(item for item in workflow["jobs"][job]["steps"] if item.get("name") == step_name)
    words = shlex.split(step["run"])
    assert words[:3] == ["docker", "compose", "up"], step["run"]
    return [word for word in words[3:] if not word.startswith("-")]


def _started(services: dict, requested: list[str]) -> set[str]:
    """The requested services and, transitively, everything they depend on."""

    started: set[str] = set()
    pending = list(requested)
    while pending:
        name = pending.pop()
        if name in started:
            continue
        assert name in services, f"{COMPOSE} has no service {name}"
        started.add(name)
        pending.extend(services[name].get("depends_on") or [])
    return started


def _consumes_queue(service: dict, queue: str) -> bool:
    command = _command(service)
    if "dramatiq" not in " ".join(command) or "--queues" not in command:
        return False
    after = command[command.index("--queues") + 1 :]
    queues = []
    for word in after:
        if word.startswith("-"):
            break
        queues.append(word)
    return queue in queues


def test_the_services_ci_starts_include_a_consumer_of_the_job_queue() -> None:
    services = _load(COMPOSE)["services"]
    requested = _requested_services(_load(WORKFLOW), "test", "Build and start services")
    started = _started(services, requested)

    queued = [
        name
        for name in started
        if _environment(services[name]).get("JOB_DISPATCH_MODE") == "dramatiq"
    ]
    assert queued, "none of the services CI starts queues jobs; this guard is obsolete"
    consumers = sorted(name for name in started if _consumes_queue(services[name], CONSUMED_QUEUE))
    assert consumers, (
        f"CI starts {sorted(started)}; {queued} publish jobs to Redis but no started service "
        f"runs a Dramatiq worker on the '{CONSUMED_QUEUE}' queue, so every job stays queued"
    )


def test_the_ci_log_step_covers_the_job_consumer() -> None:
    workflow = _load(WORKFLOW)
    step = next(
        item
        for item in workflow["jobs"]["test"]["steps"]
        if item.get("name") == "Show service logs on failure"
    )
    services = _load(COMPOSE)["services"]
    started = _started(
        services, _requested_services(workflow, "test", "Build and start services")
    )
    consumers = {name for name in started if _consumes_queue(services[name], CONSUMED_QUEUE)}
    assert consumers, "no job consumer is started"
    assert consumers <= set(shlex.split(step["run"])), (
        f"the failure log step must print {sorted(consumers)}: a stuck job is only explained by its worker"
    )
