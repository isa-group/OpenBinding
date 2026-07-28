"""Writing an instance as parts, one per component of the tuple.

The point is reuse: the same application over different infrastructures, or
the same infrastructure under different objectives, without rewriting what
they have in common. That only holds if taking an instance apart and putting
it back together is the identity, which is what most of this file checks.
"""

from __future__ import annotations

import glob
import json
import os

import pytest

from openbinding_gateway.semantics.instance_parts import (
    NORMALIZATION_PART,
    PART_KEYS,
    PartsError,
    compose,
    split,
)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def every_instance() -> list:
    """Whole instances only: the parts/ directory holds pieces, not instances."""
    paths = [
        path
        for path in sorted(glob.glob(os.path.join(REPO_ROOT, "examples", "**", "*.json"), recursive=True))
        if f"{os.sep}parts{os.sep}" not in path
    ]
    paths += sorted(
        glob.glob(os.path.join(REPO_ROOT, "experimentation", "icws", "instances", "**", "*.json"),
                  recursive=True)
    )
    assert paths, "no instances found to round-trip"
    return paths


@pytest.mark.parametrize("path", every_instance())
def test_split_then_compose_is_the_identity(path: str) -> None:
    with open(path) as handle:
        instance = json.load(handle)

    assert compose(split(instance)) == instance


def test_every_part_belongs_to_a_component_of_the_tuple() -> None:
    """No key may be silently dropped: composing must reproduce the whole."""
    with open(os.path.join(REPO_ROOT, "examples", "placement", "01_small_placement.json")) as handle:
        instance = json.load(handle)

    parts = split(instance)
    assert set(parts) - {NORMALIZATION_PART} <= set(PART_KEYS)

    covered = {key for name in parts if name != NORMALIZATION_PART for key in parts[name]}
    assert covered == set(instance)


def test_normalization_is_lifted_out_so_the_policies_can_be_shared() -> None:
    """Per-instance bounds must not force a per-instance aggregation policy."""
    with open(os.path.join(REPO_ROOT, "examples", "placement", "01_small_placement.json")) as handle:
        instance = json.load(handle)

    parts = split(instance)

    assert NORMALIZATION_PART in parts
    for policy in parts["aggregation-policies"]["aggregation_policies"].values():
        assert "normalize" not in policy
    assert compose(parts) == instance


def test_the_same_application_composes_with_different_candidate_models() -> None:
    """The reuse the split exists for, in one assertion."""
    with open(os.path.join(REPO_ROOT, "examples", "placement", "01_small_placement.json")) as handle:
        first = json.load(handle)
    with open(os.path.join(REPO_ROOT, "examples", "placement", "02_stock_market_sample.json")) as handle:
        second = json.load(handle)

    application = {name: split(first)[name] for name in ("tasks", "composition")}
    candidates_of_first = {
        name: split(first)[name]
        for name in ("providers", "candidates", "features", "resource-model", "latency-model")
        if name in split(first)
    }

    composed = compose({
        **application,
        **candidates_of_first,
        "metadata": split(first)["metadata"],
        "aggregation-policies": split(first)["aggregation-policies"],
        NORMALIZATION_PART: split(first)[NORMALIZATION_PART],
        "constraints": split(first)["constraints"],
        "objective": split(first)["objective"],
    })
    assert composed == first
    # The second instance has its own application model, so the parts differ.
    assert split(second)["composition"] != application["composition"]


def test_a_key_in_the_wrong_part_is_rejected_and_told_where_it_belongs() -> None:
    """The parts own disjoint keys, so putting one in the wrong file is caught.

    This is also what stops a key being supplied twice: the second part cannot
    legally carry it in the first place.
    """
    with pytest.raises(PartsError, match="does not belong to the composition part"):
        compose({"composition": {"tasks": [{"id": "T1", "name": "T1"}]}})

    with pytest.raises(PartsError, match="it belongs to objective"):
        compose({"tasks": {"objective": {"type": "MONO"}}})


def test_an_unknown_part_is_rejected() -> None:
    with pytest.raises(PartsError, match="Unknown part"):
        compose({"not-a-model": {}})


def test_normalization_for_an_unknown_feature_is_rejected() -> None:
    with pytest.raises(PartsError, match="no aggregation policy"):
        compose({
            "aggregation-policies": {"aggregation_policies": {"cost": {"neutral": 0}}},
            NORMALIZATION_PART: {"latency": {"type": "minmax", "bounds": {"min": 0, "max": 1}}},
        })
