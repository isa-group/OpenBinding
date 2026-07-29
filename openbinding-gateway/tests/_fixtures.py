"""Instances shared by several test modules.

A plain module rather than conftest, so importing it is unambiguous: pytest
puts every conftest directory on sys.path, and `from conftest import ...`
resolved to whichever one came first.
"""

from __future__ import annotations

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
                "id": cid, "name": cid, "task_ids": [task], "provider_id": f"prov_{pool}",
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
