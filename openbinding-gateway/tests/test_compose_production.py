"""Tests of the Docker Compose production definition (M0.9, ADR-0021).

Nothing here starts a container or reaches a database. The entrypoint tests run ``docker-entrypoint.sh`` with
``sh`` against a fake ``alembic`` that only records how it was called; later slices append their own sections.
"""

from __future__ import annotations

import os
import stat
import subprocess

import pytest

from _repo import REPO_ROOT

# --- entrypoint (S2) ---

ENTRYPOINT = REPO_ROOT / "openbinding-gateway" / "docker-entrypoint.sh"

SECRET_VARIABLES = (
    "DATABASE_URL",
    "GATEWAY_JWT_SECRET",
    "SPACE_API_KEY",
    "SPHERE_API_KEY",
    "SECRETS_FERNET_KEYS",
    "FEDERATION_SECRET_KEY",
    "BOOTSTRAP_ADMIN_PASSWORD",
)
FILE_IDS = [f"{name}_FILE" for name in SECRET_VARIABLES]

FILE_SECRET = "from-the-file-4f9c1e"
ENV_SECRET = "from-the-environment-77ab02"

# Records its arguments and the DATABASE_URL it sees, then exits with FAKE_ALEMBIC_EXIT (default 0).
FAKE_ALEMBIC = """#!/bin/sh
echo "$*" >> "$ALEMBIC_LOG"
echo "$DATABASE_URL" >> "$ALEMBIC_LOG.url"
exit "${FAKE_ALEMBIC_EXIT:-0}"
"""


class Run:
    """The result of one entrypoint run and what the fake ``alembic`` saw."""

    def __init__(self, result: subprocess.CompletedProcess[str], log) -> None:
        self.returncode = result.returncode
        self.stdout = result.stdout
        self.stderr = result.stderr
        self.alembic_calls = log.read_text().splitlines() if log.exists() else []
        url_log = log.with_name(log.name + ".url")
        self.alembic_urls = url_log.read_text().splitlines() if url_log.exists() else []

    @property
    def output(self) -> str:
        return self.stdout + self.stderr

    @property
    def environment(self) -> dict[str, str]:
        """The ``env`` output of the command, when the command was ``env``."""
        return dict(line.split("=", 1) for line in self.stdout.splitlines() if "=" in line)


