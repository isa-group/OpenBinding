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
UNITS = {"b": 1, "k": 1024, "m": 1024**2, "g": 1024**3}


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


def test_compose_has_postgres_and_runner(compose):
    assert set(compose["services"]) == {"postgres", "runner"}


def test_compose_publishes_no_ports(compose):
    for name, service in compose["services"].items():
        assert not service.get("ports"), f"{name} publishes ports"
    assert compose["networks"]["pgtest"].get("internal") is True
    for service in compose["services"].values():
        assert service.get("network_mode") is None
        assert service["networks"] == ["pgtest"]


def test_compose_mounts_no_docker_socket(compose):
    text = json.dumps(compose)
    assert "docker.sock" not in text
    assert not compose["services"]["postgres"].get("volumes")


def test_postgres_has_healthcheck_and_runner_waits_for_it(compose):
    healthcheck = compose["services"]["postgres"]["healthcheck"]
    assert "pg_isready" in " ".join(healthcheck["test"])
    depends = compose["services"]["runner"]["depends_on"]
    assert depends["postgres"]["condition"] == "service_healthy"


def test_postgres_data_is_ephemeral(compose):
    tmpfs = compose["services"]["postgres"]["tmpfs"]
    assert any(entry.startswith("/var/lib/postgresql/data") for entry in tmpfs)


def test_runner_targets_a_test_database_matching_postgres(compose):
    env = compose["services"]["runner"]["environment"]
    url = env["TEST_DATABASE_URL"]
    check_test_database_url(url)
    postgres = compose["services"]["postgres"]["environment"]
    assert url.rsplit("/", 1)[1] == postgres["POSTGRES_DB"]
    assert f"{postgres['POSTGRES_USER']}:{postgres['POSTGRES_PASSWORD']}@postgres:" in url
    assert env["DATABASE_URL"] == url


def test_runner_uses_the_gateway_dockerfile(compose):
    import yaml

    if not (REPO_ROOT / "docker-compose.yml").is_file():
        pytest.skip("docker-compose.yml not found")
    build = compose["services"]["runner"]["build"]
    dev = yaml.safe_load((REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
    dev_build = dev["services"]["gateway-dev"]["build"]
    assert (build["context"], build["dockerfile"], build.get("target")) == (
        dev_build["context"],
        dev_build["dockerfile"],
        dev_build.get("target"),
    )


def test_runner_migrates_then_runs_pytest_and_keeps_its_exit_code(compose):
    command = compose["services"]["runner"]["command"]
    script = command[-1]
    assert script.index("alembic upgrade head") < script.index("pytest")
    assert "exec pytest -p no:cacheprovider -rA tests/concurrency" in script
    assert "|| true" not in script


def test_memory_limits_are_set_and_within_budget(compose):
    limits = {name: _memory_limit(service) for name, service in compose["services"].items()}
    assert sum(limits.values()) <= LIMIT_BUDGET, limits


def test_compose_has_no_real_secret_shapes(compose):
    text = json.dumps(compose)
    assert "BEGIN PRIVATE KEY" not in text
    assert "GATEWAY_JWT_SECRET" not in text
