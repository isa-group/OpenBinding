"""An organization with every role, a composition with two declared versions, over HTTP (F4 environment tests).

Not a test module (no ``test_`` prefix). ``team`` registers an OWNER, an ADMIN, a MEMBER, a VIEWER and an outsider
(OWNER of another organization), creates the composition ``tomato`` and seals ``1.0.0`` and ``1.1.0`` (declared
values) into it; ``env`` creates an environment as the OWNER.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from _b1_helpers import make_account, make_org, put_member

YAML = {"content-type": "application/yaml"}


def declared(label: str, latency: int, candidate: str = "c1a") -> str:
    return f"""\
syntaxVersion: "1.0"
composition: tomato
version: {label}
kind: workflow
workflow:
  seq: [t1, t2]
binding:
  t1: {{candidate: {candidate}}}
  t2: {{local: true}}
values:
  latency: {{value: {latency}, unit: ms}}
"""


def code(response) -> str:
    body = response.json()
    detail = body.get("detail")
    return detail["code"] if isinstance(detail, dict) else body["code"]


@dataclass
class Team:
    org: str
    organization_id: str
    composition_id: str
    owner: dict
    admin: dict
    member: dict
    viewer: dict
    outsider: dict
    ids: dict = field(default_factory=dict)
    versions: dict = field(default_factory=dict)

    @property
    def base(self) -> str:
        return f"/v1/organizations/{self.org}/compositions/tomato"

    @property
    def environments(self) -> str:
        return f"{self.base}/environments"


async def seal(client, headers, base: str, source: str) -> dict:
    sealed = await client.post(f"{base}/versions", content=source.encode("utf-8"), headers={**headers, **YAML})
    assert sealed.status_code == 201, sealed.text
    return sealed.json()["version"]


async def team(client, registration, db_session, gate, *, versions: bool = True) -> Team:
    accounts = {}
    for name in ("owner", "admin", "member", "viewer", "outsider"):
        accounts[name] = await make_account(client, registration, db_session, gate)
    owner_headers = accounts["owner"][1]
    organization = await make_org(client, owner_headers)
    await make_org(client, accounts["outsider"][1])
    for name, role in (("admin", "ADMIN"), ("member", "MEMBER"), ("viewer", "VIEWER")):
        put = await put_member(client, owner_headers, organization["slug"], accounts[name][0]["id"], role)
        assert put.status_code in (200, 201), put.text
    created = await client.post(
        f"/v1/organizations/{organization['slug']}/compositions", headers=owner_headers,
        json={"slug": "tomato", "name": "Tomato"},
    )
    assert created.status_code == 201, created.text
    result = Team(
        org=organization["slug"], organization_id=organization["id"], composition_id=created.json()["id"],
        **{name: accounts[name][1] for name in accounts},
    )
    result.ids = {name: accounts[name][0]["id"] for name in accounts}
    result.ids.update({f"{name}_username": accounts[name][0]["username"] for name in accounts})
    if versions:
        result.versions["1.0.0"] = await seal(client, owner_headers, result.base, declared("1.0.0", 30))
        result.versions["1.1.0"] = await seal(client, owner_headers, result.base, declared("1.1.0", 20, "c1b"))
    return result


async def env(client, t: Team, slug: str = "production", **fields):
    created = await client.post(t.environments, headers=t.owner, json={"slug": slug, "name": slug.title(), **fields})
    assert created.status_code == 201, created.text
    return created


def unique() -> str:
    return uuid.uuid4().hex[:8]
