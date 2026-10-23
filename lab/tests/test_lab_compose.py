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
NGINX_CONF = ROOT / "frontend" / "nginx.lab.conf"
DOCKERFILE = ROOT / "frontend" / "Dockerfile"
DEMO_DOC = ROOT / "docs" / "DEMO.md"

ALLOWED_TOP_LEVEL = {"name", "services", "networks", "volumes"}
FORBIDDEN_SERVICE_KEYS = {
    "privileged", "devices", "cap_add", "pid", "ipc", "container_name", "extends",
    "env_file", "secrets", "configs", "volumes_from", "deploy",
}
ALLOWED_BUILD_KEYS = {"context", "dockerfile", "args", "target"}
ALLOWED_MOUNT_KEYS = {"type", "source", "target", "tmpfs"}
MAX_SERVICES = 15
MAX_MIB = 4096  # the lab ceiling; the sum includes `seed`, which only runs on demand
EXPECTED_MIB = 4032  # 3456 before e2e (576); docs/DEMO.md states it
ARTIFACT_DIR = "/var/lib/openbinding/artifacts"
LOCK = ROOT / "frontend" / "pnpm-lock.yaml"
DOCKERFILE_E2E = ROOT / "frontend" / "Dockerfile.e2e"
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
# The one reference allowed a default: the origin the browser reaches the lab by.  Unset, the lab
# is the local one; set, the supervisor's origin is added to the CORS list and used for links.
PUBLIC_ORIGIN = "DEMO_PUBLIC_ORIGIN"
LOCAL_ORIGIN = "http://localhost:18100"
PUBLIC_ORIGIN_DEFAULTED = f"${{{PUBLIC_ORIGIN}:-{LOCAL_ORIGIN}}}"
PUBLIC_ORIGIN_BARE = f"${{{PUBLIC_ORIGIN}}}"
LOCAL_CORS = f"{LOCAL_ORIGIN},http://127.0.0.1:18100"
# Variables of the gateway, the worker and the seed that carry the public origin, by service.
PUBLIC_ORIGIN_VARIABLES = {
    "gateway": {"PUBLIC_BASE_URL": PUBLIC_ORIGIN_DEFAULTED, "FRONTEND_URL": PUBLIC_ORIGIN_DEFAULTED,
                "CORS_ALLOW_ORIGINS": f"{LOCAL_CORS},{PUBLIC_ORIGIN_BARE}"},
    "worker": {"PUBLIC_BASE_URL": PUBLIC_ORIGIN_DEFAULTED},
    "seed": {"PUBLIC_BASE_URL": PUBLIC_ORIGIN_DEFAULTED, "FRONTEND_URL": PUBLIC_ORIGIN_DEFAULTED,
             "CORS_ALLOW_ORIGINS": f"{LOCAL_CORS},{PUBLIC_ORIGIN_BARE}"},
}

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
}
# The worker and the seed compile and re-evaluate through the BIM port, so they reach the service like the gateway.
BIM_CLIENTS = ("gateway", "worker", "seed")
BIM_VARIABLES = {
    "BIM_MODE": "http",
    "BIM_SERVICE_URL": "http://bim-service:8080",
    "BIM_SERVICE_TOKEN_FILE": "/run/bim/token",
    "DEMO_BIM_TOKEN": "${DEMO_BIM_TOKEN}",
    "BIM_SERVICE_ALLOW_INSECURE_HTTP": "true",
}
# Variables only the seed gets (tools/remote_probe.py exits without SPACE_ORGANIZATION_ID;
# tools/seed_lab.py --space-contracts requires the three SPACE_DEV_* ones).
SPACE_SERVICE_REFERENCE = "${DEMO_SPACE_DEV_SERVICE}"
SPACE_DEV_VARIABLES = {
    "SPACE_DEV_SERVICE_NAME": SPACE_SERVICE_REFERENCE,
    "SPACE_DEV_PLAN": "${DEMO_SPACE_DEV_PLAN}",
    "SPACE_DEV_PRICING_VERSION": "${DEMO_SPACE_PRICING_VERSION}",
}
SEED_EXTRAS = {"SPACE_ORGANIZATION_ID", "DEMO_SEED_PASSWORD", "SMOKE_BASE_URL", *SPACE_DEV_VARIABLES}


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


