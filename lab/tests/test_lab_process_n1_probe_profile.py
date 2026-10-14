"""Static checks of ``compose.lab-process-n1-probe.json``, without Docker.

It is ``compose.lab-process.json`` (the N1 profile: one process worker, bodies up to 6 MiB) with one more variable for
``bim-service``, ``BIM_SERVICE_OPERATION_TIMEOUT_SECONDS=3``, so that a real ``503 operation_timeout`` can be exercised in a
few seconds with a single slot. It must pass the rules that ``test_lab_process_profiles.py`` applies to the process
profiles (which are those of ``test_lab_compose.py``) and differ from the N1 manifest only by that variable.

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

# The rules of the process profiles, loaded by path. The module must be registered before it runs: its dataclass
# resolves its postponed annotations through ``sys.modules``.
_spec = importlib.util.spec_from_file_location("lab_process_profiles", HERE / "test_lab_process_profiles.py")
profiles = importlib.util.module_from_spec(_spec)
sys.modules["lab_process_profiles"] = profiles
_spec.loader.exec_module(profiles)
rules = profiles.rules

N1 = profiles.N1
PROBE_PATH = ROOT / "compose.lab-process-n1-probe.json"
PROBE = profiles.Profile(
    "N1-probe", PROBE_PATH, workers=N1.workers, body=N1.body, budget=N1.budget, pending=N1.pending, acquire_ms=N1.acquire_ms
)
TIMEOUT_VARIABLE = "BIM_SERVICE_OPERATION_TIMEOUT_SECONDS"
TIMEOUT_SECONDS = "3"
ACQUIRE_LINE = '        "BIM_SERVICE_ACQUIRE_TIMEOUT_MS": "3000"\n'

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


def test_it_is_the_n1_manifest_byte_for_byte_plus_one_line():
    n1 = N1.path.read_text(encoding="utf-8")
    assert n1.count(ACQUIRE_LINE) == 1
    expected = n1.replace(
        ACQUIRE_LINE,
        '        "BIM_SERVICE_ACQUIRE_TIMEOUT_MS": "3000",\n'
        f'        "{TIMEOUT_VARIABLE}": "{TIMEOUT_SECONDS}"\n',
    )
    assert PROBE_PATH.read_text(encoding="utf-8") == expected


def test_the_only_difference_with_n1_is_the_time_budget_of_an_operation(manifest):
    n1 = _load(N1.path)
    assert TIMEOUT_VARIABLE not in _env(n1), "N1 keeps the service default of 60 s"
    assert _env(manifest) == {**_env(n1), TIMEOUT_VARIABLE: TIMEOUT_SECONDS}
    without_env = {
        name: {key: value for key, value in service.items() if not (name == "bim-service" and key == "environment")}
        for name, service in manifest["services"].items()
    }
    n1_without_env = {
        name: {key: value for key, value in service.items() if not (name == "bim-service" and key == "environment")}
        for name, service in n1["services"].items()
    }
    assert without_env == n1_without_env
    assert {key: value for key, value in manifest.items() if key != "services"} == {
        key: value for key, value in n1.items() if key != "services"
    }
    assert rules._total_mib(manifest["services"]) == rules.EXPECTED_MIB == 4032


def test_the_profile_is_n1_one_process_worker_and_bodies_up_to_6_mib(manifest):
    env = _env(manifest)
    assert env["BIM_SERVICE_EXECUTOR"] == "process"
    assert int(env["BIM_SERVICE_MAX_CONCURRENCY"]) == 1
    assert int(env["BIM_SERVICE_MAX_BODY_BYTES"]) == 6291456 == 6 * profiles.MIB


def test_the_time_budget_is_short_but_leaves_the_slot_back_within_the_acquire_timeout(manifest):
    env = _env(manifest)
    budget = int(env[TIMEOUT_VARIABLE])
    assert budget == 3
    # Short enough to see a real timeout in seconds, below the service default.
    assert 1 <= budget < 60
    # The worker is killed at the budget and its replacement is up within about a second (docs/qa/PROCESS_DEPLOYMENT.md);
    # with one slot, the next request waits for it.
    assert int(env["BIM_SERVICE_ACQUIRE_TIMEOUT_MS"]) >= 1000
