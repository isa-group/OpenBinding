"""Public compositions: anybody reads them through the organization URLs, redacted to what the documents say (F2 A3).

A composition is private by default. An ADMIN makes it public, and then anybody, with no credential too, reads
it through the five read routes (the composition, its versions, a version, its content and the diff). A reader
who is not a member gets what the canonical bytes carry (values, digests, the problem's ref, the evidence's run)
and nothing else: member ids, problem, revision and compilation ids, evaluation diagnostics and violations, the
older evaluations, and lineage that names a source that is not public now. A private composition answers
exactly as a missing one, for an unknown organization too, with one body. Every other route stays for members,
and a fork from a public composition works from any organization.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any

import pytest
import yaml
from sqlalchemy import select

from _b1_helpers import gate, make_account, make_key, put_member  # noqa: F401
from _composition_helpers import Linked, OtherToolchain, bim_binding, finished_run, linked_problem
from _problem_helpers import make_org
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import AuditEvent, User
from openbinding_gateway.integrations import bim
from openbinding_gateway.security.tokens import issue_access_token

YAML = {"content-type": "application/yaml"}
SIMPLE_BINDING = {"t1": "c1a", "t2": "c2a", "t3": "c3a"}
READ_HEADERS = ("Authorization", "X-API-Key")

DECLARED = """\
syntaxVersion: "1.0"
composition: {slug}
version: {label}
kind: workflow
workflow:
  seq: [t1, t2]
binding:
  t1: {{candidate: c1a}}
  t2: {{local: true}}
values:
  trust: 0.9
  latency: {{value: {latency}, unit: ms}}
