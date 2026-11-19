"""Adopting a sealed version in a composition environment (F4 A4).

The one write that changes what an application runs: it needs the environment's ETag in ``If-Match`` (428 when
absent or ``*``), a role that reaches the environment's ``adoptRole``, an unarchived composition, a version of the
composition that is not already in effect, and an evaluation by the installed toolchain whose binding holds. It
leaves one immutable history row pinning that evaluation, one audit row, and notifications to the operator and
the followers who hold a role.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import delete, func, select, update

from _b1_helpers import gate, make_key  # noqa: F401
from _composition_helpers import document_for, first_binding, linked_problem
from _environment_api import code, env, seal, team
from openbinding_gateway.core import revision
from openbinding_gateway.db.models import (
    AuditEvent,
    CompositionAdoption,
    CompositionEnvironment,
    CompositionEvaluation,
    CompositionVersion,
    EvaluationOutcome,
    Notification,
    Organization,
    User,
)
from openbinding_gateway.modules.compositions.application import versions

pytestmark = pytest.mark.asyncio


async def adopt(client, t, headers, version, tag, slug="production", note=""):
    extra = {} if tag is None else {"If-Match": tag}
    return await client.post(
        f"{t.environments}/{slug}/adopt", headers={**headers, **extra}, json={"version": version, "note": note},
    )


async def count(db, model, *where) -> int:
    return int(await db.scalar(select(func.count()).select_from(model).where(*where)) or 0)


async def test_adopting_moves_the_version_in_effect_and_keeps_the_history(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate)
    created = await env(api_client, t, operator=t.ids["member_username"])
    v1, v2 = t.versions["1.0.0"], t.versions["1.1.0"]

    first = await adopt(api_client, t, t.owner, "1.0.0", created.headers["ETag"], note="Go live")
    assert first.status_code == 200, first.text
    body = first.json()
    assert first.headers["ETag"] != created.headers["ETag"]
    environment = body["environment"]
    assert environment["inEffect"]["adoption"] == 1
    assert environment["inEffect"]["version"] == {"id": v1["id"], "label": "1.0.0", "ordinal": 1}
    assert environment["inEffect"]["note"] == "Go live"
    assert environment["inEffect"]["binding"] == {"t1": {"candidate": "c1a"}}
    assert environment["inEffect"]["evaluation"]["valuesStatus"] == "declared"
    assert environment["feed"]["etag"] == f'"{v1["content_digest"]}"'
    assert body["adoption"]["ordinal"] == 1 and body["adoption"]["previousVersion"] is None
    assert body["adoption"]["feedEtag"] == f'"{v1["content_digest"]}"'

    # By ordinal, then by id.
    second = await adopt(api_client, t, t.owner, "2", first.headers["ETag"])
    assert second.status_code == 200, second.text
    third = await adopt(api_client, t, t.owner, v1["id"], second.headers["ETag"])
    assert third.status_code == 200, third.text
    assert third.json()["environment"]["feed"]["etag"] == f'"{v1["content_digest"]}"'

    history = await api_client.get(f"{t.environments}/production/adoptions", headers=t.viewer)
    assert history.status_code == 200
    rows = history.json()["adoptions"]
    assert [row["ordinal"] for row in rows] == [3, 2, 1]
    assert [row["version"]["label"] for row in rows] == ["1.0.0", "1.1.0", "1.0.0"]
    assert [row["previousVersion"] and row["previousVersion"]["label"] for row in rows] == ["1.1.0", "1.0.0", None]
    assert rows[1]["feedEtag"] == f'"{v2["content_digest"]}"'
    assert rows[0]["adoptedBy"]["username"] == t.ids["owner_username"]
    paged = await api_client.get(f"{t.environments}/production/adoptions?limit=2", headers=t.viewer)
    assert [row["ordinal"] for row in paged.json()["adoptions"]] == [3, 2] and paged.json()["nextBefore"] == 2
    rest = await api_client.get(f"{t.environments}/production/adoptions?limit=2&before=2", headers=t.viewer)
    assert [row["ordinal"] for row in rest.json()["adoptions"]] == [1] and rest.json()["nextBefore"] is None

    stored = (await db_session.scalars(select(CompositionAdoption).order_by(CompositionAdoption.ordinal))).all()
    for row in stored:
        version = await db_session.get(CompositionVersion, row.version_id)
        assert row.content_digest == version.content_digest
        evaluation = await db_session.get(CompositionEvaluation, row.evaluation_id)
        assert evaluation.version_id == version.id
    actions = (await db_session.scalars(
        select(AuditEvent).where(AuditEvent.action == "composition.adopted").order_by(AuditEvent.created_at)
    )).all()
    assert [(a.detail["version"], a.detail["previous"], a.detail["ordinal"]) for a in actions] == [
        ("1.0.0", None, 1), ("1.1.0", "1.0.0", 2), ("1.0.0", "1.1.0", 3),
    ]


async def test_if_match_is_required_with_an_entity_tag(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate)
    created = await env(api_client, t)
    tag = created.headers["ETag"]

    for value in (None, "*", " * "):
        refused = await adopt(api_client, t, t.owner, "1.0.0", value)
        assert refused.status_code == 428, refused.text
        assert code(refused) == "precondition_required"
    malformed = await adopt(api_client, t, t.owner, "1.0.0", "not-a-tag")
    assert malformed.status_code == 400 and code(malformed) == "invalid_if_match"
    stale = await adopt(api_client, t, t.owner, "1.0.0", '"0000"')
    assert stale.status_code == 412 and stale.headers["ETag"] == tag

    assert await count(db_session, CompositionAdoption) == 0
    assert await count(db_session, AuditEvent, AuditEvent.action == "composition.adopted") == 0
    unchanged = await api_client.get(f"{t.environments}/production", headers=t.owner)
    assert unchanged.headers["ETag"] == tag
    # A list of tags naming the current one passes.
    assert (await adopt(api_client, t, t.owner, "1.0.0", f'"x", {tag}')).status_code == 200


async def test_require_if_match():
    with pytest.raises(Exception) as absent:
        revision.require_if_match(None)
    assert absent.value.status_code == 428
    with pytest.raises(Exception) as wildcard:
        revision.require_if_match("*")
    assert wildcard.value.status_code == 428
    with pytest.raises(Exception) as malformed:
        revision.require_if_match("nope")
    assert malformed.value.status_code == 400
    assert revision.require_if_match('"a", W/"b"') == ['"a"', 'W/"b"']


async def test_who_may_adopt(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate)
    admins = await env(api_client, t)
    members = await env(api_client, t, "staging", adoptRole="MEMBER")

    member_on_admin = await adopt(api_client, t, t.member, "1.0.0", admins.headers["ETag"])
    assert member_on_admin.status_code == 403 and code(member_on_admin) == "organization_forbidden"
    for slug, tag in (("production", admins.headers["ETag"]), ("staging", members.headers["ETag"])):
        viewer = await adopt(api_client, t, t.viewer, "1.0.0", tag, slug)
        assert viewer.status_code == 403 and code(viewer) == "organization_forbidden"
    assert (await adopt(api_client, t, t.member, "1.0.0", members.headers["ETag"], "staging")).status_code == 200
    assert (await adopt(api_client, t, t.admin, "1.0.0", admins.headers["ETag"])).status_code == 200

    # Not a member: the composition's parity, before If-Match is read.
    outsider = await adopt(api_client, t, t.outsider, "1.0.0", None)
    assert outsider.status_code == 404 and outsider.json()["detail"]["error"] == "Composition not found."


async def test_a_personal_key_needs_the_adopt_permission(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate)
    created = await env(api_client, t)
    writer = await make_key(api_client, t.owner, ["compositions:read", "compositions:write"])
    adopter = await make_key(api_client, t.owner, ["compositions:adopt"])

    refused = await adopt(api_client, t, writer, "1.0.0", created.headers["ETag"])
    assert refused.status_code == 403 and code(refused) == "insufficient_api_key_permission"
    assert refused.json()["detail"]["missing_permissions"] == ["compositions:adopt"]
    assert (await adopt(api_client, t, adopter, "1.0.0", created.headers["ETag"])).status_code == 200


async def test_what_cannot_be_adopted(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate)
    created = await env(api_client, t)
    tag = created.headers["ETag"]
    other = await api_client.post(
        f"/v1/organizations/{t.org}/compositions", headers=t.owner, json={"slug": "other", "name": "Other"},
    )
    other_version = await seal(api_client, t.owner, f"/v1/organizations/{t.org}/compositions/other",
                               "syntaxVersion: \"1.0\"\ncomposition: other\nversion: 9.0.0\nkind: workflow\n"
                               "workflow:\n  seq: [t1]\nbinding:\n  t1: {local: true}\nvalues:\n  trust: 0.5\n")
    assert other.status_code == 201

    for ref in ("9.9.9", "77", other_version["id"], str(uuid.uuid4())):
        missing = await adopt(api_client, t, t.owner, ref, tag)
        assert missing.status_code == 404, (ref, missing.text)

    adopted = await adopt(api_client, t, t.owner, "1.0.0", tag)
    again = await adopt(api_client, t, t.owner, "1.0.0", adopted.headers["ETag"])
    assert again.status_code == 409 and code(again) == "already_in_effect"

    archived = await api_client.patch(t.base, headers=t.owner, json={"archived": True})
    assert archived.status_code == 200
    refused = await adopt(api_client, t, t.owner, "1.1.0", adopted.headers["ETag"])
    assert refused.status_code == 409 and code(refused) == "composition_archived"
    assert await count(db_session, CompositionAdoption) == 1


async def test_the_lock_reads_the_row_not_the_read_phase(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    """A change committed between the read phase and the lock is seen: 412, never the read phase's role."""
    from openbinding_gateway.modules.compositions.application import adoption

    t = await team(api_client, registration, db_session, gate)
    created = await env(api_client, t, adoptRole="MEMBER")
    async def concurrent_edit():
        # Another writer raises the bar and bumps the revision after the read phase; the identity-mapped row
        # the read phase loaded is left as it was.
        await db_session.execute(
            update(CompositionEnvironment).values(adopt_role="ADMIN", updated_at=datetime(2030, 1, 1, tzinfo=timezone.utc))
            .execution_options(synchronize_session=False)
        )

    real_adopt = adoption.adopt

    async def adopt_after_edit(session, **kwargs):
        await concurrent_edit()
        return await real_adopt(session, **kwargs)

    monkeypatch.setattr(adoption, "adopt", adopt_after_edit)

    refused = await adopt(api_client, t, t.member, "1.0.0", created.headers["ETag"])

    assert refused.status_code == 412, refused.text
    assert refused.headers["ETag"] != created.headers["ETag"]
    assert await count(db_session, CompositionAdoption) == 0
    # With the new tag, the locked row's role decides: MEMBER is now refused.
    again = await adopt(api_client, t, t.member, "1.0.0", refused.headers["ETag"])
    assert again.status_code == 403 and code(again) == "organization_forbidden"


