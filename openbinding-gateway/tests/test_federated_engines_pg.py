"""The plan's ``federatedEngines`` limit on a real PostgreSQL 16: owners, races, replays and rollbacks.

``test_federated_engines_limit.py`` pins the rule on SQLite, with one session. The rule there is "count the owner's
active registrations and activate", serialised by a ``SELECT ... FOR UPDATE`` on the owner's row: a promise only a
server with row locks can keep, and one SQLite cannot even state. Here several sessions on distinct connections
(``pg_backend_pid`` says so) run the real service and the real route against the migrated schema.

* **Owners and roles**: one owner's registrations are invisible to, and unchangeable by, another (the answer is
  the same 404 as for a key that does not exist); the quota is per owner and one owner's open transaction never
  makes another wait; only an administrator reviews publications.
* **Races**: two sessions activating at once never exceed the limit; the second one is seen *waiting* for the
  first one's lock (``pg_stat_activity``) and then counts its commit; a deactivation that has not committed frees
  nothing; six sessions for two places give exactly two.
* **Deduplication and idempotency**: the same document registered twice is one row; the same name and version of
  another owner is another registration that leaks nothing; activating what is active is not a second place.
* **Rollback**: an activation or a registration that fails or is rolled back leaves no active row, no half-made
  registration and no place used.

Two tests state what two concurrent *replays* answer: the caller that loses the race is given the registration the
winner made or activated, not a 402 / 409 (see docs/qa/PG_REAL_RUN.md); the tests beside them pin what must hold
whatever the answer.

Needs ``TEST_DATABASE_URL`` (the ``pg`` fixture skips without it) and nothing else: no SPACE, no network.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import func, select

from _pg_support import WAIT_SECONDS, http_client, settle
from test_engine_registry_service import (
    key_of,
    make_user,
    register,
    registration_document,
    settings_with_key,
    verifier,
)
from test_usage_limits import set_plan
from test_v1_lifecycle_rbac import (
    _builtin_engine_ref,
    _register_and_login,
    _registration_document,
)

from openbinding_gateway.db.models import EngineRegistrationRevision, User, UserRole
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.services import engines
from openbinding_gateway.services.engine_registry import (
    RegistrationKey,
    RegistryProblem,
    change_registration,
    list_registrations,
    read_registration,
)

EXHAUSTED = {"limit_id": "federatedEngines", "state": "exhausted", "unit": "engine", "source": "plan"}


# -- helpers ------------------------------------------------------------------------------------------


async def an_owner_with(pg, registrations: int, *, role: UserRole = UserRole.USER):
    """A committed user and that many committed, inactive registrations of theirs."""
    async with pg.session() as session:
        owner = await make_user(session, role)
        summaries = [await register(session, owner) for _ in range(registrations)]
        await session.commit()
    return owner.id, summaries


async def apply(session, owner_id, summary, *, action="activate", max_active=1, verify=None):
    """The service call of a request whose session the caller owns (it commits or rolls back)."""
    caller = await session.get(User, owner_id)
    return await change_registration(
        key_of(summary), caller, session, action=action, settings=settings_with_key(),
        verify=verify or verifier(), max_active=max_active,
    )


async def request(pg, owner_id, summary, *, action="activate", max_active=1, verify=None):
    """One request on a session of its own, committed with its success and rolled back with its failure (``get_session``)."""
    async with pg.session() as session:
        try:
            result = await apply(session, owner_id, summary, action=action, max_active=max_active, verify=verify)
            await session.commit()
            return result
        except BaseException:
            await session.rollback()
            raise


async def refusal_of(awaitable) -> RegistryProblem:
    with pytest.raises(RegistryProblem) as caught:
        await asyncio.wait_for(awaitable, WAIT_SECONDS)
    return caught.value


async def active_count(pg, owner_id=None) -> int:
    query = select(func.count()).select_from(EngineRegistrationRevision).where(
        EngineRegistrationRevision.is_active.is_(True)
    )
    if owner_id is not None:
        query = query.where(EngineRegistrationRevision.owner_id == owner_id)
    async with pg.session() as session:
        return int(await session.scalar(query))


async def registration_rows(pg) -> int:
    async with pg.session() as session:
        return int(await session.scalar(select(func.count()).select_from(EngineRegistrationRevision)))


def only_refusals_and_summaries(outcomes) -> None:
    strange = [item for item in outcomes if not isinstance(item, (dict, RegistryProblem))]
    assert not strange, strange


def summaries_of(outcomes) -> list:
    return [item for item in outcomes if isinstance(item, dict)]


def refusals_of(outcomes) -> list[RegistryProblem]:
    return [item for item in outcomes if isinstance(item, RegistryProblem)]


# -- races ----------------------------------------------------------------------------------------------


async def test_two_sessions_activating_at_once_never_exceed_the_limit(pg):
    owner_id, (first, second) = await an_owner_with(pg, 2)

    outcomes = await settle(
        request(pg, owner_id, first, max_active=1), request(pg, owner_id, second, max_active=1)
    )

    only_refusals_and_summaries(outcomes)
    assert len(summaries_of(outcomes)) == 1 and len(refusals_of(outcomes)) == 1, outcomes
    problem = refusals_of(outcomes)[0]
    assert (problem.status, problem.code) == (402, "quota_exceeded")
    assert problem.extra == {"quota": {**EXHAUSTED, "limit": 1, "used": 1}}
    assert await active_count(pg, owner_id) == 1


async def test_the_second_activation_is_seen_waiting_for_the_first_commit_and_then_counts_it(pg):
    owner_id, (first, second) = await an_owner_with(pg, 2)

    async with pg.session() as a, pg.session() as b:
        pid_a, pid_b = await pg.backend_pid(a), await pg.backend_pid(b)
        assert pid_a != pid_b  # two connections, two server processes
        await apply(a, owner_id, first)  # a holds the owner's row lock; its activation is not committed
        waiting = asyncio.create_task(apply(b, owner_id, second))
        await pg.wait_until_blocked(pid_b)  # observed, not assumed: b is waiting for a's lock
        assert not waiting.done()
        await a.commit()
        problem = await refusal_of(waiting)  # b woke up and counted a's committed activation
        await b.rollback()

    assert (problem.status, problem.code) == (402, "quota_exceeded")
    assert problem.extra["quota"]["used"] == 1 and problem.extra["quota"]["limit"] == 1
    assert await active_count(pg, owner_id) == 1


async def test_six_sessions_competing_for_two_places_are_given_exactly_two(pg):
    owner_id, registrations = await an_owner_with(pg, 6)

    outcomes = await settle(*(request(pg, owner_id, item, max_active=2) for item in registrations))

    only_refusals_and_summaries(outcomes)
    assert len(summaries_of(outcomes)) == 2 and len(refusals_of(outcomes)) == 4, outcomes
    assert {(item.status, item.code) for item in refusals_of(outcomes)} == {(402, "quota_exceeded")}
    assert {item.extra["quota"]["used"] for item in refusals_of(outcomes)} == {2}
    assert await active_count(pg, owner_id) == 2


async def test_a_deactivation_that_has_not_committed_frees_no_place_until_it_does(pg):
    owner_id, (first, second) = await an_owner_with(pg, 2)
    await request(pg, owner_id, first, max_active=1)

    async with pg.session() as a:
        await apply(a, owner_id, first, action="deactivate")
        await a.flush()  # the UPDATE has been sent; it is not committed
        problem = await refusal_of(request(pg, owner_id, second, max_active=1))  # deactivating takes no owner lock: no wait
        assert (problem.status, problem.code) == (402, "quota_exceeded")
        await a.commit()

    assert (await request(pg, owner_id, second, max_active=1))["active"] is True
    assert await active_count(pg, owner_id) == 1


async def test_owners_neither_wait_for_each_other_nor_share_a_quota(pg):
    x_id, (x_first, x_second) = await an_owner_with(pg, 2)
    y_id, (y_first,) = await an_owner_with(pg, 1)

    async with pg.session() as a:
        await apply(a, x_id, x_first)  # x's owner row is locked and x's activation is open
        done = await asyncio.wait_for(request(pg, y_id, y_first, max_active=1), 10)  # y does not wait for x
        assert done["active"] is True
        await a.rollback()

    assert (await active_count(pg, x_id), await active_count(pg, y_id)) == (0, 1)
    assert (await request(pg, x_id, x_second, max_active=1))["active"] is True  # x's place was never used


# -- deduplication and idempotency ------------------------------------------------------------------------


async def test_activating_what_is_active_is_not_a_second_place_across_sessions(pg):
    owner_id, (summary,) = await an_owner_with(pg, 1)

    first = await request(pg, owner_id, summary, max_active=1)
    again = await request(pg, owner_id, summary, max_active=1)

    assert first["active"] is again["active"] is True
    assert await active_count(pg, owner_id) == 1


async def test_two_concurrent_replays_of_one_activation_leave_one_active_registration(pg):
    owner_id, (summary,) = await an_owner_with(pg, 1)

    outcomes = await settle(
        request(pg, owner_id, summary, max_active=1), request(pg, owner_id, summary, max_active=1)
    )

    only_refusals_and_summaries(outcomes)
    assert summaries_of(outcomes), outcomes  # somebody got it
    assert {item.code for item in refusals_of(outcomes)} <= {"quota_exceeded"}
    assert await active_count(pg, owner_id) == 1


async def test_both_callers_of_a_replayed_activation_are_answered_with_the_active_registration(pg):
    owner_id, (summary,) = await an_owner_with(pg, 1)

    outcomes = await settle(
        request(pg, owner_id, summary, max_active=1), request(pg, owner_id, summary, max_active=1)
    )

    only_refusals_and_summaries(outcomes)
    assert [item["active"] for item in summaries_of(outcomes)] == [True, True], outcomes
    assert await active_count(pg, owner_id) == 1


async def test_the_same_document_registered_twice_is_one_registration(pg):
    async with pg.session() as session:
        owner = await make_user(session)
        document = registration_document(owner)
        first = await register(session, owner, document)
        await session.commit()
    async with pg.session() as session:
        again = await register(session, await session.get(User, owner.id), document)
        await session.commit()

    assert again["digest"] == first["digest"]
    assert await registration_rows(pg) == 1


async def test_two_sessions_registering_the_same_document_at_once_leave_one_registration(pg):
    async with pg.session() as session:
        owner = await make_user(session)
        document = registration_document(owner)
        await session.commit()

    async with pg.session() as a, pg.session() as b:
        pid_b = await pg.backend_pid(b)
        first = await register(a, await a.get(User, owner.id), document)  # inserted, not committed
        waiting = asyncio.create_task(register(b, await b.get(User, owner.id), document))
        await pg.wait_until_blocked(pid_b)  # b is stopped by the unique index, not by luck
        await a.commit()
        (second,) = await settle(waiting)
        await b.rollback()

    assert await registration_rows(pg) == 1
    assert isinstance(second, (dict, RegistryProblem)), second
    if isinstance(second, RegistryProblem):
        assert (second.status, second.code) == (409, "immutable_registration")
    else:
        assert second["digest"] == first["digest"]


async def test_the_loser_of_a_concurrent_registration_of_the_same_document_gets_the_registration(pg):
    async with pg.session() as session:
        owner = await make_user(session)
        document = registration_document(owner)
        await session.commit()

    async def register_once():
        async with pg.session() as session:
            try:
                summary = await register(session, await session.get(User, owner.id), document)
                await session.commit()
                return summary
            except BaseException:
                await session.rollback()
                raise

    outcomes = await settle(register_once(), register_once())

    only_refusals_and_summaries(outcomes)
    assert [item["digest"] for item in summaries_of(outcomes)] == [outcomes[0]["digest"]] * 2, outcomes
    assert await registration_rows(pg) == 1


async def test_the_same_name_and_version_of_another_owner_is_another_registration_and_leaks_nothing(pg):
    name = f"shared-{uuid.uuid4().hex[:8]}"
    async with pg.session() as session:
        alice, bob = await make_user(session), await make_user(session)
        mine = await register(session, alice, registration_document(alice, name=name, version="1.0.0"))
        theirs = await register(session, bob, registration_document(bob, name=name, version="1.0.0"))
        await session.commit()
    assert mine["digest"] != theirs["digest"] and await registration_rows(pg) == 2

    async with pg.session() as session:
        stranger = await session.get(User, bob.id)
        # Naming somebody else's namespace is refused up front; nothing is created.
        refused = await refusal_of(register(session, stranger, registration_document(alice, name="other", version="1.0.0")))
        assert (refused.status, refused.code) == (403, "forbidden")
        # Bob cannot read, and cannot tell it exists: the answer is that of a key that does not exist.
        unknown = RegistrationKey(mine["namespace"], mine["name"], mine["version"], "sha256-" + "0" * 64)
        existing = await refusal_of(read_registration(key_of(mine), stranger, session))
        absent = await refusal_of(read_registration(unknown, stranger, session))
        assert (existing.status, existing.code, existing.detail) == (absent.status, absent.code, absent.detail)
        assert (existing.status, existing.code) == (404, "not_found")
        listed = await list_registrations(stranger, session)
        assert [item["digest"] for item in listed["registrations"]] == [theirs["digest"]]
        await session.rollback()
    assert await registration_rows(pg) == 2


# -- auth and roles ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("action", ["activate", "deactivate", "request_publication"])
async def test_another_owner_cannot_change_my_registration_and_is_told_it_is_not_there(pg, action):
    mine_owner, (mine,) = await an_owner_with(pg, 1)
    theirs_owner, (theirs,) = await an_owner_with(pg, 1)
    absent_key = RegistrationKey(mine["namespace"], mine["name"], mine["version"], "sha256-" + "0" * 64)

    async with pg.session() as session:
        stranger = await session.get(User, theirs_owner)
        problem = await refusal_of(change_registration(
            key_of(mine), stranger, session, action=action, settings=settings_with_key(), verify=verifier(), max_active=5
        ))
        absent = await refusal_of(change_registration(
            absent_key, stranger, session, action=action, settings=settings_with_key(), verify=verifier(), max_active=5
        ))
        await session.rollback()

    assert (problem.status, problem.code, problem.detail) == (absent.status, absent.code, absent.detail)
    assert (problem.status, problem.code) == (404, "not_found")
    assert (await active_count(pg, mine_owner), await active_count(pg, theirs_owner)) == (0, 0)
    # and the quota of the stranger was not touched by the attempt: the registration of theirs activates
    assert (await request(pg, theirs_owner, theirs, max_active=1))["active"] is True


async def test_only_an_administrator_reviews_and_only_what_is_pending(pg):
    owner_id, (summary,) = await an_owner_with(pg, 1)
    admin_id, _ = await an_owner_with(pg, 0, role=UserRole.ADMIN)

    async with pg.session() as session:
        owner, admin = await session.get(User, owner_id), await session.get(User, admin_id)
        for action in ("approve", "reject"):
            forbidden = await refusal_of(change_registration(
                key_of(summary), owner, session, action=action, settings=settings_with_key(), verify=verifier()
            ))
            assert (forbidden.status, forbidden.code) == (403, "forbidden")  # not even the owner
            # An administrator reviews publication requests only: this one was never requested.
            unseen = await refusal_of(change_registration(
                key_of(summary), admin, session, action=action, settings=settings_with_key(), verify=verifier()
            ))
            assert (unseen.status, unseen.code) == (404, "not_found")
        assert (await refusal_of(list_registrations(owner, session, review=True))).status == 403
        assert (await list_registrations(admin, session, review=True))["registrations"] == []
        await session.rollback()
    assert await active_count(pg) == 0


# -- rollback ---------------------------------------------------------------------------------------------


async def test_an_activation_that_is_rolled_back_uses_no_place(pg):
    owner_id, (first, second) = await an_owner_with(pg, 2)

    async with pg.session() as session:
        await apply(session, owner_id, first)
        await session.flush()  # the UPDATE is in the transaction
        await session.rollback()

    assert await active_count(pg, owner_id) == 0
    assert (await request(pg, owner_id, second, max_active=1))["active"] is True
    assert await active_count(pg, owner_id) == 1


async def test_a_deployment_that_fails_to_verify_leaves_the_registration_pending_and_the_place_free(pg):
    owner_id, (first, second) = await an_owner_with(pg, 2)

    async def unreachable(document, credential, engine):
        raise RuntimeError("deployment unreachable")

    with pytest.raises(RuntimeError):
        await request(pg, owner_id, first, max_active=1, verify=unreachable)

    async with pg.session() as session:
        row = (await session.execute(
            select(EngineRegistrationRevision).where(EngineRegistrationRevision.manifest_digest == first["digest"])
        )).scalars().one()
        assert (row.is_active, row.verification_report["status"]) == (False, "pending")
    assert (await request(pg, owner_id, second, max_active=1))["active"] is True
    assert await active_count(pg, owner_id) == 1


async def test_a_registration_that_is_rolled_back_leaves_no_row_and_can_be_made_again(pg):
    async with pg.session() as session:
        owner = await make_user(session)
        owner_id = owner.id
        document = registration_document(owner)
        await session.commit()  # the owner must outlive the rollback; only the registration is undone
    async with pg.session() as session:
        await register(session, await session.get(User, owner_id), document)  # flushed in the transaction
        await session.rollback()
    assert await registration_rows(pg) == 0

    async with pg.session() as session:
        made = await register(session, await session.get(User, owner_id), document)
        await session.commit()
    assert made["active"] is False and await registration_rows(pg) == 1


# -- through the route ------------------------------------------------------------------------------------


async def test_over_http_the_limit_is_per_owner_and_a_refusal_changes_nothing(pg, registration, monkeypatch):
    monkeypatch.setattr(routes, "validate_endpoint", lambda endpoint, **_kwargs: None)

    async def verified(document, credential, engine_document):
        return (
            {"protocol": "bim-engine/v1", "protocolDigest": engines.protocol_digest(), "status": "verified",
             "checks": [], "durationMs": 0.0},
            {"openapi": "3.1.0", "paths": {}},
            "sha256-" + "e" * 64,
        )

    monkeypatch.setattr(routes, "_verify_registration", verified)
    alice_details, bob_details = registration(), registration()

    async with http_client(pg) as client:
        alice = await _register_and_login(client, alice_details)
        bob = await _register_and_login(client, bob_details)
        engine = await _builtin_engine_ref(client, alice)

        async def create(headers, details, version):
            name = f"deployment-{uuid.uuid4().hex[:8]}"
            created = await client.post(
                "/v1/engine-registrations", headers=headers,
                json=_registration_document(namespace=details["username"], name=name, version=version, engine=engine),
            )
            assert created.status_code == 201, created.text
            return name, {"namespace": details["username"], "version": version, "digest": created.json()["digest"]}

        (a1, a1_ref), (a2, a2_ref) = await create(alice, alice_details, "1.0.0"), await create(alice, alice_details, "2.0.0")
        b1, b1_ref = await create(bob, bob_details, "1.0.0")

        def activate(name, ref, headers=None):
            return client.post(f"/v1/engine-registrations/{name}/activate", params=ref, headers=headers or {})

        assert (await activate(a1, a1_ref, alice)).status_code == 200
        over = await activate(a2, a2_ref, alice)
        assert over.status_code == 402, over.text
        assert over.json()["code"] == "quota_exceeded"
        assert over.json()["quota"] == {**EXHAUSTED, "limit": 1, "used": 1}
        # The refusal changed nothing, and Bob's place is Bob's own.
        assert (await activate(b1, b1_ref, bob)).status_code == 200
        # Bob cannot touch Alice's registration, and Alice's is not reachable without a token.
        stranger = await activate(a2, a2_ref, bob)
        assert stranger.status_code == 404, stranger.text
        assert (await activate(a2, a2_ref)).status_code in (401, 403)

        async with pg.session() as session:
            owners = {
                row[0]: row[1]
                for row in (await session.execute(
                    select(User.username, func.count(EngineRegistrationRevision.id))
                    .join(EngineRegistrationRevision, EngineRegistrationRevision.owner_id == User.id)
                    .where(EngineRegistrationRevision.is_active.is_(True)).group_by(User.username)
                )).all()
            }
        assert owners == {alice_details["username"]: 1, bob_details["username"]: 1}

        # A plan with more room lets the second one in; the committed state agrees.
        set_plan(federatedEngines=3)
        assert (await activate(a2, a2_ref, alice)).status_code == 200
        assert await active_count(pg) == 3
