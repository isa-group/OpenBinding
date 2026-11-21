"""Proposing a change to a composition as typed steps (F6 B2): building, bases, previews, references, supersession,
the destructive rule, cancelling, and who reads what.

Over TomatoMeter as the lab seeds it (1.0.0 in ``production``, 1.1.0 derived from revision 3 with Resend PRO), with a
MEMBER, a VIEWER and an outsider. Confirming is ``test_proposal_executor.py``.
"""

from __future__ import annotations

import hashlib
import uuid

import pytest
from sqlalchemy import func, select

from _b1_helpers import gate  # noqa: F401
from _environment_rows import World, _version
from _upstream_rows import event, watch
from openbinding_gateway.db.models import (
    AuditEvent,
    Composition,
    CompositionAdoption,
    CompositionEnvironment,
    CompositionVersion,
    Proposal,
    ProposalStep,
)
from openbinding_gateway.modules.compositions.application import proposals

from ._proposals import adopt, code, derive_and_adopt, errors, step_kinds, tomato_team  # noqa: F401
from ._tomatometer import fresh

pytestmark = pytest.mark.asyncio


async def _event_in(db_session, organization_id, composition_id, user_id) -> uuid.UUID:
    version_id, evaluation_id = await _version(db_session, composition_id, user_id, 99, f"9.{uuid.uuid4().int % 1000}.0")
    w = World(user_id, organization_id, composition_id, (version_id,), (evaluation_id,), composition_id, version_id,
              evaluation_id)
    found = await event(db_session, w, await watch(db_session))
    await db_session.commit()
    return found


async def _count(db_session, model, *where) -> int:
    return int(await db_session.scalar(select(func.count()).select_from(model).where(*where)) or 0)


async def test_a_member_proposes_an_adoption_and_a_viewer_cannot(api_client, registration, db_session, gate):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    environment = (await api_client.get(f"{t.base}/environments/production", headers=t.member))
    made = await api_client.post(t.proposals, headers=t.member, json=adopt("1.1.0", note="Resend"))
    assert made.status_code == 201, made.text
    body = made.json()
    assert body["status"] == "pending" and body["mine"] and body["origin"] == "web"
    assert body["summary"] == "Adopt 1.1.0 in Production"
    assert body["proposedBy"]["username"] == t.ids["member_username"]
    assert made.headers["Location"] == f"/v1/organizations/{t.org}/proposals/{body['id']}"
    (step,) = body["steps"]
    assert step["kind"] == "adopt" and step["status"] == "pending" and step["dependsOn"] == [] and step["deferred"] == []
    assert step["params"] == {"environment": environment.json()["id"], "version": str(t.found.ids["v110"]),
                              "note": "Resend"}
    assert step["base"] == {"environmentEtag": environment.headers["ETag"], "inEffect": str(t.found.ids["v100"])}
    assert step["preview"] is None
    refused = await api_client.post(t.proposals, headers=t.viewer, json=adopt("1.1.0"))
    assert refused.status_code == 403 and code(refused) == "organization_forbidden"
    audit = await db_session.scalar(select(AuditEvent).where(AuditEvent.action == "composition.proposal_created"))
    assert audit.detail["steps"] == ["adopt"] and audit.detail["origin"] == "web"
    # Nothing changed: the environment and its feed are as they were.
    after = await api_client.get(f"{t.base}/environments/production", headers=t.member)
    assert after.headers["ETag"] == environment.headers["ETag"]


async def test_a_derive_and_adopt_proposal_stores_the_document_it_would_seal(api_client, registration, db_session, gate):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    versions_before = await _count(db_session, CompositionVersion)
    made = await api_client.post(t.proposals, headers=t.member, json=derive_and_adopt(t.found))
    assert made.status_code == 201, made.text
    body = made.json()
    seal, take = body["steps"]
    assert seal["kind"] == "seal_derived" and seal["params"]["label"] == "1.2.0"
    assert seal["params"]["source"]["revision"] == f"tomatometer-email@{t.found.ids['revision']}"
    assert seal["description"].startswith("Seal 1.2.0 from tomatometer-email@")
    assert seal["base"]["headVersionId"] == str(t.found.ids["v110"])
    document = seal["preview"]["document"]
    assert seal["base"]["contentDigest"] == "sha256-" + hashlib.sha256(document.encode()).hexdigest()
    assert "version: 1.2.0" in document and "email.resend.pro" in document
    assert take["kind"] == "adopt" and take["params"]["version"] == "@s1.version"
    assert take["dependsOn"] == [1] and take["deferred"] == ["version"]
    assert body["summary"] == (f"Seal 1.2.0 from tomatometer-email@{t.found.ids['revision']}; then Adopt the version "
                               "step 1 seals in Production")
    # Nothing is stored but the proposal.
    assert await _count(db_session, CompositionVersion) == versions_before

    # Its own read serves the document's diff against the version in effect in production, as the diff service does.
    read = await api_client.get(t.proposal(body["id"]), headers=t.viewer)
    assert read.status_code == 200, read.text
    preview = read.json()["steps"][0]["preview"]
    assert preview["against"]["version"]["label"] == "1.0.0"
    assert preview["against"]["environment"]["slug"] == "production"
    in_effect = (await api_client.get(f"{t.base}/versions/1.0.0/content", headers=t.member)).text
    stateless = await api_client.post("/v1/compositions/diff", headers=t.member,
                                      json={"before": in_effect, "after": document})
    assert stateless.status_code == 200, stateless.text
    assert preview["diff"] == stateless.json()
    assert read.headers["ETag"]


