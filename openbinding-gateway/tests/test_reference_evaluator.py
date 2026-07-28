"""Correctness tests for the BIM' reference evaluator.

Every expected value in this file is computed by hand (or by an independent
brute-force path enumerator) so that the reference evaluator — the single
source of truth every engine is checked against — is itself verified.
"""

import copy
import itertools
import random

import pytest

from openbinding_gateway.validation.engine_plugins.reference_evaluator import (
    build_scenarios,
    evaluate_solution,
)


# ---------------------------------------------------------------------------
# Micro instance: 4 tasks, 3 pools, XOR inside AND (arOrch-like shape)
#
# Composition: SEQ(t1, AND(SEQ(t2, XOR(t3a | t3b)), t4))  -- t3a/t3b tasks
# wait: XOR branches are tasks t3a, t3b; sinks of AND = {t3a|t3b, t4};
# no trailing task, so sinks of root = XOR-branch task and t4.
# Pools: p1, p2, p3. Event ev0 at p1.
# ---------------------------------------------------------------------------

LAT = {
    "p1": {"p1": 0.0, "p2": 10.0, "p3": 20.0},
    "p2": {"p2": 0.0, "p3": 4.0},
    "p3": {"p3": 0.0},
}
EVENT_LAT = {"ev0": {"p1": 1.0, "p2": 5.0, "p3": 9.0}}


def micro_instance():
    tasks = ["t1", "t2", "t3a", "t3b", "t4"]
    features = [
        {"id": "latency", "name": "Latency", "direction": "MINIMIZE", "unit": "ms",
         "scale": "RATIO", "valid_range": {"min": 0, "max": 100000}},
        {"id": "cost", "name": "Cost", "direction": "MINIMIZE", "unit": "USD",
         "scale": "RATIO", "valid_range": {"min": 0, "max": 100000}},
        {"id": "security", "name": "Security", "direction": "MAXIMIZE", "unit": "score",
         "scale": "RATIO", "valid_range": {"min": 0, "max": 1}},
    ]
    # One candidate per (task, pool). Costs: p1=1, p2=5, p3=9 per task.
    # Security: p1=0.33, p2=0.66, p3=1.0. Exec latency: 2 ms everywhere.
    pool_cost = {"p1": 1.0, "p2": 5.0, "p3": 9.0}
    pool_sec = {"p1": 0.33, "p2": 0.66, "p3": 1.0}
    candidates = []
    bindings = []
    for task in tasks:
        for pool in ("p1", "p2", "p3"):
            cid = f"c_{task}_{pool}"
            candidates.append({
                "id": cid, "name": cid, "task_id": task, "provider_id": f"prov_{pool}",
                "features": {"latency": 2.0, "cost": pool_cost[pool], "security": pool_sec[pool]},
            })
            bindings.append({"candidate_id": cid, "pool_id": pool,
                             "demand": {"memory": 2.0}})

    composition = {
        "type": "STRUCTURED",
        "root": {
            "id": "n_root", "kind": "SEQ",
            "children": [
                {"id": "n_t1", "kind": "TASK", "task_id": "t1"},
                {"id": "n_and", "kind": "AND", "children": [
                    {"id": "n_seq2", "kind": "SEQ", "children": [
                        {"id": "n_t2", "kind": "TASK", "task_id": "t2"},
                        {"id": "n_xor", "kind": "XOR", "branches": [
                            {"p": 0.5, "child": {"id": "n_t3a", "kind": "TASK", "task_id": "t3a"}},
                            {"p": 0.5, "child": {"id": "n_t3b", "kind": "TASK", "task_id": "t3b"}},
                        ]},
                    ]},
                    {"id": "n_t4", "kind": "TASK", "task_id": "t4"},
                ]},
            ],
        },
    }

    return {
        "metadata": {"id": "micro", "name": "micro", "version": "1.0.0",
                     "created_at": "2026-01-01T00:00:00Z"},
        "features": features,
        "providers": [{"id": f"prov_{p}", "name": p} for p in ("p1", "p2", "p3")],
        "tasks": [{"id": t, "name": t} for t in tasks],
        "candidates": candidates,
        "composition": composition,
        "aggregation_policies": {
            "cost": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}, "and": {"fn": "SUM"},
                                               "xor": {"fn": "SCALED_SUM"}},
                     "normalize": {"type": "minmax", "bounds": {"min": 0.0, "max": 50.0}}},
            "latency": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}, "and": {"fn": "MAX"},
                                                  "xor": {"fn": "SCALED_SUM"}},
                        "normalize": {"type": "minmax", "bounds": {"min": 0.0, "max": 100.0}}},
            "security": {"neutral": 1, "compose": {"seq": {"fn": "MIN"}, "and": {"fn": "MIN"},
                                                   "xor": {"fn": "MIN"}},
                         "normalize": {"type": "minmax", "bounds": {"min": 0.0, "max": 1.0}}},
        },
        "constraints": [],
        "objective": {
            "type": "MONO",
            "targets": ["latency", "cost", "security"],
            "weights": {"latency": 0.4, "cost": 0.4, "security": 0.2},
            "weights_sum_to_one": True,
        },
        "resource_model": {
            "resources": ["memory"],
            "pools": [
                {"id": "p1", "name": "p1", "kind": "EDGE", "capacity": {"memory": 4.0}},
                {"id": "p2", "name": "p2", "kind": "EDGE", "capacity": {"memory": 4.0}},
                {"id": "p3", "name": "p3", "kind": "CLOUD", "capacity": {"memory": 100.0}},
            ],
            "candidate_bindings": bindings,
            "constraints": [
                {"id": "cap_all", "kind": "DEPENDENCY", "type": "RESOURCE_CAPACITY",
                 "scope": "ALL_POOLS", "resources": ["memory"], "hard": True},
            ],
        },
        "latency_model": {
            "unit": "ms",
            "pool_latency_matrix_ms": LAT,
            "event_generator_pools": {"ev0": "p1"},
            "event_latency_matrix_ms": EVENT_LAT,
            "transition_constraints": [
                {"id": "tr_t1_t2", "from_task": "t1", "to_task": "t2",
                 "op": "<=", "value": 15.0, "hard": True},
                {"id": "tr_ev_t1", "from_event": "ev0", "to_task": "t1",
                 "op": "<=", "value": 6.0, "hard": True},
            ],
            "global_latency": {
                "attribute_id": "latency",
                "include_execution_latency_feature": True,
                "xor_semantics": "EXPECTED",
                "and_semantics": "MAX",
            },
        },
    }


