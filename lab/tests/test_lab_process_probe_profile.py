"""Static checks of ``compose.lab-process-n2-probe.json``, without Docker.

It is ``compose.lab-process-n2.json`` with one more variable for ``bim-service``,
``BIM_SERVICE_OPERATION_TIMEOUT_SECONDS=3``, so that the timeout probe of ``tools/process_probe.py`` (see
``docs/qa/PROCESS_PROBE.md``) can see a real ``503 operation_timeout`` in a few seconds. It must pass the rules that
``test_lab_process_profiles.py`` applies to the process profiles (which are those of ``test_lab_compose.py``) and
differ from the N2 manifest only by that variable.

Run from ``openbinding-gateway`` with its environment::

    uv run --locked pytest ../lab/tests
"""

from __future__ import annotations

import importlib.util
import inspect
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

# The rules of the process profiles, loaded by path (they load those of the original manifest the same way). The module
# must be registered before it runs: its dataclass resolves its postponed annotations through ``sys.modules``.
_spec = importlib.util.spec_from_file_location("lab_process_profiles", HERE / "test_lab_process_profiles.py")
profiles = importlib.util.module_from_spec(_spec)
sys.modules["lab_process_profiles"] = profiles
_spec.loader.exec_module(profiles)
rules = profiles.rules

N2 = profiles.N2
PROBE_PATH = ROOT / "compose.lab-process-n2-probe.json"
PROBE = profiles.Profile(
    "N2-probe", PROBE_PATH, workers=N2.workers, body=N2.body, budget=N2.budget, pending=N2.pending, acquire_ms=N2.acquire_ms
)
TIMEOUT_VARIABLE = "BIM_SERVICE_OPERATION_TIMEOUT_SECONDS"
TIMEOUT_SECONDS = "3"
ACQUIRE_LINE = '        "BIM_SERVICE_ACQUIRE_TIMEOUT_MS": "2000"\n'
TOOL = ROOT / "openbinding-gateway" / "tools" / "process_probe.py"
DOC = ROOT / "docs" / "qa" / "PROCESS_PROBE.md"

#: Rules of ``test_lab_process_profiles.py`` that apply to the probe manifest as they are.
RULES = [
    "test_shape_and_names_follow_the_validator_rules",
    "test_no_forbidden_key_no_network_mode_no_socket_no_space_service",
    "test_every_service_has_a_mem_limit_in_m_or_g_and_the_sum_is_the_documented_one",
    "test_volumes_are_structured_declared_and_used",
    "test_builds_use_only_allowed_keys_and_literal_paths_inside_the_repository",
    "test_secrets_are_references_never_literals_and_references_have_no_defaults",
    "test_only_the_gateway_holds_the_jwt_secret_and_one_port_is_published",
    "test_long_running_services_have_healthchecks_and_depends_on_is_consistent",
    "test_every_other_service_the_volumes_and_the_name_are_those_of_compose_lab",
    "test_bim_service_differs_only_in_its_environment",
    "test_the_executor_is_process_and_the_parameters_are_the_profiles",
    "test_the_budget_pending_and_timeout_are_coherent_with_the_body_limit",
    "test_the_fit_rule_holds_with_the_measured_figures_and_margin",
    "test_the_fit_rule_holds_with_conservative_figures",
]
#: The one rule that does not apply: it lists the three variables a process profile adds, and this one adds a fourth.
NOT_APPLICABLE = {"test_the_environment_changes_are_exactly_the_documented_ones"}


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _env(manifest: dict) -> dict:
    return rules._env(manifest["services"]["bim-service"])


@pytest.fixture(scope="module")
def manifest() -> dict:
    return _load(PROBE_PATH)


@pytest.fixture(scope="module")
def base() -> dict:
    return _load(profiles.BASE)


@pytest.mark.parametrize("name", RULES)
def test_the_probe_manifest_passes_the_rule_of_the_process_profiles(name, manifest, base):
    function = getattr(profiles, name)
    available = {"profile": PROBE, "manifest": manifest, "base": base}
    function(**{key: value for key, value in available.items() if key in inspect.signature(function).parameters})


def test_no_rule_of_the_process_profiles_is_forgotten():
    with_profile = {
        name
        for name, function in inspect.getmembers(profiles, inspect.isfunction)
        if name.startswith("test_") and "profile" in inspect.signature(function).parameters
    }
    assert with_profile == set(RULES) | NOT_APPLICABLE


def test_it_is_the_n2_manifest_byte_for_byte_plus_one_line():
    n2 = N2.path.read_text(encoding="utf-8")
    assert n2.count(ACQUIRE_LINE) == 1
    expected = n2.replace(
        ACQUIRE_LINE,
        '        "BIM_SERVICE_ACQUIRE_TIMEOUT_MS": "2000",\n'
        f'        "{TIMEOUT_VARIABLE}": "{TIMEOUT_SECONDS}"\n',
    )
    assert PROBE_PATH.read_text(encoding="utf-8") == expected