async def test_each_refusal_says_which_step_and_why(api_client, registration, db_session, gate):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)

    async def refused(body, headers=None) -> list[dict]:
        answer = await api_client.post(t.proposals, headers=headers or t.member, json=body)
        assert answer.status_code == 422, answer.text
        assert code(answer) == "proposal_invalid"
        return errors(answer)

    assert [e["code"] for e in await refused(adopt("1.1.0", environment="nowhere"))] == ["environment_not_found"]
    assert [e["code"] for e in await refused(adopt("7.7.7"))] == ["version_not_found"]
    assert [e["code"] for e in await refused(adopt("1.0.0"))] == ["already_in_effect"]
    # A version of another composition is not one of this one's.
    other = (await api_client.post(f"/v1/organizations/{t.org}/compositions", headers=t.owner,
                                   json={"slug": "other", "name": "Other"})).json()
    other_version, _ = await _version(db_session, uuid.UUID(other["id"]), t.found.ids["user"], 1, "1.0.0")
    await db_session.commit()
    assert [e["code"] for e in await refused(adopt(str(other_version)))] == ["version_not_found"]
    # A derivation the toolchain refuses.
    bad = await refused(derive_and_adopt(t.found, binding={"dailySummary": "email.nobody.nothing"}))
    assert [e["code"] for e in bad] == ["derivation_invalid"] and bad[0]["step"] == 1
    # A label another content holds.
    assert [e["code"] for e in await refused(derive_and_adopt(t.found, label="1.0.0"))] == ["derivation_invalid"]
    # An environment only ADMIN adopts in, for a MEMBER.
    staging = await api_client.post(f"{t.base}/environments", headers=t.owner,
                                    json={"slug": "staging", "name": "Staging", "adoptRole": "ADMIN"})
    assert staging.status_code == 201, staging.text
    assert [e["code"] for e in await refused(adopt("1.1.0", environment="staging"))] == ["not_permitted"]
    owner = await api_client.post(t.proposals, headers=t.owner, json=adopt("1.1.0", environment="staging"))
    assert owner.status_code == 201, owner.text
    # An upstream event of another composition, and of another organization: the same answer.
    organization, composition, user = await fresh(db_session, t.found)
    elsewhere = await _event_in(db_session, organization.id, uuid.UUID(other["id"]), user.id)
    from _environment_rows import world

    w = await world(db_session)
    foreign = await _event_in(db_session, w.organization_id, w.composition_id, w.user_id)
    answers = []
    for event_id in (elsewhere, foreign):
        answers.append(await refused(adopt("1.1.0", upstreamEvent=str(event_id))))
    assert answers[0] == answers[1] == [{"step": None, "code": "event_not_found",
                                         "message": "This composition has no such upstream event."}]
    own = await _event_in(db_session, organization.id, composition.id, user.id)
    answering = await api_client.post(t.proposals, headers=t.member, json=adopt("1.1.0", upstreamEvent=str(own)))
    assert answering.status_code == 201 and answering.json()["upstreamEvent"] == str(own)
    # The request is typed: an unknown kind or field is the schema's 422.
    for body in ({"kind": "delete"}, {**adopt("1.1.0"), "steps": []}):
        answer = await api_client.post(t.proposals, headers=t.member, json=body)
        assert answer.status_code == 422 and code(answer) != "proposal_invalid"