def reference_name(body: str) -> str:
    """The variable a ``${...}`` body names: DEMO_PUBLIC_ORIGIN's default is dropped, any other default stays."""
    return PUBLIC_ORIGIN if body == f"{PUBLIC_ORIGIN}:-{LOCAL_ORIGIN}" else body


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
    # The token file is written first (see test_demo_bim_token_is_expanded_by_the_shell_not_by_compose).
    assert services["seed"]["command"][2].endswith("&& python tools/${DEMO_SEED_TOOL} ${DEMO_SEED_ARGS}")


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


def test_memory_sum_is_within_the_lab_ceiling_and_is_the_documented_one(services):
    total = _total_mib(services)
    assert total <= MAX_MIB, total
    # A change to any mem_limit must be made on purpose: here and in docs/DEMO.md.
    assert total == EXPECTED_MIB, total


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
    for name, mount in binds:
        source = mount["source"]
        parts = source.split("/")
        assert not source.startswith("/") and ".." not in parts and "${" not in source, (name, mount)
        assert (ROOT / source).is_dir(), (name, mount)


def test_no_host_code_is_bind_mounted_and_the_image_carries_the_seed_tools(services):
    # The seed runs as uid 10001; under rootless docker a bind-mounted tools/ can be unreadable
    # for it ("Permission denied" on seed_lab.py), so the tools travel in the image.  nginx's
    # configuration is baked into its image for the same reason (uid 101).
    assert not [(n, m) for n, m in _mounts(services) if m["type"] == "bind"]
    assert not [m for m in services["seed"]["volumes"] if m["target"].startswith("/app")]
    assert not [m for m in services["web"]["volumes"] if m["target"].startswith("/etc/nginx")]
    dockerfile = (ROOT / "openbinding-gateway" / "Dockerfile").read_text(encoding="utf-8")
    lines = [line.strip() for line in dockerfile.splitlines()]
    copy = lines.index("COPY openbinding-gateway/tools/ tools/")
    chmod = next(i for i, line in enumerate(lines) if line.startswith("&& chmod -R a+rX /app"))
    assert copy < chmod


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
    assert build["context"] == "frontend" and build["target"] == "lab"
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
            name = reference_name(body)
            assert re.fullmatch(r"[A-Z][A-Z0-9_]*", name), f"reference with a default or modifier: ${{{body}}}"
            assert name.startswith("DEMO_") or name in PRIVATE_VARIABLES, body
            seen.add(name)
    assert seen & PRIVATE_VARIABLES, "the private SPACE/SPHERE variables are expected to be referenced"


def test_only_the_public_origin_has_a_default_and_it_is_the_local_origin(compose):
    defaulted = {body for text in _strings(compose) for body in REFERENCE.findall(text) if ":-" in body or ":" in body}
    assert defaulted == {f"{PUBLIC_ORIGIN}:-{LOCAL_ORIGIN}"}
    assert PUBLIC_ORIGIN_DEFAULTED == "${DEMO_PUBLIC_ORIGIN:-http://localhost:18100}"


def test_public_origin_reaches_gateway_worker_and_seed_by_interpolation(services):
    for name, expected in PUBLIC_ORIGIN_VARIABLES.items():
        env = _env(services[name])
        assert {key: env[key] for key in expected} == expected, name
    holders = [n for n, s in services.items() if PUBLIC_ORIGIN in json.dumps(s)]
    assert holders == ["gateway", "worker", "seed"]
    # the worker only needs the base URL: no CORS and no frontend link
    assert not {"CORS_ALLOW_ORIGINS", "FRONTEND_URL"} & set(_env(services["worker"]))


def _expand(value: str, supplied: str | None) -> str:
    """Compose's interpolation of the two forms used here: ``${V:-default}`` (unset or empty) and ``${V}``."""
    def replace(match):
        body = match.group(1)
        if ":-" in body:
            variable, default = body.split(":-", 1)
            return supplied or default
        return supplied or ""
    return REFERENCE.sub(replace, value)


