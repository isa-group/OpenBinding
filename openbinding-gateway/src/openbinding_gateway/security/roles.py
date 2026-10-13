"""Who may start, repeat, stop or remove work: MEMBER or above in the owning organization.

VIEWER is a read role. It reads the results of an organization (jobs, studies,
artifacts), redacted by ``security.redaction``, and nothing that costs compute
or changes state. Work that belongs to no organization (a user's own upload, a
job of their own with no ``organization_id``) is personal and needs no role.

An API key inherits the role of its user and adds its permissions on top
(``security.apikeys``): the route checks both, and neither widens the other.
"""

from __future__ import annotations

import uuid
from typing import Iterable

from fastapi import status
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import OrganizationRole, User
from ..models.errors import api_error

#: The lowest role that may launch, repeat, cancel or delete work.
WORK_ROLE = OrganizationRole.MEMBER


async def require_work_role(
    session: AsyncSession,
    user: User,
    organization_ids: Iterable[uuid.UUID | None],
) -> None:
    """Refuse (403 ``insufficient_role``) unless ``user`` may do work for these organizations.

    ``organization_ids`` are the organizations the work belongs to. Without any
    (the work is personal) there is nothing to check. With several (a snapshot
    shared by more than one project) a MEMBER role in any one of them is enough,
    as that is what grants the access. This never reveals whether a resource
    exists: callers look the resource up, and answer 404 to a non-member, first.
    """
    # Imported late, as ``security.redaction`` does: ``collaboration`` reaches the services.
    from ..collaboration import ROLE_STRENGTH, effective_role

    organizations = {value for value in organization_ids if value is not None}
    if not organizations:
        return
    for organization_id in organizations:
        role = await effective_role(session, organization_id, user)
        if role is not None and ROLE_STRENGTH[role] >= ROLE_STRENGTH[WORK_ROLE]:
            return
    raise api_error(
        status.HTTP_403_FORBIDDEN,
        "insufficient_role",
        f"Starting, repeating, cancelling or deleting work requires {WORK_ROLE.value} access to the organization.",
    )
