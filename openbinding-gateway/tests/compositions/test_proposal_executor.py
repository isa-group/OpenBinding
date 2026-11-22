"""Confirming a proposal and applying it step by step (F6 B4): the §8 invariants P3-P9, references between steps,
interrupted runs and invariant F (an environment's feed moves only through an adoption).

Over TomatoMeter as the lab seeds it (1.0.0 in ``production``, adopt role MEMBER), its team, and the two test-only
kinds of ``_proposals``. The races are ``tests/test_proposals_pg.py``.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from _b1_helpers import gate, make_key, put_member  # noqa: F401
from _composition_helpers import bim_binding, finished_run
from openbinding_gateway.db.models import (
    AuditEvent,
    CompositionAdoption,
    CompositionEnvironment,
    CompositionVersion,
    Job,
    JobState,
    Proposal,
    ProposalStep,
)
from openbinding_gateway.jobs import clock
from openbinding_gateway.modules.compositions.application import derive as derive_module
from openbinding_gateway.modules.compositions.application import proposal_executor, proposals

from ._proposals import adopt, code, derive_and_adopt, step_kinds, tomato_team  # noqa: F401
from ._tomatometer import fresh
from ._watching import Clocks

pytestmark = pytest.mark.asyncio


async def _count(db_session, model, *where) -> int:
    return int(await db_session.scalar(select(func.count()).select_from(model).where(*where)) or 0)


async def confirm(api_client, t, headers, proposal_id: str, **body):
    return await api_client.post(f"{t.proposal(proposal_id)}/confirm", headers=headers, json=body or None)


async def propose(api_client, t, headers, body) -> dict:
    made = await api_client.post(t.proposals, headers=headers, json=body)
    assert made.status_code == 201, made.text
    return made.json()


async def production(api_client, t) -> tuple[str, str]:
    """``production``'s ETag and its feed's ETag."""
    read = await api_client.get(f"{t.base}/environments/production", headers=t.member)
    return read.headers["ETag"], read.json()["feed"]["etag"]


# -- Happy paths -----------------------------------------------------------------------------------------------------


async def test_an_adopt_proposal_adopts_through_the_one_adopt_path(api_client, registration, db_session, gate):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    made = await propose(api_client, t, t.member, adopt("1.1.0", note="Resend"))
    before = await production(api_client, t)

    confirmed = await confirm(api_client, t, t.member, made["id"])

    assert confirmed.status_code == 200, confirmed.text
    body = confirmed.json()
    assert body["status"] == "completed" and body["confirmedAt"] and body["completedAt"]
    (step,) = body["steps"]
    v110 = await db_session.get(CompositionVersion, t.found.ids["v110"])
    assert step["status"] == "done" and step["error"] is None
    assert step["result"] == {"ordinal": 2, "environment": "production", "feedEtag": f'"{v110.content_digest}"',
                              "versionLabel": "1.1.0"}
    adoption = await db_session.scalar(select(CompositionAdoption).where(CompositionAdoption.ordinal == 2))
    assert (adoption.source, adoption.proposal_id, adoption.note) == ("proposal", uuid.UUID(made["id"]), "Resend")
    after = await production(api_client, t)
    assert after[1] == f'"{v110.content_digest}"' and after[1] != before[1]
    history = (await api_client.get(f"{t.base}/environments/production/adoptions", headers=t.viewer)).json()
    assert history["adoptions"][0]["source"] == "proposal"
    assert history["adoptions"][0]["proposal"] == {"id": made["id"], "summary": "Adopt 1.1.0 in Production"}
    assert history["adoptions"][1]["source"] == "direct" and history["adoptions"][1]["proposal"] is None
    actions = (await db_session.scalars(select(AuditEvent.action).where(AuditEvent.action.in_((
        "composition.proposal_created", "composition.proposal_confirmed", "composition.adopted",
        "composition.proposal_finished",
    ))).order_by(AuditEvent.created_at, AuditEvent.id))).all()
    assert actions[-4:] == ["composition.proposal_created", "composition.proposal_confirmed", "composition.adopted",
                            "composition.proposal_finished"]
    adopted = await db_session.scalar(select(AuditEvent).where(AuditEvent.action == "composition.adopted")
                                      .order_by(AuditEvent.created_at.desc()))
    assert adopted.detail["source"] == "proposal" and adopted.detail["proposal"] == made["id"]
    again = await confirm(api_client, t, t.member, made["id"])
    assert again.status_code == 409 and code(again) == "proposal_not_pending"


async def test_a_derive_and_adopt_proposal_seals_exactly_what_it_showed(api_client, registration, db_session, gate):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    made = await propose(api_client, t, t.member, derive_and_adopt(t.found))
    shown = made["steps"][0]["preview"]["document"]

    confirmed = await confirm(api_client, t, t.member, made["id"])

    assert confirmed.status_code == 200, confirmed.text
    seal, take = confirmed.json()["steps"]
    assert seal["status"] == take["status"] == "done"
    sealed = await db_session.get(CompositionVersion, uuid.UUID(seal["result"]["version"]["id"]))
    assert seal["result"]["version"]["label"] == "1.2.0" and seal["result"]["created"]
    assert sealed.content == shown
    assert take["result"]["versionLabel"] == "1.2.0"
    environment = await db_session.scalar(select(CompositionEnvironment).execution_options(populate_existing=True))
    assert environment.adopted_version_id == sealed.id
    # A step that is done is not previewed against itself any more: its version is in effect.
    read = (await api_client.get(t.proposal(made["id"]), headers=t.member)).json()
    assert read["steps"][0]["preview"]["against"]["version"]["label"] == "1.2.0"


async def test_a_derive_and_adopt_from_a_run(api_client, registration, db_session, gate):  # noqa: F811
    from test_composition_derive_api import SIMPLE_BINDING, composition_of

    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])
    created = await api_client.post(f"{base}/environments", headers=headers, json={"slug": "production", "name": "P"})
    assert created.status_code == 201, created.text
    made = await api_client.post(f"{base}/proposals", headers=headers, json={
        "kind": "derive_and_adopt", "source": {"run": str(run.id)}, "environment": "production"})
    assert made.status_code == 201, made.text
    seal = made.json()["steps"][0]
    assert seal["params"]["label"] == "1.0.0" and seal["base"]["runId"] == str(run.id)
    assert seal["base"]["headVersionId"] is None and seal["preview"]["against"] is None
    org = linked.organization.slug

    confirmed = await api_client.post(f"/v1/organizations/{org}/proposals/{made.json()['id']}/confirm", headers=headers)

    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["status"] == "completed"
    assert (await api_client.get(f"{base}/environments/production", headers=headers)).json()["inEffect"]["version"][
        "label"] == "1.0.0"


async def test_confirming_a_derivation_from_the_new_pricing_resolves_its_upstream_event(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    from .test_upstream_resolution import UP, _events, _revision_at, _with_events

    found = await _with_events(api_client, registration, db_session, gate, sphere, source, clocks,
                               "brevo-professional-up")
    (event,) = await _events(db_session, subject="binding")
    revision = await _revision_at(api_client, found, UP)
    base = f"/v1/organizations/{found.org}/compositions/tomatometer"
    made = await api_client.post(f"{base}/proposals", headers=found.headers,
                                 json=derive_and_adopt(found, revision=revision, upstreamEvent=str(event.id)))
    assert made.status_code == 201, made.text
    assert made.json()["upstreamEvent"] == str(event.id)

    confirmed = await api_client.post(f"/v1/organizations/{found.org}/proposals/{made.json()['id']}/confirm",
                                      headers=found.headers)

    assert confirmed.status_code == 200 and confirmed.json()["status"] == "completed", confirmed.text
    (event,) = await _events(db_session, subject="binding")
    assert event.state == "resolved"
    assert str(event.resolved_by_version_id) == confirmed.json()["steps"][0]["result"]["version"]["id"]


# -- P5: a stale base changes nothing --------------------------------------------------------------------------------


@pytest.mark.parametrize("change", ["adopted_meanwhile", "head_moved", "archived", "derivation", "environment_deleted"])
async def test_a_stale_proposal_is_refused_and_changes_nothing(api_client, registration, db_session, gate, change, monkeypatch):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    made = await propose(api_client, t, t.member, derive_and_adopt(t.found))
    if change == "adopted_meanwhile":
        tag = (await production(api_client, t))[0]
        direct = await api_client.post(f"{t.base}/environments/production/adopt", headers={**t.owner, "If-Match": tag},
                                       json={"version": "1.1.0"})
        assert direct.status_code == 200, direct.text
    elif change == "head_moved":
        other = derive_and_adopt(t.found, binding={"dailySummary": "email.mailgun.foundation"})
        moved = await api_client.post(t.base + "/derive", headers=t.owner, json={
            **other["source"], "offering": other["offering"], "version": "1.5.0"})
        assert moved.status_code == 201, moved.text
    elif change == "archived":
        archived = await api_client.patch(t.base, headers=t.owner, json={"archived": True})
        assert archived.status_code == 200, archived.text
    elif change == "derivation":
        real = derive_module.derive_version

        async def another_basis(*args, **kwargs):
            derived = await real(*args, **kwargs)
            from dataclasses import replace

            return replace(derived, assessment=replace(derived.assessment, content_digest="sha256-" + "1" * 64))

        monkeypatch.setattr(derive_module, "derive_version", another_basis)
    else:
        deleted = await api_client.delete(f"{t.base}/environments/production", headers=t.owner)
        assert deleted.status_code == 204, deleted.text
    versions, adoptions = await _count(db_session, CompositionVersion), await _count(db_session, CompositionAdoption)

    refused = await confirm(api_client, t, t.member, made["id"])

    assert refused.status_code == 409, refused.text
    row = await db_session.get(Proposal, uuid.UUID(made["id"]), populate_existing=True)
    assert row.status == "stale"
    if change == "environment_deleted":
        assert code(refused) == "proposal_not_pending"  # already stale with the environment (B1)
    else:
        assert code(refused) == "proposal_stale"
        reasons = {item["reason"] for item in refused.json()["detail"]["stale"]}
        expected = {"adopted_meanwhile": {"environment_changed"}, "head_moved": {"head_version_changed"},
                    "archived": {"composition_archived"}, "derivation": {"derivation_changed"}}[change]
        assert reasons == expected
    assert (await _count(db_session, CompositionVersion), await _count(db_session, CompositionAdoption)) == (
        versions, adoptions)
    assert await _count(db_session, ProposalStep, ProposalStep.status != "pending") == 0


# -- P4: partial failures, reported exactly --------------------------------------------------------------------------


async def test_an_adoption_raced_between_the_steps_fails_only_the_adopt_step(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    made = await propose(api_client, t, t.member, derive_and_adopt(t.found))
    real = proposals.SEAL_DERIVED.apply

    async def then_someone_adopts(context, step, outputs):
        result = await real(context, step, outputs)
        tag = (await production(api_client, t))[0]
        direct = await api_client.post(f"{t.base}/environments/production/adopt", headers={**t.owner, "If-Match": tag},
                                       json={"version": "1.1.0"})
        assert direct.status_code == 200, direct.text
        return result

    monkeypatch.setattr(proposals.SEAL_DERIVED, "apply", then_someone_adopts)
    versions = await _count(db_session, CompositionVersion)

    confirmed = await confirm(api_client, t, t.member, made["id"])

    body = confirmed.json()
    assert confirmed.status_code == 200 and body["status"] == "partial", confirmed.text
    seal, take = body["steps"]
    assert seal["status"] == "done" and take["status"] == "failed"
    assert take["error"]["status"] == 412 and take["error"]["code"] == "precondition_failed"
    assert await _count(db_session, CompositionVersion) == versions + 1
    assert await _count(db_session, CompositionAdoption, CompositionAdoption.proposal_id.is_not(None)) == 0
    finished = await db_session.scalar(select(AuditEvent).where(AuditEvent.action == "composition.proposal_finished"))
    assert finished.detail == {"status": "partial", "done": 1, "failed": 1, "skipped": 0}


async def test_a_failed_seal_skips_the_adoption_that_needs_it(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    made = await propose(api_client, t, t.member, derive_and_adopt(t.found))

    async def taken(*args, **kwargs):
        from openbinding_gateway.models.errors import api_error

        raise api_error(409, "version_label_taken", "Version 1.2.0 of this composition holds another content.")

    monkeypatch.setattr(derive_module, "derive_and_seal", taken)
    confirmed = await confirm(api_client, t, t.member, made["id"])

    body = confirmed.json()
    assert body["status"] == "failed"
    seal, take = body["steps"]
    assert (seal["status"], seal["error"]["code"], seal["error"]["status"]) == ("failed", "version_label_taken", 409)
    assert (take["status"], take["error"]["code"]) == ("skipped", "skipped_dependency")
    assert await _count(db_session, CompositionAdoption) == 1


async def test_an_independent_step_still_runs_after_a_failure(api_client, registration, db_session, gate, step_kinds, monkeypatch):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    revision_kind, _ = step_kinds
    organization, composition, user = await fresh(db_session, t.found)

    async def refused(context, step, outputs):
        from openbinding_gateway.models.errors import api_error

        raise api_error(422, "recipe_invalid", "The recipe no longer applies.")

    monkeypatch.setattr(revision_kind, "apply", refused)
    made = await proposals.create(db_session, organization, user, [
        proposals.StepRequest("test_revision", {"revision": "tomatometer-email@3"}),
        proposals.StepRequest("adopt", {"environment": "production", "version": "1.1.0"}),
    ], role=_role("OWNER"), composition=composition)

    confirmed = await confirm(api_client, t, t.owner, str(made.id))

    body = confirmed.json()
    assert body["status"] == "partial"
    assert [s["status"] for s in body["steps"]] == ["failed", "done"]
    assert body["steps"][0]["error"] == {"status": 422, "code": "recipe_invalid",
                                         "message": "The recipe no longer applies.", "detail": None}


def _role(name: str):
    from openbinding_gateway.db.models import OrganizationRole

    return OrganizationRole(name)


# -- P6, P7, P3: who confirms, with what ------------------------------------------------------------------------------


async def test_permissions_are_checked_again_with_the_confirming_caller(api_client, registration, db_session, gate):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    made = await propose(api_client, t, t.member, adopt("1.1.0"))
    # P7: another member, the OWNER included, cannot confirm it.
    other = await confirm(api_client, t, t.owner, made["id"])
    assert other.status_code == 403 and code(other) == "proposal_not_yours"
    # The author demoted to VIEWER.
    demoted = await put_member(api_client, t.owner, t.org, t.ids["member"], "VIEWER")
    assert demoted.status_code == 200, demoted.text
    refused = await confirm(api_client, t, t.member, made["id"])
    assert refused.status_code == 403 and code(refused) == "organization_forbidden"
    await put_member(api_client, t.owner, t.org, t.ids["member"], "MEMBER")
    # The environment now adopted by ADMIN only: the permission refusal comes before its changed ETag.
    raised = await api_client.patch(f"{t.base}/environments/production", headers=t.owner, json={"adoptRole": "ADMIN"})
    assert raised.status_code == 200, raised.text
    refused = await confirm(api_client, t, t.member, made["id"])
    assert refused.status_code == 403 and code(refused) == "organization_forbidden"
    assert (await db_session.get(Proposal, uuid.UUID(made["id"]), populate_existing=True)).status == "pending"
    assert await _count(db_session, CompositionAdoption) == 1


async def test_a_key_needs_each_steps_own_permission(api_client, registration, db_session, gate):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    writes = await make_key(api_client, t.member, ["compositions:read", "compositions:write"])
    made = await propose(api_client, t, writes, adopt("1.1.0"))
    refused = await confirm(api_client, t, writes, made["id"])
    assert refused.status_code == 403, refused.text
    detail = refused.json()["detail"]
    assert detail["code"] == "insufficient_api_key_permission" and detail["missing_permissions"] == ["compositions:adopt"]
    assert (await db_session.get(Proposal, uuid.UUID(made["id"]), populate_existing=True)).status == "pending"
    adopts = await make_key(api_client, t.member, ["compositions:read", "compositions:write", "compositions:adopt"])
    confirmed = await confirm(api_client, t, adopts, made["id"])
    assert confirmed.status_code == 200 and confirmed.json()["status"] == "completed", confirmed.text


async def test_a_destructive_step_runs_only_behind_its_phrase(api_client, registration, db_session, gate, step_kinds):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    _, destroy = step_kinds
    organization, composition, user = await fresh(db_session, t.found)
    made = await proposals.create(db_session, organization, user,
                                  [proposals.StepRequest("test_destroy", {"target": "TomatoMeter Production"})],
                                  role=_role("OWNER"), composition=composition)
    absent = await confirm(api_client, t, t.owner, str(made.id))
    assert absent.status_code == 422 and code(absent) == "confirmation_required"
    wrong = await confirm(api_client, t, t.owner, str(made.id), confirmation="TomatoMeter Staging")
    assert wrong.status_code == 422 and code(wrong) == "confirmation_mismatch"
    assert destroy.applied == []
    right = await confirm(api_client, t, t.owner, str(made.id), confirmation="  tomatometer   PRODUCTION ")
    assert right.status_code == 200 and right.json()["status"] == "completed", right.text
    assert destroy.applied == ["TomatoMeter Production"]
    audit = await db_session.scalar(select(AuditEvent).where(AuditEvent.action == "composition.proposal_confirmed"))
    assert audit.detail == {"phrase": True}


# -- References ------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("gives", [None, "tomatometer-email@999"])
async def test_a_chain_takes_each_earlier_steps_output(api_client, registration, db_session, gate, step_kinds, gives):  # noqa: F811
    from ._proposals import spec

    t = await tomato_team(api_client, registration, db_session, gate)
    revision_kind, _ = step_kinds
    revision_kind.give = gives
    organization, composition, user = await fresh(db_session, t.found)
    made = await proposals.create(db_session, organization, user, [
        proposals.StepRequest("test_revision", {"revision": f"tomatometer-email@{t.found.ids['revision']}"}),
        proposals.StepRequest("seal_derived", {"source": {"revision": "@s1.revision", "binding": {
            **spec()["binding"], "dailySummary": "email.resend.pro"}}, "offering": spec()["offering"]}),
        proposals.StepRequest("adopt", {"environment": "production", "version": "@s2.version"}),
    ], role=_role("OWNER"), composition=composition)

    confirmed = await confirm(api_client, t, t.owner, str(made.id))

    steps = confirmed.json()["steps"]
    if gives is None:
        assert confirmed.json()["status"] == "completed", confirmed.text
        assert steps[2]["result"]["versionLabel"] == steps[1]["result"]["version"]["label"] == "1.2.0"
    else:
        assert confirmed.json()["status"] == "partial"
        assert [s["status"] for s in steps] == ["done", "failed", "skipped"]
        assert (steps[1]["error"]["status"], steps[1]["error"]["code"]) == (409, "derivation_changed")
        assert steps[2]["error"]["code"] == "skipped_dependency"


# -- Interrupted runs ------------------------------------------------------------------------------------------------


async def _executing(db_session, proposal_id: str, *, minutes_ago: int) -> None:
    moment = clock.utcnow() - timedelta(minutes=minutes_ago)
    await db_session.execute(update(Proposal).where(Proposal.id == uuid.UUID(proposal_id)).values(
        status="executing", confirmed_at=moment, progressed_at=moment))
    await db_session.commit()


async def _housekeeping(db_session):
    from ._watching import cycle

    return await cycle(db_session, None, sphere_enabled=False)


async def test_an_interrupted_run_is_closed_by_the_watchers_housekeeping(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    Clocks(monkeypatch)
    t = await tomato_team(api_client, registration, db_session, gate)
    stuck = await propose(api_client, t, t.member, derive_and_adopt(t.found))
    slow = await propose(api_client, t, t.owner, adopt("1.1.0"))
    await _executing(db_session, stuck["id"], minutes_ago=11)
    await _executing(db_session, slow["id"], minutes_ago=2)

    report = await _housekeeping(db_session)

    assert report.closed_proposals == 1 and report.skipped == "disabled"
    row = await db_session.get(Proposal, uuid.UUID(stuck["id"]), populate_existing=True)
    assert row.status == "failed" and row.completed_at is not None
    steps = (await db_session.scalars(select(ProposalStep).where(ProposalStep.proposal_id == row.id)
                                      .order_by(ProposalStep.ordinal).execution_options(populate_existing=True))).all()
    assert [(s.status, s.error["code"]) for s in steps] == [("failed", "interrupted"), ("skipped", "interrupted")]
    assert steps[0].error["message"] == proposal_executor.INTERRUPTED_RUNNING
    assert steps[1].error["message"] == proposal_executor.INTERRUPTED_LATER
    # Slow but alive: its progress is recent.
    assert (await db_session.get(Proposal, uuid.UUID(slow["id"]), populate_existing=True)).status == "executing"
    from openbinding_gateway.modules.compositions.application import upstream_watch_status

    assert (await upstream_watch_status(db_session))["executingProposals"] == 1


async def test_an_adoption_made_before_the_interruption_is_reconciled(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    from openbinding_gateway.core import revision as etags
    from openbinding_gateway.modules.compositions.application import adoption

    Clocks(monkeypatch)
    t = await tomato_team(api_client, registration, db_session, gate)
    made = await propose(api_client, t, t.member, adopt("1.1.0"))
    # The process died after adopt() committed and before the outcome was written.
    organization, composition, user = await fresh(db_session, t.found)
    environment = await db_session.scalar(select(CompositionEnvironment))
    adopted = await adoption.adopt(db_session, organization=organization, composition=composition,
                                   environment=environment, role=_role("MEMBER"), version_ref="1.1.0", actor=user,
                                   if_match=etags.etag_for(environment), source="proposal",
                                   proposal_id=uuid.UUID(made["id"]))
    ordinal = adopted.adoption.ordinal
    await _executing(db_session, made["id"], minutes_ago=30)

    await _housekeeping(db_session)

    row = await db_session.get(Proposal, uuid.UUID(made["id"]), populate_existing=True)
    (step,) = (await db_session.scalars(select(ProposalStep).where(ProposalStep.proposal_id == row.id)
                                        .execution_options(populate_existing=True))).all()
    assert step.status == "done" and step.result["ordinal"] == ordinal and step.result["reconciled"]
    # Every step done: the run is recorded as it ended, completed.
    assert row.status == "completed"


async def test_a_closure_racing_a_live_run_wins_and_stops_it(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    clocks = Clocks(monkeypatch)
    t = await tomato_team(api_client, registration, db_session, gate)
    made = await propose(api_client, t, t.member, derive_and_adopt(t.found))
    real = proposals.SEAL_DERIVED.apply

    async def then_the_watcher_closes_it(context, step, outputs):
        result = await real(context, step, outputs)
        clocks.advance(3600)
        factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
        assert await proposal_executor.close_interrupted(factory, deadline_s=600) == 1
        return result

    monkeypatch.setattr(proposals.SEAL_DERIVED, "apply", then_the_watcher_closes_it)
    versions = await _count(db_session, CompositionVersion)

    confirmed = await confirm(api_client, t, t.member, made["id"])

    body = confirmed.json()
    # The closure's account stands: the seal applied, but its outcome came too late to be written.
    assert body["status"] == "failed", confirmed.text
    assert [(s["status"], s["error"]["code"]) for s in body["steps"]] == [("failed", "interrupted"),
                                                                         ("skipped", "interrupted")]
    assert await _count(db_session, CompositionVersion) == versions + 1
    assert await _count(db_session, CompositionAdoption, CompositionAdoption.proposal_id.is_not(None)) == 0


# -- Invariant F -----------------------------------------------------------------------------------------------------


async def test_the_feed_moves_only_when_a_proposal_adopts(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    t = await tomato_team(api_client, registration, db_session, gate)
    start = await production(api_client, t)
    superseded = await propose(api_client, t, t.member, adopt("1.1.0"))
    cancelled = await propose(api_client, t, t.member, derive_and_adopt(t.found))
    assert (await api_client.delete(t.proposal(cancelled["id"]), headers=t.member)).status_code == 200
    stale = await propose(api_client, t, t.owner, derive_and_adopt(t.found))
    await api_client.patch(t.base, headers=t.owner, json={"description": "Renamed, not stale"})
    archived_meanwhile = await api_client.patch(t.base, headers=t.owner, json={"archived": True})
    assert archived_meanwhile.status_code == 200
    assert (await confirm(api_client, t, t.owner, stale["id"])).status_code == 409
    await api_client.patch(t.base, headers=t.owner, json={"archived": False})
    assert (await api_client.get(t.proposal(superseded["id"]), headers=t.member)).json()["status"] == "superseded"
    assert await production(api_client, t) == start

    completed = await propose(api_client, t, t.member, adopt("1.1.0"))
    assert (await confirm(api_client, t, t.member, completed["id"])).json()["status"] == "completed"
    moved = await production(api_client, t)
    assert moved[1] != start[1]
    adoptions = await _count(db_session, CompositionAdoption)
    assert adoptions == 2


async def test_a_run_whose_job_is_gone_is_stale(api_client, registration, db_session, gate):  # noqa: F811
    from test_composition_derive_api import SIMPLE_BINDING, composition_of

    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])
    await api_client.post(f"{base}/environments", headers=headers, json={"slug": "production", "name": "P"})
    made = (await api_client.post(f"{base}/proposals", headers=headers, json={
        "kind": "derive_and_adopt", "source": {"run": str(run.id)}, "environment": "production"})).json()
    await db_session.execute(update(Job).where(Job.id == run.id).values(state=JobState.FAILED))
    await db_session.commit()
    refused = await api_client.post(f"/v1/organizations/{linked.organization.slug}/proposals/{made['id']}/confirm",
                                    headers=headers)
    assert refused.status_code == 409 and code(refused) == "proposal_stale"
    assert {item["reason"] for item in refused.json()["detail"]["stale"]} == {"run_unreadable"}


async def _bounded_key(api_client, headers, boundary: dict) -> dict:
    made = await api_client.post("/v1/users/me/api-keys", headers=headers, json={
        "name": "bounded", "permissions": ["compositions:read", "compositions:write", "compositions:adopt"],
        "engine_access": {"all": True, "engines": []}, "boundary": boundary,
    })
    assert made.status_code == 201, made.text
    body = made.json()
    return {"X-API-Key": body["secret"]}


async def test_a_key_bounded_to_another_composition_reaches_no_proposal_of_this_one(api_client, registration, db_session, gate):  # noqa: F811
    """A proposal's own routes name only the organization and the proposal: the key's slugs are checked against the
    proposal's composition, with the same 404 as a missing proposal, and the caller's list is filtered alike."""
    t = await tomato_team(api_client, registration, db_session, gate)
    made = await propose(api_client, t, t.member, adopt("1.1.0"))
    elsewhere = await _bounded_key(api_client, t.member, {"slugs": ["other"]})
    missing = await api_client.get(t.proposal(str(uuid.uuid4())), headers=t.member)
    for method, path in (("GET", t.proposal(made["id"])), ("DELETE", t.proposal(made["id"])),
                         ("POST", f"{t.proposal(made['id'])}/confirm")):
        refused = await api_client.request(method, path, headers=elsewhere)
        assert refused.status_code == 404 and refused.json() == missing.json(), (method, path, refused.text)
    assert (await api_client.get("/v1/users/me/proposals", headers=elsewhere)).json() == {"proposals": []}
    assert (await db_session.get(Proposal, uuid.UUID(made["id"]), populate_existing=True)).status == "pending"
    reaching = await _bounded_key(api_client, t.member, {"slugs": ["tomatometer"]})
    assert [row["id"] for row in (await api_client.get("/v1/users/me/proposals", headers=reaching)).json()[
        "proposals"]] == [made["id"]]
    confirmed = await confirm(api_client, t, reaching, made["id"])
    assert confirmed.status_code == 200 and confirmed.json()["status"] == "completed", confirmed.text


async def test_a_run_interrupted_after_its_last_outcome_is_closed_completed(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    Clocks(monkeypatch)
    t = await tomato_team(api_client, registration, db_session, gate)
    made = await propose(api_client, t, t.member, adopt("1.1.0"))
    await _executing(db_session, made["id"], minutes_ago=30)
    await db_session.execute(update(ProposalStep).where(ProposalStep.proposal_id == uuid.UUID(made["id"])).values(
        status="done", result={"ordinal": 2}, finished_at=clock.utcnow()))
    await db_session.commit()

    await _housekeeping(db_session)

    assert (await db_session.get(Proposal, uuid.UUID(made["id"]), populate_existing=True)).status == "completed"


async def test_a_refused_step_leaves_the_key_readable_for_a_later_run_step(api_client, registration, db_session, gate, step_kinds, monkeypatch):  # noqa: F811
    """A refused step rolls the session back; the API key that authenticated the request is read again, so a later
    seal step from a run (which checks the key's engines) still applies. (On SQLite the key is read in another session,
    so this holds with or without the reload; the reload is for PostgreSQL's one request session.)"""
    from test_composition_derive_api import SIMPLE_BINDING, composition_of

    from openbinding_gateway.db.models import Composition, Organization, OrganizationRole, User

    revision_kind, _ = step_kinds

    async def refused(context, step, outputs):
        from openbinding_gateway.models.errors import api_error

        raise api_error(422, "recipe_invalid", "The recipe no longer applies.")

    monkeypatch.setattr(revision_kind, "apply", refused)
    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])
    await db_session.execute(update(Job).where(Job.id == run.id).values(provenance={"engine": ENGINE}))
    await db_session.commit()
    organization = await db_session.get(Organization, linked.organization.id)
    composition = await db_session.scalar(select(Composition).where(Composition.organization_id == organization.id))
    user = await db_session.get(User, linked.upload.problem.created_by_id)
    made = await proposals.create(db_session, organization, user, [
        proposals.StepRequest("test_revision", {"revision": "simple-seq@1"}),
        proposals.StepRequest("seal_derived", {"source": {"run": str(run.id)}}),
    ], role=OrganizationRole.OWNER, composition=composition)
    key = await make_key(api_client, headers, ["compositions:read", "compositions:write"])

    confirmed = await api_client.post(f"/v1/organizations/{organization.slug}/proposals/{made.id}/confirm",
                                      headers=key)

    assert confirmed.status_code == 200, confirmed.text
    assert [s["status"] for s in confirmed.json()["steps"]] == ["failed", "done"]