def _cors_list(value: str) -> list[str]:
    """How Settings.cors_origins reads the variable: comma separated, blanks dropped."""
    return [item.strip() for item in value.split(",") if item.strip()]


@pytest.mark.parametrize("name", sorted(PUBLIC_ORIGIN_VARIABLES))
def test_unset_or_empty_public_origin_leaves_the_local_lab(services, name):
    env = _env(services[name])
    for supplied in (None, ""):
        for key in PUBLIC_ORIGIN_VARIABLES[name]:
            value = _expand(env[key], supplied)
            if key == "CORS_ALLOW_ORIGINS":
                assert value == f"{LOCAL_CORS},"  # the trailing empty item is dropped by Settings
                assert _cors_list(value) == LOCAL_CORS.split(",")
            else:
                assert value == LOCAL_ORIGIN, (name, key)


@pytest.mark.parametrize("name", sorted(PUBLIC_ORIGIN_VARIABLES))
def test_a_public_origin_replaces_the_urls_and_is_appended_to_the_local_cors_origins(services, name):
    origin = "https://demo.example.org"
    env = _env(services[name])
    for key in PUBLIC_ORIGIN_VARIABLES[name]:
        value = _expand(env[key], origin)
        if key == "CORS_ALLOW_ORIGINS":
            assert _cors_list(value) == [*LOCAL_CORS.split(","), origin]
        else:
            assert value == origin, (name, key)


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
    assert gateway["SPHERE_ENABLED"] == "true"


def test_space_enabled_is_a_variable_in_gateway_worker_and_seed_never_a_literal(services):
    holders = [name for name, s in services.items() if "SPACE_ENABLED" in _env(s)]
    assert sorted(holders) == ["gateway", "seed", "worker"]
    for name in holders:
        assert _env(services[name])["SPACE_ENABLED"] == "${DEMO_SPACE_ENABLED}", name
    for name in ("gateway", "worker", "seed"):
        assert _env(services[name])["SPHERE_ENABLED"] == "true", name


def test_demo_bim_token_is_expanded_by_the_shell_not_by_compose(services):
    # `$$` is compose's escape: the token is read from the container's own environment and
    # never baked into the command line that `docker inspect` shows.
    for name in ("bim-service", "gateway", "worker", "seed"):
        command = " ".join(services[name]["command"])
        assert services[name]["command"][:2] == ["sh", "-c"], name
        assert '"$$DEMO_BIM_TOKEN"' in command, name
        assert "${DEMO_BIM_TOKEN}" not in command, name
        assert "umask 077" in command, name
        assert _env(services[name])["DEMO_BIM_TOKEN"] == "${DEMO_BIM_TOKEN}", name


def test_the_bim_clients_reach_the_service_with_a_token_file_on_a_tmpfs(services):
    for name in BIM_CLIENTS:
        env = _env(services[name])
        assert {key: env[key] for key in BIM_VARIABLES} == BIM_VARIABLES, name
        token_file = env["BIM_SERVICE_TOKEN_FILE"]
        tmpfs = [m for m in services[name]["volumes"] if m["type"] == "tmpfs" and token_file.startswith(m["target"] + "/")]
        assert len(tmpfs) == 1, name
        # The file is written where BIM_SERVICE_TOKEN_FILE says, and never to a layer of the image.
        assert f"> {token_file}" in " ".join(services[name]["command"]), name
        if name != "gateway":
            assert tmpfs[0].get("tmpfs") == {"mode": 1023}, name
    assert services["worker"]["depends_on"]["bim-service"] == {"condition": "service_healthy"}
    assert services["seed"]["depends_on"]["bim-service"] == {"condition": "service_healthy"}


def test_insecure_http_to_the_bim_service_is_opted_into_only_by_its_three_clients(services):
    # The lab's private network carries a synthetic token over plain http; nothing else may opt in.
    for name, service in services.items():
        env = _env(service)
        if name in BIM_CLIENTS:
            assert env["BIM_SERVICE_ALLOW_INSECURE_HTTP"] == "true", name
        else:
            assert "BIM_SERVICE_ALLOW_INSECURE_HTTP" not in env, name


# -- who holds the session-signing secret---------------------------------------------------------


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


