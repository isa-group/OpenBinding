"""The Engine registry service, called directly: no HTTP, no router.

``tests/test_v1_lifecycle_rbac.py`` and ``tests/test_v1_platform_contracts.py`` cover the same rules through
``/v1/engine-registrations``; these pin the service's own contract (what it raises, what it returns, what it
stores) and the properties that must hold whoever calls it: the destination policy, credentials that never
leave the store, idempotent registration, and a deployment that is down being a state and not a crash.
"""

from __future__ import annotations

import copy
import json
import logging
import socket
import threading
import uuid
from datetime import datetime
from functools import partial

import httpx
import pytest
import pytest_asyncio
from bim_core.canonical import digest
from sqlalchemy import func, select, update
from sqlalchemy.orm.attributes import set_committed_value

from _pricing import pricing_catalog

from openbinding_gateway.core.settings import Settings
from openbinding_gateway.db.models import (
    EngineCredential,
    EngineRegistrationRevision,
    ManifestPublication,
    Notification,
    User,
    UserRole,
)
from openbinding_gateway.security.secrets import CredentialStore, generate_key
from openbinding_gateway.services import engine_registry, engines
from openbinding_gateway.services.engine_registry import (
    RegistrationKey,
    RegistryProblem,
    change_registration,
    delete_registration,
    read_registration,
    register_engine,
    registration_report,
    set_credential,
    verify_registration,
)
from openbinding_gateway.v1 import remote
from openbinding_gateway.v1.remote import RemoteEngineError, fetch_remote_document

SECRET = "engine-secret-that-must-never-leave-the-store"
PUBLIC_ENDPOINT = "https://93.184.216.34"


def no_dns(endpoint: str, **_kwargs) -> tuple[str, ...]:
    """A destination validator that accepts anything: for tests about something other than the destination."""
    return ()


def settings_with_key() -> Settings:
    return Settings(federation_secret_key=generate_key())


def settings_without_key() -> Settings:
    return Settings(federation_secret_key=None, secrets_fernet_keys=None)


async def make_user(session, role: UserRole = UserRole.USER) -> User:
    account = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=role,
        plan_cache=pricing_catalog().default_plan,
    )
    session.add(account)
    await session.commit()
    return account


@pytest_asyncio.fixture
async def owner(db_session) -> User:
    return await make_user(db_session)


@pytest_asyncio.fixture
async def other(db_session) -> User:
    return await make_user(db_session)


@pytest_asyncio.fixture
async def admin(db_session) -> User:
    return await make_user(db_session, UserRole.ADMIN)


def builtin_engine() -> dict[str, str]:
    return engines.engine_ref(engines.manifest("random-search"), "bim.builtin")


def registration_document(
    owner: User,
    *,
    name: str | None = None,
    version: str = "1.0.0",
    endpoint: str = "https://solver.example",
    auth_scheme: str = "none",
    **spec_extra,
) -> dict:
    openapi = copy.deepcopy(engines.protocol_document())
    openapi["x-bim-protocol"] = "bim-engine/v1"
    openapi["x-bim-protocol-digest"] = engines.protocol_digest()
    openapi["paths"]["/health"] = {"get": {"responses": {"200": {"description": "Healthy"}}}}
    return {
        "apiVersion": "bim/v1",
        "kind": "EngineRegistration",
        "metadata": {
            "namespace": owner.username,
            "name": name or f"deployment-{uuid.uuid4().hex[:8]}",
            "version": version,
        },
        "spec": {
            "engine": builtin_engine(),
            "endpoint": endpoint,
            "protocol": {
                "id": "bim-engine/v1",
                "mediaType": "application/json",
                "digest": engines.protocol_digest(),
            },
            "mappings": {
                "request": "/internal/v1/binding-problems",
                "health": "/health",
                "openapi": "/openapi.json",
            },
            "auth": {"scheme": auth_scheme},
            "openapi": openapi,
            **spec_extra,
        },
    }


async def register(session, owner: User, document: dict | None = None, **options) -> dict:
    options.setdefault("settings", settings_with_key())
    options.setdefault("validate", no_dns)
    return await register_engine(document or registration_document(owner), owner, session, **options)


def key_of(summary: dict) -> RegistrationKey:
    return RegistrationKey(summary["namespace"], summary["name"], summary["version"], summary["digest"])