def lat(a, b):
    v = LAT.get(a, {}).get(b)
    if v is None:
        v = LAT.get(b, {}).get(a)
    return v


def brute_force_e2e(instance, binding):
    """Independent makespan: longest path over each XOR scenario's DAG.

    The makespan of a precedence DAG equals the longest source-to-sink path
    (edge weight = transfer latency, node weight = execution latency), which
    this helper computes by explicit path enumeration.
    """
    pool_of = {cb["candidate_id"]: cb["pool_id"]
               for cb in instance["resource_model"]["candidate_bindings"]}
    exec_of = {c["id"]: c["features"]["latency"] for c in instance["candidates"]}
    task_pool = {t: pool_of[c] for t, c in binding.items()}
    task_exec = {t: exec_of[c] for t, c in binding.items()}

    scenarios = build_scenarios(
        instance["composition"]["root"],
        sorted(instance["latency_model"]["event_generator_pools"].keys()),
    )

    total = 0.0
    for scenario in scenarios:
        # Enumerate all paths ending at each sink by walking preds backwards.
        def longest(task):
            best = 0.0
            for kind, src in scenario["preds"][task]:
                if kind == "event":
                    transfer = EVENT_LAT[src][task_pool[task]]
                    best = max(best, transfer)
                else:
                    transfer = lat(task_pool[src], task_pool[task])
                    best = max(best, longest(src) + transfer)
            return best + task_exec[task]

        makespan = max(longest(sink) for sink in scenario["sinks"])
        total += scenario["prob"] * makespan
    return total