def test_seed_password_is_a_bare_reference_only_in_the_seed_and_the_e2e_and_the_smoke_targets_web(services):
    # tools/seed_lab.py and tools/smoke_lab.py exit with "DEMO_SEED_PASSWORD is required" without it; the live specs
    # (e2e/live/support.ts) sign the same synthetic users in with it.
    holders = [name for name, s in services.items() if "DEMO_SEED_PASSWORD" in json.dumps(s)]
    assert holders == ["seed", "e2e"]
    for name in holders:
        assert _env(services[name])["DEMO_SEED_PASSWORD"] == "${DEMO_SEED_PASSWORD}", name
    seed = _env(services["seed"])
    assert seed["SMOKE_BASE_URL"] == "http://web:8080"
    assert [n for n, s in services.items() if "SMOKE_BASE_URL" in _env(s)] == ["seed"]


def test_space_dev_contract_variables_are_bare_references_only_in_the_seed(services):
    # seed_lab.py --space-contracts reads them; no service or plan name is written in the file.  The
    # plan and pricing-version seeding variables stay with the seed; the development service name also
    # reaches the gateway and the worker, but only as SPACE_SERVICE_NAME (see the next test).
    seed = _env(services["seed"])
    assert {key: seed[key] for key in SPACE_DEV_VARIABLES} == SPACE_DEV_VARIABLES
    for name, service in services.items():
        if name != "seed":
            assert not [key for key in _env(service) if key.startswith("SPACE_DEV_")], name
    assert "DEMO_SPACE_DEV_PLAN" not in json.dumps({n: s for n, s in services.items() if n != "seed"})


def test_gateway_worker_and_seed_name_the_same_space_service(services):
    # The service the gateway reads contracts from must be the one seed_lab.py seeds; one reference
    # feeds both, and no other service gets the name.
    for name in ("gateway", "worker", "seed"):
        assert _env(services[name])["SPACE_SERVICE_NAME"] == SPACE_SERVICE_REFERENCE, name
    holders = [n for n, s in services.items() if "DEMO_SPACE_DEV_SERVICE" in json.dumps(s)]
    assert holders == ["gateway", "worker", "seed"]
    for name in ("gateway", "worker"):
        assert "SPACE_DEV_SERVICE_NAME" not in _env(services[name]), name


def test_no_space_service_or_plan_name_is_written_in_the_file(services):
    # What names SPACE's service and plan is the supervisor's, through DEMO_* references.
    for name, service in services.items():
        for key, value in _env(service).items():
            if re.search(r"SPACE_.*(SERVICE|PLAN)", key):
                assert WHOLE_REFERENCE.fullmatch(value) and value.startswith("${DEMO_"), f"{name}:{key}"


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
    assert env["CORS_ALLOW_ORIGINS"] == f"{LOCAL_CORS},{PUBLIC_ORIGIN_BARE}"
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


def test_bim_service_memory_limits_fit_its_mem_limit(services):
    """The body-proportional memory of bim-service, by the figures of bim-toolchain/docs/SERVICE.md, fits its mem_limit."""
    bim = services["bim-service"]
    env = _env(bim)
    body = int(env["BIM_SERVICE_MAX_BODY_BYTES"])
    budget = int(env["BIM_SERVICE_MEMORY_BUDGET_BYTES"])
    pending = int(env["BIM_SERVICE_MAX_PENDING_BODY_BYTES"])
    assert int(env["BIM_SERVICE_MAX_CONCURRENCY"]) <= 2
    assert body * 8 <= budget, "a request at the body limit must be admissible (BODY_MEMORY_FACTOR = 8)"
    limit = _mib(bim["mem_limit"]) * 1024 * 1024
    idle = 55451648  # RSS of the process at rest, measured
    worst_case_per_byte = 8.4  # resident memory per body byte of the first admitted request, measured
    admitted = budget // 8  # raw bytes the budget admits
    waiting = max(pending - admitted, 0)
    # the waiting bodies are buffered twice while their chunks are joined
    assert idle + worst_case_per_byte * admitted + 2 * waiting <= limit, "bim-service could exceed its mem_limit"


