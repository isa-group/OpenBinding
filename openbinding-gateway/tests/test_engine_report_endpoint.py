"""The engine report over HTTP, against an engine that misreports on purpose.

The unit tests prove the comparison. These prove the wiring: that the flag is
honoured, that the canonical answer is untouched by asking for the report, and
that a stub engine claiming a solution is feasible when it is not gets caught.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
import copy
from unittest.mock import MagicMock, patch

from openbinding_gateway.main import app

client = TestClient(app)


@pytest.fixture
def instance(micro_placement_instance):
    """The suite's shared placement instance.

    Hand-written instances get the aggregation policies subtly wrong; this one
    is the same one the rest of the suite solves, so the reference evaluator
    produces real numbers rather than an error.
    """
    return micro_placement_instance


@pytest.fixture
def lying_engine(instance):
    """An engine that answers synchronously and overstates its result."""
    binding = {
        task["id"]: f"c_{task['id']}_p1" for task in instance["tasks"]
    }
    engine_body = {
        "solutions": [
            {
                "binding": binding,
                # All three are wrong on purpose: an engine that reports
                # nothing cannot diverge, so the stub has to claim something.
                "objective_value": 0.0,
                "aggregated_features": {"cost": 0.0, "latency": 0.0, "security": 1.0},
                "violations": [],
                "feasible": True,
            }
        ],
        "provenance": {"engine_id": "stub", "execution_time_ms": 12},
    }

    with patch("openbinding_gateway.main.pipeline") as pipeline, patch(
        "openbinding_gateway.registry.engine.EngineRegistry.get_plugin"
    ) as get_plugin, patch(
        "openbinding_gateway.registry.engine.EngineRegistry.get_url",
        return_value="http://stub-engine",
    ), patch(
        "httpx.AsyncClient.post"
    ) as post:
        pipeline.validate_general_schema.return_value = []
        pipeline.validate_full.return_value = ([], [])

        plugin = MagicMock()
        plugin.transform_request.return_value = ({"instance": instance}, [])
        # A fresh copy per call, because canonicalization rewrites what it is
        # given in place. A real plugin builds a new dict from the engine's
        # response every time; returning one shared object would let the first
        # solve's canonical values leak into the second solve's "engine claim".
        plugin.transform_response.side_effect = lambda *_, **__: copy.deepcopy(engine_body)
        plugin.get_capabilities.return_value = {"type": "HEURISTIC"}
        get_plugin.return_value = plugin

        response = MagicMock()
        response.status_code = 200
        response.json.return_value = engine_body
        response.raise_for_status.return_value = None
        post.return_value = response

        yield engine_body


def solve(instance, **extra):
    return client.post(
        "/v1/solve",
        json={"engine_id": "stub", "instance": instance, **extra},
    )


def test_the_report_is_absent_unless_asked_for(instance, lying_engine):
    body = solve(instance).json()

    assert body["result"].get("engine_report") is None


def test_the_report_is_returned_when_asked_for(instance, lying_engine):
    body = solve(instance, include_engine_report=True).json()

    assert body["result"]["engine_report"] is not None


def test_asking_for_the_report_does_not_change_the_canonical_answer(instance, lying_engine):
    without = solve(instance).json()["result"]
    with_report = solve(instance, include_engine_report=True).json()["result"]

    assert without["solutions"] == with_report["solutions"]
    assert without["feasibility"] == with_report["feasibility"]


def test_the_canonical_answer_still_overrides_the_engine(instance, lying_engine):
    # The official result is the reference evaluator's, whatever the engine said.
    solution = solve(instance, include_engine_report=True).json()["result"]["solutions"][0]

    # The stub claimed zero cost for five tasks on the cheapest pool, which is
    # five, so the canonical figure cannot be what it said.
    assert solution["aggregated_features"]["cost"] != 0.0


def test_the_report_preserves_what_the_engine_claimed(instance, lying_engine):
    report = solve(instance, include_engine_report=True).json()["result"]["engine_report"]

    claimed = report["solutions"][0]
    assert claimed["feasible"] is True
    assert claimed["aggregated_features"]["cost"] == 0.0


def test_the_divergence_reports_what_the_engine_got_wrong(instance, lying_engine):
    divergence = solve(instance, include_engine_report=True).json()["result"]["engine_report"][
        "divergence"
    ]

    assert divergence["solutions_compared"] == 1
    # Cost, latency and the objective were all misreported, so there is
    # something to say about each.
    assert divergence["notes"], "an engine reporting wrong numbers should not read as agreeing"
    assert any("aggregated features differ" in note for note in divergence["notes"])


def test_the_report_carries_the_untransformed_body(instance, lying_engine):
    report = solve(instance, include_engine_report=True).json()["result"]["engine_report"]

    assert report["raw"] is not None
    assert report["raw_truncated"] is False


def test_the_report_keeps_the_engine_provenance(instance, lying_engine):
    report = solve(instance, include_engine_report=True).json()["result"]["engine_report"]

    assert report["provenance"]["engine_id"] == "stub"


def test_the_flag_is_independent_of_verbose(instance, lying_engine):
    # Different purposes and different sizes: either is useful without the
    # other, so neither implies the other.
    verbose_only = solve(instance, verbose=True).json()["result"]
    report_only = solve(instance, include_engine_report=True).json()["result"]

    assert verbose_only.get("engine_report") is None
    assert report_only.get("diagnostics") is None
    assert report_only.get("engine_report") is not None