async def registration_count(session) -> int:
    return (await session.execute(select(func.count()).select_from(EngineRegistrationRevision))).scalar_one()


async def stored(session, summary: dict) -> EngineRegistrationRevision:
    return (
        await session.execute(
            select(EngineRegistrationRevision).where(EngineRegistrationRevision.manifest_digest == summary["digest"])
        )
    ).scalars().one()


def verified_report() -> dict:
    return {
        "protocol": "bim-engine/v1",
        "protocolDigest": engines.protocol_digest(),
        "status": "verified",
        "checks": [],
        "durationMs": 0.0,
    }


def verifier(seen: list | None = None):
    """A deployment check that passes and notes which credential it was given."""

    async def verify(document, credential, engine):
        if seen is not None:
            seen.append(credential)
        openapi = document["spec"]["openapi"]
        return verified_report(), openapi, digest(openapi)

    return verify


async def refused(coroutine) -> RegistryProblem:
    with pytest.raises(RegistryProblem) as caught:
        await coroutine
    return caught.value


# -- Destination policy (SSRF) -----------------------------------------------------------------------


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://127.0.0.1",
        "https://127.0.0.1:8443/engine",
        "https://10.0.0.5",
        "https://172.16.4.2",
        "https://192.168.1.10",
        "https://169.254.169.254",
        "https://[::1]",
        "https://[fe80::1]",
        "https://0.0.0.0",
        "https://224.0.0.1",
    ],
)
async def test_private_loopback_link_local_and_reserved_destinations_are_refused(db_session, owner, endpoint):
    problem = await refused(
        register(db_session, owner, registration_document(owner, endpoint=endpoint), validate=remote.validate_endpoint)
    )

    assert (problem.status, problem.code) == (422, "invalid_registration")
    assert "permitted network class" in problem.detail
    assert await registration_count(db_session) == 0


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://93.184.216.34",
        "ftp://93.184.216.34",
        "https://user:hunter2@93.184.216.34",
        "https://93.184.216.34/#fragment",
    ],
)
async def test_only_plain_https_destinations_are_accepted_by_default(db_session, owner, endpoint):
    problem = await refused(
        register(db_session, owner, registration_document(owner, endpoint=endpoint), validate=remote.validate_endpoint)
    )

    assert (problem.status, problem.code) == (422, "invalid_registration")
    assert "hunter2" not in problem.detail
    assert await registration_count(db_session) == 0


async def test_internal_http_is_only_for_internal_addresses_and_only_if_the_deployment_trusts_it(db_session, owner):
    trusting = Settings(federation_require_https=False, federation_secret_key=generate_key())

    internal = await register(
        db_session,
        owner,
        registration_document(owner, endpoint="http://10.0.0.5:8080"),
        settings=trusting,
        validate=remote.validate_endpoint,
    )
    public = await refused(
        register(
            db_session,
            owner,
            registration_document(owner, endpoint="http://93.184.216.34"),
            settings=trusting,
            validate=remote.validate_endpoint,
        )
    )
    default = await refused(
        register(
            db_session,
            owner,
            registration_document(owner, endpoint="http://10.0.0.5:8080", version="2.0.0"),
            validate=remote.validate_endpoint,
        )
    )

    assert internal["active"] is False
    assert (public.status, public.code) == (422, "invalid_registration")
    assert (default.status, default.code) == (422, "invalid_registration")
    assert await registration_count(db_session) == 1


def fake_resolver(*addresses: str):
    def getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port)) for address in addresses]

    return getaddrinfo


async def test_a_name_that_resolves_to_a_private_address_is_refused(db_session, owner, monkeypatch):
    monkeypatch.setattr(remote.socket, "getaddrinfo", fake_resolver("10.1.2.3"))

    problem = await refused(
        register(
            db_session,
            owner,
            registration_document(owner, endpoint="https://engine.example.test"),
            validate=remote.validate_endpoint,
        )
    )

    assert (problem.status, problem.code) == (422, "invalid_registration")
    assert await registration_count(db_session) == 0


async def test_one_private_address_among_public_ones_is_enough_to_refuse_the_name(db_session, owner, monkeypatch):
    monkeypatch.setattr(remote.socket, "getaddrinfo", fake_resolver("93.184.216.34", "169.254.169.254"))

    problem = await refused(
        register(
            db_session,
            owner,
            registration_document(owner, endpoint="https://engine.example.test"),
            validate=remote.validate_endpoint,
        )
    )

    assert (problem.status, problem.code) == (422, "invalid_registration")


