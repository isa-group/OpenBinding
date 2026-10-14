"""Static checks of ``compose.lab-engines.json``, the laboratory profile that runs the REAL-MiniZinc tests of
``engines/minizinc-csp`` and the end-to-end harness ``tools/engine_e2e.py`` against it, without Docker.

It must pass the format rules of ``compose.lab.json`` (shape, names, no ports, no network keys, structured builds,
``mem_limit``), run nothing as root, publish nothing, hold no secret, and keep the pattern of ``compose.pgtest.json``:
the services without a profile are built/started by ``up``; the one-shot ``seed`` (``lab_compose seed`` runs only the
service named ``seed``) reuses an image that ``up`` built.

Why two services and not one: ``seed`` must be the gateway image (it has ``bim_core``, the harness and its
dependencies), while the real MiniZinc tests need the engine image (node, MiniZinc). The root ``.dockerignore`` keeps
``engines/`` out of the gateway's build context and the engine's context has no ``bim-core``, so the real tests run as
``engine-real-tests`` when ``up`` starts it (healthy only if they passed) and ``seed`` runs the harness.

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

COMPOSE = ROOT / "compose.lab-engines.json"
ENGINE_DOCKERFILE = ROOT / "engines" / "minizinc-csp" / "Dockerfile"
GATEWAY_DOCKERFILE = ROOT / "openbinding-gateway" / "Dockerfile"
MAX_MIB = 1024  # modest: the profile runs next to nothing else, and compose.lab.json leaves 4 GiB for itself
EXPECTED_SERVICES = ["engine", "image-builder", "engine-real-tests", "seed"]


@pytest.fixture(scope="module")
def manifest() -> dict:
    return json.loads(COMPOSE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def services(manifest) -> dict:
    return manifest["services"]


# -- the validator rules --------------------------------------------------------------------------------------------


def test_shape_names_and_services(manifest, services):
    assert set(manifest) <= rules.ALLOWED_TOP_LEVEL and {"name", "services"} <= set(manifest)
    assert manifest["name"] == "openbinding-lab-engines"
    assert list(services) == EXPECTED_SERVICES
    names = [*services, *(manifest.get("volumes") or {}), *(manifest.get("networks") or {})]
    assert not [name for name in names if not rules.NAME_PATTERN.fullmatch(name)]
    assert not manifest.get("networks") and not manifest.get("volumes"), "nothing persists and no network is defined"


def test_no_forbidden_key_network_socket_mount_or_port(manifest, services):
    for name, service in services.items():
        assert not (set(service) & rules.FORBIDDEN_SERVICE_KEYS), name
        assert service.get("network_mode", "none") == "none", name
        assert "networks" not in service and "tmpfs" not in service, name
        assert "ports" not in service and "expose" not in service, f"{name}: nothing is published"
        assert "volumes" not in service, f"{name}: no mount, no host code"
    assert not [s for s in rules._strings(manifest) if ".sock" in s]


def test_every_service_has_a_modest_mem_limit(services):
    for name, service in services.items():
        assert "mem_limit" in service, name
        rules._mib(service["mem_limit"])
    assert rules._total_mib(services) <= MAX_MIB, rules._total_mib(services)
    assert rules._mib(services["engine"]["mem_limit"]) == 192  # the figure of the engine in compose.lab.json


def test_builds_use_only_allowed_keys_and_literal_paths_inside_the_repository(services):
    builds = {name: service["build"] for name, service in services.items() if "build" in service}
    assert sorted(builds) == ["engine", "image-builder"]
    for name, build in builds.items():
        assert set(build) <= rules.ALLOWED_BUILD_KEYS, name
        for key in ("context", "dockerfile"):
            value = build[key]
            assert "${" not in value and not value.startswith("/") and ".." not in value.split("/"), (name, key)
        assert (ROOT / build["context"]).is_dir() and (ROOT / build["context"] / build["dockerfile"]).is_file(), name


def test_nothing_runs_as_root(services):
    for name, service in services.items():
        uid = str(service["user"]).split(":")[0]
        assert uid.isdigit() and int(uid) != 0, name


# -- no secrets -------------------------------------------------------------------------------------------------------


def test_no_secret_no_reference_and_no_private_variable(manifest, services):
    text = COMPOSE.read_text(encoding="utf-8")
    assert not rules.SECRET_SHAPES.search(text) and rules.DESTRUCTIVE_KEY not in text
    assert "${" not in text, "the profile needs no variable of the supervisor"
    for name, service in services.items():
        for key in rules._env(service):
            assert not rules.SECRET_NAME.search(key), f"{name}:{key}"
            assert key not in rules.PRIVATE_VARIABLES, f"{name}:{key}"
    assert "ENGINE_AUTH_TOKENS" not in text, "the laboratory engine is internal and open, as compose.lab.json runs it"


# -- the pattern of compose.pgtest.json --------------------------------------------------------------------------------


def test_up_starts_the_engine_and_the_builder_and_seed_is_the_only_profile_service(services):
    assert [name for name, service in services.items() if "profiles" not in service] == [
        "engine", "image-builder", "engine-real-tests",
    ]
    assert services["seed"]["profiles"] == ["seed"]
    assert [name for name, service in services.items() if "profiles" in service] == ["seed"]


def test_image_builder_only_builds_and_idles_like_the_pgtest_one(services):
    builder = services["image-builder"]
    pgtest = json.loads((ROOT / "compose.pgtest.json").read_text(encoding="utf-8"))["services"]["image-builder"]
    for key in ("user", "entrypoint", "command", "mem_limit", "healthcheck"):
        assert builder[key] == pgtest[key], key
    assert builder["build"] == {"context": ".", "dockerfile": "openbinding-gateway/Dockerfile"}


def test_seed_and_the_real_tests_reuse_the_images_that_up_builds(services):
    assert services["seed"]["image"] == services["image-builder"]["image"] == "openbinding-lab-engines-tools:latest"
    assert services["engine-real-tests"]["image"] == services["engine"]["image"] == "openbinding-lab-engines-engine:latest"
    assert "build" not in services["seed"] and "build" not in services["engine-real-tests"]
    for name in ("seed", "engine-real-tests"):
        assert services[name]["depends_on"] == {"engine": {"condition": "service_healthy"}}, name


# -- the engine image ----------------------------------------------------------------------------------------------


def test_the_engine_is_built_from_the_lab_stage_of_its_own_dockerfile(services):
    dockerfile = ENGINE_DOCKERFILE.read_text(encoding="utf-8")
    stages = re.findall(r"^FROM .* AS (\w+)$", dockerfile, flags=re.MULTILINE)
    assert stages == ["base", "lab", "production"], "production must be the last stage (compose.lab.json builds without target)"
    assert services["engine"]["build"]["target"] == "lab"
    assert "minizinc" in dockerfile and "tini" in dockerfile
    base, lab, production = re.split(r"^FROM .*$", dockerfile, flags=re.MULTILINE)[1:]
    assert "COPY tests/" in lab and "COPY tests/" not in base and "COPY tests/" not in production
    assert "USER node" in lab and "USER node" in production
    assert 'ENTRYPOINT ["tini", "--"]' in lab and 'ENTRYPOINT ["tini", "--"]' in production
    assert "tmp_minizinc" in base and "chown node:node" in base
    healthcheck = " ".join(services["engine"]["healthcheck"]["test"])
    assert "http://localhost:3000/health" in healthcheck and "EXPOSE 3000" in dockerfile


def test_pid_1_of_the_real_tests_is_tini_from_the_image_so_orphans_are_reaped(services):
    """engine-real-tests only overrides ``command``: the image ENTRYPOINT (tini) stays PID 1 over ``sh -c ... sleep``.

    The grandchild test of minizinc_runner.test.ts failed in the lab because the fake grandchild was signalled before
    it had installed its SIGTERM handler (a test race), not because of zombies; adding ``init`` here would put
    docker-init above tini, so neither service may override the entrypoint or set ``init``.
    """
    for name in ("engine", "engine-real-tests"):
        assert "entrypoint" not in services[name] and "init" not in services[name], name
    assert services["engine-real-tests"]["command"][0] == "sh"
    dockerfile = ENGINE_DOCKERFILE.read_text(encoding="utf-8")
    assert dockerfile.count('ENTRYPOINT ["tini", "--"]') == 2  # lab and production
    test = (ROOT / "engines" / "minizinc-csp" / "src" / "minizinc_runner.test.ts").read_text(encoding="utf-8")
    ready = test.index("GRANDCHILD_READY_TICKS, 30_000")
    assert test.index("FAKE_MINIZINC_GRANDCHILD_IGNORE_TERM === '1'") < ready < test.index("return { pid, grandchild, controller, run }")


def test_the_user_of_the_engine_is_the_node_user_of_the_image(services):
    assert services["engine"]["user"] == services["engine-real-tests"]["user"] == "1000:1000"  # uid of `node` in node:20-slim


# -- what runs --------------------------------------------------------------------------------------------------------------


def test_the_real_tests_run_with_minizinc_real_and_make_the_service_healthy_only_if_they_pass(services):
    tests = services["engine-real-tests"]
    assert rules._env(tests)["MINIZINC_REAL"] == "1"
    script = tests["command"][2]
    assert tests["command"][:2] == ["sh", "-c"]
    assert "node --test --test-reporter=spec dist/minizinc_runner.test.js dist/cancel.test.js" in script
    assert script.index("rc=$$?") < script.index('"$$rc" -eq 0') < script.index("touch /tmp/real-tests-ok") < script.index("exec sleep infinity")
    assert "$" not in script.replace("$$", ""), "every $ must be escaped as $$ for compose"
    assert tests["healthcheck"]["test"] == ["CMD-SHELL", "test -f /tmp/real-tests-ok"]
    assert tests["restart"] == "no"
    src = ROOT / "engines" / "minizinc-csp" / "src"
    assert (src / "minizinc_runner.test.ts").is_file() and (src / "cancel.test.ts").is_file()
    # the file name in the test is the one the real tests are skipped with when the variable is missing
    assert "MINIZINC_REAL" in (src / "cancel.test.ts").read_text(encoding="utf-8")


def test_the_seed_runs_the_harness_against_the_engine_service(services):
    seed = services["seed"]
    command = seed["command"]
    assert command[:2] == ["python", "tools/engine_e2e.py"]
    assert command[command.index("--url") + 1] == "http://engine:3000"
    assert command[command.index("--expect") + 1] == "optimal"
    assert (ROOT / "openbinding-gateway" / "tools" / "engine_e2e.py").is_file()
    assert seed["entrypoint"] == [] and seed["working_dir"] == "/app"
    env = rules._env(seed)
    assert env["PYTHONPATH"] == "/app/src" and env["SCHEMAS_DIR"] == "/app/schemas" and env["APP_ENV"] == "dev"
    assert str(seed["user"]).startswith("10001:"), "the uid of the gateway image"
    gateway = GATEWAY_DOCKERFILE.read_text(encoding="utf-8")
    assert "COPY openbinding-gateway/tools/ tools/" in gateway, "the harness travels in the gateway image"


def test_the_engine_port_is_the_one_the_harness_and_the_dockerfile_use(services):
    dockerfile = ENGINE_DOCKERFILE.read_text(encoding="utf-8")
    assert "EXPOSE 3000" in dockerfile
    index = (ROOT / "engines" / "minizinc-csp" / "src" / "index.ts").read_text(encoding="utf-8")
    assert "process.env.PORT || 3000" in index


def test_the_other_compose_files_are_not_touched_by_this_profile():
    base = json.loads((ROOT / "compose.lab.json").read_text(encoding="utf-8"))["services"]["engine-minizinc"]
    assert base["build"] == {"context": "engines/minizinc-csp", "dockerfile": "Dockerfile"}  # still the production stage


def test_the_procedure_is_documented():
    doc = (ROOT / "docs" / "qa" / "ENGINE_CANCELLATION.md").read_text(encoding="utf-8")
    for needle in (
        "compose.lab-engines.json",
        "lab_compose up file=compose.lab-engines.json",
        "lab_compose seed",
        "engine-real-tests",
        "REAL_TESTS_EXIT=0",
        "NO EJECUTADO",
    ):
        assert needle in doc, needle