async def test_the_builder_refuses_kinds_step_counts_and_references_it_cannot_follow(api_client, registration, db_session, gate, step_kinds):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    organization, composition, user = await fresh(db_session, t.found)
    step = proposals.StepRequest

    async def refused(steps) -> list[dict]:
        with pytest.raises(proposals.ProposalInvalid) as raised:
            await proposals.create(db_session, organization, user, steps, role=_owner(), composition=composition)
        return raised.value.errors

    taking = step("adopt", {"environment": "production", "version": "1.1.0"})
    assert [e["code"] for e in await refused([step("drop_tables", {})])] == ["unknown_kind"]
    assert [e["code"] for e in await refused([taking] * 9)] == ["too_many_steps"]
    forward = [step("adopt", {"environment": "production", "version": "@s3.version"}),
               step("seal_derived", {"source": {"run": str(uuid.uuid4())}})]
    assert [(e["step"], e["code"]) for e in await refused(forward)] == [(1, "dependency_invalid")]
    undeclared = [step("seal_derived", {"source": {"run": str(uuid.uuid4())}}),
                  step("adopt", {"environment": "production", "version": "@s1.revision"})]
    assert [(e["step"], e["code"]) for e in await refused(undeclared)] == [(2, "dependency_invalid")]
    not_referenceable = [step("test_revision", {"revision": "x@1"}),
                         step("adopt", {"environment": "@s1.revision", "version": "1.1.0"})]
    assert [e["code"] for e in await refused(not_referenceable)] == ["dependency_invalid"]
    assert [e["code"] for e in await refused([step("adopt", {"environment": "production"})])] == ["params_invalid"]


def _owner():
    from openbinding_gateway.db.models import OrganizationRole

    return OrganizationRole.OWNER


async def test_a_step_takes_an_earlier_steps_revision_and_defers_its_base(api_client, registration, db_session, gate, step_kinds):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    organization, composition, user = await fresh(db_session, t.found)
    spec_binding = {"dailySummary": "email.resend.pro"}
    from ._proposals import spec

    made = await proposals.create(db_session, organization, user, [
        proposals.StepRequest("test_revision", {"revision": f"tomatometer-email@{t.found.ids['revision']}"}),
        proposals.StepRequest("seal_derived", {"source": {"revision": "@s1.revision",
                                                          "binding": {**spec()["binding"], **spec_binding}},
                                               "offering": spec()["offering"]}),
        proposals.StepRequest("adopt", {"environment": "production", "version": "@s2.version"}),
    ], role=_owner(), composition=composition)
    steps = (await db_session.scalars(select(ProposalStep).where(ProposalStep.proposal_id == made.id)
                                      .order_by(ProposalStep.ordinal))).all()
    assert [s.depends_on for s in steps] == [[], [1], [2]]
    assert steps[1].preview is None and steps[1].base["deferred"] == ["revisionId", "contentDigest"]
    assert steps[1].base["headVersionId"] == str(t.found.ids["v110"]) and steps[1].params["label"] == "1.2.0"
    assert steps[2].base["deferred"] == ["version"]
    read = await api_client.get(t.proposal(str(made.id)), headers=t.owner)
    assert read.json()["steps"][1]["deferred"] == ["revisionId", "contentDigest"]
    assert read.json()["steps"][1]["preview"] is None


async def test_a_new_proposal_supersedes_the_pending_one(api_client, registration, db_session, gate):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    first = (await api_client.post(t.proposals, headers=t.member, json=adopt("1.1.0"))).json()
    others = (await api_client.post(t.proposals, headers=t.owner, json=adopt("1.1.0"))).json()
    second = (await api_client.post(t.proposals, headers=t.member, json=derive_and_adopt(t.found))).json()
    read = (await api_client.get(t.proposal(first["id"]), headers=t.member)).json()
    assert read["status"] == "superseded" and read["supersededBy"] == second["id"]
    # Another author's pending proposal on the same composition is theirs to replace.
    assert (await api_client.get(t.proposal(others["id"]), headers=t.member)).json()["status"] == "pending"
    audit = await db_session.scalar(select(AuditEvent).where(AuditEvent.action == "composition.proposal_superseded"))
    assert audit.target_id == uuid.UUID(first["id"]) and audit.detail == {"by": second["id"]}


