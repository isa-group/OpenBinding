"""The shape of ``compose.pgtest.json``, checked without Docker or a database.

This file lives in the ordinary gateway suite, where the repository checkout (and so the compose file)
exists.  It used to sit in ``tests/concurrency`` and was skipped in the lab PostgreSQL run, because the
image carries ``schemas`` and ``examples`` but not the compose file.  A missing compose file is now an
error, never a silent skip, unless ``OPENBINDING_SKIP_COMPOSE_SHAPE=1`` is set (see docs/qa/PG_HARNESS.md).
Do not list this file in ``DEMO_PYTEST_ARGS``: the container has no checkout.
"""

from __future__ import annotations

import json
import os
import re

import pytest

from _repo import REPO_ROOT
from concurrency._two_sessions import check_test_database_url

COMPOSE = REPO_ROOT / "compose.pgtest.json"
SKIP_VARIABLE = "OPENBINDING_SKIP_COMPOSE_SHAPE"
LIMIT_BUDGET = int(1.3 * 1024**3)
LAB_BUDGET = 4 * 1024**3
UNITS = {"b": 1, "k": 1024, "m": 1024**2, "g": 1024**3}
# What lab_compose refuses in a service.  Ports, networks and the short ``tmpfs`` key are not used
# either; they have their own tests.
FORBIDDEN_SERVICE_KEYS = {
    "container_name", "env_file", "secrets", "configs", "cap_add", "privileged", "deploy", "extends",
}


def _bytes(value) -> int:
    if isinstance(value, int):
        return value
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([bkmg]?)b?", str(value).strip().lower())
    assert match, f"unparseable memory size: {value!r}"
    return int(float(match.group(1)) * UNITS[match.group(2) or "b"])


def _memory_limit(service: dict) -> int:
    limit = service.get("mem_limit") or (
        service.get("deploy", {}).get("resources", {}).get("limits", {}).get("memory")
    )
    assert limit, "service has no memory limit"
    return _bytes(limit)


@pytest.fixture(scope="module")
def compose() -> dict:
    if not COMPOSE.is_file():
        message = f"compose.pgtest.json not found under {REPO_ROOT}"
        if os.environ.get(SKIP_VARIABLE) == "1":
            pytest.skip(f"{message} ({SKIP_VARIABLE}=1)")
        pytest.fail(f"{message}; run from a checkout, or set {SKIP_VARIABLE}=1 to skip knowingly")
    return json.loads(COMPOSE.read_text(encoding="utf-8"))


def test_compose_has_postgres_image_builder_and_seed(compose):
    assert set(compose["services"]) == {"postgres", "image-builder", "seed"}


def test_only_the_seed_service_is_behind_a_profile(compose):
    # ``up`` starts the healthy postgres and the image builder; the tests run as ``run --rm seed``.
    assert compose["services"]["seed"]["profiles"] == ["seed"]
    assert "profiles" not in compose["services"]["postgres"]
    assert "profiles" not in compose["services"]["image-builder"]


def test_seed_shares_the_image_that_up_always_rebuilds(compose):
    # ``up --build`` rebuilds only services without a profile; ``run --no-deps seed`` reuses an
    # existing image, so a seed with its own build would run stale code.  The seed therefore has no
    # build and uses the image tagged by the always-rebuilt image-builder.
    builder, seed = compose["services"]["image-builder"], compose["services"]["seed"]
    assert "build" in builder and "build" not in seed
    assert builder["image"] == seed["image"] == "openbinding-pgtest-gateway:latest"


def test_image_builder_is_inert(compose):
    builder = compose["services"]["image-builder"]
    assert "ports" not in builder and "volumes" not in builder and "depends_on" not in builder
    assert builder["mem_limit"] == "64m"
    assert builder["entrypoint"] == []
    assert builder["healthcheck"]["test"] == ["CMD-SHELL", "true"]
    assert builder["command"][0] in {"sh", "python"} and "sleep" in " ".join(builder["command"])


def test_compose_publishes_no_ports(compose):
    for name, service in compose["services"].items():
        assert "ports" not in service, f"{name} publishes ports"


