"""Value origins (``problem_value_origins``): written with their revision only, immutable, gone with it, and read
back as value sources, provenance and a digest."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import DatabaseError

from _b1_helpers import gate  # noqa: F401
from openbinding_gateway.db.models import BindingCaseRevision, ProblemValueOrigin
from openbinding_gateway.modules.problems.application import (
    candidate_provenance,
    create_problem,
    delete_problem,
    origins_digest,
    origins_for,
    value_sources,
)
from openbinding_gateway.modules.problems.application import add_revision

from problems._sphere_helpers import flagship, member

pytestmark = pytest.mark.asyncio


async def _count(db_session) -> int:
    return int(await db_session.scalar(select(func.count()).select_from(ProblemValueOrigin)) or 0)


async def test_origins_are_written_with_their_revision(api_client, registration, db_session, gate):  # noqa: F811
    _, _, organization, user = await member(api_client, registration, db_session, gate)
    generated = flagship()
    upload = await create_problem(
        db_session, organization, generated.archive(), user, slug="tomatometer-email",
        provenance={"producer": "openbinding-sphere-import"}, value_origins=generated.origins,
    )
    rows = await origins_for(db_session, upload.revision.id)
    assert len(rows) == len(generated.origins)
    assert {(r.candidate_key, r.target_kind, r.target) for r in rows} == {
        (o["candidateKey"], o["targetKind"], o["target"]) for o in generated.origins
    }
    foundation = next(r for r in rows if r.candidate_key.endswith("mailgun.foundation") and r.target == "subscription")
    assert (foundation.source_kind, foundation.value, foundation.plan) == ("priced", 35, "FOUNDATION")
    assert foundation.detail["formula"] == "FOUNDATION 35 x 1 (monthly)"


async def test_a_refused_compile_leaves_no_revision_and_no_origin(api_client, registration, db_session, gate):  # noqa: F811
    _, _, organization, user = await member(api_client, registration, db_session, gate)
    generated = flagship()
    with pytest.raises(HTTPException):
        await create_problem(db_session, organization, b"not a package", user, slug="nope",
                             value_origins=generated.origins)
    await db_session.rollback()
    assert await _count(db_session) == 0
    assert await db_session.scalar(select(func.count()).select_from(BindingCaseRevision)) == 0


async def test_the_same_package_again_inserts_no_origins(api_client, registration, db_session, gate):  # noqa: F811
    _, _, organization, user = await member(api_client, registration, db_session, gate)
    generated = flagship()
    first = await create_problem(db_session, organization, generated.archive(), user, slug="t",
                                 value_origins=generated.origins)
    before = await _count(db_session)
    again = await add_revision(db_session, first.problem, generated.archive(), user, value_origins=generated.origins[:3])
    assert not again.created and again.revision.id == first.revision.id
    assert await _count(db_session) == before


async def test_origins_are_immutable_and_go_with_the_problem(api_client, registration, db_session, gate):  # noqa: F811
    _, _, organization, user = await member(api_client, registration, db_session, gate)
    generated = flagship()
    upload = await create_problem(db_session, organization, generated.archive(), user, slug="t",
                                  value_origins=generated.origins)
    with pytest.raises(DatabaseError):
        async with db_session.begin_nested():
            await db_session.execute(
                update(ProblemValueOrigin).where(ProblemValueOrigin.revision_id == upload.revision.id).values(value=1)
            )
    await delete_problem(db_session, upload.problem, user)
    await db_session.commit()
    assert await _count(db_session) == 0


async def test_provenance_and_sources_group_by_candidate(api_client, registration, db_session, gate):  # noqa: F811
    _, _, organization, user = await member(api_client, registration, db_session, gate)
    generated = flagship()
    upload = await create_problem(db_session, organization, generated.archive(), user, slug="t",
                                  value_origins=generated.origins)
    provenance = await candidate_provenance(db_session, upload.revision.id)
    generated_keys = {c["key"] for c in generated.candidates}
    assert set(provenance) == generated_keys
    mailgun = provenance["sphere-email/email.mailgun.foundation"]
    assert (mailgun.sphere, mailgun.version, mailgun.plan, mailgun.addons) == (
        "danruilop1/mailgun", "6ade36454b2b5b01c587db3d", "FOUNDATION", (),
    )
    assert mailgun.permanent_url and "6ade364540e55445692b0eda" in mailgun.permanent_url
    assert "catalog/email.selfhosted.postfix" not in provenance
    sources = await value_sources(db_session, upload.revision.id)
    assert sources.digest == origins_digest(await origins_for(db_session, upload.revision.id))
    latency = sources.sources[("sphere-email/email.mailgun.foundation", "feature", "latency")]
    assert latency == {"kind": "manual", "pricing": {
        "sphere": "danruilop1/mailgun", "registry": None, "pricingId": "6ade364540e55445692b0eda",
        "versionId": "6ade36454b2b5b01c587db3d", "versionLabel": None, "plan": "FOUNDATION", "addOns": [],
        "permanentUrl": mailgun.permanent_url,
    }, "detail": {"key": "mailgun.FOUNDATION"}, "carried": False}
    assert origins_digest([]) is None
