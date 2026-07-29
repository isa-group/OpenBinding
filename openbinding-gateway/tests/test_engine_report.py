"""Keeping what the engine said, and noticing when it is wrong.

The canonical result stays the official one - metrics come from one reference
evaluator rather than from four engines' arithmetic. What changes here is that
an engine's own account of its answer is no longer discarded without trace, and
that the difference between the two is reported rather than left for somebody to
spot.

The failure mode worth guarding against is subtle: canonicalization rewrites
solutions **in place**, so a shallow snapshot would hand back the canonical
values and report perfect agreement every single time. A test that only checked
"the field is present" would pass while saying nothing.
"""

from __future__ import annotations

from openbinding_gateway.models.api import EngineReport
from openbinding_gateway.semantics import engine_report


def a_result(**overrides) -> dict:
    """An engine's answer in the general shape, before canonicalization."""
    solution = {
        "binding": {"t1": "c1"},
        "objective_value": 10.0,
        "aggregated_features": {"cost": 1.0},
        "violations": [],
        "feasible": True,
    }
    solution.update(overrides)
    return {"solutions": [solution], "provenance": {"engine_id": "stub"}}


def canonicalized(**overrides) -> dict:
    """The same answer after the reference evaluator has had its say."""
    solution = {
        "binding": {"t1": "c1"},
        "objective_value": 10.0,
        "aggregated_features": {"cost": 1.0},
        "violations": [],
        "feasible": True,
    }
    solution.update(overrides)
    return {"solutions": [solution], "provenance": {"engine_id": "stub"}}


# -- The snapshot -----------------------------------------------------------


def test_the_snapshot_survives_canonicalization_rewriting_in_place():
    # The whole thing turns on this. canonicalize_result_data mutates the
    # solutions it is given, so a shallow copy would report agreement always.
    original = a_result()
    before = engine_report.snapshot(original)

    original["solutions"][0]["feasible"] = False
    original["solutions"][0]["aggregated_features"]["cost"] = 99.0

    assert before["solutions"][0]["feasible"] is True
    assert before["solutions"][0]["aggregated_features"]["cost"] == 1.0


def test_a_snapshot_of_something_unexpected_does_not_raise():
    assert engine_report.snapshot(None) is None
    assert engine_report.snapshot([1, 2]) == [1, 2]


# -- What the report carries ------------------------------------------------


def test_it_keeps_the_engine_solutions():
    report = engine_report.build(a_result(), canonicalized())

    assert isinstance(report, EngineReport)
    assert report.solutions[0]["binding"] == {"t1": "c1"}


def test_it_keeps_the_engine_provenance():
    report = engine_report.build(a_result(), canonicalized())

    assert report.provenance == {"engine_id": "stub"}


def test_it_keeps_the_untransformed_body():
    # What matters for an engine using its own field names: the general-shaped
    # solutions have already lost them.
    raw = {"assignment": {"t1": "c1"}, "score": 10.0}

    report = engine_report.build(a_result(), canonicalized(), raw=raw)

    assert report.raw == raw
    assert report.raw_truncated is False


def test_an_oversized_body_is_dropped_and_says_so():
    # /solve accepts up to 512 MB and a result can be proportionate. Past the
    # cap the report stops being something a client wants and becomes something
    # it has to cope with.
    huge = {"blob": "x" * (engine_report.MAX_RAW_BYTES + 1)}

    report = engine_report.build(a_result(), canonicalized(), raw=huge)

    assert report.raw is None
    assert report.raw_truncated is True


def test_a_body_that_cannot_be_serialised_is_dropped_rather_than_raising():
    report = engine_report.build(a_result(), canonicalized(), raw={"f": lambda: None})

    assert report.raw is None
    assert report.raw_truncated is True


def test_no_body_means_nothing_was_truncated():
    report = engine_report.build(a_result(), canonicalized())

    assert report.raw is None
    assert report.raw_truncated is False


# -- Divergence -------------------------------------------------------------


def test_an_engine_that_agrees_shows_no_divergence():
    report = engine_report.build(a_result(), canonicalized())

    assert report.divergence.solutions_compared == 1
    assert report.divergence.feasibility_mismatches == 0
    assert report.divergence.notes == []
    assert report.divergence.agrees is True


def test_a_misreported_feasibility_is_caught():
    # The signal that matters: an engine calling a solution feasible that the
    # reference evaluator rejects has a bug in its semantics.
    report = engine_report.build(a_result(feasible=True), canonicalized(feasible=False))

    assert report.divergence.feasibility_mismatches == 1
    assert "feasible" in report.divergence.notes[0]
    assert report.divergence.agrees is False


def test_a_differing_objective_is_reported_with_its_size():
    report = engine_report.build(
        a_result(objective_value=10.0), canonicalized(objective_value=12.5)
    )

    assert report.divergence.max_objective_delta == 2.5
    assert any("objective differs" in note for note in report.divergence.notes)


def test_objectives_within_floating_point_noise_are_the_same_number():
    report = engine_report.build(
        a_result(objective_value=1.0), canonicalized(objective_value=1.0 + 1e-12)
    )

    assert report.divergence.max_objective_delta is None
    assert report.divergence.notes == []


def test_differing_aggregated_features_are_named():
    report = engine_report.build(
        a_result(aggregated_features={"cost": 1.0, "latency": 5.0}),
        canonicalized(aggregated_features={"cost": 1.0, "latency": 9.0}),
    )

    note = " ".join(report.divergence.notes)
    assert "latency" in note
    assert "cost" not in note


def test_the_largest_objective_gap_is_the_one_reported():
    before = {"solutions": [{"binding": {}, "objective_value": 1.0}, {"binding": {}, "objective_value": 1.0}]}
    after = {"solutions": [{"binding": {}, "objective_value": 2.0}, {"binding": {}, "objective_value": 9.0}]}

    report = engine_report.build(before, after)

    assert report.divergence.max_objective_delta == 8.0


def test_an_engine_that_reports_nothing_is_not_accused_of_disagreeing():
    # Reporting only a binding is the documented minimum. Silence is not a
    # wrong answer.
    before = {"solutions": [{"binding": {"t1": "c1"}}]}
    after = canonicalized(feasible=False)

    report = engine_report.build(before, after)

    assert report.divergence.feasibility_mismatches == 0
    assert report.divergence.notes == []


def test_an_empty_result_compares_cleanly():
    report = engine_report.build({"solutions": []}, {"solutions": []})

    assert report.divergence.solutions_compared == 0
    assert report.divergence.agrees is True


def test_a_result_that_is_not_a_result_does_not_raise():
    report = engine_report.build(None, None)

    assert report.solutions == []
    assert report.divergence.solutions_compared == 0