async def test_a_name_that_does_not_resolve_is_refused(db_session, owner, monkeypatch):
    def failing(*args, **kwargs):
        raise socket.gaierror("no such host")

    monkeypatch.setattr(remote.socket, "getaddrinfo", failing)

    problem = await refused(
        register(
            db_session,
            owner,
            registration_document(owner, endpoint="https://missing.example.test"),
            validate=remote.validate_endpoint,
        )
    )

    assert (problem.status, problem.code) == (422, "invalid_registration")
    assert "cannot be resolved" in problem.detail


async def test_a_name_that_resolves_to_public_addresses_is_accepted(db_session, owner, monkeypatch):
    monkeypatch.setattr(remote.socket, "getaddrinfo", fake_resolver("93.184.216.34"))

    summary = await register(
        db_session,
        owner,
        registration_document(owner, endpoint="https://engine.example.test"),
        validate=remote.validate_endpoint,
    )

    assert (summary["status"], summary["active"]) == ("private", False)


async def test_the_destination_is_checked_off_the_event_loop(db_session, owner):
    threads: list[int] = []

    def validate(endpoint: str, **kwargs):
        threads.append(threading.get_ident())
        return ()

    await register(db_session, owner, validate=validate)

    assert len(threads) == 1
    assert threads[0] != threading.get_ident(), "the blocking getaddrinfo must not run on the event loop"


async def test_the_destination_is_validated_with_the_deployments_https_policy(db_session, owner):
    policies: list[bool] = []

    def validate(endpoint: str, *, allow_internal_http: bool = False):
        policies.append(allow_internal_http)
        return ()

    await register(db_session, owner, validate=validate)
    await register(
        db_session,
        owner,
        registration_document(owner),
        settings=Settings(federation_require_https=False, federation_secret_key=generate_key()),
        validate=validate,
    )

    assert policies == [False, True]


async def test_a_redirect_from_the_deployment_is_not_followed(owner):
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"})

    fetch = partial(fetch_remote_document, transport=httpx.MockTransport(handler))

    report, _, _ = await verify_registration(
        registration_document(owner, endpoint=PUBLIC_ENDPOINT),
        None,
        engines.manifest("random-search"),
        settings=settings_with_key(),
        fetch=fetch,
    )

    assert report["status"] == "failed"
    assert "(302)" in report["checks"][-1]["message"]
    assert requested == ["https://93.184.216.34/openapi.json"], "the redirect target must never be requested"


async def test_registration_refuses_a_document_that_embeds_a_secret_without_echoing_it(db_session, owner):
    document = registration_document(owner, extensions={"apiToken": SECRET})

    problem = await refused(register(db_session, owner, document))

    assert (problem.status, problem.code) == (422, "secret_in_document")
    assert problem.diagnostics == [
        {"code": "secret_in_document", "pointer": "/spec/extensions/apiToken", "message": "secret-like field is forbidden"}
    ]
    assert SECRET not in json.dumps([problem.detail, problem.diagnostics])
    assert await registration_count(db_session) == 0


# -- Registration: identity and idempotence ----------------------------------------------------------


async def test_registering_twice_is_idempotent(db_session, owner):
    document = registration_document(owner)

    first = await register(db_session, owner, document)
    second = await register(db_session, owner, copy.deepcopy(document))

    assert first == second
    assert set(first) == {"namespace", "name", "version", "digest", "status", "active"}
    assert (first["status"], first["active"]) == ("private", False)
    assert await registration_count(db_session) == 1
    row = await stored(db_session, first)
    assert (row.is_active, row.verification_report["status"], row.owner_id) == (False, "pending", owner.id)


async def test_the_same_version_with_other_content_is_an_immutable_registration_conflict(db_session, owner):
    document = registration_document(owner)
    await register(db_session, owner, document)
    changed = copy.deepcopy(document)
    changed["spec"]["endpoint"] = "https://another-solver.example"

    problem = await refused(register(db_session, owner, changed))

    assert (problem.status, problem.code) == (409, "immutable_registration")
    assert await registration_count(db_session) == 1