"""


def declared(slug: str, label: str = "1.0.0", latency: int = 30) -> bytes:
    return DECLARED.format(slug=slug, label=label, latency=latency).encode("utf-8")


def code(response) -> str:
    body = response.json()
    return body["detail"]["code"] if isinstance(body.get("detail"), dict) else body["code"]


@dataclass(frozen=True)
class Owner:
    """An OWNER of an organization with a problem, and the base URL of its compositions."""

    headers: dict[str, str]
    user: User
    linked: Linked

    @property
    def org(self) -> str:
        return self.linked.organization.slug

    @property
    def compositions(self) -> str:
        return f"/v1/organizations/{self.org}/compositions"


async def an_owner(api_client, registration, db_session, gate) -> Owner:  # noqa: F811
    account, headers = await make_account(api_client, registration, db_session, gate)
    user = await db_session.get(User, uuid.UUID(account["id"]))
    linked = await linked_problem(db_session, user)
    await db_session.commit()
    return Owner(headers, user, linked)


async def create(api_client, owner: Owner, slug: str, name: str | None = None) -> str:
    created = await api_client.post(
        owner.compositions, headers=owner.headers, json={"slug": slug, "name": name or slug.title()},
    )
    assert created.status_code == 201, created.text
    assert created.json()["visibility"] == "private"
    return f"{owner.compositions}/{slug}"


async def seal(api_client, headers, base: str, body: bytes) -> dict[str, Any]:
    sealed = await api_client.post(f"{base}/versions", content=body, headers={**headers, **YAML})
    assert sealed.status_code == 201, sealed.text
    return sealed.json()["version"]


async def set_visibility(api_client, headers, base: str, visibility: str):
    changed = await api_client.patch(base, headers=headers, json={"visibility": visibility})
    assert changed.status_code == 200, changed.text
    assert changed.json()["visibility"] == visibility
    return changed


async def linked_public(api_client, registration, db_session, gate):  # noqa: F811
    """An owner, and a public composition ``shop`` whose version 1.0.0 was derived from a run and evaluated by two
    toolchain releases (two evaluations, the installed one's current)."""
    owner = await an_owner(api_client, registration, db_session, gate)
    base = await create(api_client, owner, "shop", "Shop")
    run = await finished_run(db_session, owner.linked, [bim_binding(owner.linked, SIMPLE_BINDING)])
    derived = await api_client.post(f"{base}/derive", headers=owner.headers, json={"run": str(run.id), "version": "1.0.0"})
    assert derived.status_code == 201, derived.text
    with bim.bim_override(OtherToolchain(bim.get_bim())):
        again = await api_client.post(f"{base}/versions/1/evaluations", headers=owner.headers)
    assert again.status_code == 201, again.text
    await set_visibility(api_client, owner.headers, base, "public")
    return owner, base, run


def assert_redacted_version(version: dict[str, Any], owner: Owner) -> None:
    link = version["problem"]
    assert link["problem"] == {"id": None, "slug": owner.linked.upload.problem.slug, "name": None}
    assert link["revision"] == {"id": None, "revision": owner.linked.upload.revision.revision}
    assert link["linked_compilation"]["id"] is None
    assert link["linked_compilation"]["compilation_digest"] == owner.linked.compilation.compilation_digest
    assert version["created_by_id"] is None
    (evaluation,) = version["evaluations"]
    assert evaluation["current"] is True and evaluation["id"] == version["current_evaluation_id"]
    assert evaluation["diagnostics"] == [] and evaluation["violations"] == []
    assert evaluation["compilation"]["id"] is None and evaluation["compilation"]["compilation_digest"]
    assert version["values"] and version["values_status"] == "verified" and version["verified"] is True


# --------------------------------------------------------------------------- who reads


async def test_an_anonymous_caller_reads_a_public_composition_redacted(api_client, registration, db_session, gate):  # noqa: F811
    owner, base, run = await linked_public(api_client, registration, db_session, gate)
    hidden = await create(api_client, owner, "hidden")

    composition = await api_client.get(base)
    version = await api_client.get(f"{base}/versions/1")
    content = await api_client.get(f"{base}/versions/1/content")
    member = await api_client.get(f"{base}/versions/1", headers=owner.headers)
    private = await api_client.get(hidden)

    assert composition.status_code == 200, composition.text
    body = composition.json()
    assert body["visibility"] == "public" and body["created_by_id"] is None
    assert body["organization"] == {
        "id": str(owner.linked.organization.id), "slug": owner.org, "name": owner.linked.organization.name,
    }
    assert body["latest_version"]["label"] == "1.0.0" and body["version_count"] == 1
    assert version.status_code == 200, version.text
    assert_redacted_version(version.json(), owner)
    # The run the document's evidence names is public with the document; the run itself is not.
    assert content.status_code == 200, content.text
    evidence = yaml.safe_load(content.text)["evidence"]
    assert version.json()["evidence_run"] == {"id": str(run.id)} == {"id": str(evidence["run"])}
    assert (await api_client.get(f"/v1/organizations/{owner.org}/runs/{run.id}")).status_code == 401
    # A member sees everything, both evaluations included.
    full = member.json()
    assert len(full["evaluations"]) == 2 and full["created_by_id"] == str(owner.user.id)
    assert full["problem"]["problem"]["id"] == str(owner.linked.upload.problem.id)
    assert full["problem"]["problem"]["name"] == owner.linked.upload.problem.name
    assert private.status_code == 404 and code(private) == "not_found"


async def test_a_reader_who_is_not_a_member_gets_one_404_body(api_client, registration, db_session, gate):  # noqa: F811
    owner = await an_owner(api_client, registration, db_session, gate)
    hidden = await create(api_client, owner, "hidden")
    _, outsider = await make_account(api_client, registration, db_session, gate)
    missing_org = f"/v1/organizations/missing-{uuid.uuid4().hex[:8]}/compositions/hidden"
    missing = f"{owner.compositions}/nothing-here"

    for headers in ({}, outsider):
        answers = [await api_client.get(path, headers=headers) for path in (missing_org, missing, hidden)]
        assert [answer.status_code for answer in answers] == [404, 404, 404]
        assert answers[0].content == answers[1].content == answers[2].content
        assert answers[0].json()["detail"] == {"code": "not_found", "error": "Composition not found."}
        for suffix in ("/versions", "/versions/1", "/versions/1/content", "/diff"):
            assert (await api_client.get(f"{hidden}{suffix}", headers=headers)).content == answers[0].content


async def test_an_expired_or_malformed_credential_is_refused_and_never_read_as_a_visitor(
    api_client, registration, db_session, gate,  # noqa: F811
):
    owner = await an_owner(api_client, registration, db_session, gate)
    hidden = await create(api_client, owner, "hidden")
    shown = await create(api_client, owner, "shown")
    await set_visibility(api_client, owner.headers, shown, "public")
    settings = get_settings()
    expired = issue_access_token(
        settings.gateway_jwt_secret, user_id=owner.user.id, role=owner.user.role.value, ttl_seconds=-60,
        issuer=settings.gateway_jwt_issuer, audience=settings.gateway_jwt_audience,
    )

    for credential in ({"Authorization": f"Bearer {expired}"}, {"Authorization": "Bearer not-a-token"}):
        for path in (hidden, shown, f"{shown}/versions"):
            refused = await api_client.get(path, headers=credential)
            assert refused.status_code == 401, (path, refused.text)
            assert code(refused) == "unauthorized"
            assert refused.headers["WWW-Authenticate"].startswith("Bearer")


async def test_a_signed_in_non_member_reads_a_public_composition_and_a_member_reads_it_whole(
    api_client, registration, db_session, gate,  # noqa: F811
):
    owner, base, _ = await linked_public(api_client, registration, db_session, gate)
    hidden = await create(api_client, owner, "hidden")
    _, outsider = await make_account(api_client, registration, db_session, gate)
    viewer, viewer_headers = await make_account(api_client, registration, db_session, gate)
    assert (await put_member(api_client, owner.headers, owner.org, viewer["id"], "VIEWER")).status_code in (200, 201)

    redacted = await api_client.get(f"{base}/versions/1", headers=outsider)
    composition = await api_client.get(base, headers=outsider)
    private = await api_client.get(hidden, headers=outsider)
    whole = await api_client.get(f"{base}/versions/1", headers=viewer_headers)

    assert redacted.status_code == 200, redacted.text
    assert_redacted_version(redacted.json(), owner)
    assert composition.json()["created_by_id"] is None
    assert private.status_code == 404
    assert whole.status_code == 200 and len(whole.json()["evaluations"]) == 2
    assert whole.json()["created_by_id"] == str(owner.user.id)
    assert (await api_client.get(hidden, headers=viewer_headers)).status_code == 200


async def test_a_published_fork_names_a_private_source_to_nobody(api_client, registration, db_session, gate):  # noqa: F811
    # Somebody in both A and B forks A's private composition into B, and B's ADMIN publishes the fork.
    owner = await an_owner(api_client, registration, db_session, gate)
    tag = uuid.uuid4().hex[:8]
    owner.linked.organization.name = f"Origin {tag}"
    await db_session.commit()
    source = await create(api_client, owner, f"origin-{tag}", f"Secret source {tag}")
    await seal(api_client, owner.headers, source, declared(f"origin-{tag}"))
    target = await make_org(api_client, owner.headers)
    forked = await api_client.post(
        f"{source}/fork", headers=owner.headers,
        json={"version": "1", "targetOrganization": target, "slug": "copy", "name": "Copy", "description": "Mine"},
    )
    assert forked.status_code == 201, forked.text
    assert forked.json()["composition"]["visibility"] == "private"
    source_id = forked.json()["version"]["forked_from"]["compositionId"]
    fork = f"/v1/organizations/{target}/compositions/copy"
    await seal(api_client, owner.headers, fork, declared("copy", "1.1.0", latency=31))
    await set_visibility(api_client, owner.headers, fork, "public")

    async def read_all() -> list[Any]:
        answers = [
            await api_client.get(fork),
            await api_client.get(f"{fork}/versions"),
            await api_client.get(f"{fork}/versions/1"),
            await api_client.get(f"{fork}/diff"),
        ]
        assert [answer.status_code for answer in answers] == [200] * 4, [answer.text for answer in answers]
        return [answer.json() for answer in answers]

    hidden = await read_all()

    first = hidden[2]
    assert first["based_on"] is None
    assert first["forked_from"] == {
        "compositionId": None, "versionId": None, "label": None, "organization": None, "slug": None, "name": None,
        "droppedProblem": False,
    }
    text = json.dumps(hidden)
    for secret in (
        str(owner.linked.organization.id), owner.org, owner.linked.organization.name,
        source_id, f"origin-{tag}", f"Secret source {tag}",
    ):
        assert secret not in text, secret
    # The member of B still sees where it came from.
    member = (await api_client.get(f"{fork}/versions/1", headers=owner.headers)).json()
    assert member["forked_from"]["slug"] == f"origin-{tag}" and member["based_on"]["composition_id"] == source_id

    # Once A publishes its composition, the same reads name it.
    await set_visibility(api_client, owner.headers, source, "public")
    shown = (await read_all())[2]
    assert shown["based_on"] == member["based_on"]
    assert shown["forked_from"] == member["forked_from"]
    assert shown["forked_from"]["organization"] == {
        "id": str(owner.linked.organization.id), "name": owner.org, "displayName": f"Origin {tag}",
    }


async def test_the_reads_of_a_public_composition_are_revalidated_and_stop_when_it_is_private_again(
    api_client, registration, db_session, gate,  # noqa: F811
):
    owner, base, _ = await linked_public(api_client, registration, db_session, gate)
    await seal(api_client, owner.headers, base, declared("shop", "2.0.0"))

    reads = {
        "composition": await api_client.get(base),
        "versions": await api_client.get(f"{base}/versions"),
        "version": await api_client.get(f"{base}/versions/1"),
        "content": await api_client.get(f"{base}/versions/1/content"),
        "diff": await api_client.get(f"{base}/diff"),
    }
    for name, answer in reads.items():
        assert answer.status_code == 200, (name, answer.text)
        assert answer.headers["Cache-Control"] == "private, no-cache", name
        assert all(header in answer.headers["Vary"] for header in READ_HEADERS), name
    listed = reads["versions"].json()["versions"]
    assert [item["label"] for item in listed] == ["2.0.0", "1.0.0"]
    assert all(item["created_by_id"] is None for item in listed)
    assert len(listed[1]["evaluations"]) == 1 and listed[1]["evaluations"][0]["current"] is True
    assert reads["diff"].json()["to"]["label"] == "2.0.0"

    # A member's content keeps its immutable cache, and every read still varies on the credential.
    own = await api_client.get(f"{base}/versions/1/content", headers=owner.headers)
    assert own.headers["Cache-Control"] == "private, immutable"
    assert "Authorization" in own.headers["Vary"]
    tag = reads["content"].headers["ETag"]
    assert (await api_client.get(f"{base}/versions/1/content", headers={"If-None-Match": tag})).status_code == 304

    await set_visibility(api_client, owner.headers, base, "private")
    again = await api_client.get(f"{base}/versions/1/content", headers={"If-None-Match": tag})
    assert again.status_code == 404 and code(again) == "not_found"


async def test_every_other_route_stays_for_members(api_client, registration, db_session, gate):  # noqa: F811
    owner, base, run = await linked_public(api_client, registration, db_session, gate)
    _, outsider = await make_account(api_client, registration, db_session, gate)
    content = (await api_client.get(f"{base}/versions/1/content")).content

    answers = [
        await api_client.post(f"{base}/versions/check", content=content, headers={**outsider, **YAML}),
        await api_client.post(f"{base}/evaluate", headers=outsider, json={}),
        await api_client.get(f"{base}/neighborhood", headers=outsider),
        await api_client.post(f"{base}/derive", headers=outsider, json={"run": str(run.id), "version": "9.0.0"}),
        await api_client.post(f"{base}/versions/1/evaluations", headers=outsider),
        await api_client.patch(base, headers=outsider, json={"name": "Mine"}),
        await api_client.get(owner.compositions, headers=outsider),
    ]
    for answer in answers:
        assert answer.status_code == 404 and code(answer) == "not_found", answer.text

    anonymous = await api_client.post(f"{base}/versions", content=declared("shop", "3.0.0"), headers=YAML)
    assert anonymous.status_code == 401 and code(anonymous) == "unauthorized"
    assert (await api_client.delete(base)).status_code == 401


# --------------------------------------------------------------------------- visibility


async def test_an_admin_changes_the_visibility_and_a_member_cannot(api_client, registration, db_session, gate):  # noqa: F811
    owner = await an_owner(api_client, registration, db_session, gate)
    base = await create(api_client, owner, "shop")
    member, member_headers = await make_account(api_client, registration, db_session, gate)
    admin, admin_headers = await make_account(api_client, registration, db_session, gate)
    for user, role in ((member, "MEMBER"), (admin, "ADMIN")):
        assert (await put_member(api_client, owner.headers, owner.org, user["id"], role)).status_code in (200, 201)

    refused = await api_client.patch(base, headers=member_headers, json={"visibility": "public"})
    renamed = await api_client.patch(base, headers=member_headers, json={"name": "Renamed", "visibility": "private"})
    stale = await api_client.patch(base, headers={**admin_headers, "If-Match": '"stale"'}, json={"visibility": "public"})
    tag = (await api_client.get(base, headers=admin_headers)).headers["ETag"]
    published = await api_client.patch(base, headers={**admin_headers, "If-Match": tag}, json={"visibility": "public"})

    assert refused.status_code == 403 and code(refused) == "organization_forbidden"
    assert refused.json()["detail"]["error"] == "Changing visibility requires ADMIN access to the organization."
    # Sending the visibility it already has changes nothing, so a MEMBER may.
    assert renamed.status_code == 200 and renamed.json()["visibility"] == "private"
    assert stale.status_code == 412, stale.text
    assert published.status_code == 200, published.text
    assert published.json()["visibility"] == "public" and published.headers["ETag"] != tag
    audited = (await db_session.scalars(
        select(AuditEvent).where(AuditEvent.action == "composition.visibility_changed")
    )).all()
    assert len(audited) == 1
    assert audited[0].detail == {"from": "private", "to": "public"}
    assert str(audited[0].actor_id) == admin["id"]
    invalid = await api_client.patch(base, headers=admin_headers, json={"visibility": "secret"})
    assert invalid.status_code == 422


# --------------------------------------------------------------------------- fork


async def test_an_outsider_forks_a_public_composition(api_client, registration, db_session, gate):  # noqa: F811
    owner, base, _ = await linked_public(api_client, registration, db_session, gate)
    plain = await create(api_client, owner, "plain")
    await seal(api_client, owner.headers, plain, declared("plain"))
    await set_visibility(api_client, owner.headers, plain, "public")
    _, outsider = await make_account(api_client, registration, db_session, gate)
    own = await make_org(api_client, outsider)
    payload = {"version": "1", "targetOrganization": own}

    refused = await api_client.post(f"{base}/fork", headers=outsider, json=payload)
    dropped = await api_client.post(f"{base}/fork", headers=outsider, json={**payload, "dropProblem": True})
    declared_fork = await api_client.post(f"{plain}/fork", headers=outsider, json=payload)

    assert refused.status_code == 409 and code(refused) == "composition_fork_problem_unreadable"
    assert dropped.status_code == 201, dropped.text
    body = dropped.json()
    assert body["droppedProblem"] is True and body["composition"]["visibility"] == "private"
    assert body["version"]["values_status"] == "declared" and body["version"]["problem"] is None
    assert body["version"]["forked_from"]["organization"]["name"] == owner.org
    assert body["version"]["forked_from"]["slug"] == "shop"
    assert declared_fork.status_code == 201, declared_fork.text
    assert declared_fork.json()["composition"]["visibility"] == "private"
    # The forks are private: a visitor does not read them.
    assert (await api_client.get(f"/v1/organizations/{own}/compositions/shop")).status_code == 404


# --------------------------------------------------------------------------- API keys


async def bounded_key(api_client, headers, permissions: list[str], boundary: dict) -> dict[str, str]:
    response = await api_client.post(
        "/v1/users/me/api-keys",
        headers=headers,
        json={
            "name": "bounded composition key",
            "permissions": permissions,
            "engine_access": {"all": True, "engines": []},
            "boundary": boundary,
        },
    )
    assert response.status_code == 201, response.text
    return {"X-API-Key": response.json()["secret"]}


async def test_an_api_key_reads_as_its_user_and_its_boundary_still_holds(api_client, registration, db_session, gate):  # noqa: F811
    owner, base, _ = await linked_public(api_client, registration, db_session, gate)
    hidden = await create(api_client, owner, "hidden")
    _, outsider = await make_account(api_client, registration, db_session, gate)
    own = await make_org(api_client, outsider)
    unbounded = await make_key(api_client, outsider, ["compositions:read"])
    bounded = await bounded_key(
        api_client, outsider, ["compositions:read", "compositions:write"], {"organizations": [own]},
    )

    read = await api_client.get(f"{base}/versions/1", headers=unbounded)
    private = await api_client.get(hidden, headers=unbounded)
    outside = await api_client.get(base, headers=bounded)
    fork = await api_client.post(
        f"{base}/fork", headers=bounded, json={"version": "1", "targetOrganization": own, "dropProblem": True},
    )

    assert read.status_code == 200, read.text
    assert_redacted_version(read.json(), owner)
    assert private.status_code == 404 and code(private) == "not_found"
    for answer in (outside, fork):
        assert answer.status_code == 403 and code(answer) == "api_key_boundary", answer.text


# --------------------------------------------------------------------------- the anonymous budget


@pytest.fixture
def read_budget(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "work_rate_limit_read_requests", 60)
    monkeypatch.setattr(settings, "work_rate_limit_signed_in_multiplier", 1)
    monkeypatch.setattr(settings, "work_rate_limit_window_s", 3600)


async def test_only_visitors_are_charged_for_reading(api_client, registration, db_session, gate, read_budget):  # noqa: F811
    owner = await an_owner(api_client, registration, db_session, gate)
    base = await create(api_client, owner, "shop")
    await set_visibility(api_client, owner.headers, base, "public")

    visitor = [(await api_client.get(base)).status_code for _ in range(61)]
    member = [(await api_client.get(base, headers=owner.headers)).status_code for _ in range(70)]

    assert visitor == [200] * 60 + [429]
    refused = await api_client.get(f"{base}/versions")
    assert refused.status_code == 429
    assert refused.headers["content-type"].split(";")[0] == "application/json"
    assert 1 <= int(refused.headers["Retry-After"]) <= 3600
    assert refused.json()["detail"]["code"] == "rate_limit_exceeded"
    assert refused.json()["detail"]["work_class"] == "read"
    assert member == [200] * 70
