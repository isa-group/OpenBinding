"""Static checks of the process-executor manifests, without Docker.

``compose.lab-process.json`` (one worker process, bodies up to 6 MiB) and ``compose.lab-process-n2.json`` (two worker
processes, bodies up to 2 MiB) are ``compose.lab.json`` with a different ``bim-service`` environment and nothing else;
``compose.lab.json`` (thread executor) is the rollback.  They must pass the same rules as the original, differ from it
only where documented, and satisfy the fit rule of ``bim_service.workers.memory_fit`` inside the 256 MiB container.

Run from ``openbinding-gateway`` with its environment::

    uv run --locked pytest ../lab/tests
"""

from __future__ import annotations

import importlib.util
import json
import re
from dataclasses import dataclass
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

# The rules of the original manifest, loaded by path (its tests are not collected from here).
_spec = importlib.util.spec_from_file_location("lab_compose_rules", HERE / "test_lab_compose.py")
rules = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rules)

BASE = ROOT / "compose.lab.json"
DOC = ROOT / "docs" / "qa" / "PROCESS_DEPLOYMENT.md"
DEMO_DOC = ROOT / "docs" / "DEMO.md"
SERVICE_DIR = ROOT / "bim-toolchain" / "packages" / "bim-service" / "src" / "bim_service"

MIB = 1024 * 1024
MEMORY_MAX = 256 * MIB  # mem_limit of bim-service, and so the memory.max its start reads
BODY_MEMORY_FACTOR = 8  # bim_service.settings
FIT_MARGIN = 0.10  # bim_service.workers

# Measured (bim-toolchain/docs/SERVICE.md): a worker when ready, and the PID 1 of the lab container in thread mode.
CHILD_MEASURED = 51564544
PARENT_MEASURED = 55451648
# Conservative stand-ins used to prove headroom: the parent of a process-mode service was not measured in that
# container (it also holds the I/O threads), and a worker is about 10% heavier than measured.
CHILD_CONSERVATIVE = 54 * MIB
PARENT_CONSERVATIVE = 60 * MIB
MIN_HEADROOM_CONSERVATIVE = 2 * MIB
MIN_HEADROOM_MEASURED = 10 * MIB


@dataclass(frozen=True)
class Profile:
    name: str
    path: Path
    workers: int
    body: int
    budget: int
    pending: int
    acquire_ms: int

    @property
    def limits(self) -> dict:
        """The part of ``limits.service`` of ``GET /bim/v1/capabilities`` that this profile sets."""
        return {
            "executor": "process",
            "maxBodyBytes": self.body,
            "maxConcurrentOperations": self.workers,
            "maxConcurrentOperationsPerTenant": 0,
            "acquireTimeoutMs": self.acquire_ms,
            "memoryBudgetBytes": self.budget,
            "maxPendingBodyBytes": self.pending,
        }


N1 = Profile(
    "N1", ROOT / "compose.lab-process.json",
    workers=1, body=6 * MIB, budget=48 * MIB, pending=12 * MIB, acquire_ms=3000,
)
N2 = Profile(
    "N2", ROOT / "compose.lab-process-n2.json",
    workers=2, body=2 * MIB, budget=16 * MIB, pending=4 * MIB, acquire_ms=2000,
)
PROFILES = [N1, N2]
IDS = [p.name for p in PROFILES]
THREAD_BODY = 16 * MIB  # what compose.lab.json advertises


def required_bytes(profile: Profile, parent: int, child: int) -> int:
    """``P + Q + N*C + B + N*(L + R) + margin`` of ``bim_service.workers.memory_fit``, with ``R`` the allowance."""
    allowance = BODY_MEMORY_FACTOR * profile.body
    terms = [
        parent,
        profile.pending,
        profile.workers * child,
        profile.budget,
        profile.workers * (profile.body + allowance),
    ]
    return sum(terms) + int(FIT_MARGIN * MEMORY_MAX)


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _bim_env(manifest: dict) -> dict:
    return rules._env(manifest["services"]["bim-service"])


@pytest.fixture(scope="module")
def base() -> dict:
    return _load(BASE)


@pytest.fixture(scope="module", params=PROFILES, ids=IDS)
def profile(request) -> Profile:
    return request.param


@pytest.fixture(scope="module")
def manifests() -> dict:
    return {p.name: _load(p.path) for p in PROFILES}


@pytest.fixture
def manifest(profile, manifests) -> dict:
    return manifests[profile.name]


# -- the same rules as compose.lab.json ----------------------------------------------------------


def test_the_manifests_exist_and_are_json_objects():
    for p in PROFILES:
        assert p.path.is_file(), p.path
        assert isinstance(_load(p.path), dict)


