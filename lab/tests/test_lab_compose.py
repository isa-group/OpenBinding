"""Static checks of ``compose.lab.json`` and its nginx configuration, without Docker.

They mirror the rules of the supervisor's ``lab_compose`` validator, so a file it
would refuse fails here first, and add the project's own rules (memory budget,
secrets, one published port, who may hold the session-signing secret).

Run from ``openbinding-gateway`` with its environment::

    uv run --locked pytest ../lab/tests
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "compose.lab.json"
PGTEST_COMPOSE = ROOT / "compose.pgtest.json"
NAME_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,62}")
NGINX_DIR = ROOT / "lab" / "nginx"
DEMO_DOC = ROOT / "docs" / "DEMO.md"

ALLOWED_TOP_LEVEL = {"name", "services", "networks", "volumes"}
FORBIDDEN_SERVICE_KEYS = {
    "privileged", "devices", "cap_add", "pid", "ipc", "container_name", "extends",
    "env_file", "secrets", "configs", "volumes_from", "deploy",
}
ALLOWED_BUILD_KEYS = {"context", "dockerfile", "args", "target"}
ALLOWED_MOUNT_KEYS = {"type", "source", "target"}
MAX_SERVICES = 15
MAX_MIB = 4096
TARGET_MIB = 3481  # 3.4 GiB
PUBLISHED = {"target": 8080, "published": 18100, "host_ip": "127.0.0.1"}
PORT_RANGE = range(18100, 18200)

# Supplied privately by the supervisor; referenced as ${NAME}, never given a value or a default.
PRIVATE_VARIABLES = {
    "SPACE_API_KEY", "SPACE_ORGANIZATION_ID", "SPACE_URL",
    "SPHERE_API_KEY", "SPHERE_ORGANIZATION_ID", "SPHERE_URL",
}
# Assembled from parts so a repository-wide search for the retired key finds no literal here.
DESTRUCTIVE_KEY = "SPACE_" + "DESTRUCTIVE_API_KEY"
SECRET_NAME = re.compile(r"KEY|SECRET|TOKEN|PASSWORD", re.IGNORECASE)
SECRET_SHAPES = re.compile(
    r"BEGIN [A-Z ]*PRIVATE KEY|\bsk-[A-Za-z0-9]{16,}|\beyJ[A-Za-z0-9_-]{10,}\.|\bAKIA[0-9A-Z]{12,}"
    r"|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}"
)
REFERENCE = re.compile(r"\$\{([^}]*)\}")
WHOLE_REFERENCE = re.compile(r"\$\{[A-Z][A-Z0-9_]*\}")

# The gateway is the only service that signs sessions.  Everything else either never verifies a
# token (workers, engines, bim-service, web) or talks to the gateway over HTTP (seed): a seed that
# logs in sends a password and receives a token, so it needs no secret of its own.  The seed tools
# of the repository write to the database directly.  Least privilege: the secret stays in one place.
JWT_SECRET = "GATEWAY_JWT_SECRET"
JWT_HOLDERS = {"gateway"}
# Variables of the gateway the seed does not get, with the reason.
SEED_OMITS = {
    JWT_SECRET: "the seed never signs or verifies a session",
    "FORWARDED_ALLOW_IPS": "the seed serves no HTTP",
    "DEMO_BIM_TOKEN": "no BIM token file is created for the seed; a later phase may add it",
    "BIM_MODE": "same",
    "BIM_SERVICE_URL": "same",
    "BIM_SERVICE_TOKEN_FILE": "same",
}
# Variables only the seed gets (tools/remote_probe.py exits without it).
SEED_EXTRAS = {"SPACE_ORGANIZATION_ID"}


@pytest.fixture(scope="module")
def compose() -> dict:
    return json.loads(COMPOSE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def services(compose) -> dict:
    return compose["services"]


def _mib(value) -> int:
    match = re.fullmatch(r"(\d+)([mg])", str(value))
    assert match, f"mem_limit must be an integer with m or g, not {value!r}"
    return int(match.group(1)) * (1024 if match.group(2) == "g" else 1)


def _env(service: dict) -> dict:
    env = service.get("environment") or {}
    assert isinstance(env, dict), "environment must be an object"
    return {str(k): "" if v is None else str(v) for k, v in env.items()}


def _strings(node):
    """Every string in a JSON value, keys of objects included."""
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for key, value in node.items():
            yield str(key)
            yield from _strings(value)
    elif isinstance(node, list):
        for item in node:
            yield from _strings(item)


def _command_text(service: dict) -> str:
    parts = []
    for key in ("command", "entrypoint"):
        value = service.get(key) or ""
        parts.append(value if isinstance(value, str) else " ".join(map(str, value)))
    return " ".join(parts)


def _total_mib(services: dict) -> int:
    return sum(_mib(service["mem_limit"]) for service in services.values())


# -- shape ---------------------------------------------------------------------------------------


def test_json_is_valid_and_only_allowed_top_level_keys(compose):
    assert set(compose) <= ALLOWED_TOP_LEVEL
    assert {"name", "services"} <= set(compose)


def test_top_level_volumes_and_networks_carry_only_labels(compose):
    for section in ("networks", "volumes"):
        for name, definition in (compose.get(section) or {}).items():
            assert set(definition or {}) <= {"labels"}, f"{section}.{name}"


@pytest.mark.parametrize("path", [COMPOSE, PGTEST_COMPOSE], ids=lambda p: p.name)
def test_service_volume_and_network_names_match_the_validator_pattern(path):
    # Underscores are refused; environment variable keys are not names and may have them.
    data = json.loads(path.read_text(encoding="utf-8"))
    names = [*data["services"], *(data.get("volumes") or {}), *(data.get("networks") or {})]
    assert names
    bad = [name for name in names if not NAME_PATTERN.fullmatch(name)]
    assert not bad, f"{path.name}: {bad}"
    for service in data["services"].values():
        for mount in service.get("volumes", []):
            if mount["type"] == "volume":
                assert NAME_PATTERN.fullmatch(mount["source"]), mount


@pytest.mark.parametrize("path", [COMPOSE, PGTEST_COMPOSE], ids=lambda p: p.name)
def test_postgres_runs_as_a_non_root_user_with_pgdata_in_a_subdirectory(path):
    # The supervisor drops every capability; the stock root entrypoint cannot chown without them.
    postgres = json.loads(path.read_text(encoding="utf-8"))["services"]["postgres"]
    uid = str(postgres["user"]).split(":")[0]
    assert uid.isdigit() and int(uid) != 0
    pgdata = _env(postgres)["PGDATA"]
    targets = [m["target"] for m in postgres["volumes"]]
    assert pgdata.startswith(tuple(t.rstrip("/") + "/" for t in targets)), pgdata
    assert postgres["healthcheck"]["test"]


def test_service_count(services):
    assert 1 <= len(services) <= MAX_SERVICES


@pytest.mark.parametrize("key", sorted(FORBIDDEN_SERVICE_KEYS))
def test_no_forbidden_service_key(services, key):
    for name, service in services.items():
        assert key not in service, f"{name} uses {key}"


def test_no_network_mode_other_than_none_and_no_service_networks(services):
    for name, service in services.items():
        assert service.get("network_mode", "none") == "none", name
        assert "networks" not in service, name
        assert "tmpfs" not in service, f"{name}: use a structured tmpfs volume"


def test_no_socket_anywhere(compose):
    assert not [s for s in _strings(compose) if ".sock" in s]


def test_no_space_services(services):
    # SPACE and SPHERE are remote; no local SPACE deployment may come back.
    assert not [name for name in services if name.startswith("space")]
    assert not [name for name in services if "space" in name.split("-")]


def test_seed_exists_behind_the_seed_profile(services):
    assert services["seed"]["profiles"] == ["seed"]
    assert [name for name, s in services.items() if "profiles" in s] == ["seed"]
    assert services["seed"]["command"][:2] == ["sh", "-c"]
    assert services["seed"]["command"][2] == "python tools/${DEMO_SEED_TOOL} ${DEMO_SEED_ARGS}"


# -- ports ---------------------------------------------------------------------------------------


def test_single_published_port_on_loopback(services):
    ports = [(name, port) for name, s in services.items() for port in s.get("ports", [])]
    assert [name for name, _ in ports] == ["web"]
    for _, port in ports:
        assert isinstance(port, dict), "ports must be structured objects"
        assert set(port) <= {"target", "published", "host_ip"}
        assert port["host_ip"] == "127.0.0.1"
        assert int(port["published"]) in PORT_RANGE
    assert ports[0][1] == PUBLISHED


def test_no_expose_of_published_ports_on_other_services(services):
    # Only `web` is reachable from the host; the rest talk over the compose network.
    for name, service in services.items():
        if name != "web":
            assert not service.get("ports"), name


# -- memory --------------------------------------------------------------------------------------


def test_every_service_has_a_mem_limit(services):
    for name, service in services.items():
        assert "mem_limit" in service, f"{name} has no mem_limit"
        _mib(service["mem_limit"])


def test_memory_sum_is_within_the_lab_ceiling_and_the_target(services):
    total = _total_mib(services)
    assert total <= MAX_MIB, total
    assert total <= TARGET_MIB, total


def test_java_engines_cap_the_heap_below_the_container_limit(services):
    java = [n for n in ("engine-random-search", "engine-many-heuristic", "engine-evolutionary-heuristics")]
    for name in java:
        options = _env(services[name])["JAVA_TOOL_OPTIONS"]
        heap = int(re.search(r"-Xmx(\d+)m", options).group(1))
        assert heap == 192, name
        assert _mib(services[name]["mem_limit"]) >= heap + 96, name


# -- mounts and builds ---------------------------------------------------------------------------


def _mounts(services):
    return [(name, mount) for name, s in services.items() for mount in s.get("volumes", [])]


def test_volumes_are_structured_and_declared(compose, services):
    declared = set(compose.get("volumes") or {})
    used = set()
    for name, mount in _mounts(services):
        assert isinstance(mount, dict), f"{name}: volume entries must be objects"
        assert mount["type"] in {"bind", "volume", "tmpfs"}, (name, mount)
        assert set(mount) <= ALLOWED_MOUNT_KEYS, (name, mount)
        assert mount["target"].startswith("/"), (name, mount)
        if mount["type"] == "volume":
            assert mount["source"] in declared, (name, mount)
            used.add(mount["source"])
        if mount["type"] == "tmpfs":
            assert "source" not in mount, (name, mount)
    assert used == declared, "a declared volume is unused, or a used one is undeclared"


def test_binds_are_relative_literal_and_exist(services):
    binds = [(n, m) for n, m in _mounts(services) if m["type"] == "bind"]
    assert binds
    for name, mount in binds:
        source = mount["source"]
        parts = source.split("/")
        assert not source.startswith("/") and ".." not in parts and "${" not in source, (name, mount)
        assert (ROOT / source).is_dir(), (name, mount)


def test_only_configuration_and_seed_tools_are_bound(services):
    # The only code the lab mounts is the seed tools directory (the image does not carry
    # tools/); nginx gets its configuration.  Nothing else.
    binds = {(n, m["source"], m["target"]) for n, m in _mounts(services) if m["type"] == "bind"}
    assert binds == {
        ("web", "./lab/nginx", "/etc/nginx/conf.d"),
        ("seed", "./openbinding-gateway/tools", "/app/tools"),
    }


def test_builds_use_only_allowed_keys_and_literal_paths_inside_the_repo(services):
    builds = {n: s["build"] for n, s in services.items() if "build" in s}
    assert builds
    for name, build in builds.items():
        assert set(build) <= ALLOWED_BUILD_KEYS, name
        for key in ("context", "dockerfile"):
            value = build[key]
            assert "${" not in value and not value.startswith("/") and ".." not in value.split("/"), (name, key)
        context = ROOT / build["context"]
        assert context.is_dir(), (name, build)
        assert (context / build["dockerfile"]).is_file(), (name, build)
        for key, value in (build.get("args") or {}).items():
            assert not SECRET_NAME.search(key), f"{name}: build arg {key} looks like a secret"
            assert "${" not in str(value), (name, key)


def test_gateway_worker_and_seed_share_one_always_rebuilt_image(services):
    # ``up --build`` rebuilds only profile-less services; ``run --no-deps seed`` reuses an existing
    # image.  So only the gateway builds, and worker and seed use the image it tags.
    image = "openbinding-lab-gateway:latest"
    assert "build" in services["gateway"]
    for name in ("gateway", "worker", "seed"):
        assert services[name]["image"] == image, name
    assert "build" not in services["worker"] and "build" not in services["seed"]
    assert services["worker"]["depends_on"]["gateway"]["condition"] == "service_healthy"


def test_frontend_is_built_for_the_api_prefix(services):
    build = services["web"]["build"]
    assert build["context"] == "frontend" and build["target"] == "prod"
    assert build["args"] == {"VITE_API_BASE_URL": "/api"}
    assert not [k for k in build["args"] if k.startswith("VITE_") and SECRET_NAME.search(k)]


# -- secrets -------------------------------------------------------------------------------------


def test_secret_variables_are_never_literal(services):
    for name, service in services.items():
        for key, value in _env(service).items():
            if SECRET_NAME.search(key) and not key.endswith("_FILE"):  # *_FILE names a path, not a value
                assert WHOLE_REFERENCE.fullmatch(value), f"{name}:{key} must be a ${{VARIABLE}} reference"


def test_database_url_takes_its_password_from_a_reference(services):
    for name in ("gateway", "worker", "seed"):
        url = _env(services[name])["DATABASE_URL"]
        assert url == "postgresql+asyncpg://openbinding:${DEMO_PG_PASSWORD}@postgres:5432/openbinding", name


def test_references_are_demo_or_private_and_never_have_defaults(compose):
    seen = set()
    for text in _strings(compose):
        for body in REFERENCE.findall(text):
            assert re.fullmatch(r"[A-Z][A-Z0-9_]*", body), f"reference with a default or modifier: ${{{body}}}"
            assert body.startswith("DEMO_") or body in PRIVATE_VARIABLES, body
            seen.add(body)
    assert seen & PRIVATE_VARIABLES, "the private SPACE/SPHERE variables are expected to be referenced"


def test_no_real_secret_shapes_and_no_destructive_key(compose):
    text = COMPOSE.read_text(encoding="utf-8")
    assert not SECRET_SHAPES.search(text)
    assert DESTRUCTIVE_KEY not in text
    assert "VITE_API_KEY" not in text


def test_private_variables_are_passed_by_reference_only(services):
    for name, service in services.items():
        for key, value in _env(service).items():
            if key in PRIVATE_VARIABLES:
                assert value == f"${{{key}}}", f"{name}:{key}"
    gateway = _env(services["gateway"])
    assert gateway["SPACE_ENABLED"] == "true" and gateway["SPHERE_ENABLED"] == "true"


def test_demo_bim_token_is_expanded_by_the_shell_not_by_compose(services):
    # `$$` is compose's escape: the token is read from the container's own environment and
    # never baked into the command line that `docker inspect` shows.
    for name in ("bim-service", "gateway"):
        command = " ".join(services[name]["command"])
        assert '"$$DEMO_BIM_TOKEN"' in command, name
        assert "${DEMO_BIM_TOKEN}" not in command, name
        assert "umask 077" in command, name
        assert _env(services[name])["DEMO_BIM_TOKEN"] == "${DEMO_BIM_TOKEN}", name


# -- who holds the session-signing secret ---------------------------------------------------------


def test_only_the_gateway_holds_the_jwt_secret(services):
    holders = {
        name
        for name, service in services.items()
        if JWT_SECRET in _env(service) or JWT_SECRET in json.dumps(service)
    }
    assert holders == JWT_HOLDERS


def test_workers_and_seed_do_not_receive_the_jwt_secret(services):
    # The repository's own test (tests/test_compose_worker_secrets.py) requires it of dramatiq services.
    dramatiq = [n for n, s in services.items() if "dramatiq" in _command_text(s)]
    assert dramatiq == ["worker"]
    for name in dramatiq + ["seed"]:
        assert JWT_SECRET not in _env(services[name]), name
        assert "DEMO_JWT_SECRET" not in json.dumps(services[name]), name
    assert _env(services["gateway"])[JWT_SECRET] == "${DEMO_JWT_SECRET}"


def test_seed_environment_is_the_gateways_minus_the_documented_omissions(services):
    gateway, seed = _env(services["gateway"]), _env(services["seed"])
    missing = set(gateway) - set(seed) - set(SEED_OMITS)
    assert not missing, f"the seed lacks gateway variables: {sorted(missing)}"
    assert set(seed) - set(gateway) == SEED_EXTRAS
    for key in set(seed) - SEED_EXTRAS:
        assert seed[key] == gateway[key], key


def test_space_organization_id_is_only_in_the_seed_as_a_bare_reference(services):
    # tools/remote_probe.py requires it; nothing else reads it.
    holders = [name for name, s in services.items() if "SPACE_ORGANIZATION_ID" in _env(s)]
    assert holders == ["seed"]
    assert _env(services["seed"])["SPACE_ORGANIZATION_ID"] == "${SPACE_ORGANIZATION_ID}"


def test_worker_has_the_variables_it_needs(services):
    worker = _env(services["worker"])
    assert worker["JOB_DISPATCH_MODE"] == "dramatiq"
    assert worker["FEDERATION_SECRET_KEY"] == "${DEMO_FERNET_KEY}"
    assert worker["DATABASE_URL"] == _env(services["gateway"])["DATABASE_URL"]


# -- gateway behaviour ---------------------------------------------------------------------------


def test_gateway_environment(services):
    env = _env(services["gateway"])
    assert env["APP_ENV"] == "dev"
    assert env["CAS_ENABLED"] == "false"
    assert env["CORS_ALLOW_ORIGINS"] == "http://localhost:18100,http://127.0.0.1:18100"
    assert env["FEDERATION_SECRET_KEY"] == "${DEMO_FERNET_KEY}"  # the name settings.py reads
    assert env["SPACE_PRICING_VERSION"] == "${DEMO_SPACE_PRICING_VERSION}"
    assert env["SPACE_DEFAULT_PLAN"] == "${DEMO_SPACE_DEFAULT_PLAN}"
    assert int(env["MAX_CONCURRENT_JOBS_PER_USER"]) >= 1
    assert (env["BIM_MODE"], env["BIM_SERVICE_URL"]) == ("http", "http://bim-service:8080")
    assert env["BIM_SERVICE_TOKEN_FILE"].startswith("/run/bim/")


def test_gateway_trusts_proxy_headers_only_from_private_networks(services):
    gateway = services["gateway"]
    assert "--proxy-headers" in " ".join(gateway["command"])
    allowed = _env(gateway)["FORWARDED_ALLOW_IPS"]
    assert "*" not in allowed
    assert allowed.split(",") == ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]


def test_gateway_command_goes_through_the_migrating_entrypoint(services):
    # docker-entrypoint.sh runs `alembic upgrade head` when DATABASE_URL is set, then execs the command.
    gateway = services["gateway"]
    assert "entrypoint" not in gateway
    assert "DATABASE_URL" in _env(gateway)
    assert "docker-entrypoint.sh" in (ROOT / "openbinding-gateway" / "Dockerfile").read_text(encoding="utf-8")
    assert "alembic upgrade head" in (ROOT / "openbinding-gateway" / "docker-entrypoint.sh").read_text(encoding="utf-8")


def test_bim_service_reads_its_tokens_from_a_tmpfs(services):
    bim = services["bim-service"]
    env = _env(bim)
    assert {"type": "tmpfs", "target": "/run/bim"} in bim["volumes"]
    assert env["BIM_SERVICE_TOKENS_FILE"].startswith("/run/bim/")
    assert env["BIM_SERVICE_TOKENS_FILE"] in " ".join(bim["command"])
    assert "8080" in " ".join(bim["command"])
    assert "/healthz" in " ".join(bim["healthcheck"]["test"])


def test_gateway_waits_for_what_it_uses(services):
    depends = services["gateway"]["depends_on"]
    assert {"postgres", "redis", "bim-service"} <= set(depends)
    assert {n for n in services if n.startswith("engine-")} <= set(depends)
    assert set(services["worker"]["depends_on"]) == {"gateway", "redis"}
    assert set(services["web"]["depends_on"]) == {"gateway"}


def test_named_volumes_back_the_stateful_services(services):
    assert {"type": "volume", "source": "lab-pg", "target": "/var/lib/postgresql/data"} in services["postgres"]["volumes"]
    assert {"type": "volume", "source": "lab-redis", "target": "/data"} in services["redis"]["volumes"]
    assert services["postgres"]["image"] == "postgres:16-alpine"
    assert services["redis"]["image"] == "redis:7-alpine"
    assert "pg_isready" in " ".join(services["postgres"]["healthcheck"]["test"])
    assert "noeviction" in services["redis"]["command"]  # the job queue must never be evicted


# -- health and ordering -------------------------------------------------------------------------


def test_long_running_services_have_healthchecks(services):
    for name, service in services.items():
        if name == "seed":
            continue
        assert service.get("healthcheck", {}).get("test"), f"{name} has no healthcheck"


def test_depends_on_points_to_existing_services_with_healthchecks(services):
    for name, service in services.items():
        for dependency, rule in (service.get("depends_on") or {}).items():
            assert dependency in services, (name, dependency)
            assert rule == {"condition": "service_healthy"}, (name, dependency)
            assert "healthcheck" in services[dependency], (name, dependency)
            assert "profiles" not in services[dependency], (name, dependency)


# -- nginx ---------------------------------------------------------------------------------------


def _nginx_conf() -> str:
    confs = sorted(NGINX_DIR.glob("*.conf"))
    assert [c.name for c in confs] == ["default.conf"]
    assert sorted(p.name for p in NGINX_DIR.iterdir()) == ["default.conf"], "the whole directory is mounted"
    return confs[0].read_text(encoding="utf-8")


def test_nginx_listens_on_the_published_target_and_strips_the_api_prefix(services):
    conf = _nginx_conf()
    assert f"listen {PUBLISHED['target']};" in conf
    assert re.search(r"location \^~ /api/ \{[^}]*proxy_pass\s+http://gateway:8000/;", conf, re.DOTALL)
    assert "/healthz" in conf
    assert "gateway" in services
    health = " ".join(services["web"]["healthcheck"]["test"])
    assert f"127.0.0.1:{PUBLISHED['target']}/healthz" in health


def test_web_runs_unprivileged_with_writable_runtime_directories(services):
    web = services["web"]
    assert web["user"] == "101:101"
    # The stock docker-entrypoint.sh would write /etc/nginx/conf.d/default.conf, which is a
    # read-only bind mount, and exit 1.
    assert web["entrypoint"] == ["nginx", "-g", "daemon off;"]
    tmpfs = {m["target"] for m in web["volumes"] if m["type"] == "tmpfs"}
    assert {"/run", "/var/cache/nginx"} <= tmpfs
    assert int(PUBLISHED["target"]) > 1023


def test_nginx_upstream_hosts_are_compose_services(services):
    hosts = set(re.findall(r"proxy_pass\s+http://([a-z0-9-]+)", _nginx_conf()))
    assert hosts and hosts <= set(services)


# -- documentation -------------------------------------------------------------------------------


def test_demo_doc_states_the_memory_sum_and_every_demo_variable(compose, services):
    doc = DEMO_DOC.read_text(encoding="utf-8")
    assert f"{_total_mib(services)} MiB" in doc
    variables = {body for text in _strings(compose) for body in REFERENCE.findall(text) if body.startswith("DEMO_")}
    assert variables
    for variable in sorted(variables):
        assert f"`{variable}`" in doc, f"docs/DEMO.md does not describe {variable}"
    assert "18100" in doc and "lab_compose" in doc
