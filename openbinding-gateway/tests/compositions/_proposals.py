"""The F6-B proposal tests' harness (not a test module): TomatoMeter as the lab seeds it with a team around it, the
request bodies, and two test-only step kinds that exercise what F6 registers no kind for (an output ``revision`` that
a later step takes, and a destructive step behind a typed phrase), as F7's kinds will.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import pytest
from pydantic import BaseModel, ConfigDict

from _b1_helpers import make_account, put_member
from openbinding_gateway.modules.compositions.application import proposals
from openbinding_gateway.modules.compositions.application import templates
from openbinding_gateway.modules.compositions.domain import proposals as domain

from ._tomatometer import Seeded, seeded


@dataclass
class Team:
    found: Seeded
    owner: dict
    member: dict
    viewer: dict
    outsider: dict
    ids: dict

    @property
    def org(self) -> str:
        return self.found.org

    @property
    def base(self) -> str:
        return f"/v1/organizations/{self.found.org}/compositions/tomatometer"

    @property
    def proposals(self) -> str:
        return f"{self.base}/proposals"

    def proposal(self, proposal_id: str) -> str:
        return f"/v1/organizations/{self.found.org}/proposals/{proposal_id}"


async def tomato_team(api_client, registration, db_session, gate, *, production: bool = True) -> Team:
    """``seeded`` (its member is the OWNER) plus a MEMBER, a VIEWER and an outsider with an organization of their own."""
    found = await seeded(api_client, registration, db_session, gate, production=production)
    accounts = {}
    for name in ("member", "viewer", "outsider"):
        accounts[name] = await make_account(api_client, registration, db_session, gate)
    for name, role in (("member", "MEMBER"), ("viewer", "VIEWER")):
        put = await put_member(api_client, found.headers, found.org, accounts[name][0]["id"], role)
        assert put.status_code in (200, 201), put.text
    ids = {name: accounts[name][0]["id"] for name in accounts}
    ids.update({f"{name}_username": accounts[name][0]["username"] for name in accounts})
    return Team(found, found.headers, accounts["member"][1], accounts["viewer"][1], accounts["outsider"][1], ids)


def spec() -> dict[str, Any]:
    return templates.template("tomatometer").composition


def derive_and_adopt(found: Seeded, *, environment: str = "production", label: str | None = None,
                     binding: dict[str, str] | None = None, revision: int | None = None, **extra) -> dict[str, Any]:
    """Derive the TomatoMeter of a binding of ``tomatometer-email`` (Resend PRO by default) and adopt it."""
    body: dict[str, Any] = {
        "kind": "derive_and_adopt",
        "source": {"revision": f"tomatometer-email@{revision or found.ids['revision']}",
                   "binding": {**spec()["binding"], **(binding or {"dailySummary": "email.resend.pro"})}},
        "offering": spec()["offering"], "environment": environment,
    }
    if label is not None:
        body["label"] = label
    return {**body, **extra}


def adopt(version: str, environment: str = "production", **extra) -> dict[str, Any]:
    return {"kind": "adopt", "environment": environment, "version": version, **extra}


def code(response) -> str:
    body = response.json()
    detail = body.get("detail")
    return detail["code"] if isinstance(detail, dict) else body["code"]


def errors(response) -> list[dict[str, Any]]:
    body = response.json()
    detail = body.get("detail") if isinstance(body.get("detail"), dict) else body
    return detail["errors"]


# -- Test-only step kinds ---------------------------------------------------------------------------------------------


class _RevisionParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: str


class RevisionKind:
    """Outputs ``revision`` (``<problem>@<revision>``) as F7's ``apply_sphere_recipe`` will, without making one: it
    names the revision it was given. ``give`` overrides what ``apply`` answers (a revision other than expected)."""

    name = "test_revision"
    params_model = _RevisionParams
    referenceable: frozenset[str] = frozenset()
    outputs = frozenset({"revision"})
    destructive = False
    key_permission = "compositions:write"
    give: str | None = None

    async def build(self, context, params, referenced, ordinal):
        return proposals.Built(params=dict(params), base={"revision": params["revision"]},
                               description=f"Make revision {params['revision']}")

    async def check_base(self, context, step):
        return []

    async def check_permission(self, context, step):
        return None

    async def check_deferred(self, context, step, outputs):
        return None

    async def apply(self, context, step, outputs):
        return {"revision": self.give or step.params["revision"]}


class _TargetParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target: str


class DestructiveKind:
    """A step that would delete ``target``: it goes alone, behind the target's name as the typed phrase."""

    name = "test_destroy"
    params_model = _TargetParams
    referenceable: frozenset[str] = frozenset()
    outputs: frozenset[str] = frozenset()
    destructive = True
    key_permission = "compositions:write"
    applied: list[str] = []

    async def build(self, context, params, referenced, ordinal):
        return proposals.Built(params=dict(params), base={}, description=f"Delete {params['target']}",
                               phrase=params["target"])

    async def check_base(self, context, step):
        return []

    async def check_permission(self, context, step):
        return None

    async def check_deferred(self, context, step, outputs):
        return None

    async def apply(self, context, step, outputs):
        DestructiveKind.applied.append(step.params["target"])
        return {"deleted": step.params["target"]}


@pytest.fixture
def step_kinds():
    revision, destroy = RevisionKind(), DestructiveKind()
    DestructiveKind.applied = []
    domain.register(revision)
    domain.register(destroy)
    try:
        yield revision, destroy
    finally:
        domain.unregister(revision.name)
        domain.unregister(destroy.name)


def new_id() -> str:
    return str(uuid.uuid4())
