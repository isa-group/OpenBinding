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
LAB_SERVICE = {"analysis-worker": "worker"}

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
        node = config
        for key in path[:-1]:
            node = node[key]
        if value is _DELETE:
            del node[path[-1]]
        else:
            node[path[-1]] = value

    return apply


def append(*path, item):
    def apply(config: dict) -> None:
        node = config
        for key in path:
            node = node[key]
        node.append(item)

    return apply


def assert_caught(rule, mutation, fragment: str) -> None:
    """The mutated production file breaks ``rule``, and the problem names ``fragment``."""
    config = production()
    mutation(config)
    problems = rule(config)
    assert problems, f"the rule accepted a file that should break it ({fragment})"
    assert fragment in " | ".join(problems), problems


# -- project: standalone, exact services (compose-only) --------------------------------------------------------


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


# [utest->req~lab-deployment-compose-only~1]
def test_production_file_exists():
    assert PRODUCTION.is_file(), "deploy/compose/production/compose.yaml"


# [utest->req~lab-deployment-compose-only~1]
def test_production_is_a_standalone_project_with_the_exact_service_set():
    config = production()
    assert not project_problems(config)
    assert len(config["services"]) == 13


# [utest->req~lab-deployment-compose-only~1]
@pytest.mark.parametrize(
    ("mutation", "fragment"),
    [
        (edit("name", value="openbinding"), "name is"),
        (edit("services", "engine-minizinc"), "missing service engine-minizinc"),
        (edit("services", "space-api", value={"image": "x"}), "unexpected service space-api"),
        (edit("services", "gateway", "build", value={"context": "."}), "gateway: uses build"),
        (edit("services", "redis", "profiles", value=["prod"]), "redis: uses profiles"),
        (edit("services", "nginx", "extends", value={"service": "x"}), "nginx: uses extends"),
        (edit("include", value=["../../../docker-compose.yml"]), "top-level include"),
    ],
    ids=["name", "missing-service", "extra-service", "build", "profiles", "extends", "include"],
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
    for variable, value in images.items():
        if not variable.endswith("_IMAGE"):
            problems.append(f"{variable}: not an _IMAGE variable")
        elif not PINNED_IMAGE.fullmatch(value):
            problems.append(f"{variable}: {value!r} is not name:tag@sha256:<64 hex>")
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
    ],
    ids=["tag-only", "short-digest", "uppercase-digest", "third-party-marker", "marker-not-zeros", "no-digest", "unused"],
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
    ],
    ids=["literal-image", "build", "no-required-marker", "default-image", "undefined-variable"],
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
        if env.get("APP_ENV", "prod") != "prod":
            problems.append(f"{name}: APP_ENV is {env['APP_ENV']!r}")
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
    ],
)
def test_production_secret_rule_detects(mutation, fragment):
    assert_caught(secret_problems, mutation, fragment)


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
    ],
)
def test_production_health_rule_detects(mutation, fragment):
    assert_caught(health_problems, mutation, fragment)


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


# [utest->req~lab-deployment-production-backups~1]
def test_production_backup_rule_detects_an_unescaped_dollar_in_the_script():
    def unescape(config: dict) -> None:
        command = config["services"]["pg-backup"]["command"]
        command[0] = command[0].replace("$${stamp}", "${stamp}", 1)

    assert_caught(backup_problems, unescape, "unescaped $")


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


# -- network, ports, SPACE (compose-only) -----------------------------------------------------------------


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


# [utest->req~lab-deployment-compose-only~1]
def test_production_only_nginx_publishes_ports_and_one_network_carries_everything():
    config = production()
    assert not network_problems(config)
    assert config["x-subnet"] == config["networks"][PROJECT_NETWORK]["ipam"]["config"][0]["subnet"]


# [utest->req~lab-deployment-compose-only~1]
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


# [utest->req~lab-deployment-compose-only~1]
def test_production_mounts_the_checkout_examples_for_nginx():
    mounts = production()["services"]["nginx"]["volumes"]
    assert "../../../examples:/opt/openbinding/examples:ro" in mounts
    assert (PRODUCTION_DIR / "../../../examples").resolve() == (REPO_ROOT / "examples").resolve()


# -- site variables, ci.env, real names (production-secret-files, compose-only) -------------------------------


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


# [utest->req~lab-deployment-compose-only~1]
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
LOCAL_SPACE_HEADING = "Local SPACE (owner decision local-space)"
LOCAL_SPACE_ANCHOR = "#local-space-owner-decision-local-space"
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


def runbook_problems(config: dict, text: str, compose_text: str) -> list[str]:
    """Every service, secret, _IMAGE and required variable of compose.yaml is named; the render command is there."""
    names = [
        *(("service", n) for n in _services(config)),
        *(("secret", n) for n in (config.get("secrets") or {})),
        *(("variable", n) for n in sorted(set(REQUIRED_VARIABLE.findall(compose_text)))),
    ]
    problems = [f"{kind} {name} is not named" for kind, name in names if not _names_in(text, name)]
    if RENDER_COMMAND not in text:
        problems.append("the render command is missing")
    if "us.es" in text:
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


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_preflight_checks_values_not_comments_before_deploying():
    deploy = section(runbook_text(), "Deploying a release")
    markers = ("cp images.env", "git checkout", "gap\\.invalid", "$DC pull", "$DC up -d")
    steps = [deploy.index(marker) for marker in markers]
    assert steps == sorted(steps), "save images.env, check out the tag, pre-flight, pull, up"
    assert "grep -n 'gap" not in runbook_text()


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
    assert body.index("restore the database") < body.index("images.env")
    # The old dump goes into a new database (a --clean restore leaves the objects only the new schema has).
    assert "DROP DATABASE openbinding" in body
    assert "--clean" not in body.split("did not add a migration")[0].split("```bash")[1]


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
def test_runbook_restore_drill_is_for_a_spare_host():
    body = section(runbook_text(), "Restore drill")
    assert "spare host" in body
    assert "172.29.40.0/24" in body


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_renders_with_the_command_of_ci():
    assert RENDER_COMMAND in runbook_text()


# [utest->req~lab-deployment-production-runbook~1]
def test_runbook_local_space_decision_is_recorded_and_compose_has_no_space_service():
    text = runbook_text()
    assert f"## {LOCAL_SPACE_HEADING}" in text
    body = section(text, LOCAL_SPACE_HEADING)
    for needle in ("INTENT.md", "SPACE_URL", "space-api", "space-mongo", "space-redis", "test_no_local_space.py"):
        assert needle in body, needle
    assert LOCAL_SPACE_ANCHOR in section(text, "What stays blocked")
    config = production()
    for kind in ("services", "networks", "volumes"):
        assert not [name for name in config[kind] if "space" in name.lower() or "sphere" in name.lower()], kind
