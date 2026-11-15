"""createRun (``POST /v1/organizations/{org}/runs``) is idempotent per account and per canonical request."""

from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import func, select

from _pricing import roomy_plan
from _problem_helpers import revision_of, runs_url_for

from openbinding_gateway import space_client
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import BindingCase, BindingCaseRevision, Job, User
from openbinding_gateway.domain import idempotency
from openbinding_gateway.modules.execution.adapters import routes as runs_routes
from openbinding_gateway.modules.execution.application import RunRequest
from openbinding_gateway.services import job_submission
from openbinding_gateway.services.entitlements import entitlement_service
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
KEY = "idem-key-1"


async def _login(client, details):
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['access_token']}"}


async def _revision(client, headers):
    """A revision of a problem the caller uploads into an organization of their own."""
    return await revision_of(client, headers)


def _body(revision, **extra):
    return {
        "revision": revision,
        "engine": "random-search",
        "mode": "seeded",
        "optimization": OPTIMIZATION,
        **extra,
    }


async def _post(client, headers, body, key=KEY):
    return await client.post(runs_url_for(body["revision"]), headers={**headers, "Idempotency-Key": key}, json=body)


async def _job_count(db_session):
    return (await db_session.execute(select(func.count()).select_from(Job))).scalar_one()


@pytest.fixture
def no_dispatch(monkeypatch):
    async def queued(*args, **kwargs):
        return None

    monkeypatch.setattr(runs_routes, "dispatch_persisted_job", queued)


@pytest.fixture
async def account(api_client, registration, no_dispatch):
    headers = await _login(api_client, registration())
    return headers, await _revision(api_client, headers)


async def test_same_key_and_body_replays_the_same_job(api_client, db_session, account):
    headers, revision = account
    first = await _post(api_client, headers, _body(revision))
    second = await _post(api_client, headers, _body(revision))

    assert first.status_code == 202, first.text
    assert second.status_code == 202, second.text
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["idempotent"] is True
    assert "idempotent" not in first.json()
    assert await _job_count(db_session) == 1
    stored = (await db_session.execute(select(Job))).scalars().one()
    assert idempotency.is_request_fingerprint(stored.idempotency_fingerprint)
    assert len(stored.idempotency_fingerprint) == 74


async def test_same_key_with_a_different_body_conflicts(api_client, db_session, account):
    headers, revision = account
    body = _body(revision, engine="evolutionary-heuristics", mode="elitist-genetic")
    first = await _post(api_client, headers, {**body, "options": {"max_evaluations": 100}})
    changed = await _post(api_client, headers, {**body, "options": {"max_evaluations": 200}})

    assert first.status_code == 202, first.text
    assert changed.status_code == 409, changed.text
    assert changed.json()["title"] == "idempotency_conflict"
    assert await _job_count(db_session) == 1


async def test_plan_clamping_is_not_part_of_the_fingerprint(api_client, db_session, account, monkeypatch):
    headers, revision = account
    real = entitlement_service.clamp_options
    calls = []

    def clamp(options, caps):
        calls.append(1)
        clamped = real(options, caps)
        if len(calls) > 1:
            clamped.options["iterations"] = 1
        return clamped

    monkeypatch.setattr(entitlement_service, "clamp_options", clamp)
    first = await _post(api_client, headers, _body(revision))
    second = await _post(api_client, headers, _body(revision))

    assert second.status_code == 202, second.text
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["idempotent"] is True
    assert len(calls) == 1
    assert await _job_count(db_session) == 1