class _BlindFirstLookup:
    """A session that does not see the registration the first time it is looked up by identity.

    That is what a request sees when another one stores the same identity between its lookup and its insert:
    the lookup finds nothing, the insert meets the unique index. SQLite with one connection cannot interleave two
    requests, so the first lookup of an ``EngineRegistrationRevision`` is answered with no rows; everything else
    goes to the real session.
    """

    class _NoRows:
        def scalars(self):
            return self

        def first(self):
            return None

    def __init__(self, session) -> None:
        self._session = session
        self.hidden = 0

    def __getattr__(self, name):
        return getattr(self._session, name)

    async def execute(self, statement, *args, **kwargs):
        entities = [item.get("entity") for item in getattr(statement, "column_descriptions", [])]
        if self.hidden == 0 and entities == [EngineRegistrationRevision]:
            self.hidden += 1
            return self._NoRows()
        return await self._session.execute(statement, *args, **kwargs)


async def test_a_registration_that_loses_the_race_to_an_identical_one_gets_that_registration(db_session, owner):
    document = registration_document(owner)
    first = await register(db_session, owner, document)
    blind = _BlindFirstLookup(db_session)

    second = await register(blind, owner, copy.deepcopy(document))

    assert blind.hidden == 1  # the insert did run into the stored identity
    assert second == first
    assert await registration_count(db_session) == 1


async def test_a_registration_that_loses_the_race_to_one_with_other_content_is_still_a_conflict(db_session, owner):
    document = registration_document(owner)
    await register(db_session, owner, document)
    changed = copy.deepcopy(document)
    changed["spec"]["endpoint"] = "https://another-solver.example"
    blind = _BlindFirstLookup(db_session)

    problem = await refused(register(blind, owner, changed))

    assert blind.hidden == 1
    assert (problem.status, problem.code) == (409, "immutable_registration")
    assert await registration_count(db_session) == 1
    assert (await db_session.execute(select(EngineRegistrationRevision.endpoint))).scalar_one() == "https://solver.example"


async def test_a_registration_must_be_in_the_callers_namespace(db_session, owner, other):
    problem = await refused(register_engine(registration_document(other), owner, db_session, settings=settings_with_key(), validate=no_dns))

    assert (problem.status, problem.code) == (403, "forbidden")
    assert await registration_count(db_session) == 0


@pytest.mark.parametrize(
    ("mutation", "expected"),
    [
        (lambda d: d["spec"]["protocol"].update(digest="sha256-" + "0" * 64), (409, "protocol_digest_mismatch")),
        (lambda d: d["spec"]["openapi"].update({"x-bim-protocol-digest": "sha256-" + "1" * 64}), (409, "openapi_protocol_mismatch")),
        (lambda d: d["spec"]["engine"].update(digest="sha256-" + "2" * 64), (422, "unknown_engine")),
        (lambda d: d["spec"]["engine"].update(name="no-such-engine"), (422, "unknown_engine")),
        (lambda d: d["spec"].pop("mappings"), (422, "invalid_registration")),
    ],
)
async def test_a_registration_must_pin_the_protocol_and_an_existing_engine_revision(db_session, owner, mutation, expected):
    document = registration_document(owner)
    mutation(document)

    problem = await refused(register(db_session, owner, document))

    assert (problem.status, problem.code) == expected
    assert await registration_count(db_session) == 0


async def test_a_document_that_is_not_an_object_is_a_diagnostic(db_session, owner):
    problem = await refused(register(db_session, owner, ["not", "an", "object"]))

    assert (problem.status, problem.code) == (422, "invalid_registration")
    assert problem.diagnostics == [{"code": "document", "message": "EngineRegistration must be an object"}]


async def test_without_the_accounts_database_registering_is_unavailable(owner):
    problem = await refused(register_engine(registration_document(owner), owner, None, settings=settings_with_key(), validate=no_dns))

    assert (problem.status, problem.code) == (503, "accounts_unavailable")


# -- A deployment that is down -----------------------------------------------------------------------


async def test_a_deployment_that_is_down_is_a_failed_report_and_not_an_exception(owner):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    fetch = partial(fetch_remote_document, transport=httpx.MockTransport(handler))
    document = registration_document(owner, endpoint=PUBLIC_ENDPOINT)

    report, served, served_digest = await verify_registration(
        document, None, engines.manifest("random-search"), settings=settings_with_key(), fetch=fetch
    )

    assert report["status"] == "failed"
    assert [check["id"] for check in report["checks"]] == ["conformance"]
    assert "connection refused" in report["checks"][0]["message"]
    assert served == document["spec"]["openapi"]
    assert served_digest == digest(document["spec"]["openapi"])


