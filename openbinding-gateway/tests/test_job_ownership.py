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


async def test_a_job_is_not_readable_by_an_administrator(db_session):
    # Administering accounts means plans, keys and activation. It does not mean
    # reading the instances people submit, which are their data.
    owner = await a_user(db_session)
    admin = await a_user(db_session, admin=True)

    assert owned_by(owner.id).readable_by(admin) is False


async def test_an_owned_job_is_not_readable_anonymously(db_session):
    owner = await a_user(db_session)

    assert owned_by(owner.id).readable_by(None) is False


async def test_an_unowned_job_belongs_to_nobody(db_session):
    """Not to everybody, which is what "no owner" used to mean.

    These rows come from before accounts existed, or from a gateway configured
    without them. Reading them as public makes a job identifier a bearer token
    for whatever it names - the thing ownership was added to stop.
    """
    stranger = await a_user(db_session)

    assert owned_by(None).readable_by(stranger) is False
    assert owned_by(None).readable_by(None) is False


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


# -- A job belongs to one person -------------------------------------------

pytestmark = pytest.mark.asyncio


async def account(client, registration) -> tuple[dict, str]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    tokens = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    return created.json(), tokens.json()["access_token"]


async def test_an_administrator_may_not_read_somebody_elses_job(
    api_client, registration, db_session
):
    """Administering accounts is not reading what people solve.

    A job carries the instance somebody submitted - a provider list, a cost
    model, a topology - and that is their data. Administrators moved plans,
    revoked keys and deactivated accounts, and could also read every instance
    anybody had ever sent, which nothing in the plans says they may.
    """
    import uuid as _uuid

    from sqlalchemy import select

    from openbinding_gateway.db.models import Job, JobState, User, UserRole, utcnow

    owner, _ = await account(api_client, registration)
    job = Job(
        id=_uuid.uuid4(),
        owner_id=_uuid.UUID(owner["id"]),
        engine_id="random-search",
        engine_job_id="sync",
        service_url="http://engine",
        state=JobState.COMPLETED,
        created_at=utcnow(),
        original_request={"tasks": [{"id": "secret"}]},
    )
    db_session.add(job)

    admin_details, admin_token = await account(api_client, registration)
    admin = (
        await db_session.execute(select(User).where(User.username == admin_details["username"]))
    ).scalar_one()
    admin.role = UserRole.ADMIN
    await db_session.flush()

    headers = {"Authorization": f"Bearer {admin_token}"}
    assert (await api_client.get(f"/v1/jobs/{job.id}", headers=headers)).status_code == 404
    assert (
        await api_client.get(f"/v1/jobs/{job.id}/request", headers=headers)
    ).status_code == 404


async def test_a_job_with_no_owner_belongs_to_nobody_rather_than_everybody(
    api_client, registration, db_session
):
    # An unowned row is one from before accounts existed. Reading "belongs to
    # nobody" as "belongs to anybody" makes a job identifier a bearer token
    # again, which is what ownership was added to stop.
    import uuid as _uuid

    from openbinding_gateway.db.models import Job, JobState, utcnow

    _, token = await account(api_client, registration)
    job = Job(
        id=_uuid.uuid4(),
        owner_id=None,
        engine_id="random-search",
        engine_job_id="sync",
        service_url="http://engine",
        state=JobState.COMPLETED,
        created_at=utcnow(),
    )
    db_session.add(job)
    await db_session.flush()

    response = await api_client.get(
        f"/v1/jobs/{job.id}", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 404


async def test_solving_without_an_account_is_refused_and_cannot_be_switched_on(
    api_client, micro_placement_instance
):
    """There used to be AUTH_REQUIRED_FOR_SOLVE. There is not.

    A solve is the expensive operation and the one plans are sold by; an
    unattributed one cannot be metered, cannot be attributed to a job anybody
    can read back, and cannot be refused when an allowance runs out. A
    deployment that turned that off by accident would find out from its bill.
    """
    from openbinding_gateway.core.settings import Settings

    assert not hasattr(Settings(), "auth_required_for_solve")

    response = await api_client.post(
        "/v1/solve",
        json={"engine_id": "random-search", "instance": micro_placement_instance},
    )

    assert response.status_code == 401