def test_gateway_waits_for_what_it_uses(services):
    depends = services["gateway"]["depends_on"]
    assert {"postgres", "redis", "bim-service"} <= set(depends)
    assert {n for n in services if n.startswith("engine-")} <= set(depends)
    assert set(services["worker"]["depends_on"]) == {"gateway", "redis", "bim-service"}
    assert set(services["web"]["depends_on"]) == {"gateway"}


def test_named_volumes_back_the_stateful_services(services):
    assert {"type": "volume", "source": "lab-pg-3", "target": "/var/lib/postgresql/data"} in services["postgres"]["volumes"]
    assert {"type": "volume", "source": "lab-redis", "target": "/data"} in services["redis"]["volumes"]
    assert services["postgres"]["image"] == "postgres:16-alpine"
    assert services["redis"]["image"] == "redis:7-alpine"
    assert "pg_isready" in " ".join(services["postgres"]["healthcheck"]["test"])
    assert "noeviction" in services["redis"]["command"]  # the job queue must never be evicted


# -- health and ordering -------------------------------------------------------------------------


ONE_SHOT = {"seed"}  # it runs to completion: no healthcheck


def test_long_running_services_have_healthchecks(services):
    for name, service in services.items():
        if name in ONE_SHOT:
            continue
        assert service.get("healthcheck", {}).get("test"), f"{name} has no healthcheck"


def test_depends_on_points_to_existing_services_with_healthchecks(services):
    for name, service in services.items():
        for dependency, rule in (service.get("depends_on") or {}).items():
            assert dependency in services, (name, dependency)
            assert "profiles" not in services[dependency], (name, dependency)
            assert rule == {"condition": "service_healthy"}, (name, dependency)
            assert "healthcheck" in services[dependency], (name, dependency)


# -- artifact volume and e2e ----------------------------------------------------------------------


def test_there_is_no_artifacts_init_and_the_app_mounts_the_new_artifact_volume(services):
    # The container has no CAP_CHOWN: a fresh lab-artifacts-2 volume inherits the 10001 owner of the image directory.
    assert "artifacts-init" not in services
    assert not [n for n, s in services.items() if "artifacts-init" in (s.get("depends_on") or {})]
    for name in ("gateway", "worker", "seed"):
        assert {"type": "volume", "source": "lab-artifacts-2", "target": ARTIFACT_DIR} in services[name]["volumes"], name
    volumes = json.loads(COMPOSE.read_text(encoding="utf-8"))["volumes"]
    assert "lab-artifacts-2" in volumes and "lab-pg-3" in volumes
    assert "lab-artifacts" not in volumes and "lab-pg" not in volumes


def test_e2e_runs_the_live_specs_unprivileged_and_stays_alive_for_up_wait(services):
    e2e = services["e2e"]
    assert "profiles" not in e2e and e2e["restart"] == "no" and e2e["mem_limit"] == "576m"
    assert e2e["build"] == {"context": "frontend", "dockerfile": "Dockerfile.e2e"}
    assert e2e["user"] not in {"0", "root"} and not str(e2e["user"]).startswith("0:")
    assert e2e["depends_on"] == {"web": {"condition": "service_healthy"}}
    env = _env(e2e)
    assert env == {"BASE_URL": "http://web:8080", "DEMO_E2E": "${DEMO_E2E}", "DEMO_SEED_PASSWORD": "${DEMO_SEED_PASSWORD}"}
    assert e2e["volumes"] == [{"type": "volume", "source": "lab-e2e", "target": "/results"}]
    assert e2e["healthcheck"]["test"] == ["CMD-SHELL", "test -f /results/done"]
    # The healthcheck waits for the whole run: the start period must outlast it.
    assert int(e2e["healthcheck"]["start_period"].rstrip("s")) >= 1800
    assert e2e["command"] == ["sh", "/app/e2e/live/run.sh"]
    assert not e2e.get("ports")