async def test_a_deployment_that_answers_something_else_is_a_failed_report(owner):
    async def fetch(registration, path, **kwargs):
        return {"openapi": "3.1.0", "info": {"title": "something else", "version": "1"}, "paths": {"/": {}}}

    report, _, _ = await verify_registration(
        registration_document(owner), None, engines.manifest("random-search"), settings=settings_with_key(), fetch=fetch
    )

    assert report["status"] == "failed"
    assert "differs from the immutable document" in report["checks"][-1]["message"]


async def test_activating_a_deployment_that_is_down_leaves_it_inactive_with_the_reason(db_session, owner):
    summary = await register(db_session, owner)
    row = await stored(db_session, summary)
    row.is_active = True  # it was working: now it is down
    await db_session.flush()

    async def down(registration, path, **kwargs):
        raise RemoteEngineError("engine document request failed: connection refused")

    problem = await refused(
        change_registration(
            key_of(summary),
            owner,
            db_session,
            action="activate",
            settings=settings_with_key(),
            verify=partial(verify_registration, settings=settings_with_key(), fetch=down),
        )
    )

    assert (problem.status, problem.code) == (409, "conformance_failed")
    assert problem.diagnostics[-1]["id"] == "conformance"
    assert "connection refused" in problem.diagnostics[-1]["message"]
    row = await stored(db_session, summary)
    assert row.is_active is False
    assert row.verification_report["status"] == "failed"
    assert row.verified_at is None


# -- State changes -----------------------------------------------------------------------------------


async def test_activating_a_verified_deployment_makes_it_active_and_records_the_report(db_session, owner):
    summary = await register(db_session, owner)

    activated = await change_registration(
        key_of(summary), owner, db_session, action="activate", settings=settings_with_key(), verify=verifier()
    )

    assert activated == {**summary, "active": True}
    row = await stored(db_session, summary)
    assert row.is_active is True
    assert row.verification_report["status"] == "verified"
    # SQLite hands the timestamp back without its offset, so compare the instant and not its spelling.
    recorded = datetime.fromisoformat(row.verification_report["verifiedAt"])
    assert recorded.replace(tzinfo=None) == row.verified_at.replace(tzinfo=None)


async def test_activating_what_is_active_again_answers_the_same_and_uses_no_second_place(db_session, owner):
    summary = await register(db_session, owner)
    other_one = await register(db_session, owner)
    settings = settings_with_key()

    first = await change_registration(
        key_of(summary), owner, db_session, action="activate", settings=settings, verify=verifier(), max_active=1
    )
    again = await change_registration(
        key_of(summary), owner, db_session, action="activate", settings=settings, verify=verifier(), max_active=1
    )
    full = await refused(
        change_registration(
            key_of(other_one), owner, db_session, action="activate", settings=settings, verify=verifier(), max_active=1
        )
    )

    assert first == again == {**summary, "active": True}
    assert (full.status, full.code) == (402, "quota_exceeded")
    assert full.extra["quota"]["used"] == 1
    active = (await db_session.execute(select(func.count()).select_from(EngineRegistrationRevision).where(
        EngineRegistrationRevision.is_active.is_(True)
    ))).scalar_one()
    assert active == 1


async def test_an_activation_that_finds_its_registration_active_after_the_lock_is_a_repetition(db_session, owner):
    summary = await register(db_session, owner)
    row = await stored(db_session, summary)
    # Another request activated it after this one read it: the row in the database is active, what this one holds is not.
    await db_session.execute(
        update(EngineRegistrationRevision)
        .where(EngineRegistrationRevision.manifest_digest == summary["digest"])
        .values(is_active=True)
        .execution_options(synchronize_session=False)
    )
    set_committed_value(row, "is_active", False)

    async def unreachable(*args):
        raise AssertionError("an activation that already happened must not verify the deployment again")

    answer = await change_registration(
        key_of(summary), owner, db_session, action="activate", settings=settings_with_key(), verify=unreachable, max_active=1
    )

    assert answer == {**summary, "active": True}