@pytest.fixture
def entrypoint(tmp_path):
    """``run(env, *command)``: the entrypoint with a minimal environment and a fake ``alembic`` on PATH."""
    if not ENTRYPOINT.is_file():
        pytest.skip("docker-entrypoint.sh is not part of this checkout")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "alembic"
    fake.write_text(FAKE_ALEMBIC)
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    log = tmp_path / "alembic.log"

    def run(env: dict[str, str] | None = None, *command: str) -> Run:
        for stale in (log, log.with_name(log.name + ".url")):
            stale.unlink(missing_ok=True)
        full_env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "ALEMBIC_LOG": str(log), **(env or {})}
        result = subprocess.run(
            ["sh", str(ENTRYPOINT), *(command or ("env",))],
            env=full_env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        return Run(result, log)

    return run


@pytest.fixture
def secret_file(tmp_path):
    """``write(content, name)``: a regular file with the given content."""

    def write(content: str, name: str = "secret") -> str:
        path = tmp_path / name
        path.write_text(content)
        return str(path)

    return write


# -- OPENBINDING_MIGRATE ----------------------------------------------------------------------------------


# [utest->req~lab-deployment-migrate-on-start~2]
def test_entrypoint_auto_migrates_when_database_url_is_set(entrypoint):
    run = entrypoint({"DATABASE_URL": "postgresql://db/app"})
    assert run.returncode == 0
    assert run.alembic_calls == ["upgrade head"]
    assert "DATABASE_URL=postgresql://db/app" in run.stdout


# [utest->req~lab-deployment-migrate-on-start~2]
def test_entrypoint_auto_is_the_default_and_explicit_auto_is_the_same(entrypoint):
    default = entrypoint({"DATABASE_URL": "postgresql://db/app"})
    explicit = entrypoint({"DATABASE_URL": "postgresql://db/app", "OPENBINDING_MIGRATE": "auto"})
    assert default.returncode == explicit.returncode == 0
    assert default.alembic_calls == explicit.alembic_calls == ["upgrade head"]


# [utest->req~lab-deployment-migrate-on-start~2]
@pytest.mark.parametrize("mode", [None, "auto"])
def test_entrypoint_auto_without_database_url_starts_without_migrating(entrypoint, mode):
    run = entrypoint({} if mode is None else {"OPENBINDING_MIGRATE": mode})
    assert run.returncode == 0
    assert run.alembic_calls == []


# [utest->req~lab-deployment-migrate-on-start~2]
def test_entrypoint_skip_never_migrates(entrypoint):
    run = entrypoint({"OPENBINDING_MIGRATE": "skip", "DATABASE_URL": "postgresql://db/app"})
    assert run.returncode == 0
    assert run.alembic_calls == []
    assert "DATABASE_URL=postgresql://db/app" in run.stdout


# [utest->req~lab-deployment-migrate-on-start~2]
def test_entrypoint_only_migrates_and_exits_without_running_the_command(entrypoint):
    run = entrypoint({"OPENBINDING_MIGRATE": "only", "DATABASE_URL": "postgresql://db/app"}, "echo", "ran")
    assert run.returncode == 0
    assert run.alembic_calls == ["upgrade head"]
    assert "ran" not in run.stdout


# [utest->req~lab-deployment-migrate-on-start~2]
@pytest.mark.parametrize("database_url", [None, ""])
def test_entrypoint_only_without_database_url_exits_2(entrypoint, database_url):
    env = {"OPENBINDING_MIGRATE": "only"}
    if database_url is not None:
        env["DATABASE_URL"] = database_url
    run = entrypoint(env, "echo", "ran")
    assert run.returncode == 2
    assert run.alembic_calls == []
    assert "ran" not in run.stdout
    assert "DATABASE_URL" in run.stderr


# [utest->req~lab-deployment-migrate-on-start~2]
@pytest.mark.parametrize("mode", ["always", "AUTO", "true", " skip", "only "])
def test_entrypoint_invalid_mode_exits_2(entrypoint, mode):
    run = entrypoint({"OPENBINDING_MIGRATE": mode, "DATABASE_URL": "postgresql://db/app"}, "echo", "ran")
    assert run.returncode == 2
    assert run.alembic_calls == []
    assert "ran" not in run.stdout
    assert "OPENBINDING_MIGRATE" in run.stderr


# [utest->req~lab-deployment-migrate-on-start~2]
def test_entrypoint_a_failed_migration_stops_the_start(entrypoint):
    run = entrypoint(
        {"DATABASE_URL": "postgresql://db/app", "FAKE_ALEMBIC_EXIT": "3"},
        "echo",
        "ran",
    )
    assert run.returncode == 3
    assert "ran" not in run.stdout


# -- <NAME>_FILE ------------------------------------------------------------------------------------------


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("name", SECRET_VARIABLES, ids=FILE_IDS)
@pytest.mark.parametrize("suffix", ["", "\n", "\n\n"], ids=["no-newline", "newline", "newlines"])
def test_entrypoint_file_content_is_exported_without_trailing_newlines(entrypoint, secret_file, name, suffix):
    path = secret_file(FILE_SECRET + suffix)
    run = entrypoint({f"{name}_FILE": path, "OPENBINDING_MIGRATE": "skip"})
    assert run.returncode == 0, run.stderr
    assert run.environment[name] == FILE_SECRET


# [utest->req~lab-deployment-entrypoint-secret-files~1]
def test_entrypoint_file_keeps_inner_spaces_and_newlines(entrypoint, secret_file):
    path = secret_file("key one,key two\n")
    run = entrypoint({"SECRETS_FERNET_KEYS_FILE": path, "OPENBINDING_MIGRATE": "skip"})
    assert run.environment["SECRETS_FERNET_KEYS"] == "key one,key two"
    # An inner newline survives; only the trailing ones go (seen through the fake alembic's DATABASE_URL).
    run = entrypoint({"DATABASE_URL_FILE": secret_file("first\nsecond\n\n")})
    assert run.alembic_urls == ["first", "second"]


# [utest->req~lab-deployment-entrypoint-secret-files~1]
def test_entrypoint_database_url_file_is_read_before_the_migration(entrypoint, secret_file):
    path = secret_file("postgresql://user:pw@db/app\n")
    run = entrypoint({"DATABASE_URL_FILE": path})
    assert run.returncode == 0, run.stderr
    assert run.alembic_calls == ["upgrade head"]
    assert run.alembic_urls == ["postgresql://user:pw@db/app"]


# [utest->req~lab-deployment-entrypoint-secret-files~1]
def test_entrypoint_database_url_file_satisfies_only(entrypoint, secret_file):
    path = secret_file("postgresql://user:pw@db/app\n")
    run = entrypoint({"DATABASE_URL_FILE": path, "OPENBINDING_MIGRATE": "only"}, "echo", "ran")
    assert run.returncode == 0, run.stderr
    assert run.alembic_urls == ["postgresql://user:pw@db/app"]
    assert "ran" not in run.stdout


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("name", SECRET_VARIABLES, ids=FILE_IDS)
def test_entrypoint_empty_file_variable_counts_as_unset(entrypoint, name):
    run = entrypoint({f"{name}_FILE": "", name: ENV_SECRET, "OPENBINDING_MIGRATE": "skip"})
    assert run.returncode == 0, run.stderr
    assert run.environment[name] == ENV_SECRET


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("name", SECRET_VARIABLES, ids=FILE_IDS)
def test_entrypoint_file_and_value_together_exit_2(entrypoint, secret_file, name):
    env = {f"{name}_FILE": secret_file(FILE_SECRET), name: ENV_SECRET, "OPENBINDING_MIGRATE": "skip"}
    run = entrypoint(env, "echo", "ran")
    assert run.returncode == 2
    assert "ran" not in run.stdout
    assert name in run.stderr
    assert FILE_SECRET not in run.output
    assert ENV_SECRET not in run.output


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("name", SECRET_VARIABLES, ids=FILE_IDS)
def test_entrypoint_missing_file_exits_2(entrypoint, tmp_path, name):
    env = {f"{name}_FILE": str(tmp_path / "absent")}
    if name != "DATABASE_URL":
        env["DATABASE_URL"] = ENV_SECRET
    run = entrypoint(env, "echo", "ran")
    assert run.returncode == 2
    assert name in run.stderr
    assert run.alembic_calls == []
    assert "ran" not in run.stdout
    assert ENV_SECRET not in run.output


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("name", SECRET_VARIABLES, ids=FILE_IDS)
def test_entrypoint_directory_instead_of_file_exits_2(entrypoint, tmp_path, name):
    directory = tmp_path / "a-directory"
    directory.mkdir()
    run = entrypoint({f"{name}_FILE": str(directory)}, "echo", "ran")
    assert run.returncode == 2
    assert name in run.stderr
    assert run.alembic_calls == []
    assert "ran" not in run.stdout


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("name", SECRET_VARIABLES, ids=FILE_IDS)
def test_entrypoint_unreadable_file_exits_2(entrypoint, secret_file, name):
    path = secret_file(FILE_SECRET)
    os.chmod(path, 0)
    if os.access(path, os.R_OK):
        pytest.skip("the test user can read a file with mode 0 (running as root)")
    run = entrypoint({f"{name}_FILE": path}, "echo", "ran")
    assert run.returncode == 2
    assert name in run.stderr
    assert run.alembic_calls == []
    assert "ran" not in run.stdout
    assert FILE_SECRET not in run.output


# [utest->req~lab-deployment-entrypoint-secret-files~1]
def test_entrypoint_a_bad_file_stops_the_start_before_any_migration(entrypoint, secret_file, tmp_path):
    run = entrypoint(
        {
            "DATABASE_URL": "postgresql://db/app",
            "SPACE_API_KEY_FILE": str(tmp_path / "absent"),
            "GATEWAY_JWT_SECRET_FILE": secret_file(FILE_SECRET),
        }
    )
    assert run.returncode == 2
    assert run.alembic_calls == []
    assert FILE_SECRET not in run.output


# [utest->req~lab-deployment-entrypoint-secret-files~1]
def test_entrypoint_several_files_are_all_exported(entrypoint, secret_file):
    run = entrypoint(
        {
            "GATEWAY_JWT_SECRET_FILE": secret_file("jwt\n", "jwt"),
            "SPACE_API_KEY_FILE": secret_file("space\n", "space"),
            "OPENBINDING_MIGRATE": "skip",
        }
    )
    assert run.returncode == 0, run.stderr
    assert run.environment["GATEWAY_JWT_SECRET"] == "jwt"
    assert run.environment["SPACE_API_KEY"] == "space"


# -- exec -------------------------------------------------------------------------------------------------


# [utest->req~lab-deployment-migrate-on-start~2]
def test_entrypoint_runs_the_command_with_its_arguments_and_exit_code(entrypoint):
    run = entrypoint({}, "sh", "-c", 'echo "args:$1:$2"; exit 7', "sh", "one two", "three")
    assert run.returncode == 7
    assert "args:one two:three" in run.stdout
