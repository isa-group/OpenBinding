"""Who may read a job, and who may not.

Before accounts, a job identifier was in effect a bearer token: anyone holding
one could read the result it named, and the MiniZinc engine derived its
identifiers from ``Math.random``. These pin the rule that replaced that - a job
belongs to whoever asked for it - and the shape of the refusal, which is "not
found" rather than "forbidden" so that the endpoint cannot be used to discover
which identifiers are real.
"""

from __future__ import annotations

import uuid

import pytest

from openbinding_gateway.db.models import Job, JobState, User, UserRole
from openbinding_gateway.jobs import GatewayJob, JobManager


async def a_user(session, *, admin=False) -> User:
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.ADMIN if admin else UserRole.USER,
    )
    session.add(user)
    await session.flush()
    return user


def owned_by(owner_id) -> GatewayJob:
    return GatewayJob("random-search", "engine-1", "http://engine", owner_id=owner_id)


async def test_a_job_is_readable_by_its_owner(db_session):
    owner = await a_user(db_session)

    assert owned_by(owner.id).readable_by(owner) is True


async def test_a_job_is_not_readable_by_somebody_else(db_session):
    owner = await a_user(db_session)
    stranger = await a_user(db_session)

    assert owned_by(owner.id).readable_by(stranger) is False


async def test_a_job_is_readable_by_an_administrator(db_session):
    owner = await a_user(db_session)
    admin = await a_user(db_session, admin=True)

    assert owned_by(owner.id).readable_by(admin) is True


async def test_an_owned_job_is_not_readable_anonymously(db_session):
    owner = await a_user(db_session)

    assert owned_by(owner.id).readable_by(None) is False


async def test_an_unowned_job_stays_readable(db_session):
    # A gateway running without accounts produces these, and there is nobody
    # they could belong to.
    stranger = await a_user(db_session)

    assert owned_by(None).readable_by(stranger) is True
    assert owned_by(None).readable_by(None) is True


async def test_a_job_survives_being_written_and_read_back(db_session):
    owner = await a_user(db_session)

    created = await JobManager.create_job(
        "minizinc-csp", "engine-7", "http://engine", owner_id=owner.id, session=db_session
    )
    created.metadata["verbose"] = True
    created.metadata["original_request"] = {"composition": {"type": "STRUCTURED"}}
    await JobManager.save_job(created, session=db_session)

    read_back = await JobManager.get_job(created.id, session=db_session)

    assert read_back is not None
    assert read_back.owner_id == owner.id
    assert read_back.engine_job_id == "engine-7"
    assert read_back.metadata["verbose"] is True
    assert read_back.metadata["original_request"] == {"composition": {"type": "STRUCTURED"}}


async def test_a_stored_job_remembers_who_owns_it(db_session):
    owner = await a_user(db_session)
    stranger = await a_user(db_session)
    created = await JobManager.create_job(
        "random-search", "engine-9", "http://engine", owner_id=owner.id, session=db_session
    )

    read_back = await JobManager.get_job(created.id, session=db_session)

    assert read_back.readable_by(owner) is True
    assert read_back.readable_by(stranger) is False


@pytest.mark.parametrize("job_id", ["not-a-uuid", "", "../etc/passwd"])
async def test_an_identifier_that_is_not_one_names_nothing(db_session, job_id):
    # Answered the same way as a well-formed identifier that does not exist,
    # rather than raising on the way to the database.
    assert await JobManager.get_job(job_id, session=db_session) is None


async def test_an_unknown_job_is_not_found(db_session):
    assert await JobManager.get_job(str(uuid.uuid4()), session=db_session) is None


async def test_solving_without_a_database_still_works():
    # The anonymous gateway is still a supported deployment; jobs there live
    # in memory and belong to nobody, exactly as they always did.
    job = await JobManager.create_job("random-search", "engine-3", "http://engine")

    assert await JobManager.get_job(job.id) is job
    assert job.owner_id is None


async def test_the_job_row_starts_queued_and_unmetered(db_session):
    owner = await a_user(db_session)
    created = await JobManager.create_job(
        "random-search", "engine-4", "http://engine", owner_id=owner.id, session=db_session
    )

    row = await db_session.get(Job, uuid.UUID(created.id))

    assert row.state is JobState.QUEUED
    # A4 relies on both of these starting false, and on only ever flipping
    # them once, to avoid billing a solve twice.
    assert row.metered is False
    assert row.concurrency_released is False