def test_shape_and_names_follow_the_validator_rules(profile, manifest):
    assert set(manifest) <= rules.ALLOWED_TOP_LEVEL
    assert {"name", "services"} <= set(manifest)
    assert 1 <= len(manifest["services"]) <= rules.MAX_SERVICES
    for section in ("networks", "volumes"):
        for name, definition in (manifest.get(section) or {}).items():
            assert set(definition or {}) <= {"labels"}, f"{section}.{name}"
    names = [*manifest["services"], *(manifest.get("volumes") or {}), *(manifest.get("networks") or {})]
    assert not [n for n in names if not rules.NAME_PATTERN.fullmatch(n)]


def test_no_forbidden_key_no_network_mode_no_socket_no_space_service(profile, manifest):
    services = manifest["services"]
    for name, service in services.items():
        assert not (set(service) & rules.FORBIDDEN_SERVICE_KEYS), name
        assert service.get("network_mode", "none") == "none", name
        assert "networks" not in service and "tmpfs" not in service, name
    assert not [s for s in rules._strings(manifest) if ".sock" in s]
    assert not [n for n in services if n.startswith("space") or "space" in n.split("-")]


def test_every_service_has_a_mem_limit_in_m_or_g_and_the_sum_is_the_documented_one(profile, manifest):
    services = manifest["services"]
    for name, service in services.items():
        assert "mem_limit" in service, name
        rules._mib(service["mem_limit"])  # an integer with m or g
    total = rules._total_mib(services)
    assert total <= rules.MAX_MIB
    assert total == rules.EXPECTED_MIB == 4032  # docs/DEMO.md: the sum does not change


def test_volumes_are_structured_declared_and_used(profile, manifest):
    declared = set(manifest.get("volumes") or {})
    used = set()
    for name, service in manifest["services"].items():
        for mount in service.get("volumes", []):
            assert isinstance(mount, dict), name
            assert mount["type"] in {"bind", "volume", "tmpfs"}, (name, mount)
            assert set(mount) <= rules.ALLOWED_MOUNT_KEYS, (name, mount)
            assert mount["type"] != "bind", (name, mount)
            assert mount["target"].startswith("/"), (name, mount)
            if mount["type"] == "volume":
                assert mount["source"] in declared, (name, mount)
                used.add(mount["source"])
            if mount["type"] == "tmpfs":
                assert "source" not in mount, (name, mount)
    assert used == declared


def test_builds_use_only_allowed_keys_and_literal_paths_inside_the_repository(profile, manifest):
    builds = {n: s["build"] for n, s in manifest["services"].items() if "build" in s}
    assert builds
    for name, build in builds.items():
        assert set(build) <= rules.ALLOWED_BUILD_KEYS, name
        for key in ("context", "dockerfile"):
            value = build[key]
            assert "${" not in value and not value.startswith("/") and ".." not in value.split("/"), (name, key)
        assert (ROOT / build["context"] / build["dockerfile"]).is_file(), (name, build)
        for key, value in (build.get("args") or {}).items():
            assert not rules.SECRET_NAME.search(key) and "${" not in str(value), (name, key)


def test_secrets_are_references_never_literals_and_references_have_no_defaults(profile, manifest):
    for name, service in manifest["services"].items():
        for key, value in rules._env(service).items():
            if rules.SECRET_NAME.search(key) and not key.endswith("_FILE"):
                assert rules.WHOLE_REFERENCE.fullmatch(value), f"{name}:{key}"
            if key in rules.PRIVATE_VARIABLES:
                assert value == f"${{{key}}}", f"{name}:{key}"
    for text in rules._strings(manifest):
        for body in rules.REFERENCE.findall(text):
            name = rules.reference_name(body)
            assert re.fullmatch(r"[A-Z][A-Z0-9_]*", name), body
            assert name.startswith("DEMO_") or name in rules.PRIVATE_VARIABLES, body
    text = profile.path.read_text(encoding="utf-8")
    assert not rules.SECRET_SHAPES.search(text)
    assert rules.DESTRUCTIVE_KEY not in text and "VITE_API_KEY" not in text


def test_only_the_gateway_holds_the_jwt_secret_and_one_port_is_published(profile, manifest):
    services = manifest["services"]
    holders = {n for n, s in services.items() if rules.JWT_SECRET in json.dumps(s)}
    assert holders == rules.JWT_HOLDERS
    ports = [(n, port) for n, s in services.items() for port in s.get("ports", [])]
    assert ports == [("web", rules.PUBLISHED_REFERENCE)]


