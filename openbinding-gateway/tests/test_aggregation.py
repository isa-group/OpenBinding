import pytest

from openbinding_gateway.semantics import (
    build_selected_candidate_by_task,
    canonicalize_result_data,
    compute_aggregated_qos,
)


def test_compute_aggregated_qos_uses_neutral_for_element_branch():
    root = {
        "id": "root_seq",
        "kind": "SEQ",
        "children": [
            {"id": "task_t1", "kind": "TASK", "task_id": "T1"},
            {
                "id": "routing_choice",
                "kind": "XOR",
                "branches": [
                    {
                        "p": 0.8,
                        "child": {
                            "id": "classic_path",
                            "kind": "ELEMENT",
                        },
                    },
                    {
                        "p": 0.2,
                        "child": {"id": "task_t5", "kind": "TASK", "task_id": "T5"},
                    },
                ],
            },
        ],
    }

    features = {
        "security": {
            "id": "security",
            "direction": "MAXIMIZE",
            "scale": "ORDINAL",
            "valid_range": {"min": 1, "max": 5},
        }
    }
    agg_policies = {
        "security": {
            "neutral": 5,
            "compose": {
                "seq": {"fn": "MIN"},
                "xor": {"fn": "SCALED_SUM"},
            },
        }
    }
    candidates_by_id = {
        "cand_t1": {"id": "cand_t1", "task_ids": ["T1"], "features": {"security": 4}},
        "cand_t5": {"id": "cand_t5", "task_ids": ["T5"], "features": {"security": 5}},
    }
    selection = {"T1": "cand_t1", "T5": "cand_t5"}
    selected = build_selected_candidate_by_task(selection, candidates_by_id)

    aggregated = compute_aggregated_qos(root, features, selected, agg_policies)

    assert aggregated["security"] == pytest.approx(4.0)


def test_compute_aggregated_qos_normalizes_percentage_product_features():
    root = {
        "id": "root_seq",
        "kind": "SEQ",
        "children": [
            {"id": "node_t1", "kind": "TASK", "task_id": "T1"},
            {"id": "node_t2", "kind": "TASK", "task_id": "T2"},
            {"id": "node_t3", "kind": "TASK", "task_id": "T3"},
            {
                "id": "routing_choice",
                "kind": "XOR",
                "branches": [
                    {"p": 0.8, "child": {"id": "classic_path", "kind": "ELEMENT"}},
                    {"p": 0.2, "child": {"id": "node_t5", "kind": "TASK", "task_id": "T5"}},
                ],
            },
            {"id": "node_t6", "kind": "TASK", "task_id": "T6"},
        ],
    }

    features = {
        "availability": {
            "id": "availability",
            "direction": "MAXIMIZE",
            "scale": "RATIO",
            "valid_range": {"min": 0, "max": 100},
        },
        "reliability": {
            "id": "reliability",
            "direction": "MAXIMIZE",
            "scale": "RATIO",
            "valid_range": {"min": 0, "max": 100},
        },
    }
    agg_policies = {
        "availability": {
            "neutral": 1,
            "compose": {
                "seq": {"fn": "PRODUCT"},
                "and": {"fn": "PRODUCT"},
                "xor": {"fn": "SCALED_SUM"},
            },
        },
        "reliability": {
            "neutral": 1,
            "compose": {
                "seq": {"fn": "PRODUCT"},
                "and": {"fn": "PRODUCT"},
                "xor": {"fn": "SCALED_SUM"},
            },
        },
    }
    candidates_by_id = {
        "cand_t1_aws": {
            "id": "cand_t1_aws",
            "task_ids": ["T1"],
            "features": {"availability": 99.95, "reliability": 99.75},
        },
        "cand_t2_radius": {
            "id": "cand_t2_radius",
            "task_ids": ["T2"],
            "features": {"availability": 99.8, "reliability": 99.3},
        },
        "cand_t3_here": {
            "id": "cand_t3_here",
            "task_ids": ["T3"],
            "features": {"availability": 99.9, "reliability": 99.5},
        },
        "cand_t5_braket": {
            "id": "cand_t5_braket",
            "task_ids": ["T5"],
            "features": {"availability": 99.9, "reliability": 99.0},
        },
        "cand_t6_stripe": {
            "id": "cand_t6_stripe",
            "task_ids": ["T6"],
            "features": {"availability": 99.99, "reliability": 99.5},
        },
    }
    selection = {
        "T1": "cand_t1_aws",
        "T2": "cand_t2_radius",
        "T3": "cand_t3_here",
        "T5": "cand_t5_braket",
        "T6": "cand_t6_stripe",
    }
    selected = build_selected_candidate_by_task(selection, candidates_by_id)

    aggregated = compute_aggregated_qos(root, features, selected, agg_policies)

    assert aggregated["availability"] == pytest.approx(99.62045678803702)
    assert aggregated["reliability"] == pytest.approx(97.8675813761625)
    assert 0.0 <= aggregated["availability"] <= 100.0
    assert 0.0 <= aggregated["reliability"] <= 100.0