ENGINE = {"namespace": "openbinding", "name": "random-search", "version": "1.0.0", "digest": "sha256-" + "e" * 64}


async def test_a_run_the_key_cannot_see_is_refused_and_leaves_the_proposal_pending(api_client, registration, db_session, gate):  # noqa: F811
    """A key sees only the runs of the engines it may use: a run it cannot see is 404 at confirm, not a stale proposal
    (the same run, confirmed in the browser, applies)."""
    from test_composition_derive_api import SIMPLE_BINDING, composition_of

    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])
    await api_client.post(f"{base}/environments", headers=headers, json={"slug": "production", "name": "P"})
    made = (await api_client.post(f"{base}/proposals", headers=headers, json={
        "kind": "derive_and_adopt", "source": {"run": str(run.id)}, "environment": "production"})).json()
    url = f"/v1/organizations/{linked.organization.slug}/proposals/{made['id']}/confirm"
    key = await make_key(api_client, headers, ["compositions:read", "compositions:write", "compositions:adopt"])
    refused = await api_client.post(url, headers=key)
    assert refused.status_code == 404 and code(refused) == "not_found", refused.text
    assert (await db_session.get(Proposal, uuid.UUID(made["id"]), populate_existing=True)).status == "pending"
    confirmed = await api_client.post(url, headers=headers)
    assert confirmed.status_code == 200 and confirmed.json()["status"] == "completed", confirmed.text