async def test_a_key_shared_by_two_accounts_is_independent(api_client, db_session, registration, no_dispatch):
    alice = await _login(api_client, registration())
    bob = await _login(api_client, registration())
    alice_revision = await _revision(api_client, alice)
    bob_revision = await _revision(api_client, bob)

    first = await _post(api_client, alice, _body(alice_revision))
    second = await _post(api_client, bob, _body(bob_revision))

    assert first.status_code == 202, first.text
    assert second.status_code == 202, second.text
    assert second.json()["id"] != first.json()["id"]
    assert "idempotent" not in second.json()
    assert await _job_count(db_session) == 2
    assert (await api_client.get(f"{runs_url_for(alice_revision)}/{first.json()['id']}", headers=bob)).status_code == 404
    assert (await api_client.get(f"{runs_url_for(bob_revision)}/{second.json()['id']}", headers=alice)).status_code == 404


@pytest.mark.parametrize("engine", ["auto", "no-such-engine"])
async def test_engines_that_are_not_installed_are_refused_without_a_job(api_client, db_session, account, engine):
    headers, revision = account
    response = await _post(api_client, headers, _body(revision, engine=engine))

    assert response.status_code == 422, response.text
    assert response.json()["title"] == "immutable_engine_required"
    assert await _job_count(db_session) == 0


def _hide_from_first_lookups(monkeypatch, hidden):
    """Make the first `hidden` idempotency lookups miss, as if the winner had not committed yet."""
    real = job_submission._find_idempotent_job
    seen = []

    async def find(session, owner_id, key):
        seen.append(key)
        if len(seen) <= hidden:
            return None
        return await real(session, owner_id, key)

    monkeypatch.setattr(job_submission, "_find_idempotent_job", find)


async def test_losing_the_job_insert_race_returns_a_replay(
    api_client, db_session, account, monkeypatch
):
    headers, revision = account
    # This test is about the INSERT race, which a second job must reach. The default plan allows one job
    # at a time and that limit now applies (plan ``maxConcurrentRuns``), so the account gets a roomier plan.
    space_client.get_gate().plans[await db_session.scalar(select(User.id))] = roomy_plan()
    first = await _post(api_client, headers, _body(revision))
    assert first.status_code == 202, first.text

    # Misses the pre-check and the check after the account lock; only the INSERT notices the winner.
    _hide_from_first_lookups(monkeypatch, 2)
    loser = await _post(api_client, headers, _body(revision))

    assert loser.status_code == 202, loser.text
    assert loser.json()["id"] == first.json()["id"]
    assert loser.json()["idempotent"] is True
    assert await _job_count(db_session) == 1


async def test_a_request_waiting_on_the_account_lock_gets_a_replay_not_a_429(
    api_client, db_session, account, monkeypatch
):
    headers, revision = account
    first = await _post(api_client, headers, _body(revision))
    assert first.status_code == 202, first.text

    # The winner's job holds the account's only slot, so a new job would be refused.
    monkeypatch.setattr(get_settings(), "max_concurrent_jobs_per_user", 1)
    # The pre-check misses, as if the winner had not committed when the request arrived;
    # the lookup after the account lock sees it and answers with the replay.
    _hide_from_first_lookups(monkeypatch, 1)
    waited = await _post(api_client, headers, _body(revision))

    assert waited.status_code == 202, waited.text
    assert waited.json()["id"] == first.json()["id"]
    assert waited.json()["idempotent"] is True
    assert await _job_count(db_session) == 1


async def test_a_replay_with_the_limit_reached_returns_the_existing_job(api_client, db_session, account, monkeypatch):
    headers, revision = account
    monkeypatch.setattr(get_settings(), "max_concurrent_jobs_per_user", 1)
    first = await _post(api_client, headers, _body(revision))
    replay = await _post(api_client, headers, _body(revision))

    assert first.status_code == replay.status_code == 202, replay.text
    assert replay.json()["id"] == first.json()["id"]
    assert replay.json()["idempotent"] is True
    assert await _job_count(db_session) == 1


async def test_clients_cannot_claim_the_study_cell_key_prefix(api_client, db_session, account):
    headers, revision = account
    response = await _post(api_client, headers, _body(revision), key="study-cell:" + "0" * 8)

    assert response.status_code == 422, response.text
    assert response.json()["title"] == "reserved_idempotency_key"
    assert await _job_count(db_session) == 0