async def test_only_the_owner_changes_a_registration_and_a_stranger_cannot_tell_it_exists(db_session, owner, other):
    summary = await register(db_session, owner)

    hidden = await refused(
        change_registration(key_of(summary), other, db_session, action="activate", settings=settings_with_key(), verify=verifier())
    )
    missing = await refused(
        change_registration(
            RegistrationKey(owner.username, "missing", "1.0.0", "sha256-" + "3" * 64),
            other,
            db_session,
            action="activate",
            settings=settings_with_key(),
            verify=verifier(),
        )
    )

    assert (hidden.status, hidden.code, hidden.detail) == (missing.status, missing.code, missing.detail) == (
        404,
        "not_found",
        "Engine registration not found",
    )
    assert (await stored(db_session, summary)).is_active is False


async def test_publication_needs_an_active_registration_and_an_administrator(db_session, owner, admin):
    summary = await register(db_session, owner)
    settings = settings_with_key()

    inactive = await refused(
        change_registration(key_of(summary), owner, db_session, action="request_publication", settings=settings, verify=verifier())
    )
    await change_registration(key_of(summary), owner, db_session, action="activate", settings=settings, verify=verifier())
    pending = await change_registration(
        key_of(summary), owner, db_session, action="request_publication", settings=settings, verify=verifier()
    )
    by_owner = await refused(
        change_registration(key_of(summary), owner, db_session, action="approve", settings=settings, verify=verifier())
    )
    published = await change_registration(key_of(summary), admin, db_session, action="approve", settings=settings, verify=verifier())

    assert (inactive.status, inactive.code) == (409, "registration_inactive")
    assert pending["status"] == "pending_review"
    assert (by_owner.status, by_owner.code) == (403, "forbidden")
    assert (published["status"], published["active"]) == ("published", True)
    row = await stored(db_session, summary)
    assert row.published_at is not None
    publications = (
        await db_session.execute(select(ManifestPublication).where(ManifestPublication.resource_digest == summary["digest"]))
    ).scalars().all()
    assert [(item.resource_kind, item.state) for item in publications] == [("EngineRegistration", "public")]
    notified = (await db_session.execute(select(Notification.kind, Notification.user_id))).all()
    assert notified == [("engine.publication_requested", admin.id)]


async def test_deactivating_and_rejecting_do_not_need_the_deployment(db_session, owner, admin):
    summary = await register(db_session, owner)

    async def unreachable(*args):
        raise AssertionError("the deployment must not be contacted")

    settings = settings_with_key()
    deactivated = await change_registration(
        key_of(summary), owner, db_session, action="deactivate", settings=settings, verify=unreachable
    )
    row = await stored(db_session, summary)
    row.publication_status = "pending_review"
    await db_session.flush()
    rejected = await change_registration(key_of(summary), admin, db_session, action="reject", settings=settings, verify=unreachable)

    assert deactivated["active"] is False
    assert rejected["status"] == "rejected"


async def test_an_unknown_action_is_a_programming_error(db_session, owner):
    summary = await register(db_session, owner)

    with pytest.raises(AssertionError, match="unknown EngineRegistration action"):
        await change_registration(key_of(summary), owner, db_session, action="explode", settings=settings_with_key())


async def test_deleting_removes_the_registration_and_its_credential(db_session, owner, other):
    summary = await register(db_session, owner)
    settings = settings_with_key()
    await set_credential(key_of(summary), SECRET, owner, db_session, settings=settings)

    stranger = await refused(delete_registration(key_of(summary), other, db_session))
    await delete_registration(key_of(summary), owner, db_session)

    assert (stranger.status, stranger.code) == (404, "not_found")
    assert await registration_count(db_session) == 0
    assert (await db_session.execute(select(func.count()).select_from(EngineCredential))).scalar_one() == 0


# -- Credentials -------------------------------------------------------------------------------------


async def test_a_credential_is_stored_encrypted_and_the_answer_is_only_the_summary(db_session, owner):
    summary = await register(db_session, owner, registration_document(owner, auth_scheme="bearer"))
    settings = settings_with_key()

    answer = await set_credential(key_of(summary), SECRET, owner, db_session, settings=settings)

    assert answer == summary
    credential = (await db_session.execute(select(EngineCredential))).scalars().one()
    assert SECRET not in credential.credential_encrypted
    assert SECRET not in credential.credential_ref
    assert CredentialStore.from_settings(settings).decrypt(credential.credential_encrypted) == SECRET
    assert SECRET not in json.dumps((await stored(db_session, summary)).document)
    assert credential.credential_encrypted not in json.dumps(answer)