def test_e2e_script_runs_only_with_demo_e2e_1_and_always_leaves_done_and_sleeps():
    script = (ROOT / "frontend" / "e2e" / "live" / "run.sh").read_text(encoding="utf-8")
    assert 'if [ "${DEMO_E2E:-0}" = "1" ]; then' in script
    assert "pnpm exec playwright test -c playwright.live.config.ts" in script
    assert "E2E_SUMMARY" in (ROOT / "frontend" / "e2e" / "live" / "summary.mjs").read_text(encoding="utf-8")
    # A stale `done` of an earlier run would make this one look finished: it goes first; the new one comes last, then sleep.
    assert script.index('rm -f "$RESULTS/done"') < script.index("playwright test")
    assert script.index("playwright test") < script.index('touch "$RESULTS/done"') < script.index("sleep infinity")
    fi = script.index("\nfi\n")
    assert script.index('touch "$RESULTS/done"') > fi, "done must be created whether or not the specs ran"


def test_dockerfile_e2e_uses_the_playwright_image_of_the_locked_version_and_a_non_root_user():
    lock = LOCK.read_text(encoding="utf-8")
    locked = set(re.findall(r"^  '@playwright/test@([0-9][^']*)':", lock, re.MULTILINE))
    assert len(locked) == 1, locked
    (version,) = locked
    dockerfile = DOCKERFILE_E2E.read_text(encoding="utf-8")
    froms = re.findall(r"^FROM (\S+)", dockerfile, re.MULTILINE)
    assert froms == [f"mcr.microsoft.com/playwright:v{version}-jammy"], froms
    assert "pnpm install --frozen-lockfile" in dockerfile
    for proxy in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"):
        assert f"ARG {proxy}" in dockerfile
    users = re.findall(r"^USER (\S+)", dockerfile, re.MULTILINE)
    assert users and users[-1] == "pwuser"
    assert "mkdir -p /results && chown pwuser:pwuser /results" in dockerfile
    # The context must carry the specs, the configuration and the script, and not the host's node_modules.
    ignore = (ROOT / "frontend" / ".dockerignore").read_text(encoding="utf-8").split()
    assert "node_modules" in ignore and "e2e" not in ignore and "playwright.live.config.ts" not in ignore


# -- nginx ---------------------------------------------------------------------------------------


def _nginx_conf() -> str:
    return NGINX_CONF.read_text(encoding="utf-8")


def test_nginx_listens_on_the_published_target_and_strips_the_api_prefix(services):
    conf = _nginx_conf()
    assert f"listen {PUBLISHED['target']};" in conf
    assert re.search(r"location \^~ /api/ \{[^}]*proxy_pass\s+http://gateway:8000/;", conf, re.DOTALL)
    assert "/healthz" in conf
    assert "gateway" in services
    health = " ".join(services["web"]["healthcheck"]["test"])
    assert f"127.0.0.1:{PUBLISHED['target']}/healthz" in health
    check = services["web"]["healthcheck"]
    assert check["test"][0] == "CMD-SHELL" and " -T " in health and health.endswith("|| exit 1")
    assert int(check["start_period"].rstrip("s")) >= 15
    assert int(check["timeout"].rstrip("s")) > 3  # longer than wget's -T 3
    assert 1 <= int(check["retries"]) <= 10


def test_prod_stage_is_stock_nginx_and_lab_stage_bakes_in_the_lab_config():
    # Target `prod` (the production image) is nginx:1.27-alpine plus the build output and must not
    # change; target `lab` is built FROM it and only replaces conf.d/default.conf.
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    assert dockerfile.count("FROM nginx:1.27-alpine AS prod") == 1
    prod_and_lab = dockerfile.split("AS prod\n", 1)[1]
    prod, lab = prod_and_lab.split("FROM prod AS lab\n", 1)
    assert "nginx.lab.conf" not in prod
    assert not re.search(r"^\s*(COPY .*/etc/nginx|ADD |RUN )", prod, re.MULTILINE)
    assert dockerfile.count("AS lab") == 1
    copies = [line for line in lab.splitlines() if line.startswith(("COPY", "ADD", "RUN"))]
    assert copies == ["COPY nginx.lab.conf /etc/nginx/conf.d/default.conf"]


def test_legacy_lab_nginx_directory_is_gone_and_the_lab_image_uses_frontend_conf():
    assert not (ROOT / "lab" / "nginx").exists()
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    lab = dockerfile.split("FROM prod AS lab\n", 1)[1]
    assert "COPY nginx.lab.conf /etc/nginx/conf.d/default.conf" in lab


