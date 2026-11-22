"""Deriving and sealing through one application function (F6 B3): the derive route and a proposal's seal step run the
same sequence, and a digest the person was shown is held to the bytes before anything is stored."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from _b1_helpers import gate  # noqa: F401
from openbinding_gateway.db.models import CompositionDerivation, CompositionEvaluation, CompositionVersion
from openbinding_gateway.modules.compositions.application import derive

from ._proposals import spec
from ._tomatometer import fresh, seeded

pytestmark = pytest.mark.asyncio


async def _count(db_session, model, *where) -> int:
    return int(await db_session.scalar(select(func.count()).select_from(model).where(*where)) or 0)


def _arguments(found) -> dict:
    return {
        "label": "1.2.0", "offering": spec()["offering"], "revision": f"tomatometer-email@{found.ids['revision']}",
        "binding": {**spec()["binding"], "dailySummary": "email.resend.pro"},
    }


async def test_the_route_and_the_function_store_the_same_version(api_client, registration, db_session, gate):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate, production=False)
    arguments = _arguments(found)
    routed = await api_client.post(f"/v1/organizations/{found.org}/compositions/tomatometer/derive",
                                   headers=found.headers, json={**{k: v for k, v in arguments.items() if k != "label"},
                                                                "version": "1.2.0"})
    assert routed.status_code == 201, routed.text
    versions, evaluations, edges = (await _count(db_session, CompositionVersion), await _count(
        db_session, CompositionEvaluation), await _count(db_session, CompositionDerivation))

    organization, composition, user = await fresh(db_session, found)
    stored = await derive.derive_and_seal(db_session, organization, composition, caller=user, **arguments)

    assert not stored.sealed.created and str(stored.sealed.version.id) == routed.json()["version"]["id"]
    assert stored.sealed.version.content_digest == routed.json()["version"]["content_digest"]
    assert (await _count(db_session, CompositionVersion), await _count(db_session, CompositionEvaluation),
            await _count(db_session, CompositionDerivation)) == (versions, evaluations, edges)


async def test_a_digest_that_no_longer_holds_stores_nothing(api_client, registration, db_session, gate):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate, production=False)
    organization, composition, user = await fresh(db_session, found)
    arguments = _arguments(found)
    draft = await derive.derive_version(db_session, organization, composition, caller=user, **arguments)
    versions = await _count(db_session, CompositionVersion)

    with pytest.raises(HTTPException) as refused:
        await derive.derive_and_seal(db_session, organization, composition, caller=user,
                                     expect_digest="sha256-" + "0" * 64, **arguments)
    assert refused.value.status_code == 409 and refused.value.detail["code"] == "derivation_changed"
    assert refused.value.detail["found"] == draft.assessment.content_digest
    assert await _count(db_session, CompositionVersion) == versions

    stored = await derive.derive_and_seal(db_session, organization, composition, caller=user,
                                          expect_digest=draft.assessment.content_digest, **arguments)
    assert stored.sealed.created and stored.sealed.version.content == draft.content
    assert await _count(db_session, CompositionVersion) == versions + 1