def test_long_running_services_have_healthchecks_and_depends_on_is_consistent(profile, manifest):
    services = manifest["services"]
    for name, service in services.items():
        if name not in rules.ONE_SHOT:
            assert service.get("healthcheck", {}).get("test"), name
        for dependency, rule in (service.get("depends_on") or {}).items():
            assert dependency in services and "profiles" not in services[dependency], (name, dependency)
            assert rule == {"condition": "service_healthy"}, (name, dependency)
            assert "healthcheck" in services[dependency], (name, dependency)


# -- they differ from compose.lab.json only in bim-service ---------------------------------------


def test_every_other_service_the_volumes_and_the_name_are_those_of_compose_lab(profile, manifest, base):
    assert manifest["name"] == base["name"], "the same project, so up on either file reuses the same volumes"
    assert manifest["volumes"] == base["volumes"]
    assert set(manifest["services"]) == set(base["services"])
    for name in base["services"]:
        if name != "bim-service":
            assert manifest["services"][name] == base["services"][name], name


def test_bim_service_differs_only_in_its_environment(profile, manifest, base):
    mine, original = manifest["services"]["bim-service"], base["services"]["bim-service"]
    assert set(mine) == set(original)
    for key in original:
        if key != "environment":
            assert mine[key] == original[key], key
    # The container budget is unchanged: this is what the fit rule is computed against.
    assert (mine["mem_limit"], mine["cpus"], mine["pids_limit"]) == ("256m", 1.5, 256)
    # The command is unchanged: the token is still written by the shell from the container's environment.
    assert mine["command"] == original["command"]
    assert '"$$DEMO_BIM_TOKEN"' in " ".join(mine["command"]) and "${DEMO_BIM_TOKEN}" not in " ".join(mine["command"])
    assert rules._env(mine)["DEMO_BIM_TOKEN"] == "${DEMO_BIM_TOKEN}"
    assert {"type": "tmpfs", "target": "/run/bim"} in mine["volumes"]


def test_the_environment_changes_are_exactly_the_documented_ones(profile, manifest, base):
    mine, original = _bim_env(manifest), rules._env(base["services"]["bim-service"])
    changed = {k for k in original if mine[k] != original[k]}
    added = set(mine) - set(original)
    # N=2 keeps the original concurrency of 2, so that one may be unchanged.
    sizing = {
        "BIM_SERVICE_MAX_BODY_BYTES",
        "BIM_SERVICE_MEMORY_BUDGET_BYTES",
        "BIM_SERVICE_MAX_PENDING_BODY_BYTES",
    }
    assert sizing <= changed <= sizing | {"BIM_SERVICE_MAX_CONCURRENCY"}
    assert added == {
        "BIM_SERVICE_EXECUTOR",
        "BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT",
        "BIM_SERVICE_ACQUIRE_TIMEOUT_MS",
    }
    assert all(k.startswith("BIM_SERVICE_") for k in added)
    for key in ("DEMO_BIM_TOKEN", "BIM_SERVICE_TOKENS_FILE"):
        assert mine[key] == original[key]


def test_the_two_profiles_differ_from_each_other_only_in_the_bim_service_environment(manifests):
    one, two = manifests["N1"], manifests["N2"]
    assert {k: v for k, v in one["services"].items() if k != "bim-service"} == \
        {k: v for k, v in two["services"].items() if k != "bim-service"}
    a, b = one["services"]["bim-service"], two["services"]["bim-service"]
    assert {k: v for k, v in a.items() if k != "environment"} == {k: v for k, v in b.items() if k != "environment"}
    assert set(rules._env(a)) == set(rules._env(b))


# -- the declared parameters ----------------------------------------------------------------------


def test_the_executor_is_process_and_the_parameters_are_the_profiles(profile, manifest):
    env = _bim_env(manifest)
    assert env["BIM_SERVICE_EXECUTOR"] == "process"
    for key in env:
        if key.startswith("BIM_SERVICE_") and key not in {"BIM_SERVICE_EXECUTOR", "BIM_SERVICE_TOKENS_FILE"}:
            assert env[key].isdigit(), (key, env[key])  # a plain integer, parsed by int() in from_env
    assert int(env["BIM_SERVICE_MAX_BODY_BYTES"]) == profile.body
    assert int(env["BIM_SERVICE_MAX_CONCURRENCY"]) == profile.workers
    assert int(env["BIM_SERVICE_MEMORY_BUDGET_BYTES"]) == profile.budget
    assert int(env["BIM_SERVICE_MAX_PENDING_BODY_BYTES"]) == profile.pending
    assert int(env["BIM_SERVICE_ACQUIRE_TIMEOUT_MS"]) == profile.acquire_ms
    assert int(env["BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT"]) == 0


