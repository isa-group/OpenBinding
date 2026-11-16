"""The public compositions of every organization: ``GET /v1/compositions`` (F2 A4).

The public list and fork discovery read every ``public`` composition that is not archived and has a version,
from any organization, the most recently changed first. Anybody reads it, with no credential too; a credential
that names nobody is a 401. Only a visitor is charged, against the ``read`` class's anonymous budget. The views
carry no member id and no lineage, and the route answers in the platform JSON envelope, not problem+json.
"""

from __future__ import annotations

import uuid

import pytest

from _b1_helpers import gate, make_account, make_key  # noqa: F401
from _composition_helpers import bim_binding, finished_run, linked_problem
from _problem_helpers import make_org
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import User
from openbinding_gateway.security.tokens import issue_access_token

LIST = "/v1/compositions"
YAML = {"content-type": "application/yaml"}
SIMPLE_BINDING = {"t1": "c1a", "t2": "c2a", "t3": "c3a"}
VIEW_FIELDS = {
    "organization", "slug", "name", "description", "kind", "latest_version", "version_count", "updated_at",
}

DECLARED = """\
syntaxVersion: "1.0"
composition: {slug}
version: {label}
kind: {kind}
workflow:
  seq: [t1, t2]
binding:
  t1: {{candidate: c1a}}
  t2: {{local: true}}
values:
  latency: {{value: 30, unit: ms}}
"""


def declared(slug: str, label: str = "1.0.0", kind: str = "workflow") -> bytes:
    return DECLARED.format(slug=slug, label=label, kind=kind).encode("utf-8")


def code(response) -> str:
    body = response.json()
    return body["detail"]["code"] if isinstance(body.get("detail"), dict) else body["code"]


async def create(api_client, headers, org: str, slug: str, name: str | None = None) -> str:
    base = f"/v1/organizations/{org}/compositions"
    created = await api_client.post(base, headers=headers, json={"slug": slug, "name": name or slug.title()})
    assert created.status_code == 201, created.text
    return f"{base}/{slug}"


async def seal(api_client, headers, base: str, body: bytes) -> None:
    sealed = await api_client.post(f"{base}/versions", content=body, headers={**headers, **YAML})
    assert sealed.status_code == 201, sealed.text


async def patch(api_client, headers, base: str, **fields) -> None:
    changed = await api_client.patch(base, headers=headers, json=fields)
    assert changed.status_code == 200, changed.text


async def published(api_client, headers, org: str, slug: str, *, name: str | None = None, kind: str = "workflow",
                    versions: int = 1) -> str:
    """A public composition of ``org`` with ``versions`` declared versions."""
    base = await create(api_client, headers, org, slug, name)
    for minor in range(versions):
        await seal(api_client, headers, base, declared(slug, f"1.{minor}.0", kind))
    await patch(api_client, headers, base, visibility="public")
    return base


