"""Tests of the Docker Compose production definition (M0.9, ADR-0021).

Nothing here starts a container or reaches a database. The entrypoint tests run ``docker-entrypoint.sh`` with
``sh`` against a fake ``alembic`` that only records how it was called; later slices append their own sections.
"""

from __future__ import annotations

import copy
import functools
import ipaddress
import json
import os
import re
import stat
import subprocess
import textwrap

import pytest
import yaml

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
NEVER_PRINTED = "do-not-print-7f3a"

# Values that a shell could mangle. Each one is written to a file and read back through the entrypoint.
AWKWARD_VALUES = [
    "p$a`b\"c'd\\e*f=g%h",
    "-n",
    "-e",
    "  leading and trailing  ",
    "$(echo injected)",
    "a\\nb",
]

# Records its arguments and the DATABASE_URL it sees, then exits with FAKE_ALEMBIC_EXIT (default 0).
FAKE_ALEMBIC = """#!/bin/sh
printf '%s\\n' "$*" >> "$ALEMBIC_LOG"
printf '%s\\n' "$DATABASE_URL" >> "$ALEMBIC_LOG.url"
exit "${FAKE_ALEMBIC_EXIT:-0}"
"""


class Run:
    """The result of one entrypoint run and what the fake ``alembic`` saw."""

    def __init__(self, result: subprocess.CompletedProcess[str], log, received: dict[str, str]) -> None:
        self.received = received
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
    assert ENTRYPOINT.is_file(), "openbinding-gateway/docker-entrypoint.sh"
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
        return Run(result, log, full_env)

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
@pytest.mark.parametrize("mode", [None, "auto", ""], ids=["unset", "auto", "empty"])
@pytest.mark.parametrize("database_url", [None, ""], ids=["no-database-url", "empty-database-url"])
def test_entrypoint_auto_without_database_url_starts_without_migrating(entrypoint, mode, database_url):
    env = {} if mode is None else {"OPENBINDING_MIGRATE": mode}
    if database_url is not None:
        env["DATABASE_URL"] = database_url
    run = entrypoint(env, "sh", "-c", "echo ran; exit 5")
    assert run.returncode == 5, "the command ran and its exit status is the entrypoint's"
    assert run.stdout == "ran\n"
    assert run.alembic_calls == []


# [utest->req~lab-deployment-migrate-on-start~2]
@pytest.mark.parametrize("mode", [None, "auto", ""], ids=["unset", "auto", "empty"])
def test_entrypoint_auto_and_an_empty_mode_migrate_when_database_url_is_set(entrypoint, mode):
    env = {"DATABASE_URL": "postgresql://db/app"}
    if mode is not None:
        env["OPENBINDING_MIGRATE"] = mode
    run = entrypoint(env, "echo", "ran")
    assert run.returncode == 0
    assert run.alembic_calls == ["upgrade head"]
    assert run.stdout.endswith("ran\n")


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


# [utest->req~lab-deployment-migrate-on-start~2]
def test_entrypoint_only_exits_with_the_status_of_a_failed_migration(entrypoint):
    run = entrypoint(
        {"OPENBINDING_MIGRATE": "only", "DATABASE_URL": "postgresql://db/app", "FAKE_ALEMBIC_EXIT": "3"},
        "echo",
        "ran",
    )
    assert run.returncode == 3
    assert run.alembic_calls == ["upgrade head"]
    assert "ran" not in run.stdout


# -- <NAME>_FILE ------------------------------------------------------------------------------------------


def print_variable(name: str) -> tuple[str, ...]:
    """The command ``sh -c 'printf "%s|" "$NAME"'``: shows the exact value, trailing newline included."""
    return ("sh", "-c", f'printf "%s|" "${name}"')


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("name", SECRET_VARIABLES, ids=FILE_IDS)
@pytest.mark.parametrize("suffix", ["", "\n", "\n\n"], ids=["no-newline", "newline", "newlines"])
def test_entrypoint_file_content_is_exported_without_trailing_newlines(entrypoint, secret_file, name, suffix):
    path = secret_file(FILE_SECRET + suffix)
    run = entrypoint({f"{name}_FILE": path, "OPENBINDING_MIGRATE": "skip"}, *print_variable(name))
    assert run.returncode == 0, run.stderr
    assert run.stdout == FILE_SECRET + "|"


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("value", AWKWARD_VALUES, ids=["metacharacters", "dash-n", "dash-e", "spaces", "substitution", "backslash-n"])
@pytest.mark.parametrize("suffix", ["", "\n"], ids=["no-newline", "newline"])
def test_entrypoint_file_values_with_shell_metacharacters_are_read_back_verbatim(
    entrypoint, secret_file, value, suffix
):
    path = secret_file(value + suffix)
    run = entrypoint({"SPACE_API_KEY_FILE": path, "OPENBINDING_MIGRATE": "skip"}, *print_variable("SPACE_API_KEY"))
    assert run.returncode == 0, run.stderr
    assert run.stdout == value + "|"
    assert run.stderr == ""


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("value", AWKWARD_VALUES, ids=["metacharacters", "dash-n", "dash-e", "spaces", "substitution", "backslash-n"])
def test_entrypoint_database_url_file_values_reach_alembic_verbatim(entrypoint, secret_file, value):
    run = entrypoint({"DATABASE_URL_FILE": secret_file(value + "\n")}, "true")
    assert run.returncode == 0, run.stderr
    assert run.alembic_urls == [value]


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("name", SECRET_VARIABLES, ids=FILE_IDS)
def test_entrypoint_a_successful_start_prints_no_secret_and_nothing_on_stderr(entrypoint, secret_file, name):
    path = secret_file(NEVER_PRINTED + "\n")
    run = entrypoint({f"{name}_FILE": path, "OPENBINDING_MIGRATE": "skip"}, "true")
    assert run.returncode == 0
    assert NEVER_PRINTED not in run.output
    assert run.stderr == ""


# [utest->req~lab-deployment-entrypoint-secret-files~1]
def test_entrypoint_database_url_file_in_auto_mode_prints_no_secret_and_nothing_on_stderr(entrypoint, secret_file):
    run = entrypoint({"DATABASE_URL_FILE": secret_file(NEVER_PRINTED + "\n")}, "true")
    assert run.returncode == 0
    assert run.alembic_calls == ["upgrade head"]
    assert run.alembic_urls == [NEVER_PRINTED]
    assert NEVER_PRINTED not in run.output
    assert run.stderr == ""


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("mode", [None, "auto", "skip"], ids=["unset", "auto", "skip"])
def test_entrypoint_without_file_variables_the_command_sees_the_environment_it_received(entrypoint, mode):
    env = {"EXTRA_SETTING": "kept as it is", "SPACE_URL": "https://space.example.org"}
    if mode is not None:
        env["OPENBINDING_MIGRATE"] = mode
    run = entrypoint(env, "env")
    assert run.returncode == 0, run.stderr
    # What `env` prints directly, with the same environment and no entrypoint, is the reference.
    reference = subprocess.run(
        ["sh", "-c", "exec env"], env=run.received, capture_output=True, text=True, timeout=30, check=False
    )
    noise = {"_", "PWD", "OLDPWD", "SHLVL"}
    expected = dict(line.split("=", 1) for line in reference.stdout.splitlines() if "=" in line)
    seen = {k: v for k, v in run.environment.items() if k not in noise}
    assert seen == {k: v for k, v in expected.items() if k not in noise}
    for name in SECRET_VARIABLES:
        assert name not in seen, f"{name} appeared out of nowhere"


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
def test_entrypoint_empty_value_with_a_file_variable_takes_the_file(entrypoint, secret_file, name):
    env = {f"{name}_FILE": secret_file(FILE_SECRET + "\n"), name: "", "OPENBINDING_MIGRATE": "skip"}
    run = entrypoint(env, *print_variable(name))
    assert run.returncode == 0, run.stderr
    assert run.stdout == FILE_SECRET + "|"


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("name", SECRET_VARIABLES, ids=FILE_IDS)
def test_entrypoint_file_and_value_together_exit_2(entrypoint, secret_file, name):
    # Auto mode with a database set, so that a conflict which did not stop the start would reach `alembic`.
    env = {f"{name}_FILE": secret_file(FILE_SECRET), name: ENV_SECRET}
    if name != "DATABASE_URL":
        env["DATABASE_URL"] = "postgresql://db/app"
    run = entrypoint(env, "echo", "ran")
    assert run.returncode == 2
    assert run.alembic_calls == []
    assert "ran" not in run.stdout
    assert f"{name}_FILE" in run.stderr
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
    assert f"{name}_FILE" in run.stderr
    assert run.alembic_calls == []
    assert "ran" not in run.stdout
    assert ENV_SECRET not in run.output


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("name", SECRET_VARIABLES, ids=FILE_IDS)
def test_entrypoint_directory_instead_of_file_exits_2(entrypoint, tmp_path, name):
    directory = tmp_path / "a-directory"
    directory.mkdir()
    # Auto mode with a database set (DATABASE_URL_FILE is the case under test for DATABASE_URL), so that a bad file
    # which did not stop the start would reach `alembic`.
    env = {f"{name}_FILE": str(directory)}
    if name != "DATABASE_URL":
        env["DATABASE_URL"] = "postgresql://db/app"
    run = entrypoint(env, "echo", "ran")
    assert run.returncode == 2
    assert f"{name}_FILE" in run.stderr
    assert run.alembic_calls == []
    assert "ran" not in run.stdout


# [utest->req~lab-deployment-entrypoint-secret-files~1]
@pytest.mark.parametrize("name", SECRET_VARIABLES, ids=FILE_IDS)
def test_entrypoint_unreadable_file_exits_2(entrypoint, secret_file, name):
    path = secret_file(FILE_SECRET)
    os.chmod(path, 0)
    if os.access(path, os.R_OK):
        # A root user reads a file of mode 0, so the check cannot be exercised here; it runs as a normal user.
        # The source test below keeps the check from being deleted unseen when this one is skipped.
        pytest.skip("the test user can read a file with mode 0 (running as root)")
    env = {f"{name}_FILE": path}
    if name != "DATABASE_URL":
        env["DATABASE_URL"] = "postgresql://db/app"  # auto mode: a bad file that did not stop the start would migrate
    run = entrypoint(env, "echo", "ran")
    assert run.returncode == 2
    assert f"{name}_FILE" in run.stderr
    assert run.alembic_calls == []
    assert "ran" not in run.stdout
    assert FILE_SECRET not in run.output