def all_p1_binding(instance):
    return {t["id"]: f"c_{t['id']}_p1" for t in instance["tasks"]}


# ---------------------------------------------------------------------------
# Scenario construction
# ---------------------------------------------------------------------------

def test_scenarios_structure():
    instance = micro_instance()
    scenarios = build_scenarios(instance["composition"]["root"], ["ev0"])
    assert len(scenarios) == 2
    for scenario in scenarios:
        assert scenario["prob"] == pytest.approx(0.5)
        assert scenario["preds"]["t1"] == [("event", "ev0")]
        assert scenario["preds"]["t2"] == [("task", "t1")]
        assert scenario["preds"]["t4"] == [("task", "t1")]
        # sinks: the chosen XOR branch task and t4
        assert set(scenario["sinks"]) == {scenario["order"][2], "t4"}
    chosen = {s["order"][2] for s in scenarios}
    assert chosen == {"t3a", "t3b"}


# ---------------------------------------------------------------------------
# End-to-end latency (hand-computed)
# ---------------------------------------------------------------------------

def test_e2e_latency_all_on_p1():
    instance = micro_instance()
    binding = all_p1_binding(instance)
    # All tasks on p1, exec 2ms each, transfers 0 within p1, event->p1 = 1.
    # Both scenarios: t1 finishes 1+2=3; t2: 3+0+2=5; t3x: 5+0+2=7; t4: 3+0+2=5.
    # Makespan = max(7, 5) = 7 in both scenarios -> expected = 7.
    result = evaluate_solution(instance, binding)
    assert result["aggregated_features"]["latency"] == pytest.approx(7.0)


def test_e2e_latency_mixed_pools():
    instance = micro_instance()
    # t1@p1, t2@p2, t3a@p3, t3b@p2, t4@p1
    binding = {"t1": "c_t1_p1", "t2": "c_t2_p2", "t3a": "c_t3a_p3",
               "t3b": "c_t3b_p2", "t4": "c_t4_p1"}
    # t1: 1 + 2 = 3 (event->p1=1)
    # t2: 3 + lat(p1,p2)=10 + 2 = 15
    # scenario A (t3a@p3): t3a: 15 + lat(p2,p3)=4 + 2 = 21; t4: 3 + 0 + 2 = 5
    #   makespan = max(21, 5) = 21
    # scenario B (t3b@p2): t3b: 15 + 0 + 2 = 17; makespan = max(17, 5) = 17
    # expected = 0.5*21 + 0.5*17 = 19
    result = evaluate_solution(instance, binding)
    assert result["aggregated_features"]["latency"] == pytest.approx(19.0)


def test_e2e_worst_case_semantics():
    instance = micro_instance()
    instance["latency_model"]["global_latency"]["xor_semantics"] = "WORST_CASE"
    binding = {"t1": "c_t1_p1", "t2": "c_t2_p2", "t3a": "c_t3a_p3",
               "t3b": "c_t3b_p2", "t4": "c_t4_p1"}
    result = evaluate_solution(instance, binding)
    assert result["aggregated_features"]["latency"] == pytest.approx(21.0)


def test_e2e_matches_brute_force_on_random_bindings():
    instance = micro_instance()
    rng = random.Random(7)
    tasks = [t["id"] for t in instance["tasks"]]
    for _ in range(25):
        binding = {t: f"c_{t}_{rng.choice(['p1', 'p2', 'p3'])}" for t in tasks}
        expected = brute_force_e2e(instance, binding)
        result = evaluate_solution(instance, binding)
        assert result["aggregated_features"]["latency"] == pytest.approx(expected), binding


# ---------------------------------------------------------------------------
# Constraints
# ---------------------------------------------------------------------------

