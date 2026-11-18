"""SPHERE import helpers for the problem tests: the flagship golden as an archive and its origins, and a member
with an organization (not a test module)."""

from __future__ import annotations

import uuid

from sqlalchemy import select

from _b1_helpers import make_account
from _paths import gateway_tool
from _problem_helpers import make_org
from openbinding_gateway.db.models import Organization, User

tool = gateway_tool("dump_sphere_goldens")
RUNNER = tool.Runner()


def flagship():
    """The generated ``tomatometer-email`` revision: ``Generated`` (files, origins, ...)."""
    return RUNNER.generated("tomatometer-email")


def base_archive() -> bytes:
    from openbinding_gateway.integrations.packages import zip_files

    return zip_files(RUNNER.load("tomatometer-email").base)


async def member(api_client, registration, db_session, gate):
    """A signed-in account with an organization: ``(headers, org slug, Organization, User)``."""
    account, headers = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, headers)
    organization = await db_session.scalar(select(Organization).where(Organization.slug == org))
    user = await db_session.get(User, uuid.UUID(account["id"]))
    return headers, org, organization, user