def test_compose_uses_only_the_default_private_network(compose):
    # lab_compose accepts top-level networks/volumes only with ``labels``; none are needed.
    for section in ("networks", "volumes"):
        for name, definition in (compose.get(section) or {}).items():
            assert set(definition or {}) <= {"labels"}, f"{section}.{name}"
    for name, service in compose["services"].items():
        assert "networks" not in service, name
        assert "tmpfs" not in service, f"{name}: use a structured tmpfs volume"
        assert service.get("network_mode", "none") == "none", name


@pytest.mark.parametrize("key", sorted(FORBIDDEN_SERVICE_KEYS))
def test_compose_services_use_no_forbidden_key(compose, key):
    for name, service in compose["services"].items():
        assert key not in service, f"{name} uses {key}"


def test_compose_mounts_are_structured_and_relative(compose):
    mounts = [
        (name, mount)
        for name, service in compose["services"].items()
        for mount in service.get("volumes", [])
    ]
    assert mounts
    for name, mount in mounts:
        assert isinstance(mount, dict), f"{name}: volume entries must be objects, not strings"
        assert mount["type"] in {"bind", "volume", "tmpfs"}, (name, mount)
        assert set(mount) <= {"type", "source", "target", "tmpfs"}, (name, mount)
        assert mount["target"].startswith("/"), (name, mount)
        if mount["type"] == "bind":
            source = mount["source"]
            parts = source.split("/")
            assert not source.startswith("/") and ".." not in parts and "${" not in source, (name, mount)
            assert (REPO_ROOT / source).is_dir(), (name, mount)


def test_compose_mounts_no_docker_socket(compose):
    text = json.dumps(compose)
    assert "docker.sock" not in text
    assert not [m for m in compose["services"]["postgres"].get("volumes", []) if m["type"] != "tmpfs"]


def test_compose_does_not_bind_the_space_directory(compose):
    # space/ is being removed; the image already carries what the tests read from it.
    for service in compose["services"].values():
        for mount in service.get("volumes", []):
            assert "space" not in mount.get("source", "").split("/"), mount


def test_the_seed_bind_mounts_no_code(compose):
    # The tests travel in the ``test`` stage of the image, so the seed needs no bind at all.
    assert not compose["services"]["seed"].get("volumes")
    for name, service in compose["services"].items():
        for mount in service.get("volumes", []):
            assert mount["type"] != "bind", f"{name} bind-mounts {mount.get('source')}"


def test_postgres_has_healthcheck_and_seed_waits_for_it(compose):
    healthcheck = compose["services"]["postgres"]["healthcheck"]
    assert "pg_isready" in " ".join(healthcheck["test"])
    depends = compose["services"]["seed"]["depends_on"]
    assert depends["postgres"]["condition"] == "service_healthy"


def test_postgres_data_is_ephemeral(compose):
    volumes = compose["services"]["postgres"]["volumes"]
    data = [m for m in volumes if m["target"] == "/var/lib/postgresql/data"]
    assert len(data) == 1 and data[0]["type"] == "tmpfs"
    # Writable by the non-root postgres user: 0o1777 written in decimal, JSON has no octal.
    assert data[0]["tmpfs"]["mode"] == 0o1777 == 1023
    assert data[0]["tmpfs"]["size"] > 0


def test_postgres_runs_as_non_root_with_pgdata_in_a_subdirectory(compose):
    # The supervisor drops every capability, so the root entrypoint of the image cannot chown.
    postgres = compose["services"]["postgres"]
    assert postgres["user"] == "70:70"
    assert postgres["environment"]["PGDATA"] == "/var/lib/postgresql/data/pgdata"


def test_no_service_runs_as_root(compose):
    # The seed has no ``user``: it inherits USER 10001 of the ``test`` stage.
    for name, service in compose["services"].items():
        user = service.get("user")
        if user is not None:
            assert str(user).split(":")[0] not in {"0", "root"}, name
    assert "user" not in compose["services"]["seed"]


def test_image_builder_builds_the_test_stage(compose):
    builder, seed = compose["services"]["image-builder"], compose["services"]["seed"]
    assert builder["build"]["target"] == "test"
    assert builder["image"] == seed["image"]