def test_capacity_violation_detected():
    instance = micro_instance()
    binding = all_p1_binding(instance)  # 5 tasks x 2 memory = 10 > 4 on p1
    result = evaluate_solution(instance, binding)
    codes = [v["constraint_id"] for v in result["violations"]]
    assert "cap_all" in codes
    assert result["feasible"] is False


def test_capacity_legacy_kind_still_enforced():
    """The legacy spelling ``kind: RESOURCE_CAPACITY`` must behave exactly as
    the canonical ``kind: DEPENDENCY`` + ``type: RESOURCE_CAPACITY`` form."""
    canonical = micro_instance()
    legacy = copy.deepcopy(canonical)
    legacy["resource_model"]["constraints"] = [
        {"id": "cap_all", "kind": "RESOURCE_CAPACITY", "scope": "ALL_POOLS",
         "resources": ["memory"], "hard": True},
    ]
    binding = all_p1_binding(canonical)
    r_canonical = evaluate_solution(canonical, binding)
    r_legacy = evaluate_solution(legacy, binding)
    assert [v["constraint_id"] for v in r_legacy["violations"]] == \
        [v["constraint_id"] for v in r_canonical["violations"]]
    assert r_legacy["feasible"] is False


def test_capacity_satisfied_when_spread():
    instance = micro_instance()
    binding = {"t1": "c_t1_p1", "t2": "c_t2_p1", "t3a": "c_t3a_p2",
               "t3b": "c_t3b_p2", "t4": "c_t4_p3"}
    result = evaluate_solution(instance, binding)
    assert all(v["constraint_id"] != "cap_all" for v in result["violations"])


def test_infinite_capacity_equals_removed_constraint():
    instance = micro_instance()
    binding = all_p1_binding(instance)
    relaxed = copy.deepcopy(instance)
    relaxed["resource_model"]["pools"][0]["capacity"]["memory"] = 1e12
    unconstrained = copy.deepcopy(instance)
    unconstrained["resource_model"]["constraints"] = []
    r_relaxed = evaluate_solution(relaxed, binding)
    r_unconstrained = evaluate_solution(unconstrained, binding)
    assert [v["constraint_id"] for v in r_relaxed["violations"]] == \
        [v["constraint_id"] for v in r_unconstrained["violations"]]


def test_transition_violation_detected():
    instance = micro_instance()
    # t1@p1 -> t2@p3: lat 20 > bound 15 -> violation. Event ev0->t1@p1 = 1 <= 6 ok.
    binding = {"t1": "c_t1_p1", "t2": "c_t2_p3", "t3a": "c_t3a_p3",
               "t3b": "c_t3b_p3", "t4": "c_t4_p3"}
    result = evaluate_solution(instance, binding)
    codes = [v["constraint_id"] for v in result["violations"]]
    assert "tr_t1_t2" in codes


def test_event_transition_violation_detected():
    instance = micro_instance()
    # t1@p3: event latency 9 > bound 6 -> violation.
    binding = {"t1": "c_t1_p3", "t2": "c_t2_p3", "t3a": "c_t3a_p3",
               "t3b": "c_t3b_p3", "t4": "c_t4_p3"}
    result = evaluate_solution(instance, binding)
    codes = [v["constraint_id"] for v in result["violations"]]
    assert "tr_ev_t1" in codes


def test_budget_constraints_checked():
    instance = micro_instance()
    instance["constraints"] = [
        {"id": "budget_global", "kind": "ATTRIBUTE_BOUND", "scope": "GLOBAL",
         "attribute_id": "cost", "op": "<=", "value": 10.0, "hard": True},
        {"id": "budget_local_t1", "kind": "ATTRIBUTE_BOUND", "scope": "LOCAL",
         "tasks": ["t1"], "attribute_id": "cost", "op": "<=", "value": 2.0, "hard": True},
    ]
    # All on p3: cost per task 9. Aggregated: t1 + AND(SUM)=... global way over 10.
    binding = {t["id"]: f"c_{t['id']}_p3" for t in micro_instance()["tasks"]}
    result = evaluate_solution(instance, binding)
    codes = [v["constraint_id"] for v in result["violations"]]
    assert "budget_global" in codes and "budget_local_t1" in codes

    # All on p1: cost aggregated = 1 + (1 + 0.5*1 + 0.5*1) + 1 = 4 <= 10; local 1 <= 2.
    binding = all_p1_binding(instance)
    result = evaluate_solution(instance, binding)
    codes = [v["constraint_id"] for v in result["violations"]]
    assert "budget_global" not in codes and "budget_local_t1" not in codes
    assert result["aggregated_features"]["cost"] == pytest.approx(4.0)


