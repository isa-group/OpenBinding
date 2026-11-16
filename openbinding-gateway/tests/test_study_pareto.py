"""The Pareto front of a study run, computed by the gateway (F2b B4).

One front per problem revision and objective-name set, from the feasible solutions of completed cells, by the
existing ``nondominated`` (minimisation). The frontend formats it and decides no dominance.
"""

from __future__ import annotations

import uuid

from sqlalchemy import update

from _b1_helpers import gate  # noqa: F401
from openbinding_gateway.db.models import StudyCell
from openbinding_gateway.studies import pareto_fronts
from test_b1_cell_result import BASE, build_world

R1, R2 = str(uuid.uuid4()), str(uuid.uuid4())
PROBLEMS = {R1: {"slug": "checkout", "revision": 1}, R2: {"slug": "checkout", "revision": 2}}


def cell(ordinal: int, revision: str, objectives, *, status="completed", feasible=True, engine="a/x@1", job=True):
    return {
        "cellId": f"00000000-0000-0000-0000-{ordinal:012d}",
        "jobId": f"10000000-0000-0000-0000-{ordinal:012d}" if job else None,
        "revisionId": revision,
        "metrics": {
            "status": status, "feasible": feasible, "objectives": objectives, "solutionIndex": 0, "engine": engine,
        },
    }


def points(front) -> list[tuple[str, dict[str, float]]]:
    return [(point["cell_id"][-2:], point["objectives"]) for point in front["points"]]


def test_two_revisions_give_two_fronts():
    fronts = pareto_fronts(
        [
            cell(1, R2, {"cost": 1, "latency": 5}),
            cell(2, R1, {"cost": 2, "latency": 2}),
            cell(3, R1, {"cost": 1, "latency": 4}),
            cell(4, R1, {"cost": 3, "latency": 3}),  # dominated by cell 2
            cell(5, R2, {"cost": 2, "latency": 6}),  # dominated by cell 1
        ],
        PROBLEMS,
    )

    assert [(front["revision_id"], front["problem"], front["revision"], front["objectives"]) for front in fronts] == [
        (R1, {"slug": "checkout"}, 1, ["cost", "latency"]),
        (R2, {"slug": "checkout"}, 2, ["cost", "latency"]),
    ]
    assert points(fronts[0]) == [("03", {"cost": 1.0, "latency": 4.0}), ("02", {"cost": 2.0, "latency": 2.0})]
    assert points(fronts[1]) == [("01", {"cost": 1.0, "latency": 5.0})]
    assert fronts[0]["points"][0] == {
        "cell_id": "00000000-0000-0000-0000-000000000003", "job_id": "10000000-0000-0000-0000-000000000003",
        "solution_index": 0, "engine": "a/x@1", "objectives": {"cost": 1.0, "latency": 4.0},
    }


def test_infeasible_failed_and_unrun_cells_are_left_out():
    fronts = pareto_fronts(
        [
            cell(1, R1, {"cost": 0, "latency": 0}, feasible=False),
            cell(2, R1, {"cost": 0, "latency": 0}, status="failed"),
            cell(3, R1, {"cost": 0, "latency": 0}, job=False),
            cell(4, R1, {"type": "SINGLE", "scalarization": "feasibility", "score": float("nan")}),
            cell(5, R1, {}),
            cell(6, R1, {"cost": 5, "latency": 5}),
        ],
        PROBLEMS,
    )

    assert [points(front) for front in fronts] == [[("06", {"cost": 5.0, "latency": 5.0})]]
    assert pareto_fronts([cell(1, R1, {"cost": 1}, feasible=False)], PROBLEMS) == []


def test_mixed_objective_sets_go_to_separate_fronts():
    fronts = pareto_fronts(
        [
            cell(1, R1, {"cost": 1, "latency": 9}),
            cell(2, R1, {"cost": 5}),
            cell(3, R1, {"cost": 2}),
            cell(4, R1, {"cost": 9, "latency": 1}),
        ],
        PROBLEMS,
    )

    assert [front["objectives"] for front in fronts] == [["cost"], ["cost", "latency"]]
    assert points(fronts[0]) == [("03", {"cost": 2.0})]
    assert points(fronts[1]) == [("01", {"cost": 1.0, "latency": 9.0}), ("04", {"cost": 9.0, "latency": 1.0})]