async def test_three_adoptions_in_one_clock_tick_keep_moving_the_etag(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    from openbinding_gateway.modules.compositions.application import adoption

    t = await team(api_client, registration, db_session, gate)
    created = await env(api_client, t)
    frozen = datetime(2026, 1, 1, tzinfo=timezone.utc)

    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen

    monkeypatch.setattr(adoption, "datetime", Frozen)
    tags = [created.headers["ETag"]]
    for version in ("1.0.0", "1.1.0", "1.0.0"):
        adopted = await adopt(api_client, t, t.owner, version, tags[-1])
        assert adopted.status_code == 200, adopted.text
        tags.append(adopted.headers["ETag"])
    assert len(set(tags)) == 4


async def test_notifications_go_to_the_operator_and_followers_with_a_role(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate)
    created = await env(api_client, t, operator=t.ids["member_username"])
    for headers in (t.viewer, t.owner, t.member):
        followed = await api_client.put(f"/v1/composition-follows/{t.org}/tomato", headers=headers)
        assert followed.status_code == 200, followed.text

    adopted = await adopt(api_client, t, t.owner, "1.0.0", created.headers["ETag"])
    assert adopted.status_code == 200

    rows = (await db_session.scalars(select(Notification).where(Notification.kind == "CompositionAdopted"))).all()
    told = sorted(str(row.user_id) for row in rows)
    assert told == sorted([t.ids["member"], t.ids["viewer"]])
    payload = rows[0].payload
    assert payload["environment"] == "production" and payload["version"] == "1.0.0"
    assert payload["previousVersion"] is None and payload["actor"] == t.ids["owner_username"]


async def test_a_linked_version_needs_a_current_valid_evaluation(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)
    owner = await db_session.get(User, uuid.UUID(t.ids["owner"]))
    organization = await db_session.get(Organization, uuid.UUID(t.organization_id))
    linked = await linked_problem(db_session, owner, organization=organization)
    await db_session.commit()
    shop = await api_client.post(
        f"/v1/organizations/{t.org}/compositions", headers=t.owner, json={"slug": "shop", "name": "Shop"},
    )
    assert shop.status_code == 201
    base = f"/v1/organizations/{t.org}/compositions/shop"
    version = await seal(api_client, t.owner, base, document_for(linked, first_binding(linked.compilation.ir)))
    assert version["values_status"] == "verified"
    environments = f"{base}/environments"
    created = await api_client.post(environments, headers=t.owner, json={"slug": "production", "name": "P"})
    tag = created.headers["ETag"]

    async def try_adopt():
        return await api_client.post(
            f"{environments}/production/adopt", headers={**t.owner, "If-Match": tag}, json={"version": "1.0.0"},
        )

    real = versions.installed_basis
    monkeypatch.setattr(versions, "installed_basis", lambda: "sha256-" + "e" * 64)
    stale = await try_adopt()
    assert stale.status_code == 409 and code(stale) == "evaluation_stale"
    monkeypatch.setattr(versions, "installed_basis", real)

    (evaluation,) = (await db_session.scalars(
        select(CompositionEvaluation).where(CompositionEvaluation.version_id == uuid.UUID(version["id"]))
    )).all()
    columns = {column.key: getattr(evaluation, column.key) for column in CompositionEvaluation.__table__.columns}
    for outcome, expected in (
        (EvaluationOutcome.BINDING_INVALID, "binding_invalid"),
        (EvaluationOutcome.SEMANTICS_CHANGED, "evaluation_semantics_changed"),
    ):
        await db_session.execute(delete(CompositionEvaluation).where(CompositionEvaluation.version_id == evaluation.version_id))
        db_session.add(CompositionEvaluation(**{**columns, "id": uuid.uuid4(), "outcome": outcome}))
        await db_session.commit()
        refused = await try_adopt()
        assert refused.status_code == 409 and code(refused) == expected, refused.text
    assert await count(db_session, CompositionAdoption) == 0

    await db_session.execute(delete(CompositionEvaluation).where(CompositionEvaluation.version_id == evaluation.version_id))
    db_session.add(CompositionEvaluation(**{**columns, "id": uuid.uuid4()}))
    await db_session.commit()
    adopted = await try_adopt()
    assert adopted.status_code == 200, adopted.text
    pinned = await db_session.scalar(select(CompositionAdoption.evaluation_id))
    current = await db_session.scalar(
        select(CompositionEvaluation.id).where(CompositionEvaluation.version_id == evaluation.version_id)
    )
    assert pinned == current