def slugs(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [row["slug"] for row in response.json()["compositions"]]


# --------------------------------------------------------------------------- what the list holds


async def test_the_list_holds_the_public_compositions_of_every_organization(
    api_client, registration, db_session, gate,  # noqa: F811
):
    account, owner = await make_account(api_client, registration, db_session, gate)
    user = await db_session.get(User, uuid.UUID(account["id"]))
    linked = await linked_problem(db_session, user)
    await db_session.commit()
    first = linked.organization.slug
    # A linked composition, derived from a run: its values are the toolchain's, verified.
    shop = await create(api_client, owner, first, "shop", "Shop")
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])
    derived = await api_client.post(f"{shop}/derive", headers=owner, json={"run": str(run.id), "version": "1.0.0"})
    assert derived.status_code == 201, derived.text
    await patch(api_client, owner, shop, visibility="public", description="A shop.")
    # Left out: public with no version, public and archived, private.
    empty = await create(api_client, owner, first, "empty")
    await patch(api_client, owner, empty, visibility="public")
    old = await published(api_client, owner, first, "old")
    await patch(api_client, owner, old, archived=True)
    hidden = await create(api_client, owner, first, "hidden")
    await seal(api_client, owner, hidden, declared("hidden"))
    # A second organization, of another account, with a declared composition of two versions.
    _, other = await make_account(api_client, registration, db_session, gate)
    second = await make_org(api_client, other)
    await published(api_client, other, second, "menu", name="Menu", versions=2)

    listed = await api_client.get(LIST)

    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["total"] == 2 and body["limit"] == 24 and body["offset"] == 0
    rows = {row["slug"]: row for row in body["compositions"]}
    assert set(rows) == {"shop", "menu"}
    for row in rows.values():
        assert set(row) == VIEW_FIELDS
        assert set(row["organization"]) == {"slug", "name"}
        assert set(row["latest_version"]) == {"label", "ordinal", "values_status", "verified", "created_at"}
    assert rows["shop"]["organization"] == {"slug": first, "name": linked.organization.name}
    assert rows["shop"]["description"] == "A shop."
    assert rows["shop"]["version_count"] == 1
    assert rows["shop"]["latest_version"]["label"] == "1.0.0"
    assert rows["shop"]["latest_version"]["values_status"] == "verified"
    assert rows["shop"]["latest_version"]["verified"] is True
    assert rows["menu"]["organization"] == {"slug": second, "name": second}
    assert rows["menu"]["kind"] == "workflow"
    assert rows["menu"]["version_count"] == 2
    assert rows["menu"]["latest_version"]["label"] == "1.1.0" and rows["menu"]["latest_version"]["ordinal"] == 2
    assert rows["menu"]["latest_version"]["values_status"] == "declared"
    assert rows["menu"]["latest_version"]["verified"] is False
    # No id of any kind: no member, composition, organization or version id.
    assert account["id"] not in listed.text and str(linked.organization.id) not in listed.text
    # An organization's own list shows anybody else its public compositions only (F2c G6).
    theirs = await api_client.get(f"/v1/organizations/{first}/compositions", headers=other)
    assert theirs.status_code == 200 and [row["slug"] for row in theirs.json()["compositions"]] == ["shop"]


async def test_the_list_filters_pages_and_puts_the_latest_change_first(
    api_client, registration, db_session, gate,  # noqa: F811
):
    _, owner = await make_account(api_client, registration, db_session, gate)
    acme = await make_org(api_client, owner)
    beta = await make_org(api_client, owner)
    pricing = await published(api_client, owner, acme, "pricing-flow", name="Pricing flow")
    await published(api_client, owner, acme, "checkout", name="Checkout", kind="pipeline")
    await published(api_client, owner, beta, "search", name="Search pricing", kind="system")
    # Changed last, so first.
    await patch(api_client, owner, pricing, description="Changed last.")

    assert slugs(await api_client.get(LIST)) == ["pricing-flow", "search", "checkout"]
    # `q` reads the name and the slug, in any case.
    assert slugs(await api_client.get(LIST, params={"q": "PRICING"})) == ["pricing-flow", "search"]
    assert slugs(await api_client.get(LIST, params={"q": "check"})) == ["checkout"]
    assert slugs(await api_client.get(LIST, params={"q": "%"})) == []
    assert slugs(await api_client.get(LIST, params={"kind": "pipeline"})) == ["checkout"]
    assert slugs(await api_client.get(LIST, params={"organization": beta})) == ["search"]
    assert slugs(await api_client.get(LIST, params={"organization": acme, "q": "pricing"})) == ["pricing-flow"]
    # An organization with nothing public, or none at all, is an empty page alike.
    assert slugs(await api_client.get(LIST, params={"organization": "no-such-organization"})) == []

    page = await api_client.get(LIST, params={"limit": 2})
    assert slugs(page) == ["pricing-flow", "search"] and page.json()["total"] == 3 and page.json()["limit"] == 2
    rest = await api_client.get(LIST, params={"limit": 2, "offset": 2})
    assert slugs(rest) == ["checkout"] and rest.json()["total"] == 3 and rest.json()["offset"] == 2
    # A composition made private again leaves the list at once.
    await patch(api_client, owner, pricing, visibility="private")
    assert slugs(await api_client.get(LIST)) == ["search", "checkout"]


