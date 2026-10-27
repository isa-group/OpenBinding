"""Read-only access to public projects for people who are not members.

``public_read`` is an *access level*, not a membership role: it never appears as
an ``OrganizationRole`` and never grants anything but GET on the routes listed
in ``PUBLIC_READ_ALLOWED``. The rest of the project API stays deny-by-default:

* A request is *eligible* only when its method is GET and its route template is
  in ``PUBLIC_READ_ALLOWED``. Writes, ``PUBLIC_READ_DENIED_GET`` and any route
  added later without being listed are never eligible.
* ``get_current_user`` binds the eligibility of the current request to its
  session (``bind``). Eligible requests may be anonymous (Explore is already
  served without a session); every other request without credentials is still
  a 401.
* ``collaboration.require_project`` is the only place that turns eligibility
  into access (``admit_public_project``): the caller must not be a member, the
  project must be public, and the caller's rate window must have room. Anything
  else falls through to the usual membership check, so a private project, a
  denied route and a write answer exactly as they did before.
* Handlers whose data is only partly public (reports, publications, files,
  library) ask ``is_public_read(session)`` and narrow what they return.

Reads are counted against the *caller* (the account, or the client address when
anonymous) and never against the sponsor of the project: nothing here touches
the sponsor's quota.
"""

from __future__ import annotations

import math
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from fastapi import Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import get_settings
from ..models.errors import api_error

PROJECT = "/v1/organizations/{org}/projects/{project}"

#: Level reported to the client when a non-member reads a public project.
PUBLIC_READ = "public_read"

#: GET routes a non-member may call on a PUBLIC project. Value: what is shown.
PUBLIC_READ_ALLOWED: dict[str, str] = {
    PROJECT: "Public project metadata (the creator is not disclosed).",
    f"{PROJECT}/cases": "Binding cases.",
    f"{PROJECT}/cases/{{case}}": "A binding case.",
    f"{PROJECT}/cases/{{case}}/revisions": "Sealed case revisions (and, through them, their snapshot digests).",
    f"{PROJECT}/cases/{{case}}/revisions/{{revision}}": "One sealed case revision.",
    f"{PROJECT}/collections": "Collections.",
    f"{PROJECT}/collections/{{collection}}": "A collection.",
    f"{PROJECT}/collections/{{collection}}/revisions": "Collection revisions.",
    f"{PROJECT}/collections/{{collection}}/revisions/{{revision}}": "One collection revision.",
    f"{PROJECT}/resources": "Project resources.",
    f"{PROJECT}/resources/{{resource}}/revisions": "Resource revisions.",
    f"{PROJECT}/studies": "Studies.",
    f"{PROJECT}/studies/{{study}}/runs": "Study runs.",
    f"{PROJECT}/studies/{{study}}/runs/{{run_id}}/cells": "Run cells.",
    f"{PROJECT}/studies/{{study}}/runs/{{run_id}}/cells/{{cell_id}}": "One run cell.",
    f"{PROJECT}/studies/{{study}}/runs/{{run_id}}/analytics": "Run analytics.",
    f"{PROJECT}/reports": "Reports, only frozen ones with a live publication (never drafts).",
    f"{PROJECT}/publications": "Publications that have not been withdrawn.",
    f"{PROJECT}/blobs": "The file list, only files marked public.",
    f"{PROJECT}/blobs/{{digest_value}}": "File download, only files marked public.",
}

#: GET routes that stay closed to non-members even on public projects.
PUBLIC_READ_DENIED_GET: dict[str, str] = {
    f"{PROJECT}/jobs": "Jobs and their history (they carry requests, options and results of members).",
    f"{PROJECT}/package": "Package export (a full copy, including private files and drafts).",
}


def eligible(method: str, template: str) -> bool:
    """Whether the matrix allows a non-member to call this route on a public project."""

    return method.upper() == "GET" and template in PUBLIC_READ_ALLOWED


class AnonymousCaller:
    """The caller of an eligible request that carried no credential.

    It is only ever produced for routes in ``PUBLIC_READ_ALLOWED`` (GET), so
    nothing that writes can receive it. It owns nothing and is nobody's member.
    """

    id = None
    username = "anonymous"
    email = None
    preferences: dict[str, Any] = {}
    is_active = True
    is_admin = False
    is_anonymous = True
    _authenticated_api_key = None


ANONYMOUS = AnonymousCaller()


def is_anonymous(user: Any) -> bool:
    return bool(getattr(user, "is_anonymous", False))


@dataclass
class ReadGrant:
    """What the current request may do as a non-member, and whether it did."""

    caller_key: str
    template: str
    project_id: uuid.UUID | None = None
    used: bool = field(default=False)


_KEY = "openbinding.public_read"


def route_template(request: Request) -> str:
    route = request.scope.get("route")
    return str(getattr(route, "path", request.url.path))


def allows_anonymous(request: Request) -> bool:
    return eligible(request.method, route_template(request))


def bind(session: AsyncSession, request: Request, user: Any) -> None:
    """Record, for this request's session, whether public reading is possible.

    Called by every ``get_current_user`` so a session reused across requests
    (tests) or a route that is not eligible never inherits an earlier grant.
    """

    template = route_template(request)
    if not eligible(request.method, template):
        session.info.pop(_KEY, None)
        return
    if is_anonymous(user):
        host = request.client.host if request.client else "unknown"
        caller_key = f"ip:{host}"
    else:
        caller_key = f"user:{user.id}"
    session.info[_KEY] = ReadGrant(caller_key=caller_key, template=template)


def current(session: AsyncSession) -> ReadGrant | None:
    return session.info.get(_KEY)


def is_public_read(session: AsyncSession) -> bool:
    """Whether this request is reading a public project as a non-member."""

    grant = current(session)
    return grant is not None and grant.used


# --- abuse limit ---------------------------------------------------------------

_WINDOW_S = 60.0
_hits: dict[str, deque[float]] = {}


def reset_rate_limits() -> None:
    _hits.clear()


def check_rate(caller_key: str) -> None:
    """Count one public read for this caller, or refuse with ``429 Retry-After``."""

    limit = get_settings().public_read_rate_per_minute
    if limit <= 0:
        return
    now = time.monotonic()
    window = _hits.setdefault(caller_key, deque())
    while window and now - window[0] >= _WINDOW_S:
        window.popleft()
    if len(window) >= limit:
        retry_after = max(1, math.ceil(_WINDOW_S - (now - window[0])))
        raise api_error(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "rate_limit_exceeded",
            "Too many reads of public projects; retry shortly.",
            headers={"Retry-After": str(retry_after)},
            retry_after_seconds=retry_after,
        )
    window.append(now)
    if len(_hits) > 10_000:
        for key in [k for k, v in _hits.items() if not v or now - v[-1] >= _WINDOW_S]:
            del _hits[key]


async def admit_public_project(session: AsyncSession, organization, reference, user):
    """The public project a non-member may read on this request, else ``None``.

    ``None`` means "no special access": the caller continues down the normal
    membership path and is refused exactly as before when it is not a member.
    """

    from ..collaboration import effective_role, project_by_ref
    from ..db.models import Visibility

    grant = current(session)
    if grant is None or await effective_role(session, organization.id, user) is not None:
        return None
    project = await project_by_ref(session, organization.id, reference)
    if project is None or project.visibility is not Visibility.PUBLIC:
        return None
    check_rate(grant.caller_key)
    grant.used = True
    grant.project_id = project.id
    return project
