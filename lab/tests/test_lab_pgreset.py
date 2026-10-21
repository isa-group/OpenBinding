"""Static checks of ``compose.lab-pgreset.json``, the recovery-only manifest that resets the password of the
``openbinding`` role in the ``lab-pg-3`` volume, without Docker.

It must pass the rules of ``compose.lab.json`` (except the memory sum, which is for the whole laboratory), use the
same project, volume, image, user and PGDATA, and never carry the password anywhere but as a bare reference.

Run from ``openbinding-gateway`` with its environment::

    uv run --locked pytest ../lab/tests
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

_spec = importlib.util.spec_from_file_location("lab_compose_rules", HERE / "test_lab_compose.py")
rules = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rules)

BASE = ROOT / "compose.lab.json"
RESET = ROOT / "compose.lab-pgreset.json"
DOC = ROOT / "docs" / "qa" / "PG_ROLE_RESET.md"
OK_LINE = "pg-role-password-reset-ok"


@pytest.fixture(scope="module")
def base() -> dict:
    return json.loads(BASE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def manifest() -> dict:
    return json.loads(RESET.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def postgres(manifest) -> dict:
    return manifest["services"]["postgres"]


@pytest.fixture(scope="module")
def script(postgres) -> str:
    assert postgres["command"][:2] == ["sh", "-c"] and len(postgres["command"]) == 3
    return postgres["command"][2]


# -- the validator rules --------------------------------------------------------------------------


def test_shape_names_and_single_service(manifest):
    assert set(manifest) <= rules.ALLOWED_TOP_LEVEL
    assert {"name", "services"} <= set(manifest)
    assert list(manifest["services"]) == ["postgres"]
    for section in ("networks", "volumes"):
        for name, definition in (manifest.get(section) or {}).items():
            assert set(definition or {}) <= {"labels"}, f"{section}.{name}"
    names = [*manifest["services"], *(manifest.get("volumes") or {}), *(manifest.get("networks") or {})]
    assert not [n for n in names if not rules.NAME_PATTERN.fullmatch(n)]


def test_no_forbidden_key_network_socket_or_build(manifest, postgres):
    assert not (set(postgres) & rules.FORBIDDEN_SERVICE_KEYS)
    assert postgres.get("network_mode", "none") == "none"
    assert "networks" not in postgres and "tmpfs" not in postgres
    assert "ports" not in postgres and "build" not in postgres and "depends_on" not in postgres
    assert not [s for s in rules._strings(manifest) if ".sock" in s]


def test_mem_limit_is_the_one_of_the_laboratory_postgres(base, postgres):
    assert postgres["mem_limit"] == base["services"]["postgres"]["mem_limit"] == "384m"
    assert rules._mib(postgres["mem_limit"]) == 384
    # The 4032 MiB sum of the whole laboratory does not apply: this manifest is recovery-only.
    assert rules._total_mib(json.loads(RESET.read_text(encoding="utf-8"))["services"]) == 384


def test_volumes_are_structured_declared_and_used(manifest, postgres):
    declared = set(manifest.get("volumes") or {})
    used = set()
    for mount in postgres["volumes"]:
        assert isinstance(mount, dict)
        assert set(mount) <= rules.ALLOWED_MOUNT_KEYS
        assert mount["type"] == "volume" and mount["target"].startswith("/")
        assert mount["source"] in declared
        used.add(mount["source"])
    assert used == declared


def test_references_are_demo_variables_without_defaults_and_no_secret_shapes(manifest):
    for text in rules._strings(manifest):
        for body in rules.REFERENCE.findall(text):
            assert re.fullmatch(r"[A-Z][A-Z0-9_]*", body), body
            assert body.startswith("DEMO_") or body in rules.PRIVATE_VARIABLES, body
    text = RESET.read_text(encoding="utf-8")
    assert not rules.SECRET_SHAPES.search(text)
    assert rules.DESTRUCTIVE_KEY not in text


# -- the same data as compose.lab.json ------------------------------------------------------------


def test_same_project_image_user_volume_and_pgdata_as_compose_lab(base, manifest, postgres):
    original = base["services"]["postgres"]
    assert manifest["name"] == base["name"] == "openbinding-lab"
    assert postgres["image"] == original["image"] == "postgres:16-alpine"
    assert postgres["user"] == original["user"] == "70:70"
    assert postgres["volumes"] == original["volumes"]
    assert postgres["volumes"] == [{"type": "volume", "source": "lab-pg-3", "target": "/var/lib/postgresql/data"}]
    assert manifest["volumes"] == {"lab-pg-3": base["volumes"]["lab-pg-3"]}
    assert rules._env(postgres)["PGDATA"] == rules._env(original)["PGDATA"] == "/var/lib/postgresql/data/pgdata"


def test_it_runs_once_and_does_not_restart(postgres):
    assert postgres["restart"] == "no"
    assert "healthcheck" not in postgres


# -- the password ---------------------------------------------------------------------------------


def test_environment_is_exactly_pgdata_and_the_password_by_pure_reference(postgres):
    assert rules._env(postgres) == {
        "PGDATA": "/var/lib/postgresql/data/pgdata",
        "DEMO_PG_PASSWORD": "${DEMO_PG_PASSWORD}",
    }
    assert not rules.SECRET_NAME.search("PGDATA")
    assert "POSTGRES_PASSWORD" not in postgres["environment"]


def test_the_password_is_never_in_the_command_line(postgres, script):
    command = json.dumps(postgres["command"])
    assert "${DEMO_PG_PASSWORD}" not in command
    # `$$` is compose's escape: the shell reads the value from the container's own environment.
    assert '"$$DEMO_PG_PASSWORD"' in script
    assert "$" not in script.replace("$$", ""), "every $ in the script must be escaped as $$ for compose"
    assert not re.search(r"PASSWORD\s+'", script) and not re.search(r"PASSWORD\s+\"", script)
    assert "echo $$DEMO" not in script and "set -x" not in script and "-x" not in script.split()


def test_the_password_reaches_psql_as_a_variable_not_in_the_sql_text(script):
    assert "ALTER ROLE openbinding PASSWORD :'pw';" in script
    assert 'printf "ALTER ROLE' in script
    assert "-v pw=\"$$DEMO_PG_PASSWORD\"" in script
    assert "-v ON_ERROR_STOP=1" in script
    assert "-U openbinding" in script and "-d openbinding" in script


# -- the script -----------------------------------------------------------------------------------


def test_script_is_strict_and_prints_only_the_ok_line(script):
    assert script.startswith("set -eu;")
    assert script.rstrip().endswith(f"echo {OK_LINE}")
    assert script.count("echo ") == 1
    assert "exit 1" not in script  # the failure code comes from set -e and the final test on psql's status


def test_script_starts_psql_stops_in_order_without_network(script):
    start = script.index('pg_ctl -D "$$PGDATA" -o "-c listen_addresses=\'\'" -w start')
    alter = script.index("ALTER ROLE openbinding")
    stop = script.index('pg_ctl -D "$$PGDATA" -m fast -w stop')
    final = script.index(f"echo {OK_LINE}")
    assert start < alter < stop < final
    assert "listen_addresses=''" in script
    assert "-h " not in script and "--host" not in script and "localhost" not in script and "5432" not in script


def test_psql_failure_still_stops_postgres_and_then_fails(script):
    # psql's status is kept, postgres is stopped cleanly, and only then the status decides the exit code.
    assert "|| rc=$$?" in script and "rc=0;" in script
    assert script.index("|| rc=$$?") < script.index("-m fast -w stop") < script.index('test "$$rc" -eq 0')
    assert script.index('test "$$rc" -eq 0') < script.index(f"echo {OK_LINE}")


def test_nothing_in_the_script_prints_server_or_client_output_to_stdout(script):
    assert script.count(">/dev/null") == 3  # pg_ctl start, psql, pg_ctl stop
    assert "-q" in script.split()


# -- documentation --------------------------------------------------------------------------------


def test_doc_describes_cause_procedure_verification_and_secrecy():
    doc = DOC.read_text(encoding="utf-8")
    for needle in (
        "compose.lab-pgreset.json",
        "compose.lab.json",
        "lab-pg-3",
        "DEMO_PG_PASSWORD",
        "environment",
        "lab_compose down",
        "lab_compose up file=compose.lab-pgreset.json",
        "lab_compose up file=compose.lab.json",
        OK_LINE,
        "complete",
        "never printed",
    ):
        assert needle in doc, needle
    assert doc.index("lab_compose up file=compose.lab-pgreset.json") < doc.index("lab_compose up file=compose.lab.json")