# --------------------------------------------------------------------------- who reads it


async def test_anybody_reads_the_list_and_a_credential_that_names_nobody_is_refused(
    api_client, registration, db_session, gate,  # noqa: F811
):
    account, owner = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, owner)
    await published(api_client, owner, org, "menu")
    _, outsider = await make_account(api_client, registration, db_session, gate)

    visitor = await api_client.get(LIST)
    signed_in = await api_client.get(LIST, headers=outsider)
    key = await api_client.get(LIST, headers=await make_key(api_client, outsider, ["compositions:read"]))

    assert slugs(visitor) == slugs(signed_in) == slugs(key) == ["menu"]
    assert visitor.headers["Cache-Control"] == "private, no-cache"
    assert signed_in.headers["Cache-Control"] == "private, no-cache"
    assert {"Authorization", "X-API-Key"} <= {item.strip() for item in visitor.headers["Vary"].split(",")}
    # A key needs `compositions:read`.
    other_key = await make_key(api_client, outsider, ["problems:read"])
    refused_key = await api_client.get(LIST, headers=other_key)
    assert refused_key.status_code == 403, refused_key.text

    user = await db_session.get(User, uuid.UUID(account["id"]))
    settings = get_settings()
    expired = issue_access_token(
        settings.gateway_jwt_secret, user_id=user.id, role=user.role.value, ttl_seconds=-60,
        issuer=settings.gateway_jwt_issuer, audience=settings.gateway_jwt_audience,
    )
    for credential in ({"Authorization": f"Bearer {expired}"}, {"Authorization": "Bearer not-a-token"}):
        refused = await api_client.get(LIST, headers=credential)
        assert refused.status_code == 401, refused.text
        assert code(refused) == "unauthorized"
        assert refused.headers["WWW-Authenticate"].startswith("Bearer")


@pytest.fixture
def read_budget(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "work_rate_limit_read_requests", 60)
    monkeypatch.setattr(settings, "work_rate_limit_signed_in_multiplier", 1)
    monkeypatch.setattr(settings, "work_rate_limit_window_s", 3600)


async def test_only_visitors_are_charged_for_the_list(api_client, registration, db_session, gate, read_budget):  # noqa: F811
    _, owner = await make_account(api_client, registration, db_session, gate)

    visitor = [(await api_client.get(LIST)).status_code for _ in range(61)]
    signed_in = [(await api_client.get(LIST, headers=owner)).status_code for _ in range(70)]

    assert visitor == [200] * 60 + [429]
    refused = await api_client.get(LIST)
    assert refused.status_code == 429
    assert refused.headers["content-type"].split(";")[0] == "application/json"
    assert 1 <= int(refused.headers["Retry-After"]) <= 3600
    assert refused.json()["detail"]["code"] == "rate_limit_exceeded"
    assert refused.json()["detail"]["work_class"] == "read"
    assert signed_in == [200] * 70


# --------------------------------------------------------------------------- the envelope and the contract


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 101}, {"offset": -1}, {"kind": "galaxy"}, {"q": "x" * 161}])
async def test_a_bad_query_is_a_422_in_the_platform_envelope(api_client, params):
    refused = await api_client.get(LIST, params=params)

    assert refused.status_code == 422, refused.text
    assert refused.headers["content-type"].split(";")[0] == "application/json"
    assert refused.json()["title"] == "validation_error"


def test_the_openapi_document_declares_the_list():
    from openbinding_gateway.main import app

    operation = app.openapi()["paths"][LIST]["get"]

    assert operation["operationId"] == "listPublicCompositions"
    assert {} in operation["security"]
    assert operation["x-required-api-key-permissions"] == ["compositions:read"]
    assert list(operation["responses"]["422"]["content"]) == ["application/json"]
    assert list(operation["responses"]["429"]["content"]) == ["application/json"]
    schema = operation["responses"]["200"]["content"]["application/json"]["schema"]
    assert schema["$ref"].endswith("/PublicCompositionList")