# -- Transient refusals and a proposal deleted before its claim ------------------------------------------------------


@pytest.mark.parametrize("refusal", [(429, "composition_busy"), (503, "bim_unavailable")])
async def test_a_busy_or_unreachable_toolchain_at_confirm_leaves_the_proposal_pending(api_client, registration, db_session, gate, monkeypatch, refusal):  # noqa: F811
    """P5: only a base that no longer holds makes a proposal stale. A busy slot or a toolchain that does not answer
    during the pre-flight is passed on as it is; the proposal stays pending and confirms once it answers."""
    from openbinding_gateway.models.errors import api_error

    t = await tomato_team(api_client, registration, db_session, gate)
    made = await propose(api_client, t, t.member, derive_and_adopt(t.found))
    status_code, error = refusal

    async def refused(*args, **kwargs):
        raise api_error(status_code, error, "Retry in a moment.")

    monkeypatch.setattr(derive_module, "derive_version", refused)
    busy = await confirm(api_client, t, t.member, made["id"])

    assert busy.status_code == status_code and code(busy) == error, busy.text
    row = await db_session.get(Proposal, uuid.UUID(made["id"]), populate_existing=True)
    assert row.status == "pending"
    assert await _count(db_session, AuditEvent, AuditEvent.action == "composition.proposal_stale") == 0
    monkeypatch.undo()
    confirmed = await confirm(api_client, t, t.member, made["id"])
    assert confirmed.status_code == 200 and confirmed.json()["status"] == "completed", confirmed.text