def test_the_budget_pending_and_timeout_are_coherent_with_the_body_limit(profile, manifest):
    env = _bim_env(manifest)
    body, budget = int(env["BIM_SERVICE_MAX_BODY_BYTES"]), int(env["BIM_SERVICE_MEMORY_BUDGET_BYTES"])
    pending = int(env["BIM_SERVICE_MAX_PENDING_BODY_BYTES"])
    # A request at the advertised limit is admissible (else 413 memory_budget_exceeded for a body the service
    # advertises), and the budget admits no more than one of them at once: the container cannot hold two.
    assert budget == BODY_MEMORY_FACTOR * body
    # As many bytes may wait as may run (the service's own default), and never less than the largest body.
    assert pending == 2 * (budget // BODY_MEMORY_FACTOR) and pending >= body
    # The slot a request waits for is back within the 0.5 s refill delay plus a cold start (about 0.3 s): a request
    # that follows a timeout must not meet a 503 service_busy.
    assert int(env["BIM_SERVICE_ACQUIRE_TIMEOUT_MS"]) >= 1000
    # One tenant shares the token of gateway, worker and seed: a per-tenant share would turn queueing for a slot into an
    # immediate 429, so none is set; the slots, the budget and the pending cap are the limits.
    assert int(env["BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT"]) == 0
    assert body < THREAD_BODY, "the process profiles advertise less than the thread laboratory"


def test_the_fit_rule_holds_with_the_measured_figures_and_margin(profile):
    required = required_bytes(profile, PARENT_MEASURED, CHILD_MEASURED)
    assert required <= MEMORY_MAX
    assert MEMORY_MAX - required >= MIN_HEADROOM_MEASURED, MEMORY_MAX - required


def test_the_fit_rule_holds_with_conservative_figures(profile):
    required = required_bytes(profile, PARENT_CONSERVATIVE, CHILD_CONSERVATIVE)
    assert required <= MEMORY_MAX
    assert MEMORY_MAX - required >= MIN_HEADROOM_CONSERVATIVE, MEMORY_MAX - required


def test_the_fit_rule_is_the_one_the_service_enforces():
    workers = (SERVICE_DIR / "workers.py").read_text(encoding="utf-8")
    settings = (SERVICE_DIR / "settings.py").read_text(encoding="utf-8")
    assert re.search(r"^FIT_MARGIN = 0\.10$", workers, re.MULTILINE)
    assert re.search(r"^BODY_MEMORY_FACTOR = 8$", settings, re.MULTILINE)
    assert "return BODY_MEMORY_FACTOR * self.max_body_bytes" in settings
    for term in (
        '"P": parent_rss',
        '"Q": settings.effective_max_pending_body_bytes',
        '"N*C": n * child_rss',
        '"B": settings.memory_budget_bytes or n * allowance',
        '"N*(L+R)": n * (settings.max_body_bytes + allowance)',
    ):
        assert term in workers, term
    assert "margin = int(FIT_MARGIN * memory_max)" in workers


def test_the_documented_example_of_service_md_is_reproduced():
    # bim-toolchain/docs/SERVICE.md: 253397401 bytes for N=1 and 244144537 for N=2, with the measured C and the lab P.
    assert required_bytes(N1, PARENT_MEASURED, CHILD_MEASURED) == 253397401
    assert required_bytes(N2, PARENT_MEASURED, CHILD_MEASURED) == 244144537


def test_the_thread_laboratory_settings_would_not_fit_in_process_mode():
    # The thread laboratory's 16 MiB / N=2 under the fit rule: the reason SERVICE.md gives for not switching it.
    thread = Profile("thread", BASE, workers=2, body=16 * MIB, budget=128 * MIB, pending=32 * MIB, acquire_ms=250)
    assert required_bytes(thread, PARENT_MEASURED, CHILD_MEASURED) == 655186329 > MEMORY_MAX


# -- what the service publishes -------------------------------------------------------------------


def test_public_limits_publish_the_values_the_profile_sets():
    settings = (SERVICE_DIR / "settings.py").read_text(encoding="utf-8")
    published = {
        "maxBodyBytes": "max_body_bytes",
        "maxConcurrentOperations": "max_concurrency",
        "maxConcurrentOperationsPerTenant": "effective_max_concurrency_per_tenant",
        "acquireTimeoutMs": "acquire_timeout_ms",
        "memoryBudgetBytes": "memory_budget_bytes",
        "maxPendingBodyBytes": "effective_max_pending_body_bytes",
        "executor": "executor",
    }
    for key, attribute in published.items():
        assert f'"{key}": self.{attribute},' in settings, key
    for p in PROFILES:
        assert set(p.limits) == set(published)


@pytest.mark.parametrize("p", PROFILES, ids=IDS)
def test_capabilities_must_publish_the_declared_body_limit(p):
    env = _bim_env(_load(p.path))
    # BimServiceSettings.from_env reads these names; limits.service is public_limits() of the result.
    assert p.limits["maxBodyBytes"] == int(env["BIM_SERVICE_MAX_BODY_BYTES"])
    assert p.limits["maxConcurrentOperations"] == int(env["BIM_SERVICE_MAX_CONCURRENCY"])
    assert p.limits["maxPendingBodyBytes"] == int(env["BIM_SERVICE_MAX_PENDING_BODY_BYTES"])
    assert p.limits["memoryBudgetBytes"] == int(env["BIM_SERVICE_MEMORY_BUDGET_BYTES"])
    assert p.limits["acquireTimeoutMs"] == int(env["BIM_SERVICE_ACQUIRE_TIMEOUT_MS"])
    assert p.limits["maxBodyBytes"] < THREAD_BODY, "16 MiB (let alone 32 MiB) is not admitted by a process profile"


# -- rollback --------------------------------------------------------------------------------------


def test_compose_lab_is_the_thread_rollback(base):
    env = rules._env(base["services"]["bim-service"])
    assert "BIM_SERVICE_EXECUTOR" not in env  # the default: thread
    assert int(env["BIM_SERVICE_MAX_BODY_BYTES"]) == THREAD_BODY
    assert (env["BIM_SERVICE_MAX_CONCURRENCY"], env["BIM_SERVICE_MEMORY_BUDGET_BYTES"]) == ("2", "134217728")
    assert env["BIM_SERVICE_MAX_PENDING_BODY_BYTES"] == "33554432"
    assert not [k for k in env if k.endswith(("_PER_TENANT", "_ACQUIRE_TIMEOUT_MS"))]
    for p in PROFILES:
        mine = _bim_env(_load(p.path))
        assert mine["BIM_SERVICE_EXECUTOR"] == "process"


# -- documentation ---------------------------------------------------------------------------------


def _doc() -> str:
    return DOC.read_text(encoding="utf-8")


def test_the_deployment_doc_states_the_terms_of_the_fit_rule_for_both_profiles():
    doc = _doc()
    for p in PROFILES:
        for parent, child in ((PARENT_MEASURED, CHILD_MEASURED), (PARENT_CONSERVATIVE, CHILD_CONSERVATIVE)):
            required = required_bytes(p, parent, child)
            assert str(required) in doc, (p.name, parent, child, required)
            assert str(MEMORY_MAX - required) in doc, (p.name, parent, child)
        for value in (p.body, p.budget, p.pending, p.acquire_ms):
            assert str(value) in doc, (p.name, value)
    assert "P + Q + N*C + B + N*(L + R) + margin" in doc
    assert str(int(FIT_MARGIN * MEMORY_MAX)) in doc


def test_the_deployment_doc_publishes_the_capabilities_each_profile_must_show():
    blocks = [json.loads(b) for b in re.findall(r"```json\n(.*?)```", _doc(), re.DOTALL)]
    limits = [b for b in blocks if isinstance(b, dict) and "executor" in b]
    assert limits == [N2.limits, N1.limits]  # in the order of the document: the recommended profile first


def test_the_deployment_doc_covers_activation_rollback_and_verification():
    doc = _doc()
    for needle in (
        "compose.lab.json",
        "compose.lab-process.json",
        "compose.lab-process-n2.json",
        "lab_compose up file=compose.lab-process-n2.json",
        "lab_compose up file=compose.lab-process.json",
        "lab_compose up file=compose.lab.json",
        "metrics",
        "oom_kill",
        "READY",
        "healthz",
        "capabilities",
        "413",
        "429",
        "operation_timeout",
        "4032 MiB",
        "256 MiB",
        "16 MiB",
        "32 MiB",
    ):
        assert needle in doc, needle
    assert "does not admit 16" in doc or "NOT admit 16" in doc or "not admit 16" in doc
    assert "recommend" in doc.lower()
    assert "assumption" in doc.lower()


def test_demo_doc_links_to_the_deployment_doc_and_keeps_the_memory_sum():
    demo = DEMO_DOC.read_text(encoding="utf-8")
    assert "qa/PROCESS_DEPLOYMENT.md" in demo
    assert "4032 MiB" in demo
    assert DOC.is_file()
