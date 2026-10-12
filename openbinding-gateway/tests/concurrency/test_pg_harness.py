"""The PostgreSQL harness itself, checked without a database.

The ``*_pg.py`` tests need a real server; these only verify the guard in front
of them and the shape of ``compose.pgtest.json``, so a broken harness fails in
the ordinary unit run instead of on the first lab execution.
"""

from __future__ import annotations

import json
import re

import pytest

from _repo import REPO_ROOT

from ._two_sessions import check_test_database_url, require_test_database_url

COMPOSE = REPO_ROOT / "compose.pgtest.json"
LIMIT_BUDGET = 1.5 * 1024**3
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
        pytest.skip(f"compose.pgtest.json not found under {REPO_ROOT}")
    return json.loads(COMPOSE.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "url",
    [
        "postgresql+asyncpg://u:p@localhost:5432/test_openbinding",
        "postgresql://u:p@localhost/test",
    ],
)
def test_guard_accepts_postgresql_test_databases(url):
    check_test_database_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "sqlite+aiosqlite:///:memory:",
        "sqlite+aiosqlite:///test.db",
        "mysql+aiomysql://u:p@localhost/test",
        "postgresql+asyncpg://u:p@localhost/openbinding",
        "postgresql+asyncpg://u:p@localhost/",
        "postgresql+asyncpg://u:p@localhost/prod_test",
        "",
        "not a url",
    ],
)
def test_guard_refuses_other_dialects_and_names(url):
    with pytest.raises(ValueError):
        check_test_database_url(url)


def _outcome(monkeypatch, url) -> str:
    if url is None:
        monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
    else:
        monkeypatch.setenv("TEST_DATABASE_URL", url)
    try:
        require_test_database_url()
    except pytest.skip.Exception:
        return "skipped"
    except pytest.fail.Exception:
        return "failed"
    return "ok"


def test_unset_variable_skips(monkeypatch):
    assert _outcome(monkeypatch, None) == "skipped"


@pytest.mark.parametrize(
    "url", ["sqlite+aiosqlite:///:memory:", "postgresql+asyncpg://u:p@h/openbinding", ""]
)
def test_defined_but_unusable_variable_fails_rather_than_skips(monkeypatch, url):
    assert _outcome(monkeypatch, url) == "failed"


def test_defined_and_valid_variable_passes(monkeypatch):
    assert _outcome(monkeypatch, "postgresql+asyncpg://u:p@h/test_x") == "ok"


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

    if not (REPO_ROOT / "docker-compose.yml").is_file():
        pytest.skip("docker-compose.yml not found")
    build = compose["services"]["image-builder"]["build"]
    dev = yaml.safe_load((REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
    dev_build = dev["services"]["gateway-dev"]["build"]
    assert (build["context"], build["dockerfile"], build.get("target")) == (
        dev_build["context"],
        dev_build["dockerfile"],
        dev_build.get("target"),
    )


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