def _dockerfile_stages() -> list[tuple[str, list[str]]]:
    path = REPO_ROOT / "openbinding-gateway" / "Dockerfile"
    if not path.is_file():
        if os.environ.get(SKIP_VARIABLE) == "1":
            pytest.skip(f"Dockerfile not found ({SKIP_VARIABLE}=1)")
        pytest.fail(f"{path} not found")
    stages: list[tuple[str, list[str]]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.upper().startswith("FROM "):
            words = line.split()
            name = words[3] if len(words) >= 4 and words[2].upper() == "AS" else ""
            stages.append((name, []))
        elif stages:
            stages[-1][1].append(line)
    return stages


def test_dockerfile_last_stage_is_production_and_only_test_copies_the_tests(compose):
    stages = _dockerfile_stages()
    assert [name for name, _ in stages] == ["base", "test", "production"]
    by_name = dict(stages)
    for name in ("base", "production"):
        assert not [l for l in by_name[name] if l.startswith("COPY") and "tests/" in l], name
    assert any(l.startswith("COPY openbinding-gateway/tests/ tests/") for l in by_name["test"])
    production = by_name["production"]
    for keyword in ("USER ", "EXPOSE ", "ENV FORWARDED_ALLOW_IPS", "ENTRYPOINT ", "CMD "):
        assert any(l.startswith(keyword) for l in production), keyword
    for keyword in ("EXPOSE ", "ENTRYPOINT ", "CMD "):
        assert not [l for l in by_name["base"] if l.startswith(keyword)], keyword
    assert not [l for l in by_name["base"] if l.startswith("USER ")]


def test_names_match_the_lab_compose_pattern(compose):
    names = [*compose["services"], *(compose.get("volumes") or {}), *(compose.get("networks") or {})]
    for name in names:
        assert re.fullmatch(r"[a-z][a-z0-9-]{0,62}", name), name


def test_seed_targets_a_test_database_matching_postgres(compose):
    env = compose["services"]["seed"]["environment"]
    url = env["TEST_DATABASE_URL"]
    check_test_database_url(url)
    postgres = compose["services"]["postgres"]["environment"]
    assert url.rsplit("/", 1)[1] == postgres["POSTGRES_DB"]
    assert f"{postgres['POSTGRES_USER']}:{postgres['POSTGRES_PASSWORD']}@postgres:" in url
    assert env["DATABASE_URL"] == url


def test_seed_uses_the_gateway_dockerfile(compose):
    import yaml

    dev_file = REPO_ROOT / "docker-compose.yml"
    if not dev_file.is_file():
        if os.environ.get(SKIP_VARIABLE) == "1":
            pytest.skip(f"docker-compose.yml not found ({SKIP_VARIABLE}=1)")
        pytest.fail(f"docker-compose.yml not found under {REPO_ROOT}")
    build = compose["services"]["image-builder"]["build"]
    dev = yaml.safe_load(dev_file.read_text(encoding="utf-8"))
    dev_build = dev["services"]["gateway-dev"]["build"]
    assert (build["context"], build["dockerfile"]) == (dev_build["context"], dev_build["dockerfile"])
    # The dev build takes the final (production) stage; only the harness selects ``test``.
    assert build["target"] == "test" and "target" not in dev_build


def test_seed_migrates_then_runs_pytest_and_keeps_its_exit_code(compose):
    command = compose["services"]["seed"]["command"]
    script = command[-1]
    assert script.index("alembic upgrade head") < script.index("pytest")
    assert "exec pytest -p no:cacheprovider $$DEMO_PYTEST_ARGS" in script
    assert script.endswith("$$DEMO_PYTEST_ARGS")  # unquoted: the container shell splits the words
    assert "|| true" not in script
    # Compose passes the supervisor's value into the container; the shell, not Compose, expands it.
    assert compose["services"]["seed"]["environment"]["DEMO_PYTEST_ARGS"] == "${DEMO_PYTEST_ARGS}"


def test_memory_limits_are_set_and_within_budget(compose):
    for name, service in compose["services"].items():
        assert re.fullmatch(r"\d+[mg]", str(service.get("mem_limit"))), f"{name}: mem_limit must be like '384m'"
    limits = {name: _memory_limit(service) for name, service in compose["services"].items()}
    assert sum(limits.values()) <= LIMIT_BUDGET <= LAB_BUDGET, limits


def test_compose_has_no_real_secret_shapes(compose):
    text = json.dumps(compose)
    assert "BEGIN PRIVATE KEY" not in text
    assert "GATEWAY_JWT_SECRET" not in text