def test_same_pool_dependency():
    instance = micro_instance()
    instance["constraints"] = [
        {"id": "dep_pool", "kind": "DEPENDENCY", "type": "SAME_POOL",
         "tasks": ["t1", "t2"], "hard": True},
    ]
    ok = evaluate_solution(instance, {**all_p1_binding(instance)})
    assert all(v["constraint_id"] != "dep_pool" for v in ok["violations"])

    bad_binding = {**all_p1_binding(instance), "t2": "c_t2_p2"}
    bad = evaluate_solution(instance, bad_binding)
    assert any(v["constraint_id"] == "dep_pool" for v in bad["violations"])


# ---------------------------------------------------------------------------
# Canonical objective + metamorphic properties
# ---------------------------------------------------------------------------

def enumerate_optimal(instance):
    """Brute-force optimum over the full binding space (feasible only)."""
    tasks = [t["id"] for t in instance["tasks"]]
    best = None
    for combo in itertools.product(["p1", "p2", "p3"], repeat=len(tasks)):
        binding = {t: f"c_{t}_{p}" for t, p in zip(tasks, combo)}
        result = evaluate_solution(instance, binding)
        if not result["feasible"]:
            continue
        if best is None or result["objective_value"] < best:
            best = result["objective_value"]
    return best


def test_canonical_objective_hand_computed():
    instance = micro_instance()
    binding = all_p1_binding(instance)
    result = evaluate_solution(instance, binding)
    # latency 7 -> loss 7/100 = 0.07 ; cost 4 -> loss 4/50 = 0.08
    # security: MIN everywhere = 0.33 -> loss 1 - 0.33 = 0.67
    expected = 0.4 * 0.07 + 0.4 * 0.08 + 0.2 * 0.67
    assert result["objective_value"] == pytest.approx(expected)


def test_canonical_objective_is_weighted_mean():
    """Uniform convention: dividing by the total weight, also when sum(w) != 1.

    Doubling every weight must leave the canonical objective unchanged —
    the same convention used by the Java engines and the MiniZinc model.
    """
    instance = micro_instance()
    binding = all_p1_binding(instance)
    baseline = evaluate_solution(instance, binding)["objective_value"]

    doubled = copy.deepcopy(instance)
    doubled["objective"]["weights"] = {
        k: 2 * v for k, v in doubled["objective"]["weights"].items()
    }
    doubled["objective"]["weights_sum_to_one"] = False
    assert evaluate_solution(doubled, binding)["objective_value"] == pytest.approx(baseline)


def test_budget_tightening_never_improves_optimum():
    base = micro_instance()
    loose = copy.deepcopy(base)
    loose["constraints"] = [
        {"id": "b", "kind": "ATTRIBUTE_BOUND", "scope": "GLOBAL",
         "attribute_id": "cost", "op": "<=", "value": 40.0, "hard": True}]
    tight = copy.deepcopy(base)
    tight["constraints"] = [
        {"id": "b", "kind": "ATTRIBUTE_BOUND", "scope": "GLOBAL",
         "attribute_id": "cost", "op": "<=", "value": 20.0, "hard": True}]
    opt_loose = enumerate_optimal(loose)
    opt_tight = enumerate_optimal(tight)
    assert opt_loose is not None and opt_tight is not None
    assert opt_loose <= opt_tight + 1e-12


# ---------------------------------------------------------------------------
# Placement payload
# ---------------------------------------------------------------------------

