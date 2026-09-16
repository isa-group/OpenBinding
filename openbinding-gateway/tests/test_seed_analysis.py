"""The analysis gallery contains genuine evaluated evidence and stable seed identities."""
import sys
from pathlib import Path

import pytest
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from seed_analysis import GALLERY, ensure_analysis_gallery, enumerate_gallery, gallery_package
from seed_dev import ensure_users, ensure_organizations, ensure_projects
from openbinding_gateway.db.models import Job
from openbinding_gateway.db.platform_models import StudyCell, StudyRun
from openbinding_gateway.v1.compiler import compile_instance

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"

@pytest.mark.parametrize("scenario,example,description", GALLERY)
def test_gallery_is_deterministic_and_canonically_evaluated(scenario, example, description):
    problem = compile_instance(gallery_package(EXAMPLES, scenario, example))
    result = enumerate_gallery(problem, scenario, description)
    assert result == enumerate_gallery(problem, scenario, description)
    assert result["termination"] == "UNKNOWN"
    assert result["provenance"]["analysisFixture"]["notSolverBenchmark"]
    expected = {"tradeoffs": 36, "constraints": 36, "journey": 36, "collinear": 4, "singleton": 1, "empty": 0, "large": 1296,
                "pooled-overlap": 18, "decision-rules": 6, "power-slice": 36, "geometry-limit": 350, "background": 3000}
    assert len(result["solutions"]) == expected[scenario]
    for solution in result["solutions"]:
        evaluated = problem.evaluate(solution["decision"]["binding"])
        assert solution["metrics"] == evaluated["metrics"]
        assert solution["objectives"] == evaluated["objectives"]
        assert solution["violations"] == evaluated["violations"]
    if scenario == "constraints":
        assert any(v["enforcement"] == "hard" for s in result["solutions"] for v in s["violations"])
        assert any(s["objectives"]["penalty"] > 0 for s in result["solutions"])
        assert all(s["objectives"]["components"][2]["loss"] == 1 - s["metrics"]["quality"] / 200 for s in result["solutions"])
    if scenario == "tradeoffs":
        vectors = [tuple(s["objectives"]["score"]) for s in result["solutions"]]
        assert len(set(vectors)) < len(vectors)
        assert any(all(x <= y for x, y in zip(a, b, strict=True)) and a != b for a in vectors for b in vectors)
    if scenario == "journey":
        trace = result["provenance"]["engineReported"]["trace"]
        assert len(trace) >= 2
        assert all(a["eval_index"] < b["eval_index"] and a["best_objective"] > b["best_objective"] for a, b in zip(trace, trace[1:], strict=False))
        for event in trace:
            observed = result["solutions"][:event["eval_index"]]
            feasible = [s for s in observed if not any(v["enforcement"] == "hard" for v in s["violations"])]
            assert event["best_objective"] == min(s["objectives"]["score"] for s in feasible)
            assert "elapsed_ms" not in event

@pytest.mark.asyncio
async def test_gallery_persistence_is_additive_and_idempotent(db_session, monkeypatch):
    users = await ensure_users(db_session)
    orgs = await ensure_organizations(db_session, users)
    projects = await ensure_projects(db_session, orgs, users)
    args = (db_session, orgs["score-ai"], projects["score-ai/qos-placement"], users["alice"], EXAMPLES)
    study, run = await ensure_analysis_gallery(*args)
    await db_session.commit()
    _, again = await ensure_analysis_gallery(*args)
    assert again.id == run.id
    runs = (await db_session.execute(select(StudyRun).where(StudyRun.study_id == study.id))).scalars().all()
    cells = (await db_session.execute(select(StudyCell).where(StudyCell.study_run_id == run.id))).scalars().all()
    from openbinding_gateway.models.platform import StudyDefinition
    from openbinding_gateway.studies import expand_study
    from openbinding_gateway.v1.canonical import digest
    expanded = expand_study(StudyDefinition.model_validate(study.definition))
    assert run.matrix_digest == digest([item["fingerprint"] for item in expanded])
    assert sorted(c.fingerprint for c in cells) == sorted(item["fingerprint"] for item in expanded)
    assert len(runs) == 1
    assert len(cells) == len(GALLERY)
    for cell in cells:
        job = await db_session.get(Job, cell.job_id)
        assert job.owner_id == users["alice"].id
        assert job.metered and job.concurrency_released
        assert job.instance_snapshot_id is not None
        assert job.result["provenance"]["analysisFixture"]["scenario"] == cell.metrics["analysisScenario"]


    # A generator semantic version creates a new run and leaves the previous evidence intact.
    import seed_analysis
    old_job_ids = {cell.job_id for cell in cells}
    monkeypatch.setattr(seed_analysis, "GENERATOR_VERSION", seed_analysis.GENERATOR_VERSION + 1)
    _, upgraded = await ensure_analysis_gallery(*args)
    await db_session.commit()
    assert upgraded.id != run.id
    # Worker aggregation must retain the seed identity used for immutable scenario reuse.
    from openbinding_gateway.study_jobs import sync_study_job
    run.summary = {**run.summary, "seedScenarioDigest": "unchanged-inputs"}
    await db_session.flush()
    await sync_study_job(str(cells[0].job_id), db_session)
    assert run.summary["seedScenarioDigest"] == "unchanged-inputs"
    for job_id in old_job_ids:
        assert await db_session.get(Job, job_id) is not None


def test_scale_batches_are_unique_explicit_canonical_assignments():
    problem = compile_instance(gallery_package(EXAMPLES, "scale", "17_analysis_tradeoffs"))
    first = enumerate_gallery(problem, "scale", "scale test", limit=500)
    second = enumerate_gallery(problem, "scale", "scale test", limit=500, offset=500)
    from openbinding_gateway.v1.canonical import digest
    rows = first["solutions"] + second["solutions"]
    assert len({digest(row["decision"]["binding"]) for row in rows}) == 1000
    assert len({row["metrics"]["cost"] for row in rows}) == 1000
    assert second["provenance"]["analysisFixture"]["evaluatedBindings"] == 500
    for row in (rows[0], rows[-1]):
        assert row["objectives"] == problem.evaluate(row["decision"]["binding"])["objectives"]
    with pytest.raises(ValueError, match="fit the model"):
        enumerate_gallery(problem, "scale", "invalid range", offset=99_999, limit=2)
