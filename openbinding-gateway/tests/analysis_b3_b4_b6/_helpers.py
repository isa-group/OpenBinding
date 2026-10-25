"""Scenario helpers for the B3 / B4 / B6 analysis tests.

Everything here is synthetic: SQLite, a stubbed engine transport and a stubbed
BIM port. Nothing reaches a network, SPACE, SPHERE or a real engine.

A test that demonstrates an open defect is ``xfail(strict=True, raises=AssertionError)``.
``raises=AssertionError`` matters: the scenario's own preconditions go through
``precondition``, which raises ``RuntimeError``, so a scenario that breaks for
another reason is a real failure instead of a silent "expected failure".
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import select

from _repo import REPO_ROOT as EXAMPLES_ROOT
from bim_core.package import load_package
from openbinding_gateway.db.base import Base
from openbinding_gateway.db.models import EngineRegistrationRevision, Job, JobState, utcnow
from openbinding_gateway.jobs import clock, leases

EXAMPLE = EXAMPLES_ROOT / "examples/demo/01_simple_seq"


def precondition(condition: bool, message: str) -> None:
    """Fail the scenario (not the claim under test) when its set-up did not hold."""
    if not condition:
        raise RuntimeError(f"precondition of the scenario failed: {message}")


JOB_PATH = "/internal/v1/jobs/{id}"

#: What a deployment declares in ``spec.extensions`` to say it can stop a job and hands out ids per attempt.
PER_ATTEMPT_CANCELLATION = {"supported": True, "idScope": "attempt"}


async def a_registration(
    session,
    owner,
    *,
    endpoint: str = "http://engine",
    cancellation: dict | None = None,
    delete_described: bool = True,
    active: bool = True,
) -> EngineRegistrationRevision:
    """A stored deployment of an engine; ``cancellation`` is its ``extensions.cancellation`` declaration (none by default)."""
    operations = {"get": {"responses": {"200": {"description": "job"}}}}
    if delete_described:
        operations["delete"] = {"responses": {"204": {"description": "stopped"}}}
    spec = {
        "endpoint": endpoint,
        "mappings": {"request": "/internal/v1/binding-problems", "job": JOB_PATH},
        "auth": {"scheme": "none"},
        "openapi": {"openapi": "3.1.0", "paths": {JOB_PATH: operations}},
    }
    if cancellation is not None:
        spec["extensions"] = {"cancellation": cancellation}
    unique = uuid.uuid4().hex[:8]
    revision = EngineRegistrationRevision(
        owner_id=owner.id,
        namespace=owner.username,
        name=f"deployment-{unique}",
        version="1.0.0",
        manifest_digest=f"sha256-{unique}",
        engine_digest="sha256-engine",
        document={"apiVersion": "bim/v1", "kind": "EngineRegistration", "spec": spec},
        endpoint=endpoint,
        protocol_digest="sha256-protocol",
        openapi_document=spec["openapi"],
        openapi_digest="sha256-openapi",
        mappings=spec["mappings"],
        auth_scheme="none",
        is_active=active,
    )
    session.add(revision)
    await session.commit()
    return revision


def registration_reference(revision: EngineRegistrationRevision) -> dict:
    return {
        "namespace": revision.namespace,
        "name": revision.name,
        "version": revision.version,
        "digest": revision.manifest_digest,
    }


async def a_job(session, owner, *, state=JobState.QUEUED, registration=None, **extra) -> Job:
    """A job; with a ``registration`` it names it the way a submitted job does and uses its endpoint."""
    if registration is not None:
        extra.setdefault("original_request", {"registration": registration_reference(registration)})
        extra.setdefault("service_url", registration.endpoint)
    job = Job(
        owner_id=owner.id,
        engine_id="random-search",
        engine_job_id="engine-1",
        state=state,
        requested_budget_s=600.0,
        created_at=utcnow(),
        **{"service_url": "http://engine", **extra},
    )
    session.add(job)
    await session.commit()
    return job


async def lose_the_worker(session, job: Job) -> None:
    """Make a claimed job look like its worker beat for a while and then died.

    The lease follows the clock the reconciler reads (``jobs.clock.utcnow``, looked up at call time), so a test
    that controls that clock gets a lease that has lapsed for the sweep whatever the distance to the real time.
    """
    lease_until = clock.utcnow() - timedelta(seconds=1)
    job.lease_until = lease_until
    job.claimed_at = lease_until - timedelta(seconds=leases.LEASE_S + 5)
    await session.commit()


async def account_headers(client, registration) -> dict[str, str]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    precondition(created.status_code == 201, f"register answered {created.status_code}")
    logged = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    precondition(logged.status_code == 200, f"login answered {logged.status_code}")
    return {"Authorization": f"Bearer {logged.json()['access_token']}"}


async def account_with_snapshot(client, registration) -> tuple[dict[str, str], str]:
    headers = await account_headers(client, registration)
    snapshot = await client.post(
        "/v1/instances",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=load_package(EXAMPLE).to_zip(),
    )
    precondition(snapshot.status_code == 201, f"snapshot answered {snapshot.status_code}")
    return headers, snapshot.json()["id"]


async def submit(client, headers, snapshot_id) -> None:
    response = await client.post(
        "/v1/jobs",
        headers=headers,
        json={
            "snapshot": snapshot_id,
            "engine": "random-search",
            "mode": "seeded",
            "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"},
        },
    )
    precondition(response.status_code == 202, f"submit answered {response.status_code}")


def answer(**extra) -> dict:
    """A well-formed engine answer for the demo instance."""
    return {
        "termination": "FEASIBLE",
        "solutions": [
            {
                "decision": {
                    "kind": "binding",
                    "binding": {
                        "t1": {"resource": "catalog", "id": "c1a"},
                        "t2": {"resource": "catalog", "id": "c2a"},
                        "t3": {"resource": "catalog", "id": "c3a"},
                    },
                }
            }
        ],
        **extra,
    }


async def only_job(session) -> Job:
    job = (await session.execute(select(Job))).scalars().one()
    await session.refresh(job)
    return job


async def persisted_anywhere(session, needle: str) -> bool:
    """Whether ``needle`` is stored in any column of any table.

    Deliberately blind to the schema: a fix may keep the evidence in a new table
    or column, and the claim under test is only that the bytes are not lost.
    """
    for table in Base.metadata.sorted_tables:
        for row in (await session.execute(select(table))).all():
            if needle in repr(tuple(row)):
                return True
    return False


def new_id() -> str:
    return str(uuid.uuid4())