def test_the_order_is_deterministic():
    cells = [
        cell(1, R2, {"cost": 1}),
        cell(2, R1, {"cost": 2, "latency": 2}),
        cell(3, R1, {"cost": 2, "latency": 2}, engine="b/y@1"),  # equal to cell 2: both stay, in cell order
        cell(4, R1, {"cost": 1, "latency": 3}),
        cell(5, R1, {"latency": 1}),
    ]

    once = pareto_fronts(cells, PROBLEMS)

    assert once == pareto_fronts(list(cells), PROBLEMS)
    assert [(front["revision"], front["objectives"]) for front in once] == [
        (1, ["cost", "latency"]), (1, ["latency"]), (2, ["cost"]),
    ]
    assert [point["cell_id"][-2:] for point in once[0]["points"]] == ["04", "02", "03"]


async def test_the_analytics_serve_the_front_of_each_revision(api_client, db_session, registration, gate, monkeypatch):  # noqa: F811
    world = await build_world(
        api_client, db_session, registration, gate, monkeypatch, parameter_sets=[{}], seeds=[1, 2],
    )
    first, second = world.cells
    for target, objectives in ((first, {"cost": 3.0, "latency": 1.0}), (second, {"cost": 1.0, "latency": 1.0})):
        await db_session.execute(
            update(StudyCell).where(StudyCell.id == target.id).values(metrics={
                **target.metrics, "status": "completed", "feasible": True, "objectives": objectives,
                "solutionIndex": 0,
            })
        )
    await db_session.commit()

    response = await api_client.get(f"{BASE}/studies/compare/runs/{world.run['id']}/analytics", headers=world.headers)

    assert response.status_code == 200, response.text
    assert "paretoStatus" not in response.json()
    assert response.json()["pareto"] == [{
        "revision_id": world.revision["id"],
        "problem": {"slug": "checkout"},
        "revision": 1,
        "objectives": ["cost", "latency"],
        "points": [{
            "cell_id": str(second.id), "job_id": str(second.job_id), "solution_index": 0,
            "engine": second.metrics["engine"], "objectives": {"cost": 1.0, "latency": 1.0},
        }],
    }]


async def test_a_cell_keeps_the_index_of_the_solution_it_reports(api_client, db_session, registration, gate, monkeypatch):  # noqa: F811
    world = await build_world(
        api_client, db_session, registration, gate, monkeypatch, parameter_sets=[{}], seeds=[1, 2],
    )

    assert all(cell.metrics["solutionIndex"] == 0 for cell in world.cells)


def engine_objectives(score, penalty=0.0, components=(), kind="SINGLE"):
    """The ``objectives`` object an engine reports (``EngineContract``), descriptors and components included."""
    return {
        "type": kind, "scalarization": "weighted-sum", "penalty": penalty, "score": score,
        "components": [
            {"criteria": name, "feature": {"id": name}, "value": loss * 10, "loss": loss, "weight": 1.0}
            for name, loss in components
        ],
    }


def test_a_single_objective_engine_report_is_compared_on_its_score_and_penalty():
    fronts = pareto_fronts(
        [
            cell(1, R1, engine_objectives(0.04, components=[("cost", 0.04)])),
            cell(2, R1, engine_objectives(0.03, components=[("cost", 0.03)])),
            cell(3, R1, engine_objectives(0.05, penalty=1.0, components=[("cost", 0.05)])),
        ],
        PROBLEMS,
    )

    assert [front["objectives"] for front in fronts] == [["penalty", "score"]]
    assert points(fronts[0]) == [("02", {"penalty": 0.0, "score": 0.03})]


def test_a_multi_objective_engine_report_is_compared_on_each_criterion_and_the_penalty():
    fronts = pareto_fronts(
        [
            cell(1, R1, engine_objectives([0.2, 0.8, 0.0], components=[("cost", 0.2), ("latency", 0.8)], kind="MULTI")),
            cell(2, R1, engine_objectives([0.6, 0.3, 0.0], components=[("cost", 0.6), ("latency", 0.3)], kind="MULTI")),
            cell(3, R1, engine_objectives([0.7, 0.9, 0.0], components=[("cost", 0.7), ("latency", 0.9)], kind="MULTI")),
        ],
        PROBLEMS,
    )

    assert [front["objectives"] for front in fronts] == [["cost", "latency", "penalty"]]
    assert points(fronts[0]) == [
        ("01", {"penalty": 0.0, "cost": 0.2, "latency": 0.8}),
        ("02", {"penalty": 0.0, "cost": 0.6, "latency": 0.3}),
    ]