# [utest->req~lab-deployment-entrypoint-secret-files~1]
def test_entrypoint_source_keeps_the_readability_and_regular_file_checks():
    """Stands in for the unreadable-file test when the suite runs as root and that test is skipped."""
    code = [
        line.strip()
        for line in ENTRYPOINT.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    checks = [number for number, line in enumerate(code) if "[ ! -f" in line and "[ ! -r" in line]
    assert checks, "the entrypoint no longer checks that the secret file is a readable regular file"
    # The check refuses the start: `exit 2` is inside the same `if`, before its `fi`.
    for number in checks:
        branch = code[number + 1 : code.index("fi", number)]
        assert "exit 2" in branch, "a file that is not a readable regular file must end the start with exit 2"
    assert any(line.startswith("value=$(cat -- ") for line in code), "the file is read with cat -- (no option parsing)"


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


# --- production definition (S3) ---
#
# Each rule is a function over the parsed Compose file that returns the problems it finds. The real file is
# checked against it, and mutated copies (the negative controls) must be caught and name what is wrong.

PRODUCTION_DIR = REPO_ROOT / "deploy" / "compose" / "production"
PRODUCTION = PRODUCTION_DIR / "compose.yaml"
IMAGES_ENV = PRODUCTION_DIR / "images.env"
CI_ENV = PRODUCTION_DIR / "ci.env"
LAB_COMPOSE = REPO_ROOT / "compose.lab.json"
RUNBOOK = REPO_ROOT / "docs" / "runbooks" / "production.md"

ENGINES = (
    "engine-minizinc",
    "engine-random-search",
    "engine-many-heuristic",
    "engine-evolutionary-heuristics",
)
EXPECTED_SERVICES = frozenset(
    {"postgres", "redis", "migrate", "gateway", "worker", "analysis-worker", "frontend-assets", "nginx", "pg-backup"}
    | set(ENGINES)
)
EXPECTED_VOLUMES = frozenset({"pgdata", "redisdata", "artifacts", "frontend_dist"})
PROJECT_NETWORK = "openbinding"

THIRD_PARTY_IMAGES = frozenset({"POSTGRES_IMAGE", "REDIS_IMAGE"})
IMAGE_VARIABLES = frozenset(
    THIRD_PARTY_IMAGES
    | {
        "GATEWAY_IMAGE",
        "ENGINE_MINIZINC_IMAGE",
        "ENGINE_RANDOM_SEARCH_IMAGE",
        "ENGINE_MANY_HEURISTIC_IMAGE",
        "ENGINE_EVOLUTIONARY_HEURISTICS_IMAGE",
        "FRONTEND_ASSETS_IMAGE",
        "NGINX_IMAGE",
    }
)
# The image variable each service takes its image from.
EXPECTED_IMAGE_VARIABLE = {
    "postgres": "POSTGRES_IMAGE",
    "redis": "REDIS_IMAGE",
    "migrate": "GATEWAY_IMAGE",
    "gateway": "GATEWAY_IMAGE",
    "worker": "GATEWAY_IMAGE",
    "analysis-worker": "GATEWAY_IMAGE",
    "engine-minizinc": "ENGINE_MINIZINC_IMAGE",
    "engine-random-search": "ENGINE_RANDOM_SEARCH_IMAGE",
    "engine-many-heuristic": "ENGINE_MANY_HEURISTIC_IMAGE",
    "engine-evolutionary-heuristics": "ENGINE_EVOLUTIONARY_HEURISTICS_IMAGE",
    "frontend-assets": "FRONTEND_ASSETS_IMAGE",
    "nginx": "NGINX_IMAGE",
    "pg-backup": "POSTGRES_IMAGE",
}
SITE_VARIABLES = (
    "PUBLIC_ORIGIN",
    "OPENBINDING_SECRETS_DIR",
    "OPENBINDING_BACKUP_DIR",
    "BACKUP_RETENTION_DAYS",
    "NGINX_SSL_DIR",
    "SPACE_URL",
)

SECRET_NAMES = (
    "postgres_password",
    "database_url",
    "gateway_jwt_secret",
    "space_api_key",
    "sphere_api_key",
    "secrets_fernet_keys",
    "bootstrap_admin_password",
)
WORKER_SECRETS = ("database_url", "space_api_key", "sphere_api_key", "secrets_fernet_keys")
EXPECTED_SECRETS = {
    "postgres": {"postgres_password"},
    "migrate": {"database_url"},
    "gateway": {
        "database_url",
        "gateway_jwt_secret",
        "space_api_key",
        "sphere_api_key",
        "secrets_fernet_keys",
        "bootstrap_admin_password",
    },
    "worker": set(WORKER_SECRETS),
    "analysis-worker": set(WORKER_SECRETS),
    "pg-backup": {"postgres_password"},
}
WORKER_ENTRYPOINT = ["/usr/local/bin/docker-entrypoint.sh"]
WORKER_ENVIRONMENT = {
    "OPENBINDING_MIGRATE": "skip",
    "DATABASE_URL_FILE": "/run/secrets/database_url",
    "SPACE_API_KEY_FILE": "/run/secrets/space_api_key",
    "SPHERE_API_KEY_FILE": "/run/secrets/sphere_api_key",
    "SECRETS_FERNET_KEYS_FILE": "/run/secrets/secrets_fernet_keys",
}
# What each service's environment must contain, value for value.
REQUIRED_ENVIRONMENT = {
    "postgres": {"POSTGRES_PASSWORD_FILE": "/run/secrets/postgres_password"},
    "migrate": {"OPENBINDING_MIGRATE": "only", "DATABASE_URL_FILE": "/run/secrets/database_url"},
    "gateway": {
        "APP_ENV": "prod",
        "OPENBINDING_MIGRATE": "skip",
        "BIM_MODE": "inproc",
        "SPACE_ENABLED": "true",
        "DATABASE_URL_FILE": "/run/secrets/database_url",
        "GATEWAY_JWT_SECRET_FILE": "/run/secrets/gateway_jwt_secret",
        "SPACE_API_KEY_FILE": "/run/secrets/space_api_key",
        "SPHERE_API_KEY_FILE": "/run/secrets/sphere_api_key",
        "SECRETS_FERNET_KEYS_FILE": "/run/secrets/secrets_fernet_keys",
        "BOOTSTRAP_ADMIN_PASSWORD_FILE": "/run/secrets/bootstrap_admin_password",
    },
    "worker": WORKER_ENVIRONMENT,
    "analysis-worker": WORKER_ENVIRONMENT,
}
# depends_on of each service: dependency -> condition.
HEALTHY = "service_healthy"
EXPECTED_DEPENDS_ON = {
    "migrate": {"postgres": HEALTHY},
    "gateway": {
        "migrate": "service_completed_successfully",
        "postgres": HEALTHY,
        "redis": HEALTHY,
        **{engine: HEALTHY for engine in ENGINES},
    },
    "worker": {"gateway": HEALTHY, "redis": HEALTHY},
    "analysis-worker": {"gateway": HEALTHY, "redis": HEALTHY},
    "nginx": {"gateway": HEALTHY, "frontend-assets": HEALTHY},
    "pg-backup": {"postgres": HEALTHY},
}
# Services that must be restarted when the gateway is recreated (nginx.conf resolves `gateway` once). The workers
# have no gateway address, so they only wait for it to be healthy.
EXPECTED_RESTART_ON_DEPENDENCY = {
    "nginx": {"gateway"},
}
LAB_SERVICE = {"analysis-worker": "worker"}
# Settings.app_env when APP_ENV is not set (openbinding_gateway/core/settings.py).
APP_ENV_DEFAULT = "dev"

# Environment names that carry a secret: they may only be <NAME>_FILE variables.
SECRET_ENVIRONMENT_NAME = re.compile(r"PASSWORD|SECRET|TOKEN|API_KEY|FERNET|DATABASE_URL|PRIVATE_KEY|CREDENTIAL")
IMAGE_REFERENCE = re.compile(r"\$\{([A-Z][A-Z0-9_]*_IMAGE):\?[^}]+\}")
PINNED_IMAGE = re.compile(r"[a-z0-9][a-z0-9./_-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*@sha256:[0-9a-f]{64}")
GAP_IMAGE = re.compile(r"gap\.invalid/[a-z0-9][a-z0-9./_-]*:0\.0\.0@sha256:0{64}")
REQUIRED_VARIABLE = re.compile(r"\$\{([A-Z][A-Z0-9_]*):\?")
URL_PASSWORD = re.compile(r"://[^/\s:@]+:[^/\s@]+@")
TOKEN_SHAPE = re.compile(r"[A-Za-z0-9_+\-]{32,}={0,2}")
MEMORY = re.compile(r"(\d+)([mg])")
LOGGING = {"driver": "json-file", "options": {"max-size": "10m", "max-file": "5"}}
CI_VALUES = {
    "PUBLIC_ORIGIN": r"https://[a-z0-9.-]*example\.(org|com|net)",
    "SPACE_URL": r"https://[a-z0-9.-]*example\.(org|com|net)",
    "OPENBINDING_SECRETS_DIR": r"/srv/openbinding/[a-z/]+",
    "OPENBINDING_BACKUP_DIR": r"/srv/openbinding/[a-z/]+",
    "NGINX_SSL_DIR": r"/srv/openbinding/[a-z/]+",
    "BACKUP_RETENTION_DAYS": r"[1-9][0-9]*",
}


@functools.cache
def _parse_yaml(path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def production():
    """A private copy of the parsed production file, ready to be mutated."""
    assert PRODUCTION.is_file(), "deploy/compose/production/compose.yaml"
    return copy.deepcopy(_parse_yaml(PRODUCTION))


def production_text() -> str:
    assert PRODUCTION.is_file(), "deploy/compose/production/compose.yaml"
    return PRODUCTION.read_text(encoding="utf-8")


def parse_env_file(text: str) -> tuple[dict[str, str], list[str]]:
    values: dict[str, str] = {}
    problems: list[str] = []
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(\S*)", stripped)
        if not match:
            problems.append(f"line {number}: not NAME=value")
        elif match[1] in values:
            problems.append(f"line {number}: {match[1]} is defined twice")
        else:
            values[match[1]] = match[2]
    return values, problems


def images_env() -> dict[str, str]:
    assert IMAGES_ENV.is_file(), "deploy/compose/production/images.env"
    values, problems = parse_env_file(IMAGES_ENV.read_text(encoding="utf-8"))
    assert not problems, problems
    return values


def _services(config: dict) -> dict[str, dict]:
    return {name: service or {} for name, service in (config.get("services") or {}).items()}


def _environment(service: dict) -> dict[str, str]:
    env = service.get("environment") or {}
    if isinstance(env, dict):
        return {str(k): "" if v is None else str(v) for k, v in env.items()}
    return {
        str(item).split("=", 1)[0]: str(item).split("=", 1)[1] if "=" in str(item) else "" for item in env
    }


def _as_list(value) -> list:
    if value is None:
        return []
    return list(value) if isinstance(value, (list, tuple)) else [value]


def _secret_sources(service: dict) -> set[str]:
    return {str(s["source"] if isinstance(s, dict) else s) for s in _as_list(service.get("secrets"))}


def _mib(value) -> int:
    match = MEMORY.fullmatch(str(value))
    if not match:
        raise AssertionError(f"mem_limit {value!r} is not <n>m or <n>g")
    return int(match[1]) * (1024 if match[2] == "g" else 1)


# -- mutations (negative controls) -------------------------------------------------------------------------

_DELETE = object()


def edit(*path, value=_DELETE):
    """A mutation: set, add or (without ``value``) delete the item at ``path`` of the config."""

    def apply(config: dict) -> None:
        node = _walk(config, path[:-1])
        if value is _DELETE:
            assert path[-1] in node, f"mutation path {path} does not exist in compose.yaml: the control is stale"
            del node[path[-1]]
        else:
            node[path[-1]] = value

    return apply


def _walk(config: dict, path) -> dict:
    node = config
    for number, key in enumerate(path):
        assert isinstance(node, (dict, list)) and (key in node if isinstance(node, dict) else True), (
            f"mutation path {path}: {key!r} (step {number + 1}) does not exist in compose.yaml: the control is stale"
        )
        node = node[key]
    return node


def append(*path, item):
    def apply(config: dict) -> None:
        node = _walk(config, path)
        assert isinstance(node, list), f"mutation path {path} is not a list"
        node.append(item)

    return apply


def assert_caught(rule, mutation, fragment: str) -> None:
    """The mutated production file breaks ``rule``, and the problem names ``fragment``."""
    config = production()
    mutation(config)
    problems = rule(config)
    assert problems, f"the rule accepted a file that should break it ({fragment})"
    assert fragment in " | ".join(problems), problems


# -- project: standalone, exact services (production-network) ---------------------------------------------


def project_problems(config: dict) -> list[str]:
    problems = []
    if config.get("name") != "openbinding-production":
        problems.append(f"name is {config.get('name')!r}, not openbinding-production")
    services = _services(config)
    for name in sorted(set(services) - EXPECTED_SERVICES):
        problems.append(f"unexpected service {name}")
    for name in sorted(EXPECTED_SERVICES - set(services)):
        problems.append(f"missing service {name}")
    for name, service in services.items():
        for key in ("build", "extends", "profiles", "env_file"):
            if key in service:
                problems.append(f"{name}: uses {key}")
    for key in ("include", "extends"):
        if key in config:
            problems.append(f"top-level {key}")
    return problems


# [utest->req~lab-deployment-production-network~1]
def test_production_file_exists():
    assert PRODUCTION.is_file(), "deploy/compose/production/compose.yaml"


# [utest->req~lab-deployment-production-network~1]
def test_production_is_a_standalone_project_with_the_exact_service_set():
    config = production()
    assert not project_problems(config)
    assert len(config["services"]) == 13


# [utest->req~lab-deployment-production-network~1]
@pytest.mark.parametrize(
    ("mutation", "fragment"),
    [
        (edit("name", value="openbinding"), "name is"),
        (edit("services", "engine-minizinc"), "missing service engine-minizinc"),
        (edit("services", "space-api", value={"image": "x"}), "unexpected service space-api"),
        (edit("services", "gateway", "build", value={"context": "."}), "gateway: uses build"),
        (edit("services", "redis", "profiles", value=["prod"]), "redis: uses profiles"),
        (edit("services", "nginx", "extends", value={"service": "x"}), "nginx: uses extends"),
        (edit("services", "gateway", "env_file", value=[".env"]), "gateway: uses env_file"),
        (edit("include", value=["../../../docker-compose.yml"]), "top-level include"),
    ],
    ids=["name", "missing-service", "extra-service", "build", "profiles", "extends", "env-file", "include"],
)
def test_production_project_rule_detects(mutation, fragment):
    assert_caught(project_problems, mutation, fragment)


# -- images pinned by digest (production-pinned-images) ---------------------------------------------------


def image_problems(config: dict, images: dict[str, str]) -> list[str]:
    problems = []
    used = set()
    for name, service in _services(config).items():
        if "build" in service:
            problems.append(f"{name}: has a build key")
        match = IMAGE_REFERENCE.fullmatch(str(service.get("image", "")))
        if not match:
            problems.append(f"{name}: image is not a required ${{..._IMAGE:?}} reference")
            continue
        used.add(match[1])
        if match[1] not in images:
            problems.append(f"{name}: {match[1]} is not defined in images.env")
        if name in EXPECTED_IMAGE_VARIABLE and match[1] != EXPECTED_IMAGE_VARIABLE[name]:
            problems.append(f"{name}: image comes from {match[1]}, not {EXPECTED_IMAGE_VARIABLE[name]}")
    for variable, value in images.items():
        if not variable.endswith("_IMAGE"):
            problems.append(f"{variable}: not an _IMAGE variable")
        elif not PINNED_IMAGE.fullmatch(value):
            problems.append(f"{variable}: {value!r} is not name:tag@sha256:<64 hex>")
        elif not value.startswith("gap.invalid/") and len(set(value.rsplit("@sha256:", 1)[1])) == 1:
            problems.append(f"{variable}: the digest is one repeated character, not a published digest")
        elif value.startswith("gap.invalid/"):
            if variable in THIRD_PARTY_IMAGES:
                problems.append(f"{variable}: a third-party image carries its published digest, not a marker")
            elif not GAP_IMAGE.fullmatch(value):
                problems.append(f"{variable}: {value!r} is not a gap.invalid marker with 64 zeros")
        elif variable not in IMAGE_VARIABLES:
            problems.append(f"{variable}: unknown image variable")
    for variable in sorted(set(images) - used):
        problems.append(f"{variable}: defined in images.env and used by no service")
    for variable in sorted(IMAGE_VARIABLES - set(images)):
        problems.append(f"{variable}: missing from images.env")
    return problems


def _images_with(**changes: str) -> dict[str, str]:
    return {**images_env(), **changes}


# [utest->req~lab-deployment-production-pinned-images~1]
def test_production_every_image_is_a_pinned_required_variable():
    config, images = production(), images_env()
    assert not image_problems(config, images)
    assert set(images) == IMAGE_VARIABLES
    assert set(EXPECTED_IMAGE_VARIABLE) == EXPECTED_SERVICES == set(config["services"])
    assert set(EXPECTED_IMAGE_VARIABLE.values()) == IMAGE_VARIABLES


# [utest->req~lab-deployment-production-pinned-images~1]
def test_production_third_party_images_are_pinned_and_repository_images_are_markers_or_digests():
    images = images_env()
    for variable in THIRD_PARTY_IMAGES:
        assert not images[variable].startswith("gap.invalid/"), variable
    for variable in IMAGE_VARIABLES - THIRD_PARTY_IMAGES:
        assert GAP_IMAGE.fullmatch(images[variable]) or PINNED_IMAGE.fullmatch(images[variable]), variable
    assert images["POSTGRES_IMAGE"].startswith("postgres:16-alpine@sha256:")
    assert images["REDIS_IMAGE"].startswith("redis:7.4-alpine@sha256:")


# [utest->req~lab-deployment-production-pinned-images~1]
def test_production_images_env_marks_the_unpublished_images_in_its_header():
    text = IMAGES_ENV.read_text(encoding="utf-8")
    assert text.lstrip().startswith("#")
    header = text.split("\nPOSTGRES_IMAGE=")[0]
    assert "gap.invalid" in header
    assert "before deploying" in header


# [utest->req~lab-deployment-production-pinned-images~1]
@pytest.mark.parametrize(
    ("changes", "fragment"),
    [
        ({"POSTGRES_IMAGE": "postgres:16-alpine"}, "POSTGRES_IMAGE"),
        ({"POSTGRES_IMAGE": "postgres:16-alpine@sha256:" + "a" * 63}, "POSTGRES_IMAGE"),
        ({"POSTGRES_IMAGE": "postgres:16-alpine@sha256:" + "A" * 64}, "POSTGRES_IMAGE"),
        ({"REDIS_IMAGE": "gap.invalid/redis:0.0.0@sha256:" + "0" * 64}, "REDIS_IMAGE"),
        ({"GATEWAY_IMAGE": "gap.invalid/openbinding-gateway:0.0.0@sha256:" + "0" * 63 + "1"}, "GATEWAY_IMAGE"),
        ({"GATEWAY_IMAGE": "openbinding-gateway:latest"}, "GATEWAY_IMAGE"),
        ({"EXTRA_IMAGE": "x:1@sha256:" + "a" * 64}, "EXTRA_IMAGE"),
        ({"POSTGRES_IMAGE": "postgres:16-alpine@sha256:" + "a" * 64}, "one repeated character"),
        ({"REDIS_IMAGE": "redis:7.4-alpine@sha256:" + "0" * 64}, "one repeated character"),
        ({"NGINX_IMAGE": "nginx:1.27@sha256:" + "f" * 64}, "one repeated character"),
    ],
    ids=[
        "tag-only",
        "short-digest",
        "uppercase-digest",
        "third-party-marker",
        "marker-not-zeros",
        "no-digest",
        "unused",
        "third-party-repeated-digest",
        "third-party-zero-digest",
        "repository-image-repeated-digest",
    ],
)
def test_production_image_rule_detects_bad_images_env(changes, fragment):
    problems = image_problems(production(), _images_with(**changes))
    assert problems
    assert fragment in " | ".join(problems)


# [utest->req~lab-deployment-production-pinned-images~1]
@pytest.mark.parametrize(
    ("mutation", "fragment"),
    [
        (edit("services", "redis", "image", value="redis:7.4-alpine"), "redis"),
        (edit("services", "gateway", "build", value={"context": "."}), "gateway: has a build key"),
        (edit("services", "nginx", "image", value="${NGINX_IMAGE}"), "nginx"),
        (edit("services", "nginx", "image", value="${NGINX_IMAGE:-nginx:1.27.3}"), "nginx"),
        (edit("services", "worker", "image", value="${UNKNOWN_IMAGE:?set it}"), "UNKNOWN_IMAGE"),
        (
            edit("services", "engine-minizinc", "image", value="${ENGINE_RANDOM_SEARCH_IMAGE:?set it}"),
            "engine-minizinc: image comes from ENGINE_RANDOM_SEARCH_IMAGE",
        ),
        (
            edit("services", "gateway", "image", value="${NGINX_IMAGE:?set it}"),
            "gateway: image comes from NGINX_IMAGE",
        ),
        (
            edit("services", "pg-backup", "image", value="${REDIS_IMAGE:?set it}"),
            "pg-backup: image comes from REDIS_IMAGE",
        ),
    ],
    ids=[
        "literal-image",
        "build",
        "no-required-marker",
        "default-image",
        "undefined-variable",
        "engine-swapped",
        "gateway-on-nginx-image",
        "backup-on-redis-image",
    ],
)
def test_production_image_rule_detects_bad_compose(mutation, fragment):
    assert_caught(lambda config: image_problems(config, images_env()), mutation, fragment)


# [utest->req~lab-deployment-production-pinned-images~1]
def test_production_image_rule_accepts_the_marker_of_the_scenario():
    marker = "gap.invalid/openbinding-gateway:0.0.0@sha256:" + "0" * 64
    assert not image_problems(production(), _images_with(GATEWAY_IMAGE=marker))


# -- secrets as files (production-secret-files) -----------------------------------------------------------


def secret_problems(config: dict) -> list[str]:
    problems = []
    declared = config.get("secrets") or {}
    if set(declared) != set(SECRET_NAMES):
        problems.append(f"top-level secrets are {sorted(declared)}, not {sorted(SECRET_NAMES)}")
    for name, definition in declared.items():
        source = str((definition or {}).get("file", ""))
        expected = rf"\$\{{OPENBINDING_SECRETS_DIR:\?[^}}]+\}}/{re.escape(name)}"
        if set(definition or {}) != {"file"} or not re.fullmatch(expected, source):
            problems.append(f"secret {name}: file {source!r} is not under ${{OPENBINDING_SECRETS_DIR:?}}")
    for name, service in _services(config).items():
        if "env_file" in service:
            problems.append(f"{name}: env_file")
        used = _secret_sources(service)
        if used - set(declared):
            problems.append(f"{name}: uses undeclared secrets {sorted(used - set(declared))}")
        if name != "gateway" and "gateway_jwt_secret" in used:
            problems.append(f"{name}: mounts gateway_jwt_secret, which only gateway may")
        wanted = EXPECTED_SECRETS.get(name, set())
        if used != wanted:
            problems.append(f"{name}: secrets are {sorted(used)}, not {sorted(wanted)}")
        env = _environment(service)
        for key, value in env.items():
            if SECRET_ENVIRONMENT_NAME.search(key):
                file_name = re.fullmatch(r"/run/secrets/([a-z_]+)", value)
                if not key.endswith("_FILE"):
                    problems.append(f"{name}: {key} holds a secret; use {key}_FILE=/run/secrets/<name>")
                elif not file_name or file_name[1] not in used:
                    problems.append(f"{name}: {key}={value!r} is not a mounted secret file")
            if URL_PASSWORD.search(value):
                problems.append(f"{name}: {key} has a password inside a URL")
            if not value.startswith("/") and TOKEN_SHAPE.fullmatch(value):
                problems.append(f"{name}: {key} looks like a literal secret")
        for key, value in REQUIRED_ENVIRONMENT.get(name, {}).items():
            if env.get(key) != value:
                problems.append(f"{name}: {key} must be {value!r}, not {env.get(key)!r}")
        # A service that sets APP_ENV sets prod. One that does not set it gets the real default of the gateway
        # settings (dev), which is why the gateway, the one service that validates the environment, must set it.
        if "APP_ENV" in env and env["APP_ENV"] != "prod":
            problems.append(f"{name}: APP_ENV is {env['APP_ENV']!r}, not prod")
        if name == "gateway" and env.get("APP_ENV", APP_ENV_DEFAULT) != "prod":
            problems.append(f"gateway: APP_ENV is {env.get('APP_ENV', APP_ENV_DEFAULT)!r} (unset means {APP_ENV_DEFAULT!r})")
    return problems


# [utest->req~lab-deployment-production-secret-files~1]
def test_production_secrets_are_files_under_the_secrets_directory():
    config = production()
    assert not secret_problems(config)
    assert list(config["secrets"]) == list(SECRET_NAMES)


# [utest->req~lab-deployment-production-secret-files~1]
def test_production_only_the_gateway_mounts_the_jwt_secret():
    holders = [n for n, s in _services(production()).items() if "gateway_jwt_secret" in _secret_sources(s)]
    assert holders == ["gateway"]


# [utest->req~lab-deployment-production-secret-files~1]
def test_production_has_no_literal_secret_shape_in_the_files():
    text = production_text()
    assert "-----BEGIN" not in text
    assert not URL_PASSWORD.search(text)
    # No secret variable is read from the host environment: every ${...} that is not required is a site setting.
    for variable in re.findall(r"\$\{([A-Z][A-Z0-9_]*)", text):
        assert variable == "OPENBINDING_SECRETS_DIR" or not SECRET_ENVIRONMENT_NAME.search(variable), variable


# [utest->req~lab-deployment-production-secret-files~1]
@pytest.mark.parametrize(
    ("mutation", "fragment"),
    [
        (
            edit("services", "gateway", "environment", "GATEWAY_JWT_SECRET", value="${GATEWAY_JWT_SECRET:?}"),
            "gateway: GATEWAY_JWT_SECRET",
        ),
        (edit("services", "postgres", "environment", "POSTGRES_PASSWORD", value="openbinding"), "postgres: POSTGRES_PASSWORD"),
        (
            edit(
                "services",
                "worker",
                "environment",
                "DATABASE_URL",
                value="postgresql+asyncpg://openbinding:openbinding@postgres:5432/openbinding",
            ),
            "worker: DATABASE_URL",
        ),
        (
            edit("services", "worker", "environment", "SPACE_API_KEY_FILE", value="/run/secrets/space_api_key_old"),
            "worker: SPACE_API_KEY_FILE",
        ),
        (
            edit("services", "gateway", "environment", "SECRETS_FERNET_KEYS_FILE", value="x" * 44),
            "gateway: SECRETS_FERNET_KEYS_FILE",
        ),
        (
            edit("secrets", "database_url", "file", value="./secrets/database_url"),
            "secret database_url",
        ),
        (
            edit("secrets", "space_api_key", "file", value="${OPENBINDING_SECRETS_DIR}/space_api_key"),
            "secret space_api_key",
        ),
        (edit("secrets", "sphere_api_key"), "top-level secrets"),
        (append("services", "worker", "secrets", item="gateway_jwt_secret"), "worker: mounts gateway_jwt_secret"),
        (append("services", "pg-backup", "secrets", item="database_url"), "pg-backup: secrets are"),
        (edit("services", "gateway", "secrets", value=["database_url"]), "gateway: secrets are"),
        (edit("services", "gateway", "env_file", value=[".env"]), "gateway: env_file"),
        (edit("services", "gateway", "environment", "APP_ENV", value="dev"), "gateway: APP_ENV"),
        (edit("services", "gateway", "environment", "APP_ENV"), "gateway: APP_ENV"),
        (edit("services", "analysis-worker", "environment", "DATABASE_URL_FILE"), "analysis-worker: DATABASE_URL_FILE"),
        (edit("services", "worker", "environment", "OPENBINDING_MIGRATE", value="auto"), "worker: OPENBINDING_MIGRATE"),
        (edit("services", "worker", "environment", "APP_ENV", value="dev"), "worker: APP_ENV is 'dev'"),
        (edit("services", "gateway", "environment", "APP_ENV"), "gateway: APP_ENV is 'dev' (unset means 'dev')"),
        (
            edit("services", "gateway", "environment", "SPACE_URL", value="https://user:pw@space.example.org"),
            "gateway: SPACE_URL has a password inside a URL",
        ),
        (
            edit("services", "gateway", "environment", "SPACE_DEFAULT_PLAN", value="a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0"),
            "gateway: SPACE_DEFAULT_PLAN looks like a literal secret",
        ),
    ],
    ids=[
        "jwt-in-environment",
        "postgres-password-literal",
        "password-in-url",
        "file-not-mounted",
        "literal-fernet-key",
        "secret-outside-directory",
        "secret-without-required-marker",
        "secret-missing",
        "jwt-on-worker",
        "extra-secret",
        "missing-secret",
        "env-file",
        "app-env-dev",
        "app-env-absent",
        "required-file-variable-absent",
        "worker-migrates",
        "worker-app-env-dev",
        "gateway-app-env-defaults-to-dev",
        "password-in-url-under-a-plain-name",
        "token-under-a-plain-name",
    ],
)
def test_production_secret_rule_detects(mutation, fragment):
    assert_caught(secret_problems, mutation, fragment)


# [utest->req~lab-deployment-production-secret-files~1]
def test_production_app_env_default_is_the_one_of_the_gateway_settings():
    """The rule above treats an unset APP_ENV as the settings do; this keeps that assumption true."""
    source = (REPO_ROOT / "openbinding-gateway" / "src" / "openbinding_gateway" / "core" / "settings.py").read_text(
        encoding="utf-8"
    )
    match = re.search(r'^\s*app_env: Literal\[[^\]]*\] = "(\w+)"', source, re.MULTILINE)
    assert match, "core/settings.py no longer declares app_env as a Literal with a default"
    assert match[1] == APP_ENV_DEFAULT
    env = _environment(production()["services"]["gateway"])
    assert env["APP_ENV"] == "prod"
    assert "APP_ENV" not in _environment(production()["services"]["worker"])


# -- health, restart and start order (production-health-restart) ------------------------------------------


def health_problems(config: dict) -> list[str]:
    problems = []
    services = _services(config)
    for name, service in services.items():
        if name == "migrate":
            if service.get("restart") != "no":
                problems.append(f"migrate: restart is {service.get('restart')!r}, not 'no'")
            if service.get("image") != services.get("gateway", {}).get("image"):
                problems.append("migrate: not the gateway image")
            if _environment(service).get("OPENBINDING_MIGRATE") != "only":
                problems.append("migrate: OPENBINDING_MIGRATE is not only")
        else:
            if service.get("restart") != "unless-stopped":
                problems.append(f"{name}: restart is {service.get('restart')!r}, not unless-stopped")
            check = service.get("healthcheck")
            test = _as_list(check.get("test")) if isinstance(check, dict) else []
            if not test or str(test[0]) == "NONE" or (isinstance(check, dict) and check.get("disable")):
                problems.append(f"{name}: no active healthcheck")
            elif not all(key in check for key in ("interval", "timeout", "retries")):
                problems.append(f"{name}: healthcheck lacks interval, timeout or retries")
        depends = {
            dep: (spec or {}).get("condition") if isinstance(spec, dict) else None
            for dep, spec in (service.get("depends_on") or {}).items()
        }
        if depends != EXPECTED_DEPENDS_ON.get(name, {}):
            problems.append(f"{name}: depends_on is {depends}, not {EXPECTED_DEPENDS_ON.get(name, {})}")
        for dep, condition in depends.items():
            if condition == HEALTHY and not (services.get(dep) or {}).get("healthcheck"):
                problems.append(f"{name}: waits for {dep}, which has no healthcheck")
        restarting = {
            dep
            for dep, spec in (service.get("depends_on") or {}).items()
            if isinstance(spec, dict) and spec.get("restart") is True
        }
        expected_restarting = EXPECTED_RESTART_ON_DEPENDENCY.get(name, set())
        if restarting != expected_restarting:
            problems.append(
                f"{name}: depends_on with restart: true is {sorted(restarting)}, not {sorted(expected_restarting)}"
            )
    for name in ("worker", "analysis-worker"):
        if services.get(name, {}).get("entrypoint") != WORKER_ENTRYPOINT:
            problems.append(f"{name}: entrypoint is not the image entrypoint script")
    gateway = services.get("gateway", {})
    if "entrypoint" in gateway or "command" in gateway:
        problems.append("gateway: overrides the image entrypoint or command")
    return problems


# [utest->req~lab-deployment-production-health-restart~1]
def test_production_health_restart_and_start_order():
    config = production()
    assert not health_problems(config)
    services = config["services"]
    assert services["migrate"]["restart"] == "no"
    assert services["gateway"]["depends_on"]["migrate"] == {"condition": "service_completed_successfully"}
    assert "healthcheck" not in services["migrate"]


# [utest->req~lab-deployment-production-health-restart~1]
@pytest.mark.parametrize(
    ("mutation", "fragment"),
    [
        (edit("services", "redis", "healthcheck"), "redis: no active healthcheck"),
        (edit("services", "redis", "healthcheck", "test", value=["NONE"]), "redis: no active healthcheck"),
        (edit("services", "redis", "healthcheck", "disable", value=True), "redis: no active healthcheck"),
        (edit("services", "redis", "healthcheck", "retries"), "redis: healthcheck lacks"),
        (edit("services", "worker", "restart", value="always"), "worker: restart"),
        (edit("services", "worker", "restart"), "worker: restart"),
        (edit("services", "nginx", "restart", value="no"), "nginx: restart"),
        (
            edit("services", "gateway", "depends_on", "migrate", "condition", value="service_started"),
            "gateway: depends_on",
        ),
        (edit("services", "gateway", "depends_on", "migrate"), "gateway: depends_on"),
        (edit("services", "gateway", "depends_on", "engine-minizinc"), "gateway: depends_on"),
        (edit("services", "migrate", "environment", "OPENBINDING_MIGRATE", value="auto"), "migrate: OPENBINDING_MIGRATE"),
        (edit("services", "migrate", "restart", value="unless-stopped"), "migrate: restart"),
        (edit("services", "migrate", "image", value="${REDIS_IMAGE:?set it}"), "migrate: not the gateway image"),
        (edit("services", "worker", "entrypoint"), "worker: entrypoint"),
        (edit("services", "gateway", "entrypoint", value=[]), "gateway: overrides"),
        (edit("services", "nginx", "depends_on", "frontend-assets", "condition", value="service_started"), "nginx: depends_on"),
        (edit("services", "pg-backup", "depends_on"), "pg-backup: depends_on"),
        (edit("services", "nginx", "depends_on", "gateway", "restart"), "nginx: depends_on with restart: true"),
        (edit("services", "nginx", "depends_on", "gateway", "restart", value=False), "nginx: depends_on with restart"),
        (
            edit("services", "worker", "depends_on", "gateway", "restart", value=True),
            "worker: depends_on with restart: true is ['gateway'], not []",
        ),
        (
            edit("services", "analysis-worker", "depends_on", "gateway", "restart", value=True),
            "analysis-worker: depends_on with restart: true",
        ),
        (edit("services", "gateway", "depends_on", "redis", "restart", value=True), "gateway: depends_on with restart"),
    ],
    ids=[
        "no-healthcheck",
        "healthcheck-none",
        "healthcheck-disabled",
        "healthcheck-without-retries",
        "restart-always",
        "no-restart",
        "restart-no",
        "gateway-started-not-completed",
        "gateway-without-migrate",
        "gateway-without-engine",
        "migrate-auto",
        "migrate-restarts",
        "migrate-other-image",
        "worker-bypasses-entrypoint",
        "gateway-overrides-entrypoint",
        "nginx-started-not-healthy",
        "backup-without-postgres",
        "nginx-does-not-follow-the-gateway",
        "nginx-restart-false",
        "worker-restarts-with-the-gateway",
        "analysis-worker-restarts-with-the-gateway",
        "gateway-follows-redis",
    ],
)
def test_production_health_rule_detects(mutation, fragment):
    assert_caught(health_problems, mutation, fragment)


# [utest->req~lab-deployment-production-health-restart~1]
def test_production_only_nginx_restarts_with_the_gateway_and_the_workers_wait_for_it():
    services = production()["services"]
    assert services["nginx"]["depends_on"]["gateway"] == {"condition": HEALTHY, "restart": True}
    for name in ("worker", "analysis-worker"):
        assert services[name]["depends_on"]["gateway"] == {"condition": HEALTHY}, name


# [utest->req~lab-deployment-production-health-restart~1]
def test_production_postgres_is_healthy_only_when_the_final_server_answers_over_tcp():
    test = production()["services"]["postgres"]["healthcheck"]["test"]
    command = test[-1] if test[0] == "CMD-SHELL" else " ".join(test[1:])
    assert re.search(r"\bpg_isready\b.* -h 127\.0\.0\.1\b", command), "the temporary init server answers on the socket"
    assert "-U openbinding" in command
    assert "-d openbinding" in command


# [utest->req~lab-deployment-production-health-restart~1]
def test_production_long_lived_shell_services_have_an_init_process():
    services = production()["services"]
    for name in ("pg-backup", "frontend-assets"):
        assert services[name].get("init") is True, f"{name}: PID 1 is a shell, it needs init: true to reap and forward signals"


# -- limits, logging, hardening (production-limits-logs) --------------------------------------------------


def limit_problems(config: dict, lab: dict[str, dict]) -> list[str]:
    problems = []
    top_logging = (config.get("x-logging") or {})
    if top_logging != LOGGING:
        problems.append(f"x-logging is {top_logging}")
    for name, service in _services(config).items():
        try:
            mib = _mib(service.get("mem_limit"))
        except AssertionError:
            problems.append(f"{name}: no valid mem_limit")
        else:
            lab_service = lab.get(LAB_SERVICE.get(name, name))
            if lab_service and mib <= _mib(lab_service["mem_limit"]):
                problems.append(f"{name}: mem_limit {service['mem_limit']} is not above the laboratory value")
        cpus = service.get("cpus")
        if isinstance(cpus, bool) or not isinstance(cpus, (int, float, str)) or float(cpus) <= 0:
            problems.append(f"{name}: cpus must be greater than 0")
        if service.get("logging") != LOGGING:
            problems.append(f"{name}: logging is not json-file with max-size 10m and max-file 5")
        if "no-new-privileges:true" not in _as_list(service.get("security_opt")):
            problems.append(f"{name}: security_opt lacks no-new-privileges:true")
    return problems


def lab_services() -> dict[str, dict]:
    assert LAB_COMPOSE.is_file(), "compose.lab.json"
    return json.loads(LAB_COMPOSE.read_text(encoding="utf-8"))["services"]


# [utest->req~lab-deployment-production-limits-logs~1]
def test_production_every_service_has_limits_logging_and_no_new_privileges():
    assert not limit_problems(production(), lab_services())


# [utest->req~lab-deployment-production-limits-logs~1]
def test_production_logging_comes_from_the_shared_anchor():
    text = production_text()
    assert text.count("logging: *logging") == len(EXPECTED_SERVICES) - 1  # analysis-worker merges worker's
    assert "x-logging: &logging" in text


# [utest->req~lab-deployment-production-limits-logs~1]
@pytest.mark.parametrize(
    ("mutation", "fragment"),
    [
        (edit("services", "engine-minizinc", "mem_limit"), "engine-minizinc: no valid mem_limit"),
        (edit("services", "engine-minizinc", "mem_limit", value="lots"), "engine-minizinc: no valid mem_limit"),
        (edit("services", "gateway", "mem_limit", value="512m"), "gateway: mem_limit"),
        (edit("services", "analysis-worker", "mem_limit", value="448m"), "analysis-worker: mem_limit"),
        (edit("services", "engine-minizinc", "cpus", value=0), "engine-minizinc: cpus"),
        (edit("services", "redis", "cpus"), "redis: cpus"),
        (edit("services", "nginx", "logging", "options", "max-size"), "nginx: logging"),
        (edit("services", "nginx", "logging", "driver", value="local"), "nginx: logging"),
        (edit("services", "postgres", "logging", "options", "max-file", value="3"), "postgres: logging"),
        (edit("services", "pg-backup", "logging"), "pg-backup: logging"),
        (edit("services", "migrate", "security_opt", value=[]), "migrate: security_opt"),
        (edit("x-logging", "options", "max-size", value="100m"), "x-logging"),
    ],
    ids=[
        "no-mem-limit",
        "bad-mem-limit",
        "below-lab-gateway",
        "below-lab-worker",
        "cpus-zero",
        "no-cpus",
        "no-max-size",
        "local-driver",
        "max-file-3",
        "no-logging",
        "no-new-privileges-missing",
        "anchor-changed",
    ],
)
def test_production_limits_rule_detects(mutation, fragment):
    assert_caught(lambda config: limit_problems(config, lab_services()), mutation, fragment)


# -- backups (production-backups) -------------------------------------------------------------------------

BACKUP_COMMAND_PARTS = {
    "a loop": r"\bwhile true\b",
    "a custom-format dump": r"pg_dump\b[^\n]* -Fc\b",
    "a partial file": r"-f \"openbinding-\$\$\{stamp\}\.dump\.partial\"",
    "a rename when complete": r"\bmv \"openbinding-\$\$\{stamp\}\.dump\.partial\" \"openbinding-\$\$\{stamp\}\.dump\"",
    "removal of stale partial files": r"find \. [^\n]*'openbinding-\*\.dump\.partial' -delete",
    "retention in minutes": (
        r"find \. [^\n]*-mmin \+\$\$\(\( \$\{BACKUP_RETENTION_DAYS:\?[^}]+\} \* 1440 \)\) -delete"
    ),
    "the password from the secret file": r'PGPASSWORD="\$\$\(cat /run/secrets/postgres_password\)"',
    "a cd into /backups before the loop": r"(?s)\bcd /backups\n.*\bwhile true\b",
    "retention of this directory only, on complete dumps only": (
        r"find \. -maxdepth 1 -name 'openbinding-\*\.dump' -mmin \+"
    ),
}


def _unescaped_dollars(text: str) -> bool:
    """True when a ``$`` is left that is neither ``$$`` nor a required ``${NAME:?...}`` variable."""
    rest = re.sub(r"\$\{[A-Z][A-Z0-9_]*:\?[^}]*\}", "", text.replace("$$", ""))
    return "$" in rest


def backup_problems(config: dict) -> list[str]:
    service = _services(config).get("pg-backup")
    if service is None:
        return ["pg-backup: missing"]
    problems = []
    script = "\n".join(str(part) for part in (*_as_list(service.get("entrypoint")), *_as_list(service.get("command"))))
    for label, pattern in BACKUP_COMMAND_PARTS.items():
        if not re.search(pattern, script):
            problems.append(f"pg-backup: the command lacks {label}")
    # A failed pg_dump must end the script before the `mv` of the .partial file: `sh -ec`, or a script that begins
    # with `set -e` (a plain `sh -c` would go on and publish a truncated dump under the final name).
    command_text = "\n".join(str(part) for part in _as_list(service.get("command")))
    if _as_list(service.get("entrypoint")) != ["sh", "-ec"] and not re.match(r"\s*set -e\b", command_text):
        problems.append(
            "pg-backup: the script stops on a failed dump only with entrypoint [sh, -ec] or a first line `set -e`"
        )
    sleeps = [int(n) for n in re.findall(r"\bsleep (\d+)\b", script)]
    if not sleeps or max(sleeps) > 86400:
        problems.append("pg-backup: the loop waits more than 86400 seconds, or does not wait")
    if "-mtime" in script or "--password" in script or script.count("PGPASSWORD=") != 1:
        problems.append("pg-backup: -mtime or a password option in the command")
    if _unescaped_dollars(script + "\n" + " ".join(str(p) for p in _as_list((service.get("healthcheck") or {}).get("test")))):
        problems.append("pg-backup: an unescaped $ (write $$ for every shell dollar)")
    mounts = [str(v) for v in _as_list(service.get("volumes"))]
    if not any(re.fullmatch(r"\$\{OPENBINDING_BACKUP_DIR:\?[^}]+\}:/backups", m) for m in mounts):
        problems.append("pg-backup: /backups is not mounted from ${OPENBINDING_BACKUP_DIR:?}")
    if _secret_sources(service) != {"postgres_password"}:
        problems.append("pg-backup: must mount only the postgres_password secret")
    if any(SECRET_ENVIRONMENT_NAME.search(key) for key in _environment(service)):
        problems.append("pg-backup: a secret-named environment variable")
    if service.get("user") != "70:70":
        problems.append("pg-backup: must run as uid 70 (the postgres user)")
    if service.get("image") != _services(config).get("postgres", {}).get("image"):
        problems.append("pg-backup: not the postgres image")
    return problems


# [utest->req~lab-deployment-production-backups~1]
def test_production_pg_backup_dumps_daily_with_retention():
    config = production()
    assert not backup_problems(config)
    script = "\n".join(config["services"]["pg-backup"]["command"])
    assert "sleep 86400" in script
    assert "-mmin" in script


# [utest->req~lab-deployment-production-backups~1]
def test_production_pg_backup_keeps_no_default_for_site_variables():
    text = production_text()
    for variable in ("OPENBINDING_BACKUP_DIR", "BACKUP_RETENTION_DAYS", "OPENBINDING_SECRETS_DIR"):
        assert f"${{{variable}:?" in text
        assert f"${{{variable}:-" not in text


# [utest->req~lab-deployment-production-backups~1]
@pytest.mark.parametrize(
    ("mutation", "fragment"),
    [
        (edit("services", "pg-backup"), "pg-backup: missing"),
        (
            edit("services", "pg-backup", "volumes", value=["${OPENBINDING_BACKUP_DIR:-./backups}:/backups"]),
            "pg-backup: /backups",
        ),
        (edit("services", "pg-backup", "volumes", value=["backups:/backups"]), "pg-backup: /backups"),
        (
            edit("services", "pg-backup", "command", value=["while true; do pg_dump -Fc x; sleep 86400; done"]),
            "pg-backup: the command lacks",
        ),
        (
            edit("services", "pg-backup", "command", value=["while true; do\n  pg_dump -Fc x\n  sleep 172800\ndone"]),
            "waits more than 86400",
        ),
        (edit("services", "pg-backup", "environment", value={"PGPASSWORD": "x"}), "pg-backup: a secret-named"),
        (edit("services", "pg-backup", "secrets", value=["postgres_password", "database_url"]), "pg-backup: must mount only"),
        (edit("services", "pg-backup", "user", value="0:0"), "pg-backup: must run as uid 70"),
        (
            edit("services", "pg-backup", "healthcheck", "test", value=["CMD-SHELL", "test -n \"$(ls /backups)\""]),
            "unescaped $",
        ),
    ],
    ids=[
        "no-service",
        "backup-dir-with-default",
        "backup-dir-is-a-volume",
        "no-retention-or-partial",
        "wait-too-long",
        "password-in-environment",
        "extra-secret",
        "root",
        "unescaped-dollar-in-healthcheck",
    ],
)
def test_production_backup_rule_detects(mutation, fragment):
    assert_caught(backup_problems, mutation, fragment)


def rewrite_backup_script(old: str, new: str, count: int = 1):
    """A mutation of the ``pg-backup`` script text: ``old`` must be there, so the control cannot go stale."""

    def apply(config: dict) -> None:
        command = config["services"]["pg-backup"]["command"]
        assert old in command[0], f"{old!r} is no longer in the pg-backup script: the control is stale"
        command[0] = command[0].replace(old, new, count)

    return apply


# [utest->req~lab-deployment-production-backups~1]
def test_production_backup_rule_detects_an_unescaped_dollar_in_the_script():
    assert_caught(backup_problems, rewrite_backup_script("$${stamp}", "${stamp}"), "unescaped $")


# [utest->req~lab-deployment-production-backups~1]
def test_production_backup_stops_on_a_failed_dump():
    service = production()["services"]["pg-backup"]
    assert service["entrypoint"] == ["sh", "-ec"]
    script = service["command"][0]
    assert script.index("pg_dump") < script.index('mv "openbinding-')


# [utest->req~lab-deployment-production-backups~1]
@pytest.mark.parametrize(
    "mutation",
    [
        edit("services", "pg-backup", "entrypoint", value=["sh", "-c"]),
        edit("services", "pg-backup", "entrypoint", value=["bash", "-c"]),
        edit("services", "pg-backup", "entrypoint"),
    ],
    ids=["sh-c", "bash-c", "no-entrypoint"],
)
def test_production_backup_rule_detects_a_script_that_goes_on_after_a_failed_dump(mutation):
    assert_caught(backup_problems, mutation, "stops on a failed dump")


# [utest->req~lab-deployment-production-backups~1]
def test_production_backup_rule_accepts_a_plain_shell_when_the_script_begins_with_set_e():
    config = production()
    config["services"]["pg-backup"]["entrypoint"] = ["sh", "-c"]
    config["services"]["pg-backup"]["command"][0] = "set -e\n" + config["services"]["pg-backup"]["command"][0]
    assert not backup_problems(config)
    config["services"]["pg-backup"]["command"][0] = config["services"]["pg-backup"]["command"][0].replace("set -e\n", "# set -e\n")
    assert any("stops on a failed dump" in problem for problem in backup_problems(config))


# [utest->req~lab-deployment-production-backups~1]
@pytest.mark.parametrize(
    ("mutation", "fragment"),
    [
        (rewrite_backup_script("cd /backups\n", ""), "the command lacks a cd into /backups before the loop"),
        (
            rewrite_backup_script("find . -maxdepth 1 -name 'openbinding-*.dump' -mmin", "find . -name 'openbinding-*.dump' -mmin"),
            "the command lacks retention of this directory only",
        ),
        (
            rewrite_backup_script("find . -maxdepth 1 -name 'openbinding-*.dump' -mmin", "find . -maxdepth 1 -name '*' -mmin"),
            "the command lacks retention of this directory only",
        ),
        (
            rewrite_backup_script("find . -maxdepth 1 -name 'openbinding-*.dump' -mmin", "find / -maxdepth 1 -name 'openbinding-*.dump' -mmin"),
            "the command lacks retention of this directory only",
        ),
    ],
    ids=["no-cd", "no-maxdepth", "any-name", "wrong-directory"],
)
def test_production_backup_rule_detects_a_retention_that_can_delete_other_files(mutation, fragment):
    assert_caught(backup_problems, mutation, fragment)


# [utest->req~lab-deployment-production-backups~1]
def test_production_backup_changes_into_the_backup_directory_before_the_loop():
    script = production()["services"]["pg-backup"]["command"][0]
    assert 0 <= script.index("cd /backups") < script.index("while true")
    assert script.index("umask 077") < script.index("while true")


# [utest->req~lab-deployment-production-backups~1]
@pytest.mark.parametrize(
    ("text", "unescaped"),
    [
        ("echo $$HOME ${X_Y:?need it}", False),
        ("echo $HOME", True),
        ("echo ${HOME}", True),
        ("echo ${HOME:-x}", True),
        ("echo $$(( ${DAYS:?set} * 2 ))", False),
    ],
)
def test_production_unescaped_dollar_helper(text, unescaped):
    assert _unescaped_dollars(text) is unescaped


# -- network, ports, SPACE (production-network) -----------------------------------------------------------


def network_problems(config: dict) -> list[str]:
    problems = []
    services = _services(config)
    for name, service in services.items():
        ports = [str(p) for p in _as_list(service.get("ports"))]
        if name == "nginx":
            if ports != ["80:80", "443:443"]:
                problems.append(f"nginx: ports are {ports}, not 80:80 and 443:443")
        elif ports:
            problems.append(f"{name}: publishes ports {ports}")
        if service.get("networks") != [PROJECT_NETWORK] or "network_mode" in service:
            problems.append(f"{name}: must be on the {PROJECT_NETWORK} network only")
    for kind in ("services", "networks", "volumes"):
        for name in config.get(kind) or {}:
            if "space" in name.lower() or "sphere" in name.lower():
                problems.append(f"{kind} {name}: SPACE and SPHERE are remote, there is no local one")
    networks = config.get("networks") or {}
    if set(networks) != {PROJECT_NETWORK}:
        problems.append(f"networks are {sorted(networks)}, not {PROJECT_NETWORK}")
    ipam = ((networks.get(PROJECT_NETWORK) or {}).get("ipam") or {}).get("config") or []
    subnets = [entry.get("subnet") for entry in ipam]
    if len(subnets) != 1:
        problems.append("the network needs exactly one fixed IPAM subnet")
    else:
        try:
            ipaddress.ip_network(subnets[0], strict=True)
        except ValueError:
            problems.append(f"subnet {subnets[0]!r} is not a network address")
        if _environment(services.get("gateway", {})).get("FORWARDED_ALLOW_IPS") != subnets[0]:
            problems.append("gateway: FORWARDED_ALLOW_IPS is not the subnet of the network")
    if set(config.get("volumes") or {}) != EXPECTED_VOLUMES:
        problems.append(f"volumes are {sorted(config.get('volumes') or {})}")
    return problems


# [utest->req~lab-deployment-production-network~1]
def test_production_only_nginx_publishes_ports_and_one_network_carries_everything():
    config = production()
    assert not network_problems(config)
    assert "x-subnet" in config, "compose.yaml no longer defines the x-subnet anchor"
    ipam = config["networks"][PROJECT_NETWORK]["ipam"]["config"]
    assert len(ipam) == 1, "the network needs exactly one subnet"
    assert config["x-subnet"] == ipam[0]["subnet"]


# [utest->req~lab-deployment-production-network~1]
@pytest.mark.parametrize(
    ("mutation", "fragment"),
    [
        (edit("services", "nginx", "ports", value=["80:80"]), "nginx: ports"),
        (edit("services", "gateway", "ports", value=["8000:8000"]), "gateway: publishes ports"),
        (edit("services", "redis", "networks", value=["default"]), "redis: must be on"),
        (edit("services", "redis", "network_mode", value="host"), "redis: must be on"),
        (edit("networks", "second", value={}), "networks are"),
        (edit("services", "gateway", "environment", "FORWARDED_ALLOW_IPS", value="10.0.0.0/8"), "FORWARDED_ALLOW_IPS"),
        (
            edit("networks", PROJECT_NETWORK, "ipam", "config", value=[{"subnet": "172.29.40.5/24"}]),
            "not a network address",
        ),
        (edit("networks", PROJECT_NETWORK, "ipam"), "exactly one fixed IPAM subnet"),
        (edit("services", "space-api", value={"networks": [PROJECT_NETWORK]}), "space-api"),
        (edit("services", "sphere-web", value={"networks": [PROJECT_NETWORK]}), "sphere-web"),
        (edit("volumes", "space-data", value={}), "space-data"),
        (edit("networks", "space", value={}), "networks space"),
        (edit("volumes", "pgdata"), "volumes are"),
    ],
    ids=[
        "nginx-without-443",
        "gateway-published",
        "default-network",
        "host-network",
        "second-network",
        "forwarded-ips-differ",
        "host-bits-in-subnet",
        "no-subnet",
        "space-service",
        "sphere-service",
        "space-volume",
        "space-network",
        "volume-missing",
    ],
)
def test_production_network_rule_detects(mutation, fragment):
    assert_caught(network_problems, mutation, fragment)


# [utest->req~lab-deployment-production-network~1]
def test_production_mounts_the_checkout_examples_for_nginx():
    mounts = production()["services"]["nginx"]["volumes"]
    assert "../../../examples:/opt/openbinding/examples:ro" in mounts
    assert (PRODUCTION_DIR / "../../../examples").resolve() == (REPO_ROOT / "examples").resolve()


# -- site variables, ci.env, real names (production-secret-files, production-network) ------------------------


def variable_problems(compose_text: str, images: dict[str, str], site: dict[str, str]) -> list[str]:
    problems = []
    required = set(REQUIRED_VARIABLE.findall(compose_text))
    for variable in sorted(required - set(images) - set(site)):
        problems.append(f"{variable}: required by compose.yaml and defined in neither images.env nor ci.env")
    for variable in sorted(set(site) - required):
        problems.append(f"{variable}: defined in ci.env and used by compose.yaml nowhere")
    return problems


def ci_env_problems(text: str) -> list[str]:
    values, problems = parse_env_file(text)
    if set(values) != set(SITE_VARIABLES):
        problems.append(f"ci.env defines {sorted(values)}, not {sorted(SITE_VARIABLES)}")
    for key, value in values.items():
        if key not in SITE_VARIABLES and SECRET_ENVIRONMENT_NAME.search(key):
            problems.append(f"{key}: ci.env holds placeholders, no secrets")
        pattern = CI_VALUES.get(key)
        if pattern and not re.fullmatch(pattern, value):
            problems.append(f"{key}={value!r} is not a placeholder")
        if "us.es" in value:
            problems.append(f"{key}: a real host name")
    return problems


def ci_env_text() -> str:
    assert CI_ENV.is_file(), "deploy/compose/production/ci.env"
    return CI_ENV.read_text(encoding="utf-8")


# [utest->req~lab-deployment-production-secret-files~1]
def test_production_ci_env_holds_placeholders_only():
    assert not ci_env_problems(ci_env_text())


# [utest->req~lab-deployment-production-secret-files~1]
def test_production_every_required_variable_is_defined_for_ci():
    site, problems = parse_env_file(ci_env_text())
    assert not problems
    assert not variable_problems(production_text(), images_env(), site)
    assert set(REQUIRED_VARIABLE.findall(production_text())) == IMAGE_VARIABLES | set(SITE_VARIABLES)


# [utest->req~lab-deployment-production-secret-files~1]
@pytest.mark.parametrize(
    ("change", "fragment"),
    [
        (lambda text: text + "GATEWAY_JWT_SECRET=abcdefabcdefabcdefabcdefabcdefabcd\n", "GATEWAY_JWT_SECRET"),
        (lambda text: text + "POSTGRES_PASSWORD=openbinding\n", "POSTGRES_PASSWORD"),
        (lambda text: text.replace("openbinding.example.org", "openbinding.score.us.es"), "PUBLIC_ORIGIN"),
        (lambda text: text.replace("BACKUP_RETENTION_DAYS=14", "BACKUP_RETENTION_DAYS=forever"), "BACKUP_RETENTION_DAYS"),
        (lambda text: text.replace("NGINX_SSL_DIR=/srv/openbinding/tls\n", ""), "ci.env defines"),
        (lambda text: text + "not a variable\n", "not NAME=value"),
        (lambda text: text + "PUBLIC_ORIGIN=https://openbinding.example.org\n", "defined twice"),
    ],
    ids=["jwt-secret", "password", "real-host", "retention-not-a-number", "missing-variable", "bad-line", "duplicate"],
)
def test_production_ci_env_rule_detects(change, fragment):
    problems = ci_env_problems(change(ci_env_text()))
    assert problems
    assert fragment in " | ".join(problems)


# [utest->req~lab-deployment-production-secret-files~1]
def test_production_variable_rule_detects_an_undefined_or_unused_variable():
    site, _ = parse_env_file(ci_env_text())
    text = production_text()
    assert variable_problems(text + "\n# ${NEW_THING:?set it}\n", images_env(), site)
    assert variable_problems(text, images_env(), {**site, "UNUSED_SITE": "x"})
    assert variable_problems(text, images_env(), {k: v for k, v in site.items() if k != "SPACE_URL"})


# [utest->req~lab-deployment-production-network~1]
def test_production_files_name_no_real_host():
    for path in (PRODUCTION, IMAGES_ENV, CI_ENV):
        assert path.is_file(), str(path.relative_to(REPO_ROOT))
        assert "us.es" not in path.read_text(encoding="utf-8"), path.name


# -- runbook (S4) ---

RENDER_COMMAND = (
    "docker compose -f deploy/compose/production/compose.yaml "
    "--env-file deploy/compose/production/images.env "
    "--env-file deploy/compose/production/ci.env config --quiet"
)
REMOTE_SPACE_HEADING = "Remote SPACE"
REMOTE_SPACE_ANCHOR = "#remote-space"
REMOTE_SPACE_URL = "https://space.score.us.es"  # the only real host name the runbook may carry
# Facts the runbook must state, found by review: (what, text that must appear).
RUNBOOK_FACTS = [
    ("the pre-flight greps value lines only, not comments", "'^[A-Z0-9_]+=gap\\.invalid/'"),
    ("site.env is exported before the commands use it", "set -a"),
    ("site.env is exported before the commands use it (end)", "set +a"),
    ("the password is written without a newline", "printf '%s'"),
    ("owner of the postgres secret", "uid 70"),
    ("owner of the other secrets", "10001"),
    ("the readiness endpoint", "$PUBLIC_ORIGIN/api/health/ready"),
    ("server names are in the image configuration", "nginx/production/nginx.conf"),
    ("first administrator: user", "BOOTSTRAP_ADMIN_USERNAME"),
    ("first administrator: email", "BOOTSTRAP_ADMIN_EMAIL"),
    ("first administrator: password file", "bootstrap_admin_password"),
    ("the restore drill is for a spare host", "spare host"),
    ("the SPACE key is required", "`space_api_key` is required"),
    ("SPACE_URL must be https", "`SPACE_URL` **must be an `https://` URL**"),
    ("the Docker Engine is rootful", "rootful Docker Engine"),
    ("the uids apply to rootful Docker only", "userns-remap"),
    ("the minimum Compose version", "v2.24.4"),
    ("the restart of nginx follows a gateway recreate", "`restart: true`"),
    ("off-host copies are encrypted", "encrypted in transit"),
    ("non-root and cap_drop are a follow-up", "F7"),
    ("the owner of the TLS key", "`privkey.pem` at 0600 root"),
]


def runbook_text() -> str:
    assert RUNBOOK.is_file(), "docs/runbooks/production.md"
    return RUNBOOK.read_text(encoding="utf-8")


def section(text: str, heading: str) -> str:
    """The body of the ``## heading`` section, up to the next ``## `` heading."""
    match = re.search(rf"^## {re.escape(heading)}[^\n]*\n(.*?)(?=^## |\Z)", text, re.MULTILINE | re.DOTALL)
    assert match, f"section {heading!r} is missing"
    return match[1]


def _names_in(text: str, name: str) -> bool:
    return re.search(rf"(?<![\w-]){re.escape(name)}(?![\w-])", text) is not None


def code_lines(text: str) -> list[str]:
    """The lines of the fenced ``bash`` blocks, in order."""
    return [line for block in re.findall(r"```bash\n(.*?)```", text, re.DOTALL) for line in block.splitlines()]


def deployed_services(text: str) -> set[str]:
    """The services in the first column of the table of the section ``What is deployed``."""
    body = section(text, "What is deployed")
    rows = set(re.findall(r"^\| `([a-z0-9-]+)` \|", body, re.MULTILINE))
    assert rows, "the section 'What is deployed' has no service table"
    return rows


def runbook_problems(config: dict, text: str, compose_text: str) -> list[str]:
    """Every service, secret, _IMAGE and required variable of compose.yaml is named; the render command is there."""
    in_table = deployed_services(text)
    names = [
        *(("service", n) for n in _services(config)),
        *(("secret", n) for n in (config.get("secrets") or {})),
        *(("variable", n) for n in sorted(set(REQUIRED_VARIABLE.findall(compose_text)))),
    ]
    problems = []
    for kind, name in names:
        if kind == "service":
            # In the services table; a mention in prose or a command does not document a service.
            if name not in in_table:
                problems.append(f"{kind} {name} is not named")
        elif not _names_in(text, name):
            problems.append(f"{kind} {name} is not named")
    if RENDER_COMMAND not in text:
        problems.append("the render command is missing")
    if "us.es" in text.replace(REMOTE_SPACE_URL, ""):
        problems.append("a real host name (us.es)")
    return problems


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_names_everything_of_the_compose_file():
    assert not runbook_problems(production(), runbook_text(), production_text())


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_names_every_image_variable_and_site_variable():
    text = runbook_text()
    for variable in sorted(IMAGE_VARIABLES | set(SITE_VARIABLES)):
        assert _names_in(text, variable), variable


# [utest->req~lab-deployment-production-runbook~1]
@pytest.mark.parametrize(
    ("kind", "name"),
    [("service", "frontend-assets"), ("secret", "secrets_fernet_keys"), ("variable", "ENGINE_MANY_HEURISTIC_IMAGE")],
)
def test_runbook_rule_detects_an_unnamed_item(kind, name):
    text = runbook_text().replace(name, "x")
    problems = runbook_problems(production(), text, production_text())
    assert f"{kind} {name} is not named" in problems


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_rule_detects_a_new_service_without_documentation():
    config = production()
    config["services"]["engine-quantum"] = {"image": "${ENGINE_QUANTUM_IMAGE:?set it}"}
    compose_text = production_text() + "\n# ${ENGINE_QUANTUM_IMAGE:?set it}\n"
    problems = runbook_problems(config, runbook_text(), compose_text)
    assert "service engine-quantum is not named" in problems
    assert "variable ENGINE_QUANTUM_IMAGE is not named" in problems


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_rule_detects_a_missing_render_command_and_a_real_host():
    text = runbook_text().replace(RENDER_COMMAND, "docker compose config")
    assert "the render command is missing" in runbook_problems(production(), text, production_text())
    text = runbook_text() + "\nhttps://openbinding.example.us.es\n"
    assert "a real host name (us.es)" in runbook_problems(production(), text, production_text())


# [utest->req~lab-deployment-production-runbook~1]
@pytest.mark.parametrize(("what", "needle"), RUNBOOK_FACTS, ids=[what for what, _ in RUNBOOK_FACTS])
def test_runbook_states(what, needle):
    assert needle in runbook_text(), what


def positions(body: str, markers, where: str) -> list[int]:
    """The index of each marker in ``body``; a missing marker fails with its name."""
    found = []
    for marker in markers:
        assert marker in body, f"{where}: {marker!r} is missing"
        found.append(body.index(marker))
    return found


def first_code_block(body: str, where: str) -> str:
    blocks = re.findall(r"```bash\n(.*?)```", body, re.DOTALL)
    assert blocks, f"{where}: no bash block"
    return blocks[0]


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_preflight_checks_values_not_comments_before_deploying():
    deploy = section(runbook_text(), "Deploying a release")
    markers = ("git describe", "git checkout", "gap\\.invalid", "predump()", "$DC pull", "$DC up -d", "$DC restart nginx")
    steps = positions(deploy, markers, "Deploying a release")
    assert steps == sorted(steps), "note the running release, check out the tag, pre-flight, dump, pull, up, restart nginx"
    assert "grep -n 'gap" not in runbook_text()


def preflight_body() -> str:
    deploy = section(runbook_text(), "Deploying a release")
    match = re.search(r"^preflight\(\) \{\n(.*?)^\}\n", deploy, re.MULTILINE | re.DOTALL)
    assert match, "the pre-flight function is missing from 'Deploying a release'"
    return match[1]


# [utest->req~lab-deployment-production-runbook~1]
@pytest.mark.parametrize(
    ("what", "needle"),
    [
        ("a dirty checkout is refused", 'git status --porcelain'),
        ("a checkout that is not exactly a tag is refused", "git describe --exact-match --tags HEAD"),
        ("the retention days are checked", 'case "${BACKUP_RETENTION_DAYS:-}" in'),
        ("the rendered images are listed", "$DC config --images"),
        ("every rendered image has a digest", "grep -Ev '@sha256:[0-9a-f]{64}$'"),
        ("a rendered marker is refused", "grep -F 'gap.invalid'"),
        ("an image in site.env is refused", '_IMAGE=\' "$SITE_ENV"'),
        ("a SPACE_URL that is not https is refused", "https://*) ;;"),
        ("the TLS directory is listed", '"$NGINX_SSL_DIR"'),
        ("the secrets directory is listed", "sudo ls -ln"),
        ("the modes of the directories themselves are listed", 'sudo ls -lnd "$OPENBINDING_SECRETS_DIR" "$NGINX_SSL_DIR"'),
    ],
    ids=[
        "clean-checkout",
        "exact-tag",
        "retention-days",
        "config-images",
        "digest-of-rendered",
        "marker-of-rendered",
        "site-env-image",
        "https",
        "tls",
        "secrets",
        "directory-modes",
    ],
)
def test_runbook_preflight_checks(what, needle):
    assert needle in preflight_body(), what


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_preflight_refuses_with_a_non_zero_status_each_time():
    body = preflight_body()
    assert body.count("refuse:") >= 9
    assert body.count("return 1") >= body.count("refuse:")


def retention_check() -> str:
    """The ``case`` of the pre-flight that checks BACKUP_RETENTION_DAYS, as a shell function that can be run."""
    match = re.search(r'^  (case "\$\{BACKUP_RETENTION_DAYS:-\}" in\n.*?^  esac)\n', preflight_body(), re.MULTILINE | re.DOTALL)
    assert match, "the pre-flight no longer checks BACKUP_RETENTION_DAYS with a case"
    return "check() {\n" + match[1] + "\n}\ncheck\n"


def run_shell(script: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["sh", "-c", script], env={"PATH": "/usr/bin:/bin", **env}, capture_output=True, text=True, timeout=30, check=False
    )


# [utest->req~lab-deployment-production-runbook~1]
@pytest.mark.parametrize("days", ["1", "14", "365"])
def test_runbook_preflight_accepts_a_whole_number_of_retention_days(days):
    result = run_shell(retention_check(), {"BACKUP_RETENTION_DAYS": days})
    assert result.returncode == 0, result.stderr


# [utest->req~lab-deployment-production-runbook~1]
@pytest.mark.parametrize(
    "days", ["", "0", "00", "014", "08", "-1", "1.5", "abc", "14d", " 14", "14 ", "1e3", "0x10"],
)
def test_runbook_preflight_refuses_retention_days_that_are_not_an_integer_of_at_least_one(days):
    result = run_shell(retention_check(), {"BACKUP_RETENTION_DAYS": days})
    assert result.returncode == 1
    assert "refuse: BACKUP_RETENTION_DAYS" in result.stderr


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_preflight_refuses_unset_retention_days():
    result = run_shell(retention_check(), {})
    assert result.returncode == 1 and "refuse:" in result.stderr


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_preflight_refuses_a_checkout_that_is_not_exactly_a_tag_before_anything_else():
    body = preflight_body()
    steps = positions(body, ("git status --porcelain", "git describe --exact-match --tags HEAD", "refuse: HEAD is not exactly a release tag", "grep -En"), "preflight")
    assert steps == sorted(steps)
    assert re.search(r"if ! git describe --exact-match --tags HEAD > /dev/null 2>&1; then\n[^\n]*refuse:[^\n]*\n\s+return 1\n", body)


# [utest->req~lab-deployment-production-backups~1]
def test_runbook_pre_release_dump_is_checked_before_deploying():
    body = section(runbook_text(), "Deploying a release")
    match = re.search(r"^predump\(\) \{\n(.*?)^\}\n", body, re.MULTILINE | re.DOTALL)
    assert match, "the predump function is missing"
    dump = match[1]
    steps = positions(dump, ("set -o pipefail", "umask 077", "pg_dump", "pg_restore --list"), "predump")
    assert steps == sorted(steps), "pipefail and umask come before the dump, the check after it"
    assert dump.count("refuse:") == 2 and dump.count("return 1") == 2
    assert "do not deploy" in dump
    assert "| sudo tee" in dump
    assert "$DC pull" not in dump
    assert body.index("predump\n") < body.index("$DC pull"), "the dump is taken, and checked, before the pull"


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_owner_uids_of_the_secret_files():
    body = section(runbook_text(), "Secrets directory")
    assert re.search(r"postgres_password[^\n]*\b70\b", body)
    assert "chown" in body
    assert "10001" in body


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_rollback_depends_on_whether_the_release_added_a_migration():
    body = section(runbook_text(), "Rollback")
    assert "added a migration" in body
    assert "did not add a migration" in body
    assert "restore the database first" in body
    with_migration, _, without_migration = body.partition("**The release did not add a migration.**")
    assert without_migration, "the case without a migration is missing"
    assert "--clean" not in with_migration, "a --clean restore leaves the objects only the new schema has"
    assert "DROP DATABASE openbinding\n" not in with_migration and "DROP DATABASE openbinding'" not in with_migration
    assert 'git checkout "$1"' in with_migration and "git checkout <previous tag>" in without_migration
    assert "cp /srv/openbinding/releases" not in body, "images.env is not a file to copy over a tracked file"


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_rollback_checks_the_dump_and_restores_aside_before_touching_the_live_database():
    body = section(runbook_text(), "Rollback")
    steps = positions(
        body,
        (
            "pg_restore --list",
            "CREATE DATABASE openbinding_rollback",
            "--exit-on-error",
            'git checkout "$1"',
            "$DC pull",
            "$DC stop nginx gateway worker analysis-worker pg-backup",
            "ALTER DATABASE openbinding RENAME TO openbinding_failed_",
            "ALTER DATABASE openbinding_rollback RENAME TO openbinding",
            "$DC up -d && $DC restart nginx",
        ),
        "Rollback",
    )
    assert steps == sorted(steps)
    # Nothing drops or renames the live database before the dump was checked and restored aside.
    before_swap = body[: body.index("$DC stop nginx gateway")]
    assert "DROP DATABASE openbinding'" not in before_swap
    assert "RENAME" not in before_swap
    assert "-1 -v ON_ERROR_STOP=1" in body, "the two renames run in one transaction"
    assert "DROP DATABASE openbinding_failed_<timestamp>" in body, "the failed database is dropped by hand later"


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_rollback_swaps_the_database_only_when_the_restore_aside_succeeded():
    body = section(runbook_text(), "Rollback")
    swap = function_body(body, "rollback_swap")
    steps = positions(
        swap,
        ('git checkout "$1"', "preflight", "$DC pull", "$DC stop nginx", "RENAME TO openbinding_failed_", "$DC up -d"),
        "rollback_swap",
    )
    assert steps == sorted(steps), "check out, pre-flight and pull before anything of the running release is stopped"
    # Both failure paths return to the release that was running, never leave the previous tag checked out against
    # the newer schema, and the first one is taken before anything is stopped.
    assert swap.count('git checkout "$running"') == 2
    assert swap.count("return 1") == 3, "the head cannot be read, the check-out or pull fails, the stop or rename fails"
    assert 'running=$(git rev-parse HEAD) || return 1' in swap
    assert 'if ! { git checkout "$1" && preflight && $DC pull; }; then' in swap
    assert "-1 -v ON_ERROR_STOP=1 -f -; }; then" in swap, "the group of stop and rename is tested as a whole"
    restore = function_body(body, "rollback_restore")
    assert "$DC stop" not in restore and "RENAME" not in restore
    # The dump is checked, and the check can stop the rollback, before the database is created or restored.
    steps = positions(
        restore, ("pg_restore --list", "return 1", "CREATE DATABASE openbinding_rollback", "--exit-on-error"), "rollback_restore"
    )
    assert steps == sorted(steps)
    listing = [line for line in restore.replace("\\\n", " ").splitlines() if "pg_restore --list" in line]
    assert listing and all("return 1" in line for line in listing), "a dump that pg_restore cannot list stops the rollback"
    assert 'rollback_restore "$OPENBINDING_BACKUP_DIR/<dump before the release>.dump" && rollback_swap <previous tag>' in body
    # The swap is never a bare line of the block: it is only reached through the && above.
    assert not [line for line in body.splitlines() if line.startswith("rollback_swap ")]
    without_migration = body.partition("**The release did not add a migration.**")[2]
    chain = "git checkout <previous tag> && preflight && $DC pull && $DC up -d && $DC restart nginx"
    assert chain in without_migration


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_rotation_commands_use_sudo_because_the_files_are_owned_by_service_uids():
    body = section(runbook_text(), "Rotation")
    assert "sudo" in body
    assert body.count("put_secret") >= 3
    assert "sudo cat" in body


# [utest->req~lab-deployment-production-backups~1]
def test_runbook_snapshot_section_names_the_volumes_and_stops_the_backup_service():
    body = section(runbook_text(), "Volume snapshots")
    for needle in ("pgdata", "artifacts", "restore drill"):
        assert needle in body, needle
    stops = [line for line in body.splitlines() if line.startswith("$DC stop ")]
    assert len(stops) == 1
    assert {"pg-backup", "postgres"} <= set(stops[0].split())


# [utest->req~lab-deployment-production-backups~1]
def test_runbook_snapshots_are_created_private_and_copied_off_host_encrypted():
    body = section(runbook_text(), "Volume snapshots")
    assert "umask 077; tar czf" in body, "the archive is created inside the container, with umask 077"
    assert "--entrypoint sh" in body
    assert "encrypted in transit and" in body
    backups = section(runbook_text(), "Backups")
    assert "encrypted in transit and" in backups
    assert "mode 0600" in backups


# [utest->req~lab-deployment-production-backups~1]
def test_runbook_restore_drill_is_for_a_spare_host():
    body = section(runbook_text(), "Restore drill")
    assert "spare host" in body
    assert "172.29.40.0/24" in body


# [utest->req~lab-deployment-production-backups~1]
def test_runbook_restore_drill_refuses_to_run_on_a_host_that_is_not_marked_as_the_drill_host():
    body = section(runbook_text(), "Restore drill")
    match = re.search(r"^drill\(\) \{\n(.*?)^\}\n", body, re.MULTILINE | re.DOTALL)
    assert match, "the drill function is missing"
    drill = match[1]
    steps = positions(drill, ('echo "host: $(hostname)"', 'DRILL_HOST:-}" != yes', "return 1", "$DC up -d --wait postgres", "pg_restore"), "drill")
    assert steps == sorted(steps), "print the host, check DRILL_HOST, only then touch Compose"
    assert "abort:" in drill
    assert "never on production" in body
    assert "--exit-on-error" in drill and "--clean" not in drill
    assert "\ndrill\n" in body, "the function is called"


def bare_down_problems(text: str) -> list[str]:
    """Volumes are removed only by ``drill_down``, which checks DRILL_HOST first; no other ``down -v`` stands."""
    problems = []
    rest = text
    match = re.search(r"^drill_down\(\) \{[^\n]*\n(.*?)^\}\n", text, re.MULTILINE | re.DOTALL)
    if not match:
        problems.append("drill_down is missing")
    else:
        rest = text.replace(match[0], "", 1)
        guard, removal = match[1].find('DRILL_HOST:-}" != yes'), match[1].find("$DC down -v")
        if guard < 0 or removal < 0 or guard > removal:
            problems.append("drill_down does not check DRILL_HOST before it removes the volumes")
        elif "return 1" not in match[1][guard:removal]:
            problems.append("drill_down does not return when DRILL_HOST is not yes")
    if re.search(r"\bdown\b[^\n]*\s(?:--volumes|-[a-z]*v[a-z]*)\b", rest):
        problems.append("a down -v outside drill_down")
    return problems


# [utest->req~lab-deployment-production-backups~1]
def test_runbook_drill_removes_volumes_only_through_the_guarded_drill_down():
    assert bare_down_problems(runbook_text()) == []
    body = section(runbook_text(), "Restore drill")
    assert "`drill_down`" in body


# [utest->req~lab-deployment-production-backups~1]
@pytest.mark.parametrize(
    ("change", "fragment"),
    [
        (lambda text: text + "\n```bash\n$DC down -v\n```\n", "a down -v outside drill_down"),
        (lambda text: text + "\nRemove it with `docker compose down --volumes`.\n", "a down -v outside drill_down"),
        (lambda text: text.replace("`drill_down`.", "`$DC down -v`."), "a down -v outside drill_down"),
        (lambda text: text.replace('"${DRILL_HOST:-}" != yes', '"${DRILL_HOST:-}" != no'), "does not check DRILL_HOST"),
        (lambda text: text.replace("drill_down() {", "drill_up() {"), "drill_down is missing"),
    ],
    ids=["bare-command", "long-flag", "typed-by-hand", "no-guard", "no-function"],
)
def test_runbook_bare_down_rule_detects(change, fragment):
    text = runbook_text()
    mutated = change(text)
    assert mutated != text, "the control is stale"
    assert fragment in " | ".join(bare_down_problems(mutated))


def drill_down_script(text: str) -> str:
    match = re.search(r"^drill_down\(\) \{[^\n]*\n(.*?)^\}\n", section(text, "Restore drill"), re.MULTILINE | re.DOTALL)
    assert match, "drill_down is missing"
    return "drill_down() {\n" + match[1] + "}\n"


# [utest->req~lab-deployment-production-backups~1]
@pytest.mark.parametrize("host", [None, "", "no", "YES", "yes "], ids=["unset", "empty", "no", "uppercase", "trailing-space"])
def test_runbook_drill_down_refuses_on_a_host_that_is_not_the_drill_host(host):
    env = {"DC": "echo REMOVED"} | ({} if host is None else {"DRILL_HOST": host})
    result = run_shell(drill_down_script(runbook_text()) + "drill_down\n", env)
    assert result.returncode == 1
    assert "REMOVED" not in result.stdout and "abort:" in result.stderr


# [utest->req~lab-deployment-production-backups~1]
def test_runbook_drill_down_removes_the_volumes_on_the_drill_host():
    result = run_shell(drill_down_script(runbook_text()) + "drill_down\n", {"DC": "echo REMOVED", "DRILL_HOST": "yes"})
    assert result.returncode == 0
    assert result.stdout == "REMOVED down -v\n"


# [utest->req~lab-deployment-production-backups~1]
def test_runbook_drill_never_uses_a_production_space_key():
    body = " ".join(section(runbook_text(), "Restore drill").split())
    assert "**The drill never uses a production SPACE key.**" in body
    for needle in ("throwaway SPACE account", "https://space.invalid", "never copy the production `space_api_key`"):
        assert needle in body, needle


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_renders_with_the_command_of_ci():
    assert RENDER_COMMAND in runbook_text()


REMOTE_SPACE_NEEDLES = (
    REMOTE_SPACE_URL,
    "SPACE_URL",
    "`space_api_key`",
    "tests/test_no_local_space.py",
    "runs no local SPACE",
)


def remote_space_problems(text: str) -> list[str]:
    """What the section 'Remote SPACE' lacks: the URL, the variable, the key file, the guard test, no local SPACE."""
    if f"## {REMOTE_SPACE_HEADING}" not in text:
        return ["the section is missing"]
    body = " ".join(section(text, REMOTE_SPACE_HEADING).split())
    problems = [f"missing: {needle}" for needle in REMOTE_SPACE_NEEDLES if needle not in body]
    if "http://space.score.us.es" in body:
        problems.append("a plain http URL")
    return problems


# [utest->req~lab-deployment-runbook-remote-space~1]
def test_remote_space_rule_refuses_incomplete_sections():
    good = "## Remote SPACE\n\n" + " ".join(REMOTE_SPACE_NEEDLES) + "\n"
    assert remote_space_problems(good) == []
    assert remote_space_problems(good.replace("`space_api_key`", "the key"))
    assert remote_space_problems(good.replace("tests/test_no_local_space.py", "a test"))
    assert remote_space_problems(good.replace("runs no local SPACE", "runs a SPACE"))
    assert remote_space_problems(good + "http://space.score.us.es\n")
    assert remote_space_problems("## Other\n\ntext\n")


# [utest->req~lab-deployment-runbook-remote-space~1]
def test_runbook_remote_space_section_and_compose_has_no_space_service():
    text = runbook_text()
    assert not remote_space_problems(text)
    outside = text.replace(section(text, REMOTE_SPACE_HEADING), "")  # that section says there is no local SPACE
    assert not re.search(r"(?i)local[ -]space", outside)
    for name in ("space-mongo", "space-redis", "space-api"):
        assert name not in text, name
    assert "gap.invalid/space-api" not in text
    blocked = section(text, "What stays blocked")
    assert not re.search(r"(?i)\bSPACE\b", blocked), "an item of 'What stays blocked' waits for a SPACE"
    assert "<!-- [impl->req~lab-deployment-runbook-remote-space~1] -->" in section(text, REMOTE_SPACE_HEADING)
    assert "SPACE decision" not in text.split("## Who may order a deployment")[0]
    config = production()
    for kind in ("services", "networks", "volumes"):
        assert not [name for name in config[kind] if "space" in name.lower() or "sphere" in name.lower()], kind


# -- what the commands of the runbook do (production-runbook) ------------------------------------------------


def commands(text: str) -> list[str]:
    """The commands of the fenced bash blocks, a command split over lines with a trailing backslash joined."""
    joined, current = [], ""
    for line in code_lines(text):
        stripped = line.rstrip()
        if stripped.endswith("\\"):
            current += stripped[:-1].strip() + " "
        else:
            joined.append((current + stripped.strip()).strip())
            current = ""
    return [command for command in joined if command]


def function_body(text: str, name: str) -> str:
    match = re.search(rf"^{re.escape(name)}\(\) \{{[^\n]*\n(.*?)^\}}\n", text, re.MULTILINE | re.DOTALL)
    assert match, f"the function {name} is missing from the runbook"
    return match[1]


def gateway_restart_problems(text: str) -> list[str]:
    """Every command that recreates the gateway is followed by ``$DC restart nginx`` (nginx resolves it once)."""
    problems = []
    lines = commands(text)
    for number, line in enumerate(lines):
        recreate = re.search(r"--force-recreate\b(?P<services>[^&|;]*)", line)
        if not recreate or not re.search(r"(?<![\w-])gateway(?![\w-])", recreate["services"]):
            continue
        after = line[recreate.end() :]
        following = lines[number + 1] if number + 1 < len(lines) else ""
        if "$DC restart nginx" not in after and following != "$DC restart nginx":
            problems.append(f"no `$DC restart nginx` after: {line}")
    return problems


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_restarts_nginx_after_every_gateway_recreate():
    text = runbook_text()
    assert not gateway_restart_problems(text)
    recreates = [line for line in commands(text) if "--force-recreate" in line and "gateway" in line]
    assert len(recreates) >= 5, "first install, JWT, Fernet, SPACE key and PostgreSQL password"


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_gateway_restart_rule_detects_a_missing_nginx_restart():
    text = runbook_text()
    assert gateway_restart_problems(text.replace("$DC restart nginx\n", "", 1))
    fernet = "--force-recreate gateway worker analysis-worker \\\n      && $DC restart nginx"
    assert fernet in text, "the Fernet rotation chains the nginx restart"
    assert gateway_restart_problems(text.replace(fernet, "--force-recreate gateway worker analysis-worker", 1))
    assert gateway_restart_problems(text + "\n```bash\n$DC up -d --force-recreate gateway\n```\n")
    assert not gateway_restart_problems(text + "\n```bash\n$DC up -d --force-recreate worker\n```\n")


def typed_secret_problems(text: str) -> list[str]:
    """The keys and passwords that a person provides are read without echo, never written in a command."""
    problems = []
    for line in commands(text):
        if not re.search(r"put_secret (space_api_key|sphere_api_key|bootstrap_admin_password)\b", line):
            continue
        if line.startswith("printf '' | put_secret ") and line.endswith(" allow-empty"):
            continue  # an empty file on purpose
        if re.search(r"printf '%s' '[^']", line):
            problems.append(f"a literal value in a command: {line}")
        elif not (
            "IFS= read -rs v;" in line and "printf '%s' \"$v\" |" in line and line.endswith("; unset v")
        ):
            problems.append(f"not read with `IFS= read -rs v` and unset afterwards: {line}")
    return problems


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_secrets_that_a_person_provides_are_never_typed_in_a_command():
    text = runbook_text()
    assert not typed_secret_problems(text)
    assert "<space key>" not in text and "<password of the first administrator>" not in text
    typed = [line for line in commands(text) if "IFS= read -rs v" in line]
    assert len(typed) >= 3, "the SPACE key and the administrator password at install, and a key rotation"
    for heading in ("Secrets directory", "Rotation"):
        code = "\n".join(code_lines(section(text, heading)))
        steps = positions(code, ("set +o history", "IFS= read -rs v", "set -o history"), heading)
        assert steps == sorted(steps), heading
    assert "HISTCONTROL=ignorespace" in section(text, "Secrets directory")


# [utest->req~lab-deployment-production-runbook~1]
@pytest.mark.parametrize(
    "bad",
    [
        "printf '%s' 'abc123' | put_secret space_api_key 10001",
        "printf '%s' '<password>' | put_secret bootstrap_admin_password 10001",
        'printf \'%s\' "$v" | put_secret space_api_key 10001',
        "IFS= read -rs v; printf '%s' \"$v\" | put_secret sphere_api_key 10001",
        "printf '' | put_secret space_api_key 10001",
    ],
    ids=["literal-key", "literal-password", "no-read", "no-unset", "empty-without-allow"],
)
def test_runbook_typed_secret_rule_detects(bad):
    assert typed_secret_problems(f"```bash\n{bad}\n```\n")


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_put_secret_writes_a_private_temp_file_and_moves_it_into_place():
    body = function_body(section(runbook_text(), "Secrets directory"), "put_secret")
    steps = positions(
        body,
        ('(umask 077; sudo tee "$f.new"', "sudo test -s", 'sudo chown "$2:$2" "$f.new"', 'sudo chmod 0400 "$f.new"', 'sudo cp -p "$f" "$f.prev"', 'sudo mv -f "$f.new" "$f"'),
        "put_secret",
    )
    assert steps == sorted(steps), "write, check, own, protect, keep the previous file, then move into place"
    assert "allow-empty" in body and "refuse: empty value" in body
    assert 'sudo cp -p "$f" "$f.prev" || { sudo rm -f "$f.new"; echo "refuse: cannot keep $1.prev" >&2; return 1; }' in body, (
        "a previous file that cannot be kept stops put_secret before the replace"
    )
    assert 'sudo tee "$f"' not in body, "the target is never written in place"
    rotation = section(runbook_text(), "Rotation")
    # The secrets directory is root's (0700): the glob is expanded by a root shell, not by the user's shell.
    assert 'sudo sh -c \'rm -f -- "$1"/*.prev\' sh "$OPENBINDING_SECRETS_DIR"' in rotation
    assert 'sudo rm -f "$OPENBINDING_SECRETS_DIR"/*.prev' not in runbook_text()


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_fernet_rotation_fails_unless_both_keys_are_set_and_forgets_them():
    body = section(runbook_text(), "Rotation")
    start = body.index("new=$(openssl rand -base64 32")
    block = body[start : body.index("```", start)]
    assert 'if [ -n "$new" ] && [ -n "$old" ]; then' in block
    assert "else" in block and "refuse:" in block
    assert block.rstrip().endswith("unset new old")
    assert block.index("put_secret secrets_fernet_keys") < block.index("--force-recreate")


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_postgres_password_rotation_keeps_the_password_out_of_arguments():
    body = section(runbook_text(), "Rotation")
    start = body.index("password=$(openssl rand -hex 24)")
    block = body[start : body.index("```", start)]
    assert "printf \"ALTER ROLE openbinding PASSWORD '%s';\\n\" \"$password\"" in block
    assert "| $DC exec -T postgres" in block, "the statement reaches psql on standard input"
    assert not re.search(r"-c\s+[\"']ALTER ROLE", block), "the password is not an argument of psql"
    assert block.rstrip().endswith("unset password")
    # Undoing it: the role is set back to the old password first, only then are the old files moved back.
    undo = indented_function_body(body, "undo_password_rotation")
    steps = positions(undo, ("ALTER ROLE openbinding PASSWORD", "mv -f --", "--force-recreate", "$DC restart nginx"), "undo")
    assert steps == sorted(steps)
    assert not re.search(r"-c\s+[\"']ALTER ROLE", undo)
    assert "\nundo_password_rotation\n" in body or "  undo_password_rotation\n" in body, "the function is called"


def indented_function_body(text: str, name: str) -> str:
    """The body of a shell function that sits in an indented fenced block (a list item), dedented."""
    match = re.search(rf"^( *){re.escape(name)}\(\) \{{[^\n]*\n(.*?)^\1\}}\n", text, re.MULTILINE | re.DOTALL)
    assert match, f"the function {name} is missing from the runbook"
    return textwrap.dedent(match[2])


def rotation_block(text: str, start: str) -> str:
    """The fenced block of the section ``Rotation`` that holds ``start``, dedented."""
    body = section(text, "Rotation")
    begin = body.rindex("\n", 0, body.index(start)) + 1
    return textwrap.dedent(body[begin : body.index("```", begin)])


SUDO_SHIM = """sudo() {
  case "$1" in
    chown) return 0 ;;
    cp) [ -z "${FAIL_CP:-}" ] || return 1 ;;
  esac
  "$@"
}
"""


def fake_dc(directory) -> str:
    """A ``$DC`` that records its arguments in ``$DC_LOG`` and what it reads on standard input for ``exec``."""
    path = directory / "dc"
    path.write_text('#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$DC_LOG"\n[ "$1" != exec ] || cat >> "$DC_LOG.stdin"\n')
    path.chmod(0o755)
    return str(path)


def put_secret_script(text: str) -> str:
    return SUDO_SHIM + "put_secret() {\n" + function_body(section(text, "Secrets directory"), "put_secret") + "}\n"


def put_secret_problems(text: str, tmp_path) -> list[str]:
    """Runs the put_secret of the runbook against a directory of temporary files (sudo is a shim)."""
    problems = []
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    target = secrets / "space_api_key"
    target.write_text("old")
    env = {"OPENBINDING_SECRETS_DIR": str(secrets)}
    result = run_shell(put_secret_script(text) + "printf '%s' new | put_secret space_api_key 10001\n", {**env, "FAIL_CP": "1"})
    if result.returncode == 0:
        problems.append("returns 0 although the previous file could not be kept")
    if target.read_text() != "old":
        problems.append("replaces the file although the previous file could not be kept")
    if (secrets / "space_api_key.new").exists():
        problems.append("leaves a .new file after a failure")
    result = run_shell(put_secret_script(text) + "printf '%s' new | put_secret space_api_key 10001\n", env)
    if result.returncode != 0 or target.read_text() != "new":
        problems.append(f"does not replace the file: {result.stderr}")
    elif (secrets / "space_api_key.prev").read_text() != "old":
        problems.append("does not keep the previous file as .prev")
    elif stat.S_IMODE(target.stat().st_mode) != 0o400:
        problems.append("the new file is not mode 0400")
    return problems


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_put_secret_keeps_a_previous_file_or_stops(tmp_path):
    assert put_secret_problems(runbook_text(), tmp_path) == []


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_put_secret_without_the_abort_on_a_failed_copy_is_detected(tmp_path):
    abort = ' || { sudo rm -f "$f.new"; echo "refuse: cannot keep $1.prev" >&2; return 1; }'
    assert abort in runbook_text()
    problems = put_secret_problems(runbook_text().replace(abort, "", 1), tmp_path)
    assert any("returns 0" in problem for problem in problems), problems
    assert any("replaces the file" in problem for problem in problems), problems


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_put_secret_refuses_an_empty_value_and_writes_the_first_file_without_a_previous_one(tmp_path):
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    env = {"OPENBINDING_SECRETS_DIR": str(secrets)}
    script = put_secret_script(runbook_text())
    result = run_shell(script + "printf '' | put_secret space_api_key 10001\n", env)
    assert result.returncode == 1 and "refuse: empty value" in result.stderr
    assert not list(secrets.iterdir())
    result = run_shell(script + "printf '' | put_secret sphere_api_key 10001 allow-empty\n", env)
    assert result.returncode == 0 and (secrets / "sphere_api_key").read_text() == ""
    assert not (secrets / "sphere_api_key.prev").exists()


URL_WITH_OLD_PASSWORD = "postgresql+asyncpg://openbinding:oldpw@postgres:5432/openbinding"


def undo_script(text: str) -> str:
    return SUDO_SHIM + "undo_password_rotation() {\n" + indented_function_body(section(text, "Rotation"), "undo_password_rotation") + "}\n"


def undo_problems(text: str, tmp_path) -> list[str]:
    """The guards of the undo: with a missing or empty .prev nothing runs, and the status is not zero."""
    problems = []
    scenarios = {
        "no postgres_password.prev": {"database_url.prev": URL_WITH_OLD_PASSWORD},
        "an empty postgres_password.prev": {"postgres_password.prev": "", "database_url.prev": "postgresql://u:@h/db"},
        "no database_url.prev": {"postgres_password.prev": "oldpw"},
        "a database_url.prev with another password": {
            "postgres_password.prev": "oldpw",
            "database_url.prev": "postgresql+asyncpg://openbinding:pw0@postgres:5432/openbinding",
        },
        "no .prev file at all": {},
    }
    for number, (label, files) in enumerate(scenarios.items()):
        case = tmp_path / f"refused-{number}"
        secrets = case / "secrets"
        secrets.mkdir(parents=True)
        for name, content in files.items():
            (secrets / name).write_text(content)
        env = {"OPENBINDING_SECRETS_DIR": str(secrets), "DC": fake_dc(case), "DC_LOG": str(case / "dc.log")}
        result = run_shell(undo_script(text) + "undo_password_rotation\n", env)
        if result.returncode == 0:
            problems.append(f"{label}: returns 0")
        if "refuse:" not in result.stderr:
            problems.append(f"{label}: no refusal on standard error")
        if (case / "dc.log").exists():
            problems.append(f"{label}: ALTER ROLE or a recreate ran")
        if sorted(p.name for p in secrets.iterdir()) != sorted(files):
            problems.append(f"{label}: the secret files were touched")
    return problems


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_undo_of_the_password_rotation_refuses_without_a_usable_previous_file(tmp_path):
    assert undo_problems(runbook_text(), tmp_path) == []


# [utest->req~lab-deployment-production-runbook~1]
@pytest.mark.parametrize(
    ("original", "replacement", "label"),
    [
        ('postgres_password.prev") && [ -n "$old" ]', 'postgres_password.prev")', "an empty postgres_password.prev"),
        (' \\\n      && printf \':%s@\' "$old" | sudo grep -qF -f - "$dir/database_url.prev"', "", "no database_url.prev"),
        (
            ' \\\n      && printf \':%s@\' "$old" | sudo grep -qF -f - "$dir/database_url.prev"',
            ' && sudo test -f "$dir/database_url.prev"',
            "a database_url.prev with another password",
        ),
    ],
    ids=["non-empty-check", "database-url-check", "database-url-password-check"],
)
def test_runbook_undo_without_a_guard_is_detected(tmp_path, original, replacement, label):
    assert runbook_text().count(original) == 1, "the control is stale or ambiguous"
    problems = undo_problems(runbook_text().replace(original, replacement), tmp_path)
    assert any(problem.startswith(label) for problem in problems), problems


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_undo_of_the_password_rotation_sets_the_old_password_and_moves_the_files_back(tmp_path):
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    files = {
        "postgres_password.prev": "oldpw",
        "database_url.prev": URL_WITH_OLD_PASSWORD,
        "postgres_password": "new",
        "database_url": "newurl",
    }
    for name, content in files.items():
        (secrets / name).write_text(content)
    env = {"OPENBINDING_SECRETS_DIR": str(secrets), "DC": fake_dc(tmp_path), "DC_LOG": str(tmp_path / "dc.log")}
    result = run_shell(undo_script(runbook_text()) + "undo_password_rotation\n", env)
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "dc.log").read_text().splitlines() == [
        "exec -T postgres psql -U openbinding -d openbinding -v ON_ERROR_STOP=1",
        "up -d --force-recreate migrate gateway worker analysis-worker pg-backup",
        "restart nginx",
    ]
    assert (tmp_path / "dc.log.stdin").read_text() == "ALTER ROLE openbinding PASSWORD 'oldpw';\n"
    assert (secrets / "postgres_password").read_text() == "oldpw"
    assert (secrets / "database_url").read_text() == URL_WITH_OLD_PASSWORD
    assert not list(secrets.glob("*.prev"))


def failing_mv_problems(text: str, tmp_path) -> list[str]:
    """The undo with a first ``mv`` that fails (a fake ``mv`` refuses postgres_password.prev): it must stop."""
    secrets = tmp_path / "secrets"
    secrets.mkdir(parents=True)
    (secrets / "postgres_password.prev").write_text("oldpw")
    (secrets / "database_url.prev").write_text(URL_WITH_OLD_PASSWORD)
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    (fake_bin / "mv").write_text('#!/bin/sh\ncase "$*" in *postgres_password.prev*) exit 1 ;; esac\nPATH=/usr/bin:/bin exec mv "$@"\n')
    (fake_bin / "mv").chmod(0o755)
    env = {
        "OPENBINDING_SECRETS_DIR": str(secrets),
        "DC": fake_dc(tmp_path),
        "DC_LOG": str(tmp_path / "dc.log"),
        "PATH": f"{fake_bin}:/usr/bin:/bin",
    }
    result = run_shell(undo_script(text) + "undo_password_rotation\n", env)
    problems = []
    if result.returncode == 0:
        problems.append("returns 0 after a failed mv")
    log = (tmp_path / "dc.log").read_text().splitlines() if (tmp_path / "dc.log").exists() else []
    if any(line.startswith(("up ", "restart ")) for line in log):
        problems.append("recreates the services after a failed mv")
    return problems


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_undo_stops_when_a_mv_fails(tmp_path):
    assert failing_mv_problems(runbook_text(), tmp_path / "ok") == []
    assert ' "$1/$f" || exit 1; done' in runbook_text()
    mutated = runbook_text().replace(' "$1/$f" || exit 1; done', ' "$1/$f"; done', 1)
    problems = failing_mv_problems(mutated, tmp_path / "mutated")
    assert "returns 0 after a failed mv" in problems, problems


def password_rotation_problems(text: str, tmp_path, generated: str) -> list[str]:
    """Runs the forward rotation block with `openssl` printing ``generated`` (put_secret and $DC are recorders)."""
    out = tmp_path / "out"
    out.mkdir(parents=True)
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    for name in ("postgres_password.prev", "database_url.prev"):
        (secrets / name).write_text("stale")
    env = {"DC": fake_dc(tmp_path), "DC_LOG": str(tmp_path / "dc.log"), "OUT": str(out), "OPENBINDING_SECRETS_DIR": str(secrets)}
    script = (
        SUDO_SHIM + f"openssl() {{ printf '%s' '{generated}'; }}\n"
        'put_secret() { cat > "$OUT/$1"; }\n' + rotation_block(text, "password=$(openssl rand -hex 24)")
    )
    result = run_shell(script, env)
    problems = []
    stale = sorted(p.name for p in secrets.iterdir())
    if generated and stale:
        problems.append(f"stale .prev files survive the rotation: {stale}")
    if not generated and len(stale) != 2:
        problems.append("the .prev files were removed although the password is empty")
    if generated:
        stdin = (tmp_path / "dc.log.stdin").read_text() if (tmp_path / "dc.log.stdin").exists() else ""
        if stdin != f"ALTER ROLE openbinding PASSWORD '{generated}';\n":
            problems.append(f"the role is not given the new password: {stdin!r}")
        if (out / "postgres_password").read_text() != generated or generated not in (out / "database_url").read_text():
            problems.append("the files do not carry the new password")
    else:
        if (tmp_path / "dc.log").exists():
            problems.append("ALTER ROLE ran with an empty password")
        if list(out.iterdir()):
            problems.append("a secret file was written with an empty password")
        if "refuse:" not in result.stderr:
            problems.append("no refusal on standard error")
    return problems


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_postgres_password_rotation_alters_the_role_only_with_a_non_empty_password(tmp_path):
    assert password_rotation_problems(runbook_text(), tmp_path / "a", "abc123") == []
    assert password_rotation_problems(runbook_text(), tmp_path / "b", "") == []


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_postgres_password_rotation_without_the_empty_check_is_detected(tmp_path):
    guard = 'if [ -n "$password" ]; then'
    assert guard in runbook_text()
    problems = password_rotation_problems(runbook_text().replace(guard, "if true; then", 1), tmp_path / "mutated", "")
    assert "ALTER ROLE ran with an empty password" in problems, problems


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_postgres_password_rotation_removes_stale_previous_files_before_altering_the_role(tmp_path):
    body = section(runbook_text(), "Rotation")
    start = body.index("password=$(openssl rand -hex 24)")
    block = body[start : body.index("```", start)]
    steps = positions(
        block,
        ('if [ -n "$password" ]; then', "postgres_password.prev", "database_url.prev", "ALTER ROLE openbinding", "put_secret postgres_password"),
        "rotation",
    )
    assert steps == sorted(steps), "guard, removal of the stale .prev files, then ALTER ROLE, then the new files"
    assert "rm -f --" in block
    mutated = runbook_text().replace(
        "sudo sh -c 'rm -f -- \"$1/postgres_password.prev\" \"$1/database_url.prev\"' sh \"$OPENBINDING_SECRETS_DIR\" \\\n      && ", "", 1
    )
    assert mutated != runbook_text(), "the control is stale"
    problems = password_rotation_problems(mutated, tmp_path, "abc123")
    assert any(problem.startswith("stale .prev files survive") for problem in problems), problems


BUILTINS = {
    "printf", "echo", "[", "read", "unset", "local", "set", ":", "return", "exit", "true", "false", "export", "cd",
}  # fmt: skip
KEYWORDS = {"if", "then", "elif", "else", "while", "until", "do", "done", "fi", "!", "{", "}", "case", "esac", "for", "in"}
SECRET_REFERENCE = re.compile(r"\$\{?(?:old|new|password|v)\b")


def simple_commands(line: str) -> list[str]:
    """Splits a shell line at ``| & ;`` outside quotes and drops comments (a rough scanner, enough for the runbook)."""
    parts, current, quote, i = [], "", "", 0
    while i < len(line):
        char = line[i]
        if quote == "'":
            quote = "" if char == "'" else quote
        elif quote == '"':
            if char == "\\":
                current += line[i : i + 2]
                i += 2
                continue
            quote = "" if char == '"' else quote
        elif char in "'\"":
            quote = char
        elif char == "#" and (not current or current[-1].isspace()):
            break
        elif char in "|&;":
            parts.append(current)
            current = ""
            i += 1
            continue
        current += char
        i += 1
    return [part.strip() for part in [*parts, current] if part.strip()]


def expanded_outside_single_quotes(text: str) -> str:
    """``text`` without the single-quoted parts (nothing expands there); a quote inside double quotes is a plain character."""
    kept, quote = "", ""
    for char in text:
        if quote == "'":
            quote = "" if char == "'" else quote
        elif quote == '"':
            quote = "" if char == '"' else quote
            kept += char
        elif char in "'\"":
            quote = char
            kept += char if char == '"' else ""
        else:
            kept += char
    return kept


def secret_argument_problems(text: str) -> list[str]:
    """A secret variable in the argument list of a command that is not a shell builtin (visible in ps and logs)."""
    problems = []
    for line in commands(text):
        for command in simple_commands(line):
            words = command.split()
            while words and words[0] in KEYWORDS:
                words = words[1:]
            if words and (re.match(r"[A-Za-z_]\w*=", words[0]) or words[0] == "local") and "$(" in command:
                words = command.split("$(", 1)[1].split()  # the command substitution of an assignment is a command
            elif not words or re.match(r"[A-Za-z_]\w*=", words[0]):
                continue
            if words[0] in BUILTINS:
                continue
            if SECRET_REFERENCE.search(expanded_outside_single_quotes(" ".join(words[1:]))):
                problems.append(command)
    return problems


OLD_UNDO_LINE = '''    old=$(sudo cat "$dir/postgres_password.prev") && [ -n "$old" ] \\
      && printf ':%s@' "$old" | sudo grep -qF -f - "$dir/database_url.prev" \\
'''


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_never_passes_a_secret_variable_as_an_argument_of_a_command():
    assert secret_argument_problems(runbook_text()) == []
    assert len([line for line in commands(runbook_text()) if SECRET_REFERENCE.search(line)]) >= 6, "the scan sees the secrets"


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_secret_argument_rule_detects_the_old_undo_line():
    text = runbook_text()
    assert OLD_UNDO_LINE in text, "the control is stale"
    reintroduced = text.replace(OLD_UNDO_LINE, '    old=$(sudo cat "$dir/postgres_password.prev") && [ -n "$old" ] && sudo grep -qF ":$old@" "$dir/database_url.prev" \\\n', 1)
    assert any("grep -qF" in problem for problem in secret_argument_problems(reintroduced))


# [utest->req~lab-deployment-production-runbook~1]
@pytest.mark.parametrize(
    ("line", "bad"),
    [
        ('sudo grep -qF ":$old@" file', True),
        ('$DC exec postgres psql -c "ALTER ROLE x PASSWORD \'$password\'"', True),
        ('sudo put_secret x "${new}"', True),
        ('docker run -e "K=$v" image', True),
        ('printf \'%s\' "$v" | put_secret space_api_key 10001', False),
        ('printf \':%s@\' "$old" | sudo grep -qF -f - file', False),
        ('if [ -n "$new" ] && [ -n "$old" ]; then', False),
        ('old=$(sudo cat "$dir/x")', False),
        ('n=$(sudo grep -cF ":$old@" f)', True),
        ('local x=$(sudo grep -cF ":$old@" f)', True),
        ('echo "$password" # sudo grep "$password"', False),
        ("sudo sh -c 'echo $old' sh", False),
    ],
)
def test_runbook_secret_argument_rule_cases(line, bad):
    assert bool(secret_argument_problems(f"```bash\n{line}\n```\n")) is bad


def dc_services(text: str) -> list[str]:
    """The service names that the ``$DC`` commands of the bash blocks pass to stop, restart, up, exec and logs."""
    found = []
    for line in commands(text):
        for match in re.finditer(r"\$DC (stop|restart|up|exec|logs)\b([^|;&>]*)", line):
            verb, rest = match.groups()
            tokens, skip = [], False
            for token in rest.split(" #", 1)[0].split():  # a trailing shell comment is not a service name
                if skip:
                    skip = False
                elif token in ("--tail", "--scale"):
                    skip = True
                elif not token.startswith("-"):
                    tokens.append(token)
                    if verb == "exec":
                        break
            found += tokens
    return found


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_compose_commands_name_services_that_exist():
    names = dc_services(runbook_text())
    assert len(names) >= 25, "the parser found too few service names: it no longer reads the runbook"
    assert set(names) <= EXPECTED_SERVICES, sorted(set(names) - EXPECTED_SERVICES)
    assert {"postgres", "gateway", "nginx", "worker", "analysis-worker", "pg-backup", "migrate"} <= set(names)


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_compose_service_check_detects_an_unknown_service():
    assert "gatway" in dc_services("```bash\n$DC restart gatway\n```\n")
    assert "gatway" in dc_services("```bash\n$DC up -d --force-recreate gateway gatway\n```\n")
    assert dc_services("```bash\n$DC up -d --scale worker=3\n```\n") == []


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_tls_directory_and_key_modes():
    text = runbook_text()
    site = section(text, "site.env")
    assert 'install -d -m 0750 -o root -g root "$NGINX_SSL_DIR"' in site
    assert 'install -m 0600 -o root -g root privkey.pem "$NGINX_SSL_DIR/privkey.pem"' in site
    assert "install -m 0600 -o root -g root <new privkey.pem>" in section(text, "TLS renewal")
    assert "`privkey.pem` at 0600 root" in section(text, "Deploying a release")


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_site_env_states_that_space_url_is_https_and_the_checks_agree():
    site = section(runbook_text(), "site.env")
    assert "`SPACE_URL` **must be an `https://` URL**" in site
    assert f"\nSPACE_URL={REMOTE_SPACE_URL}\n" in site
    assert "SPACE_URL=https://" in CI_ENV.read_text(encoding="utf-8")


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_first_install_empties_the_bootstrap_password_after_the_first_login():
    body = section(runbook_text(), "First install")
    start = body.index("7. After the first sign-in")
    block = body[start:]
    steps = positions(
        block,
        (
            "printf '' | put_secret bootstrap_admin_password 10001 allow-empty",
            "s/^BOOTSTRAP_ADMIN_USERNAME=.*/BOOTSTRAP_ADMIN_USERNAME=/",
            "s/^BOOTSTRAP_ADMIN_EMAIL=.*/BOOTSTRAP_ADMIN_EMAIL=/",
            '"$SITE_ENV"',
            "unset BOOTSTRAP_ADMIN_USERNAME BOOTSTRAP_ADMIN_EMAIL",
            "$DC up -d --force-recreate gateway",
            "$DC restart nginx",
            'sudo rm -f -- "$OPENBINDING_SECRETS_DIR/bootstrap_admin_password.prev"',
        ),
        "First install step 7",
    )
    assert steps == sorted(steps)
    assert body.index("6. Run the [verification]") < start
    assert "harmless" not in runbook_text()


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_first_install_clearing_of_the_bootstrap_variables_works_on_a_site_env(tmp_path):
    body = section(runbook_text(), "First install")
    start = body.index("sudo sed -i -e 's/^BOOTSTRAP_ADMIN_USERNAME=")
    assert "belongs" not in body and "write access" not in body
    assert "owned by the operator user" in section(runbook_text(), "site.env")
    end = body.index('"$SITE_ENV"', start) + len('"$SITE_ENV"')
    sed = SUDO_SHIM + textwrap.dedent(body[body.rindex("\n", 0, start) + 1 : end])
    assert body[end:].startswith(" \\\n     && unset BOOTSTRAP_ADMIN_USERNAME BOOTSTRAP_ADMIN_EMAIL \\\n     && $DC up -d --force-recreate gateway")
    site = tmp_path / "site.env"
    site.write_text("PUBLIC_ORIGIN=https://openbinding.example.org\nBOOTSTRAP_ADMIN_USERNAME=root\nBOOTSTRAP_ADMIN_EMAIL=a@example.org\nBACKUP_RETENTION_DAYS=14\n")
    result = run_shell(sed, {"SITE_ENV": str(site)})
    assert result.returncode == 0, result.stderr
    assert site.read_text() == (
        "PUBLIC_ORIGIN=https://openbinding.example.org\nBOOTSTRAP_ADMIN_USERNAME=\nBOOTSTRAP_ADMIN_EMAIL=\nBACKUP_RETENTION_DAYS=14\n"
    )


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_first_install_secrets_block_is_for_a_fresh_host_only():
    body = section(runbook_text(), "Secrets directory")
    assert "**The block after the function is for a fresh host only.**" in body
    assert "# FRESH HOST ONLY" in body
    assert body.index("# FRESH HOST ONLY") < body.index("password=$(openssl rand -hex 24)")
    assert "Never run it again after the" in body
    assert "FRESH HOST ONLY" not in section(runbook_text(), "Rotation")


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_host_prerequisites_and_blocked_items_state_what_was_not_done():
    text = runbook_text()
    host = section(text, "Host prerequisites")
    assert "rootful Docker Engine" in host and "userns-remap" in host and "rootless" in host
    blocked = section(text, "What stays blocked")
    assert "Non-root users and dropped capabilities" in blocked and "F7" in blocked and "cap_drop" in blocked
    assert "restart: true" in section(text, "What is deployed")
    assert "Compose 2.17" in section(text, "What is deployed")


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_follow_up_f7_and_the_trace_follow_up_are_recorded_in_the_tasks():
    tasks = (REPO_ROOT / "openspec" / "changes" / "m09-compose-only" / "tasks.md").read_text(encoding="utf-8")
    assert "F7" in tasks and "cap_drop" in tasks and "R1-SEC-003" in tasks
    assert "F8" in tasks and "OFT trace paths" in tasks
    assert "F9" in tasks and "R2-REV-002" in tasks and "resolver" in tasks


# [utest->req~lab-deployment-production-health-restart~1]
def test_runbook_says_that_only_nginx_restarts_with_the_gateway_and_that_a_daemon_restart_needs_a_manual_one():
    text = runbook_text()
    deployed = " ".join(section(text, "What is deployed").split())
    assert "`nginx` therefore depends on `gateway` with `restart: true`" in deployed
    assert "The workers wait for a healthy `gateway` but do not restart with it" in deployed
    assert "`nginx` and the workers therefore depend" not in deployed
    assert "#502-after-a-gateway-restart" in deployed
    body = section(text, "Verification")
    assert "### 502 after a gateway restart" in body
    after = " ".join(body[body.index("### 502 after a gateway restart") :].split())
    for needle in ("crash or an out-of-memory kill", "502 Bad Gateway", "$DC restart nginx", "F9"):
        assert needle in after, needle
    assert "#502-after-a-gateway-restart" in section(text, "What stays blocked")
    # The anchor of the heading is the link target used above.
    assert "502-after-a-gateway-restart" == re.sub(r"[^a-z0-9]+", "-", "502 after a gateway restart".lower()).strip("-")