def test_the_only_difference_with_n2_is_the_time_budget_of_an_operation(manifest):
    n2 = _load(N2.path)
    assert TIMEOUT_VARIABLE not in _env(n2), "N2 keeps the service default of 60 s"
    assert _env(manifest) == {**_env(n2), TIMEOUT_VARIABLE: TIMEOUT_SECONDS}
    without_env = {
        name: {key: value for key, value in service.items() if not (name == "bim-service" and key == "environment")}
        for name, service in manifest["services"].items()
    }
    n2_without_env = {
        name: {key: value for key, value in service.items() if not (name == "bim-service" and key == "environment")}
        for name, service in n2["services"].items()
    }
    assert without_env == n2_without_env
    assert {key: value for key, value in manifest.items() if key != "services"} == {
        key: value for key, value in n2.items() if key != "services"
    }
    assert rules._total_mib(manifest["services"]) == rules.EXPECTED_MIB == 4032


def test_the_time_budget_is_short_but_leaves_the_slot_back_within_the_acquire_timeout(manifest):
    env = _env(manifest)
    budget = int(env[TIMEOUT_VARIABLE])
    assert budget == 3
    # Long enough for a valid request of the probe to be running when the budget ends; short enough to see it in seconds.
    assert 1 <= budget < 60
    # The worker is killed at the budget and its replacement is up within about a second (docs/qa/PROCESS_DEPLOYMENT.md).
    assert int(env["BIM_SERVICE_ACQUIRE_TIMEOUT_MS"]) >= 1000


def test_the_seed_service_runs_the_tool_named_by_the_environment(manifest):
    command = " ".join(manifest["services"]["seed"]["command"])
    assert "python tools/${DEMO_SEED_TOOL} ${DEMO_SEED_ARGS}" in command
    assert TOOL.is_file()
    assert "COPY openbinding-gateway/tools/ tools/" in (ROOT / "openbinding-gateway" / "Dockerfile").read_text(encoding="utf-8")
    seed_env = rules._env(manifest["services"]["seed"])
    assert seed_env["BIM_SERVICE_URL"] == "http://bim-service:8080"
    assert seed_env["BIM_SERVICE_TOKEN_FILE"] == "/run/bim/token"
    assert manifest["services"]["seed"]["depends_on"] == {"bim-service": {"condition": "service_healthy"}}


def test_the_defaults_of_the_tool_are_the_figures_of_the_n2_profile():
    spec = importlib.util.spec_from_file_location("process_probe_under_test", TOOL)
    module = importlib.util.module_from_spec(spec)
    sys.modules["process_probe_under_test"] = module
    spec.loader.exec_module(module)
    defaults = module.N2_DEFAULTS
    assert defaults["executor"] == "process"
    assert defaults["max_body_bytes"] == N2.body
    assert defaults["concurrency"] == N2.workers
    assert defaults["memory_budget_bytes"] == N2.budget
    assert defaults["pending_body_bytes"] == N2.pending
    assert defaults["acquire_timeout_ms"] == N2.acquire_ms
    assert defaults["tenant_limit"] == int(_env(_load(N2.path))["BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT"]) == 0
    assert defaults["container_memory_bytes"] == profiles.MEMORY_MAX
    assert module.PROBE_OPERATION_TIMEOUT == float(TIMEOUT_SECONDS)
    assert module.fit_required_bytes(
        body=N2.body, workers=N2.workers, budget=N2.budget, pending=N2.pending, container=profiles.MEMORY_MAX
    ) == profiles.required_bytes(N2, profiles.PARENT_CONSERVATIVE, profiles.CHILD_CONSERVATIVE)


def test_the_documentation_says_how_to_run_the_probe_and_what_it_proves():
    text = DOC.read_text(encoding="utf-8")
    for needle in (
        "compose.lab-process-n2-probe.json",
        "lab_compose up file=compose.lab-process-n2-probe.json",
        "lab_compose seed",
        "DEMO_SEED_TOOL=process_probe.py",
        "DEMO_SEED_ARGS",
        "--timeout-probe",
        "--hold",
        "operation_timeout",
        "service_busy",
        "pending_body_bytes",
        "payload_too_large",
        "lab_compose metrics",
        "oom_kill",
        "Exit code",
        "compose.lab-process-n2.json",
        "BIM_SERVICE_OPERATION_TIMEOUT_SECONDS",
    ):
        assert needle in text, needle
    for step in (
        "capabilities",
        "valid_operations",
        "hostile_small",
        "large_bodies",
        "saturation",
        "healthz_under_load",
        "timeout_replacement",
    ):
        assert f"`{step}`" in text, step