def test_canonicalize_result_data_recomputes_aggregated_features():
    original_request = {
        "features": [
            {"id": "cost", "direction": "MINIMIZE", "scale": "RATIO", "valid_range": {"min": 0, "max": 1000}},
        ],
        "candidates": [
            {"id": "cand_t1", "task_ids": ["T1"], "features": {"cost": 10}},
            {"id": "cand_t2", "task_ids": ["T2"], "features": {"cost": 20}},
        ],
        "aggregation_policies": {
            "cost": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}}},
        },
        "composition": {
            "root": {
                "id": "root",
                "kind": "SEQ",
                "children": [
                    {"id": "node_t1", "kind": "TASK", "task_id": "T1"},
                    {"id": "node_t2", "kind": "TASK", "task_id": "T2"},
                ],
            }
        },
        "objective": {"type": "MONO"},
    }
    result_data = {
        "solutions": [
            {
                "binding": {"T1": "cand_t1", "T2": "cand_t2"},
                "aggregated_features": {"cost": 999.0},
                "objective_value": 123.0,
                "violations": [],
            }
        ]
    }

    canonicalize_result_data(result_data, original_request)

    assert result_data["solutions"][0]["aggregated_features"]["cost"] == pytest.approx(30.0)
    assert result_data["solutions"][0]["objective_value"] == pytest.approx(123.0)


def test_canonicalize_result_data_computes_many_objective_value():
    original_request = {
        "features": [
            {"id": "cost", "direction": "MINIMIZE", "scale": "RATIO", "valid_range": {"min": 0, "max": 1000}},
            {"id": "reliability", "direction": "MAXIMIZE", "scale": "RATIO", "valid_range": {"min": 0, "max": 100}},
        ],
        "candidates": [
            {"id": "cand_t1", "task_ids": ["T1"], "features": {"cost": 10, "reliability": 90}},
        ],
        "aggregation_policies": {
            "cost": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}}, "normalize": {"type": "minmax", "bounds": {"min": 0, "max": 1000}}},
            "reliability": {"neutral": 1, "compose": {"seq": {"fn": "SUM"}}, "normalize": {"type": "minmax", "bounds": {"min": 0, "max": 100}}},
        },
        "composition": {
            "root": {"id": "node_t1", "kind": "TASK", "task_id": "T1"}
        },
        "objective": {"type": "MANY", "targets": ["cost", "reliability"], "weights": {"cost": 0.25, "reliability": 0.75}},
    }
    result_data = {
        "solutions": [
            {
                "binding": {"T1": "cand_t1"},
                "aggregated_features": {"cost": 999.0, "reliability": 0.0},
                "objective_value": 0.0,
                "violations": [],
            }
        ]
    }

    canonicalize_result_data(result_data, original_request)

    assert result_data["solutions"][0]["aggregated_features"]["cost"] == pytest.approx(10.0)
    assert result_data["solutions"][0]["aggregated_features"]["reliability"] == pytest.approx(90.0)

    # Declaring normalize bounds for every objective target selects the
    # canonical objective: a weighted mean of per-feature losses, where lower
    # is better. It is the complement of the plain weighted sum of normalized
    # goodness that undeclared normalization keeps (0.0775 = 1 - 0.9225),
    # because the weights sum to one.
    assert result_data["solutions"][0]["objective_value"] == pytest.approx(0.0775)
    assert result_data["solutions"][0]["engine_objective_value"] == pytest.approx(0.0)