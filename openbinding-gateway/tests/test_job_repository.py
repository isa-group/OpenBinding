import ast
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import inspect as sa_inspect

from openbinding_gateway import repositories
from openbinding_gateway.db.models import Job, JobState, User, utcnow
from openbinding_gateway.db.platform_models import Organization, Project
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
        engine_id="random-search",
        engine_job_id=uuid.uuid4().hex,
        service_url="http://engine",
        created_at=utcnow() - timedelta(seconds=age_s),
        **kwargs,
    )


@pytest.mark.asyncio
async def test_get_owned_hides_other_owners_jobs(db_session):
    owner, other = await _user(db_session), await _user(db_session)
    job = _job(owner)
    db_session.add(job)
    await db_session.flush()

    assert (await job_repository.get_owned(db_session, job.id, owner.id)).id == job.id
    assert (await job_repository.get_owned(db_session, job.id, owner.id, lock=True)).id == job.id
    assert await job_repository.get_owned(db_session, job.id, other.id) is None
    assert await job_repository.get_owned(db_session, uuid.uuid4(), owner.id) is None


@pytest.mark.asyncio
async def test_list_owned_filters_state_and_clamps_limit(db_session):
    owner, other = await _user(db_session), await _user(db_session)
    failed = _job(owner, 30, state=JobState.FAILED)
    newest = _job(owner, 10)
    older = _job(owner, 20)
    db_session.add_all([failed, newest, older, _job(other)])
    await db_session.flush()

    rows = await job_repository.list_owned(db_session, owner.id)
    assert [row.id for row in rows] == [newest.id, older.id, failed.id]
    queued = await job_repository.list_owned(db_session, owner.id, state=JobState.QUEUED)
    assert [row.id for row in queued] == [newest.id, older.id]
    assert [row.id for row in await job_repository.list_owned(db_session, owner.id, limit=2)] == [
        newest.id,
        older.id,
    ]
    assert len(await job_repository.list_owned(db_session, owner.id, limit=0)) == 1
    assert len(await job_repository.list_owned(db_session, owner.id, limit=-5)) == 1


@pytest.mark.asyncio
async def test_find_retry_of_returns_most_recent(db_session):
    owner, other = await _user(db_session), await _user(db_session)
    original = _job(owner, 100, state=JobState.FAILED)
    db_session.add(original)
    await db_session.flush()
    first = _job(owner, 50, retry_of_id=original.id)
    latest = _job(owner, 5, retry_of_id=original.id)
    foreign = _job(other, 1, retry_of_id=original.id)
    db_session.add_all([first, latest, foreign])
    await db_session.flush()

    found = await job_repository.find_retry_of(db_session, owner.id, original.id)
    assert found.id == latest.id
    assert await job_repository.find_retry_of(db_session, owner.id, latest.id) is None


@pytest.mark.asyncio
async def test_list_for_project_with_and_without_job_id(db_session):
    owner = await _user(db_session)
    organization = Organization(
        slug=f"org-{uuid.uuid4().hex[:8]}", name="Org",
        billing_sponsor_user_id=owner.id, created_by_id=owner.id,
    )
    db_session.add(organization)
    await db_session.flush()
    project = Project(
        organization_id=organization.id, slug="p", name="P", created_by_id=owner.id
    )
    db_session.add(project)
    await db_session.flush()
    older = _job(owner, 20, project_id=project.id, result={"x": 1}, original_request={"r": 1})
    newer = _job(owner, 10, project_id=project.id, result={"x": 2}, original_request={"r": 2})
    db_session.add_all([older, newer, _job(owner, 5)])
    await db_session.flush()
    project_id, older_id, newer_id = project.id, older.id, newer.id
    db_session.expire_all()

    rows = await job_repository.list_for_project(db_session, project_id)
    assert [row.id for row in rows] == [newer_id, older_id]
    assert rows[0].result == {"x": 2}

    one = await job_repository.list_for_project(db_session, project_id, job_id=older_id)
    assert [row.id for row in one] == [older_id]
    assert await job_repository.list_for_project(db_session, project_id, job_id=uuid.uuid4()) == []

    db_session.expire_all()
    light = await job_repository.list_for_project(db_session, project_id, include_results=False)
    assert [row.id for row in light] == [newer_id, older_id]
    unloaded = sa_inspect(light[0]).unloaded
    assert {"result", "original_request", "provenance"} <= unloaded


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