def test_nginx_lab_conf_reaches_the_build_context():
    assert NGINX_CONF.is_file()
    ignore = (ROOT / "frontend" / ".dockerignore").read_text(encoding="utf-8").splitlines()
    patterns = [p.strip() for p in ignore if p.strip() and not p.startswith("#")]
    assert not [p for p in patterns if p.lstrip("/") in {"*.conf", "nginx.lab.conf", "**/*.conf"}] or \
        "!nginx.lab.conf" in patterns


def test_nginx_lab_conf_logs_to_the_container_and_keeps_healthz_quiet():
    conf = _nginx_conf()
    assert "access_log /dev/stdout;" in conf and "error_log /dev/stderr warn;" in conf
    health = re.search(r"location = /healthz \{([^}]*)\}", conf)
    assert health and "access_log off;" in health.group(1)
    assert "pid " not in re.sub(r"#.*", "", conf)  # not valid in a server block


def test_web_runs_unprivileged_with_writable_runtime_directories(services):
    web = services["web"]
    assert web["user"] == "101:101"
    # The stock docker-entrypoint.sh would rewrite /etc/nginx/conf.d/default.conf as uid 101 and
    # fail; the configuration is complete in the image, so the script is skipped.
    assert web["entrypoint"] == ["nginx", "-g", "daemon off;"]
    tmpfs = {m["target"]: m for m in web["volumes"] if m["type"] == "tmpfs"}
    assert {"/run", "/var/cache/nginx"} <= set(tmpfs)
    # nginx runs as uid 101; 1023 == 0o1777 (JSON has no octal) so it can write its pid/cache.
    for target in ("/run", "/var/cache/nginx"):
        assert tmpfs[target]["tmpfs"] == {"mode": 1023}, target
    assert int(PUBLISHED["target"]) > 1023


def test_nginx_sets_the_client_address_instead_of_appending_to_the_one_the_client_sent():
    # nginx is the only hop in front of the gateway, so a client-supplied X-Forwarded-For would only
    # let it forge the address the gateway throttles logins by.
    conf = re.sub(r"#.*", "", _nginx_conf())
    headers = re.findall(r"proxy_set_header\s+X-Forwarded-For\s+(\S+);", conf)
    assert len(headers) == len(re.findall(r"proxy_pass\s", conf)) == 3
    assert set(headers) == {"$remote_addr"}
    assert "$proxy_add_x_forwarded_for" not in conf


def test_nginx_conf_does_not_claim_the_compose_file_drops_capabilities():
    # The lab supervisor drops every capability; compose.lab.json has no cap_drop and says nothing of it.
    text = " ".join(line.lstrip("# ").strip() for line in _nginx_conf().splitlines())
    assert "every capability dropped" not in text
    assert "supervisor drops every capability" in text
    assert "cap_drop" not in (ROOT / "compose.lab.json").read_text(encoding="utf-8")


def test_nginx_upstream_hosts_are_compose_services(services):
    hosts = set(re.findall(r"proxy_pass\s+http://([a-z0-9-]+)", _nginx_conf()))
    assert hosts and hosts <= set(services)


# -- documentation -------------------------------------------------------------------------------


def test_demo_doc_states_the_memory_sum_and_every_demo_variable(compose, services):
    doc = DEMO_DOC.read_text(encoding="utf-8")
    assert f"{_total_mib(services)} MiB" in doc
    names = {reference_name(body) for text in _strings(compose) for body in REFERENCE.findall(text)}
    variables = {name for name in names if name.startswith("DEMO_")}
    assert variables
    for variable in sorted(variables):
        assert f"`{variable}`" in doc, f"docs/DEMO.md does not describe {variable}"


def test_demo_doc_states_the_default_and_the_cors_effect_of_the_public_origin():
    doc = DEMO_DOC.read_text(encoding="utf-8")
    row = next(line for line in doc.splitlines() if line.startswith(f"| `{PUBLIC_ORIGIN}`"))
    assert LOCAL_ORIGIN in row and "CORS_ALLOW_ORIGINS" in row
    assert "PUBLIC_BASE_URL" in row and "FRONTEND_URL" in row
    assert "18100" in doc and "lab_compose" in doc