async def test_a_busy_diff_serves_the_view_without_it_after_the_writes(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    """The view a create or a confirm answers with diffs each seal step's document on read; with every
    Composition2Yaml slot taken it is served with ``diff: null`` rather than a 429 that hides what was written."""
    from openbinding_gateway.models.errors import api_error
    from openbinding_gateway.modules.compositions.application import language

    async def busy(*args, **kwargs):
        raise api_error(429, "composition_busy", "Every Composition2Yaml slot of this gateway is busy; retry in a moment.")

    t = await tomato_team(api_client, registration, db_session, gate)
    monkeypatch.setattr(language, "diff", busy)
    made = await propose(api_client, t, t.member, derive_and_adopt(t.found))
    assert made["steps"][0]["preview"]["document"] and made["steps"][0]["preview"]["diff"] is None

    confirmed = await confirm(api_client, t, t.member, made["id"])
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["status"] == "completed" and confirmed.json()["steps"][0]["preview"]["diff"] is None
    read = await api_client.get(t.proposal(made["id"]), headers=t.member)
    assert read.status_code == 200 and read.json()["steps"][0]["preview"]["diff"] is None


async def _gone(session, proposal_id) -> None:
    """Delete a proposal as a concurrent composition or organization delete does: behind the session's back."""
    await session.execute(delete(ProposalStep).where(ProposalStep.proposal_id == proposal_id)
                          .execution_options(synchronize_session=False))
    await session.execute(delete(Proposal).where(Proposal.id == proposal_id).execution_options(synchronize_session=False))
    await session.commit()


@pytest.mark.parametrize("at", ["claim", "stale"])
async def test_a_proposal_deleted_before_its_claim_answers_its_404(api_client, registration, db_session, gate, step_kinds, monkeypatch, at):  # noqa: F811
    """Deleted between the pre-flight and the claim (or the stale mark): confirm answers the proposal's 404, not a
    server error, and nothing is applied."""
    t = await tomato_team(api_client, registration, db_session, gate)
    revision_kind, _ = step_kinds
    organization, composition, user = await fresh(db_session, t.found)
    made = await proposals.create(db_session, organization, user, [
        proposals.StepRequest("test_revision", {"revision": "tomatometer-email@3"}),
    ], role=_role("OWNER"), composition=composition)
    proposal_id = made.id

    async def deleted_meanwhile(context, step):
        await _gone(context.session, proposal_id)
        return [{"reason": "head_version_changed", "base": None, "current": None}] if at == "stale" else []

    monkeypatch.setattr(revision_kind, "check_base", deleted_meanwhile)
    refused = await confirm(api_client, t, t.owner, str(proposal_id))

    assert refused.status_code == 404 and code(refused) == "not_found", refused.text
    body = refused.json()
    assert (body["detail"] if isinstance(body.get("detail"), dict) else body)["error"] == "Proposal not found."
    assert await _count(db_session, AuditEvent, AuditEvent.target_id == proposal_id,
                        AuditEvent.action.in_(["composition.proposal_confirmed", "composition.proposal_stale"])) == 0


async def test_cancelling_a_proposal_deleted_meanwhile_answers_its_404(api_client, registration, db_session, gate):  # noqa: F811
    from fastapi import HTTPException

    t = await tomato_team(api_client, registration, db_session, gate)
    organization, composition, user = await fresh(db_session, t.found)
    made = await proposals.create(db_session, organization, user, [
        proposals.StepRequest("adopt", {"environment": "production", "version": "1.1.0"}),
    ], role=_role("OWNER"), composition=composition)
    await _gone(db_session, made.id)

    with pytest.raises(HTTPException) as refused:
        await proposals.cancel(db_session, made, user)

    assert refused.value.status_code == 404 and refused.value.detail["error"] == "Proposal not found."