async def test_study_launches_replay_with_an_idempotency_key(api_client, db_session, account):
    # A study cell launch hands the submission a typed RunRequest (no HTTP request); its key replays too.
    headers, revision = account
    user = (await db_session.execute(select(User))).scalars().one()
    organization_id = await db_session.scalar(
        select(BindingCase.organization_id)
        .join(BindingCaseRevision, BindingCaseRevision.binding_case_id == BindingCase.id)
        .where(BindingCaseRevision.id == uuid.UUID(revision))
    )
    request = RunRequest.from_document(organization_id, _body(revision), idempotency_key="study-launch-1")

    first = await job_submission.JobSubmission(db_session, user).submit(request)
    second = await job_submission.JobSubmission(db_session, user).submit(request)

    assert (first.kind, second.kind) == ("created", "replay")
    assert second.body["id"] == first.body["id"]
    assert second.body["idempotent"] is True
    assert await _job_count(db_session) == 1
    json.dumps(second.body)


# -- Run presets --------------------------------------------------------------


def _presets_url(revision):
    return runs_url_for(revision).replace("/runs", "/presets")


async def _preset(client, headers, revision, slug="quick", **settings):
    body = {"slug": slug, "name": slug.title(), "engine": "random-search", "mode": "seeded",
            "optimization": OPTIMIZATION, "options": {"seed": 3}, **settings}
    created = await client.post(_presets_url(revision), headers=headers, json=body)
    assert created.status_code == 201, created.text
    return created.json()


async def test_a_run_from_a_preset_replays_while_the_preset_is_unchanged(api_client, db_session, account):
    headers, revision = account
    preset = await _preset(api_client, headers, revision)
    first = await _post(api_client, headers, {"revision": revision, "preset": "quick"})
    again = await _post(api_client, headers, {"revision": revision, "preset": preset["id"]})

    assert first.status_code == again.status_code == 202, again.text
    assert again.json()["id"] == first.json()["id"] and again.json()["idempotent"] is True
    stored = (await db_session.execute(select(Job))).scalars().one()
    assert stored.original_request["preset"] == stored.provenance["preset"] == {"id": preset["id"], "slug": "quick"}
    assert stored.provenance["requestedOptions"] == {"seed": 3}


async def test_retrying_after_the_preset_changed_is_an_idempotency_conflict(api_client, db_session, account):
    headers, revision = account
    await _preset(api_client, headers, revision)
    first = await _post(api_client, headers, {"revision": revision, "preset": "quick"})
    edited = await api_client.patch(f"{_presets_url(revision)}/quick", headers=headers, json={"options": {"seed": 4}})
    retried = await _post(api_client, headers, {"revision": revision, "preset": "quick"})

    assert first.status_code == 202 and edited.status_code == 200, edited.text
    # The same key would now run something else.
    assert retried.status_code == 409, retried.text
    assert retried.json()["title"] == "idempotency_conflict"
    assert await _job_count(db_session) == 1
    stored = (await db_session.execute(select(Job))).scalars().one()
    assert stored.provenance["requestedOptions"] == {"seed": 3}


async def test_a_preset_beside_settings_or_unknown_is_a_422_without_a_job(api_client, db_session, account):
    headers, revision = account
    await _preset(api_client, headers, revision)

    mixed = await _post(api_client, headers, {"revision": revision, "preset": "quick", "mode": "seeded"})
    unknown = await _post(api_client, headers, {"revision": revision, "preset": "nothing-here"}, key="other")
    malformed = await _post(api_client, headers, {"revision": revision, "preset": ""}, key="third")

    assert mixed.status_code == unknown.status_code == malformed.status_code == 422
    assert mixed.json()["title"] == "preset_with_settings"
    assert unknown.json()["title"] == "preset_not_found"
    assert malformed.json()["title"] == "invalid_request_fields"
    assert await _job_count(db_session) == 0