async def test_replacing_a_credential_resets_the_registration_and_keeps_one_row(db_session, owner):
    summary = await register(db_session, owner, registration_document(owner, auth_scheme="bearer"))
    settings = settings_with_key()
    await set_credential(key_of(summary), SECRET, owner, db_session, settings=settings)
    await change_registration(key_of(summary), owner, db_session, action="activate", settings=settings, verify=verifier())
    first = (await db_session.execute(select(EngineCredential))).scalars().one().credential_encrypted

    await set_credential(key_of(summary), SECRET + "-rotated", owner, db_session, settings=settings)

    credentials = (await db_session.execute(select(EngineCredential))).scalars().all()
    assert len(credentials) == 1 and credentials[0].credential_encrypted != first
    row = await stored(db_session, summary)
    assert (row.is_active, row.publication_status, row.verified_at) == (False, "private", None)
    assert row.verification_report["status"] == "pending"


async def test_without_a_key_the_credential_is_refused_and_nothing_is_kept(db_session, owner):
    summary = await register(db_session, owner, registration_document(owner, auth_scheme="bearer"))

    problem = await refused(set_credential(key_of(summary), SECRET, owner, db_session, settings=settings_without_key()))

    assert (problem.status, problem.code) == (503, "credential_store_unavailable")
    assert SECRET not in json.dumps([problem.detail, problem.diagnostics])
    assert (await db_session.execute(select(func.count()).select_from(EngineCredential))).scalar_one() == 0


async def test_only_the_owner_sets_a_credential_and_never_on_a_published_registration(db_session, owner, other):
    summary = await register(db_session, owner, registration_document(owner, auth_scheme="bearer"))
    settings = settings_with_key()

    stranger = await refused(set_credential(key_of(summary), SECRET, other, db_session, settings=settings))
    row = await stored(db_session, summary)
    row.publication_status = "published"
    await db_session.flush()
    published = await refused(set_credential(key_of(summary), SECRET, owner, db_session, settings=settings))

    assert (stranger.status, stranger.code) == (404, "not_found")
    assert (published.status, published.code) == (409, "immutable_published_registration")
    assert (await db_session.execute(select(func.count()).select_from(EngineCredential))).scalar_one() == 0


async def test_activation_hands_the_decrypted_credential_to_the_check_and_to_nobody_else(db_session, owner):
    summary = await register(db_session, owner, registration_document(owner, auth_scheme="bearer"))
    settings = settings_with_key()
    await set_credential(key_of(summary), SECRET, owner, db_session, settings=settings)
    seen: list[str | None] = []

    activated = await change_registration(
        key_of(summary), owner, db_session, action="activate", settings=settings, verify=verifier(seen)
    )
    report = await registration_report(key_of(summary), owner, db_session)
    document = await read_registration(key_of(summary), owner, db_session)

    assert seen == [SECRET]
    ciphertext = (await db_session.execute(select(EngineCredential))).scalars().one().credential_encrypted
    for answer in (activated, report, document):
        serialized = json.dumps(answer)
        assert SECRET not in serialized
        assert ciphertext not in serialized


async def test_a_credential_that_cannot_be_decrypted_stops_the_activation_without_leaking_it(db_session, owner):
    summary = await register(db_session, owner, registration_document(owner, auth_scheme="bearer"))
    await set_credential(key_of(summary), SECRET, owner, db_session, settings=settings_with_key())

    problem = await refused(
        change_registration(
            key_of(summary), owner, db_session, action="activate", settings=settings_with_key(), verify=verifier()
        )
    )

    assert (problem.status, problem.code) == (503, "credential_store_unavailable")
    assert SECRET not in problem.detail
    assert (await stored(db_session, summary)).is_active is False


