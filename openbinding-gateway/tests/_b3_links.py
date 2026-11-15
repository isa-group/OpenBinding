"""An organization with two problems and two compositions, one of them linking the first problem (F2b B3).

Not a test module (no ``test_`` prefix).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from _b1_helpers import make_account
from _composition_helpers import document_for, linked_problem
from _problem_helpers import problem_for
from openbinding_gateway.db.models import User

SIMPLE_BINDING = {"t1": "c1a", "t2": "c2a", "t3": "c3a"}
YAML = {"content-type": "application/yaml"}


@dataclass(frozen=True)
class Links:
    headers: dict[str, str]
    org: str
    linked: Any  # the problem a version of ``shop`` links
    other: Any  # a problem nothing links
    shop: dict[str, Any]  # a composition whose version links ``linked``
    plain: dict[str, Any]  # a composition with no version


async def an_organization_with_links(api_client, registration, db_session, gate) -> Links:
    account, headers = await make_account(api_client, registration, db_session, gate)
    user = await db_session.get(User, uuid.UUID(account["id"]))
    linked = await linked_problem(db_session, user)
    other = await problem_for(db_session, user, organization=linked.organization, slug="unlinked")
    await db_session.commit()
    org = linked.organization.slug
    base = f"/v1/organizations/{org}/compositions"
    made = {}
    for slug in ("shop", "plain"):
        created = await api_client.post(base, headers=headers, json={"slug": slug, "name": slug.title()})
        assert created.status_code == 201, created.text
        made[slug] = created.json()
    sealed = await api_client.post(
        f"{base}/shop/versions", content=document_for(linked, SIMPLE_BINDING).encode("utf-8"),
        headers={**headers, **YAML},
    )
    assert sealed.status_code == 201, sealed.text
    return Links(headers, org, linked.upload.problem, other.problem, made["shop"], made["plain"])
