import ast
import uuid
from _problem_helpers import placeholder_refs
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import inspect as sa_inspect

from openbinding_gateway import repositories
from openbinding_gateway.db.models import Job, JobState, User, utcnow
from openbinding_gateway.repositories import jobs as job_repository
from _pricing import pricing_catalog


async def _user(session) -> User:
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        plan_cache=pricing_catalog().default_plan,
    )
    session.add(user)
    await session.flush()
    return user


def _job(owner: User, age_s: int = 0, **kwargs) -> Job:
    kwargs.setdefault("state", JobState.QUEUED)
    return Job(
        owner_id=owner.id,
        engine_job_id=uuid.uuid4().hex,
        service_url="http://engine",
        created_at=utcnow() - timedelta(seconds=age_s),
        **{"engine_id": "random-search", **placeholder_refs(), **kwargs},
    )


@pytest.mark.asyncio
async def test_get_in_org_hides_the_runs_of_other_organizations(db_session):
    owner = await _user(db_session)
    org, other_org = uuid.uuid4(), uuid.uuid4()
    job = _job(owner, organization_id=org)
    db_session.add(job)
    await db_session.flush()

    assert (await job_repository.get_in_org(db_session, org, job.id)).id == job.id
    assert (await job_repository.get_in_org(db_session, org, job.id, lock=True)).id == job.id
    assert await job_repository.get_in_org(db_session, other_org, job.id) is None
    assert await job_repository.get_in_org(db_session, org, uuid.uuid4()) is None


@pytest.mark.asyncio
async def test_list_in_org_filters_pages_counts_and_leaves_the_heavy_columns_unread(db_session):
    owner, teammate = await _user(db_session), await _user(db_session)
    org = uuid.uuid4()
    failed = _job(owner, 30, state=JobState.FAILED, organization_id=org, result={"x": 1})
    newest = _job(teammate, 10, organization_id=org, engine_id="evolutionary-heuristics")
    older = _job(owner, 20, organization_id=org)
    db_session.add_all([failed, newest, older, _job(owner)])
    await db_session.flush()
    ids = [newest.id, older.id, failed.id]
    db_session.expire_all()

    rows, total = await job_repository.list_in_org(db_session, org)
    assert [row.id for row in rows] == ids and total == 3
    assert {"result", "original_request", "provenance"} <= sa_inspect(rows[0]).unloaded
    queued, total = await job_repository.list_in_org(db_session, org, state=JobState.QUEUED)
    assert [row.id for row in queued] == ids[:2] and total == 2
    page, total = await job_repository.list_in_org(db_session, org, limit=1, offset=1)
    assert [row.id for row in page] == [ids[1]] and total == 3
    engine, _ = await job_repository.list_in_org(db_session, org, engine="evolutionary-heuristics")
    assert [row.id for row in engine] == [ids[0]]


@pytest.mark.asyncio
async def test_list_in_org_keeps_only_visible_runs_and_pages_them_without_reading_results(db_session):
    owner = await _user(db_session)
    org = uuid.uuid4()
    allowed = [
        _job(owner, age, organization_id=org, provenance={"engine": {"name": "seen"}}, result={"x": age})
        for age in (10, 20, 30)
    ]
    hidden = _job(owner, 15, organization_id=org, provenance={"engine": {"name": "hidden"}})
    bare = _job(owner, 25, organization_id=org)
    db_session.add_all([*allowed, hidden, bare])
    await db_session.flush()
    ids = [job.id for job in allowed]
    db_session.expire_all()
    seen: list = []

    def visible(provenance) -> bool:
        seen.append(provenance)
        return isinstance(provenance, dict) and provenance["engine"]["name"] == "seen"

    rows, total = await job_repository.list_in_org(db_session, org, visible=visible)
    assert [row.id for row in rows] == ids and total == 3 and len(seen) == 5
    assert {"result", "original_request", "provenance"} <= sa_inspect(rows[0]).unloaded
    page, total = await job_repository.list_in_org(db_session, org, limit=1, offset=1, visible=visible)
    assert [row.id for row in page] == [ids[1]] and total == 3
    beyond, total = await job_repository.list_in_org(db_session, org, offset=5, visible=visible)
    assert beyond == [] and total == 3


@pytest.mark.asyncio
async def test_list_in_org_filters_by_revision_and_problem(db_session):
    from _problem_helpers import seed_problem_run

    owner = await _user(db_session)
    seeded = await seed_problem_run(db_session, owner_id=owner.id)
    org = seeded["organization_id"]
    other = await seed_problem_run(db_session, owner_id=owner.id, organization_id=org)
    mine = _job(owner, 10, **{key: seeded[key] for key in ("organization_id", "revision_id", "compilation_id")})
    theirs = _job(owner, 5, **{key: other[key] for key in ("organization_id", "revision_id", "compilation_id")})
    db_session.add_all([mine, theirs])
    await db_session.flush()

    by_revision, _ = await job_repository.list_in_org(db_session, org, revision=seeded["revision_id"])
    by_problem, _ = await job_repository.list_in_org(db_session, org, problem=str(seeded["problem_id"]))
    assert [row.id for row in by_revision] == [row.id for row in by_problem] == [mine.id]


@pytest.mark.asyncio
async def test_find_retry_of_returns_the_most_recent_retry_whoever_made_it(db_session):
    owner, teammate = await _user(db_session), await _user(db_session)
    original = _job(owner, 100, state=JobState.FAILED)
    db_session.add(original)
    await db_session.flush()
    first = _job(owner, 50, retry_of_id=original.id)
    latest = _job(teammate, 5, retry_of_id=original.id)
    db_session.add_all([first, latest])
    await db_session.flush()

    found = await job_repository.find_retry_of(db_session, original.id)
    assert found.id == latest.id
    assert await job_repository.find_retry_of(db_session, latest.id) is None


def test_repositories_do_not_import_routes_services_or_fastapi():
    root = Path(repositories.__file__).parent
    forbidden = {"fastapi", "routes", "services"}
    offenders = []
    for path in root.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [("." * node.level) + (node.module or "")]
                names += [("." * node.level) + (node.module or "") + "." + a.name for a in node.names]
            else:
                continue
            for name in names:
                if forbidden & set(name.replace(".", " ").split()):
                    offenders.append(f"{path.name}: {name}")
    assert offenders == []