async def test_a_credential_is_never_logged(db_session, owner, caplog):
    caplog.set_level(logging.DEBUG)
    settings = settings_with_key()
    document = registration_document(owner, auth_scheme="bearer")
    summary = await register(db_session, owner, document, settings=settings)

    await set_credential(key_of(summary), SECRET, owner, db_session, settings=settings)
    await change_registration(key_of(summary), owner, db_session, action="activate", settings=settings, verify=verifier())
    await registration_report(key_of(summary), owner, db_session)
    ciphertext = (await db_session.execute(select(EngineCredential))).scalars().one().credential_encrypted
    failing = await refused(
        set_credential(key_of(summary), SECRET, owner, db_session, settings=settings_without_key())
    )

    # SQLAlchemy echoes statement parameters (the ciphertext) when the root logger is at DEBUG; that is the
    # driver's log, not the service's.  The plaintext must be nowhere, the ciphertext in no application log.
    application = [record for record in caplog.records if not record.name.startswith(("sqlalchemy", "aiosqlite"))]
    application_log = "\n".join(f"{record.getMessage()} {record.args}" for record in application)
    assert SECRET not in caplog.text
    assert SECRET not in application_log
    assert ciphertext not in application_log
    assert SECRET not in str(failing)


async def test_a_failed_check_with_a_credential_does_not_put_it_in_the_report(db_session, owner):
    summary = await register(db_session, owner, registration_document(owner, auth_scheme="bearer"))
    settings = settings_with_key()
    await set_credential(key_of(summary), SECRET, owner, db_session, settings=settings)

    async def down(registration, path, **kwargs):
        assert registration.credential == SECRET
        raise RemoteEngineError("engine document request failed: connection refused")

    problem = await refused(
        change_registration(
            key_of(summary),
            owner,
            db_session,
            action="activate",
            settings=settings,
            verify=partial(verify_registration, settings=settings, fetch=down),
        )
    )

    row = await stored(db_session, summary)
    assert SECRET not in json.dumps([problem.detail, problem.diagnostics, row.verification_report, row.openapi_document])


# -- What a reader sees ------------------------------------------------------------------------------


async def test_a_private_registration_is_invisible_to_others_and_a_published_one_carries_no_secret(
    db_session, owner, other
):
    summary = await register(db_session, owner, registration_document(owner, auth_scheme="bearer"))
    await set_credential(key_of(summary), SECRET, owner, db_session, settings=settings_with_key())

    private_read = await refused(read_registration(key_of(summary), other, db_session))
    private_report = await refused(registration_report(key_of(summary), other, db_session))
    private_listing = await engine_registry.list_registrations(other, db_session)
    row = await stored(db_session, summary)
    row.publication_status = "published"
    await db_session.flush()
    published_listing = await engine_registry.list_registrations(other, db_session)
    published_report = await registration_report(key_of(summary), other, db_session)
    published_document = await read_registration(key_of(summary), other, db_session)

    assert (private_read.status, private_read.code) == (private_report.status, private_report.code) == (404, "not_found")
    assert private_listing == {"registrations": []}
    assert published_listing == {"registrations": [{**summary, "status": "published"}]}
    assert published_report["engine"]["metadata"]["name"] == "random-search"
    assert SECRET not in json.dumps([published_listing, published_report, published_document])


async def test_publication_requests_are_listed_only_for_administrators(db_session, owner, admin):
    summary = await register(db_session, owner)
    row = await stored(db_session, summary)
    row.publication_status = "pending_review"
    await db_session.flush()

    denied = await refused(engine_registry.list_registrations(owner, db_session, review=True))
    review = await engine_registry.list_registrations(admin, db_session, review=True)
    document = await read_registration(key_of(summary), admin, db_session)

    assert (denied.status, denied.code) == (403, "forbidden")
    assert review == {"registrations": [{**summary, "status": "pending_review"}]}
    assert document["metadata"]["name"] == summary["name"]


async def test_reads_without_the_accounts_database_are_unavailable(owner):
    key = RegistrationKey(owner.username, "x", "1.0.0", "sha256-" + "4" * 64)

    problems = [
        await refused(engine_registry.list_registrations(owner, None)),
        await refused(read_registration(key, owner, None)),
        await refused(registration_report(key, owner, None)),
        await refused(change_registration(key, owner, None, action="activate", settings=settings_with_key())),
        await refused(delete_registration(key, owner, None)),
        await refused(set_credential(key, SECRET, owner, None, settings=settings_with_key())),
    ]

    assert {(problem.status, problem.code) for problem in problems} == {(503, "accounts_unavailable")}