async def test_a_destructive_step_goes_alone_behind_a_phrase(api_client, registration, db_session, gate, step_kinds):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    organization, composition, user = await fresh(db_session, t.found)
    destroy = proposals.StepRequest("test_destroy", {"target": "TomatoMeter Production"})
    with pytest.raises(proposals.ProposalInvalid) as raised:
        await proposals.create(db_session, organization, user,
                               [destroy, proposals.StepRequest("adopt", {"environment": "production", "version": "1.1.0"})],
                               role=_owner(), composition=composition)
    assert [(e["step"], e["code"]) for e in raised.value.errors] == [(1, "destructive_not_alone")]
    alone = await proposals.create(db_session, organization, user, [destroy], role=_owner(), composition=composition)
    assert alone.confirmation_phrase == "TomatoMeter Production"
    read = (await api_client.get(t.proposal(str(alone.id)), headers=t.owner)).json()
    assert read["confirmationPhrase"] == "TomatoMeter Production" and read["steps"][0]["destructive"]


async def test_only_the_author_cancels_once(api_client, registration, db_session, gate):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    made = (await api_client.post(t.proposals, headers=t.member, json=adopt("1.1.0"))).json()
    other = await api_client.delete(t.proposal(made["id"]), headers=t.owner)
    assert other.status_code == 403 and code(other) == "proposal_not_yours"
    cancelled = await api_client.delete(t.proposal(made["id"]), headers=t.member)
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    again = await api_client.delete(t.proposal(made["id"]), headers=t.member)
    assert again.status_code == 409 and code(again) == "proposal_not_pending"
    assert await _count(db_session, AuditEvent, AuditEvent.action == "composition.proposal_cancelled") == 1


async def test_members_read_every_proposal_and_nobody_else_learns_one_exists(api_client, registration, db_session, gate):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    mine = (await api_client.post(t.proposals, headers=t.member, json=adopt("1.1.0"))).json()
    owners = (await api_client.post(t.proposals, headers=t.owner, json=derive_and_adopt(t.found))).json()
    listed = await api_client.get(t.proposals, headers=t.viewer)
    assert listed.status_code == 200
    assert [row["id"] for row in listed.json()["proposals"]] == [owners["id"], mine["id"]]
    assert all(row["steps"][0]["preview"] is None for row in listed.json()["proposals"])
    pending = await api_client.get(f"{t.proposals}?status=pending&limit=1", headers=t.viewer)
    assert len(pending.json()["proposals"]) == 1

    own = await api_client.get("/v1/users/me/proposals", headers=t.member)
    assert [row["id"] for row in own.json()["proposals"]] == [mine["id"]]
    assert own.json()["proposals"][0]["composition"]["slug"] == "tomatometer"
    assert own.json()["proposals"][0]["organization"]["slug"] == t.org
    assert (await api_client.get("/v1/users/me/proposals", headers=t.outsider)).json() == {"proposals": []}

    # Not a member: the composition's parity on its routes, "Proposal not found." on a proposal's own.
    missing = await api_client.get(t.proposal(str(uuid.uuid4())), headers=t.member)
    hidden = await api_client.get(t.proposal(mine["id"]), headers=t.outsider)
    malformed = await api_client.get(t.proposal("nothing"), headers=t.member)
    assert missing.status_code == hidden.status_code == malformed.status_code == 404
    assert missing.json() == hidden.json() == malformed.json()
    assert (await api_client.get(t.proposals, headers=t.outsider)).status_code == 404
    # Another organization's proposal id through this organization's routes.
    outsider_org = (await api_client.get("/v1/organizations", headers=t.outsider)).json()
    elsewhere = await api_client.get(f"/v1/organizations/{outsider_org[0]['slug']}/proposals/{mine['id']}",
                                     headers=t.outsider)
    assert elsewhere.status_code == 404 and elsewhere.json() == missing.json()
    assert (await api_client.get(t.proposal(mine["id"]))).status_code == 401


async def test_making_superseding_or_cancelling_moves_no_feed(api_client, registration, db_session, gate):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    environment = await api_client.get(f"{t.base}/environments/production", headers=t.member)
    adoptions = await _count(db_session, CompositionAdoption)
    first = (await api_client.post(t.proposals, headers=t.member, json=adopt("1.1.0"))).json()
    second = (await api_client.post(t.proposals, headers=t.member, json=derive_and_adopt(t.found))).json()
    await api_client.delete(t.proposal(second["id"]), headers=t.member)
    after = await api_client.get(f"{t.base}/environments/production", headers=t.member)
    assert after.headers["ETag"] == environment.headers["ETag"]
    assert after.json()["feed"]["etag"] == environment.json()["feed"]["etag"]
    assert await _count(db_session, CompositionAdoption) == adoptions
    assert first["status"] == "pending"
    row = await db_session.scalar(select(CompositionEnvironment).where(CompositionEnvironment.slug == "production"))
    assert row.adoption_ordinal == 1
    assert await _count(db_session, Proposal) == 2
    assert await _count(db_session, Composition) >= 1
