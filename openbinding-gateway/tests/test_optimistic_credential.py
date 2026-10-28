"""ETag / If-Match / 412 on PUT /v1/engine-registrations/{name}/credential (Problem documents, not platform errors)."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest_asyncio
from sqlalchemy import select, update

from test_v1_lifecycle_rbac import _builtin_engine_ref, _register_and_login, _registration_document

from openbinding_gateway.core import revision
from openbinding_gateway.core.settings import Settings
from openbinding_gateway.db.models import EngineCredential, EngineRegistrationRevision, utcnow
from openbinding_gateway.main import app
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.security.secrets import generate_key

PROBLEM = "application/problem+json"
FIRST = "first-secret"
SECOND = "second-secret"


@pytest_asyncio.fixture
async def lab(api_client, db_session, registration, monkeypatch):
    """One private registration of the owner, no credential stored, plus a stranger."""
    owner_details = registration()
    owner = await _register_and_login(api_client, owner_details)
    stranger = await _register_and_login(api_client, registration())
    monkeypatch.setattr(routes, "validate_endpoint", lambda endpoint, **_kwargs: None)
    monkeypatch.setattr(routes, "get_settings", lambda: Settings(federation_secret_key=generate_key()))
    engine = await _builtin_engine_ref(api_client, owner)
    name = f"cred-{uuid.uuid4().hex[:8]}"
    created = await api_client.post(
        "/v1/engine-registrations",
        headers=owner,
        json=_registration_document(
            namespace=owner_details["username"], name=name, version="1.0.0", engine=engine, auth_scheme="bearer"
        ),
    )
    assert created.status_code == 201, created.text
    await db_session.commit()
    return {
        "url": f"/v1/engine-registrations/{name}/credential",
        "params": {"namespace": owner_details["username"], "version": "1.0.0", "digest": created.json()["digest"]},
        "headers": owner,
        "stranger": stranger,
    }


async def put(client, lab, secret=FIRST, *, if_match=None, headers=None, params=None, url=None):
    sent = dict(headers or lab["headers"])
    if if_match is not None:
        sent["If-Match"] = if_match
    return await client.put(url or lab["url"], params=params or lab["params"], headers=sent, json={"secret": secret})


async def stored(db_session, lab):
    """(registration, credential or None) as the database holds them now."""
    registration = (
        await db_session.execute(
            select(EngineRegistrationRevision)
            .where(EngineRegistrationRevision.manifest_digest == lab["params"]["digest"])
            .execution_options(populate_existing=True)
        )
    ).scalars().one()
    credential = (
        await db_session.execute(
            select(EngineCredential)
            .where(EngineCredential.registration_id == registration.id)
            .execution_options(populate_existing=True)
        )
    ).scalars().first()
    return registration, credential


async def with_credential(client, db_session, lab) -> str:
    """Store the first credential, mark the registration as verified and active; return its ETag."""
    first = await put(client, lab)
    assert first.status_code == 200, first.text
    await db_session.execute(
        update(EngineRegistrationRevision)
        .where(EngineRegistrationRevision.manifest_digest == lab["params"]["digest"])
        .values(is_active=True, verification_report={"status": "passed", "checks": []})
    )
    await db_session.commit()
    return first.headers["ETag"]


def assert_problem(response, status: int, code: str) -> None:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM)
    body = response.json()
    assert body["code"] == code and body["status"] == status


async def test_first_credential_without_if_match_is_stored_and_returns_the_etag(api_client, db_session, lab) -> None:
    response = await put(api_client, lab)

    assert response.status_code == 200, response.text
    _, credential = await stored(db_session, lab)
    assert response.headers["ETag"] == revision.etag_for(credential)


async def test_first_credential_with_any_if_match_is_412_without_etag_and_stores_nothing(
    api_client, db_session, lab
) -> None:
    for header in ("*", '"0123456789abcdef0123456789abcdef"'):
        response = await put(api_client, lab, if_match=header)

        assert_problem(response, 412, "precondition_failed")
        assert "etag" not in response.headers
        _, credential = await stored(db_session, lab)
        assert credential is None


async def test_replace_with_the_matching_tag_succeeds_and_returns_a_new_one(api_client, db_session, lab) -> None:
    tag = await with_credential(api_client, db_session, lab)
    _, before = await stored(db_session, lab)
    secret_before = before.credential_encrypted

    replaced = await put(api_client, lab, SECOND, if_match=tag)

    assert replaced.status_code == 200, replaced.text
    assert replaced.headers["ETag"] != tag
    registration, after = await stored(db_session, lab)
    assert replaced.headers["ETag"] == revision.etag_for(after)
    assert after.credential_encrypted != secret_before
    assert registration.is_active is False and registration.publication_status == "private"


async def test_wildcard_replaces_an_existing_credential(api_client, db_session, lab) -> None:
    tag = await with_credential(api_client, db_session, lab)

    replaced = await put(api_client, lab, SECOND, if_match="*")

    assert replaced.status_code == 200, replaced.text
    assert replaced.headers["ETag"] != tag


async def test_stale_tag_is_412_with_the_current_etag_and_changes_nothing(api_client, db_session, lab) -> None:
    old = await with_credential(api_client, db_session, lab)
    current = (await put(api_client, lab, SECOND, if_match=old)).headers["ETag"]
    await db_session.commit()
    registration_before, credential_before = await stored(db_session, lab)
    snapshot = (
        credential_before.credential_encrypted,
        credential_before.updated_at,
        registration_before.is_active,
        registration_before.publication_status,
        registration_before.verification_report,
        registration_before.verified_at,
    )

    refused = await put(api_client, lab, "third-secret", if_match=old)

    assert_problem(refused, 412, "precondition_failed")
    assert refused.headers["ETag"] == current
    assert old not in refused.text and current not in refused.text
    registration, credential = await stored(db_session, lab)
    assert (
        credential.credential_encrypted,
        credential.updated_at,
        registration.is_active,
        registration.publication_status,
        registration.verification_report,
        registration.verified_at,
    ) == snapshot


async def test_weak_tag_never_matches(api_client, db_session, lab) -> None:
    tag = await with_credential(api_client, db_session, lab)

    refused = await put(api_client, lab, SECOND, if_match=f"W/{tag}")

    assert_problem(refused, 412, "precondition_failed")
    assert refused.headers["ETag"] == tag
    registration, _ = await stored(db_session, lab)
    assert registration.is_active is True


async def test_malformed_if_match_is_a_400_problem(api_client, db_session, lab) -> None:
    tag = await with_credential(api_client, db_session, lab)

    for header in ("not-quoted", f"*, {tag}", ""):
        refused = await put(api_client, lab, SECOND, if_match=header)

        assert_problem(refused, 400, "invalid_if_match")
        assert "etag" not in refused.headers
    _, credential = await stored(db_session, lab)
    assert revision.etag_for(credential) == tag


async def test_malformed_if_match_without_a_stored_credential_is_still_400(api_client, lab) -> None:
    assert_problem(await put(api_client, lab, if_match="not-quoted"), 400, "invalid_if_match")


async def test_wrong_owner_and_unknown_registration_are_404_before_the_precondition(
    api_client, db_session, lab
) -> None:
    tag = await with_credential(api_client, db_session, lab)

    stranger = await put(api_client, lab, SECOND, if_match=tag, headers=lab["stranger"])
    unknown = await put(api_client, lab, SECOND, if_match='"stale"', url="/v1/engine-registrations/nope/credential")
    malformed_unknown = await put(
        api_client, lab, SECOND, if_match="not-quoted", url="/v1/engine-registrations/nope/credential"
    )

    for response in (stranger, unknown, malformed_unknown):
        assert_problem(response, 404, "not_found")
        assert "etag" not in response.headers


async def test_412_comes_before_the_immutable_published_409_and_a_409_leaves_the_revision_alone(
    api_client, db_session, lab
) -> None:
    tag = await with_credential(api_client, db_session, lab)
    await db_session.execute(
        update(EngineRegistrationRevision)
        .where(EngineRegistrationRevision.manifest_digest == lab["params"]["digest"])
        .values(publication_status="published")
    )
    await db_session.commit()
    _, before = await stored(db_session, lab)
    stamp, secret = before.updated_at, before.credential_encrypted

    stale = await put(api_client, lab, SECOND, if_match='"stale"')
    conflict = await put(api_client, lab, SECOND, if_match=tag)
    plain = await put(api_client, lab, SECOND)

    assert_problem(stale, 412, "precondition_failed")
    assert stale.headers["ETag"] == tag
    # The guard had claimed the row when the 409 was decided: the claim must not stay.
    assert_problem(conflict, 409, "immutable_published_registration")
    assert_problem(plain, 409, "immutable_published_registration")
    registration, after = await stored(db_session, lab)
    assert after.updated_at == stamp and revision.etag_for(after) == tag
    assert after.credential_encrypted == secret
    assert registration.publication_status == "published"


async def test_credential_store_unavailable_after_the_claim_leaves_the_revision_alone(
    api_client, db_session, lab, monkeypatch
) -> None:
    tag = await with_credential(api_client, db_session, lab)
    _, before = await stored(db_session, lab)
    stamp = before.updated_at
    monkeypatch.setattr(routes, "get_settings", lambda: Settings())

    refused = await put(api_client, lab, SECOND, if_match=tag)

    assert_problem(refused, 503, "credential_store_unavailable")
    _, after = await stored(db_session, lab)
    assert after.updated_at == stamp and revision.etag_for(after) == tag


async def test_a_writer_that_commits_between_read_and_claim_loses(api_client, db_session, lab, monkeypatch) -> None:
    tag = await with_credential(api_client, db_session, lab)
    _, before = await stored(db_session, lab)
    secret = before.credential_encrypted
    original_execute = db_session.execute
    landed: list[bool] = []

    async def execute(statement, *args, **kwargs):
        # The other writer commits after the comparison has passed and before the claim.
        if getattr(statement, "is_update", False) and not landed:
            landed.append(True)
            await original_execute(
                update(EngineCredential)
                .where(EngineCredential.id == before.id)
                .values(updated_at=utcnow() + timedelta(days=1))
                .execution_options(synchronize_session=False)
            )
        return await original_execute(statement, *args, **kwargs)

    monkeypatch.setattr(db_session, "execute", execute)
    loser = await put(api_client, lab, "loser-secret", if_match=tag)
    monkeypatch.setattr(db_session, "execute", original_execute)

    assert landed
    assert_problem(loser, 412, "precondition_failed")
    assert loser.headers["ETag"] != tag
    registration, credential = await stored(db_session, lab)
    assert credential.credential_encrypted == secret
    assert registration.is_active is True


def test_openapi_declares_the_header_and_the_conditional_responses() -> None:
    operation = app.openapi()["paths"]["/v1/engine-registrations/{name}/credential"]["put"]

    header = next(item for item in operation["parameters"] if item["name"] == "If-Match")
    assert header["in"] == "header" and header.get("required", False) is False
    for code in ("400", "412"):
        assert PROBLEM in operation["responses"][code]["content"]
    assert "ETag" in operation["responses"]["412"]["headers"]
