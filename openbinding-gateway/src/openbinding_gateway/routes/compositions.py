"""The composition endpoints: today, the diff.

The repository's standing rule is that every operation reachable from the web interface is
also a documented API endpoint, and phase F1 step 6 produced an operation -- comparing two
versions of a composition -- that only existed as a library function. This is that
operation, served.

**It takes the two sources rather than naming two stored versions, because nothing stores a
composition yet.** A repository-wide search finds no model, no table and no route that
persists one: phases F0 and F1 built the language, not its storage. An endpoint shaped
`/compositions/{id}/diff?from=&to=` would therefore have had to invent persistence to have
anything to read, which is a larger piece than this one and belongs with the Studio's own
storage. When that arrives, the stored-version form is an addition here, not a rewrite: the
response body does not change.

So the request carries two Composition2Yaml documents and the response is the typed change
list of ``composition/diff.py`` -- sectioned like the model, with ``renamed`` and ``moved``
among the verdicts. It reads nothing, writes nothing and touches no database; it is a POST
only because it takes two bodies.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from bim_core.canonical import digest, digest_bytes

from ..access.dependencies import get_current_user, get_optional_user, session_dependency
from ..artifacts import store_blob, validate_content, version_content
from ..collaboration import organization_by_ref, require_project
from ..composition.diff import SECTIONS, diff
from ..composition.text import TextError, parse
from ..db.models import (
    Artifact,
    ArtifactVersion,
    AuditEvent,
    Organization,
    OrganizationRole,
    Project,
    ProjectArtifact,
    User,
)
from ..models.artifacts import DraftContent
from ..models.errors import api_error
from ..models.platform import (
    CompositionCreate,
    CompositionVersionCreate,
    CompositionVersionView,
    CompositionView,
)

router = APIRouter(prefix="/v1/compositions", tags=["Compositions"])


def _audit_event(session, user: User, action: str, target, organization_id, **detail) -> None:
    session.add(AuditEvent(
        organization_id=organization_id, actor_id=user.id, action=action,
        target_type=target.__class__.__name__, target_id=getattr(target, "id", None),
        detail=detail,
    ))


class CompositionDiffRequest(BaseModel):
    """Two Composition2Yaml documents, as the author writes them."""

    model_config = ConfigDict(extra="forbid")

    before: str = Field(min_length=1, description="The earlier composition, as YAML source.")
    after: str = Field(min_length=1, description="The later composition, as YAML source.")


class CompositionChange(BaseModel):
    """One difference, in the terms the author wrote rather than the ones the package has."""

    model_config = ConfigDict(extra="forbid")

    section: str = Field(description=f"One of: {', '.join(SECTIONS)}.")
    subject: str = Field(description="What the change is about: an id, or an id and a field.")
    kind: str = Field(
        description=(
            "added, removed, changed, renamed or moved. The last two exist so the first "
            "three mean something: without them every rename is a removal plus an addition."
        ),
    )
    was: Any = None
    now: Any = None


class CompositionDiffResponse(BaseModel):
    """What changed, and nothing about how it is rendered."""

    model_config = ConfigDict(extra="forbid")

    identical: bool = Field(
        description=(
            "True when the two compositions are the same model. An empty change list means "
            "this and not that the comparison was shallow: the diff of any package in the "
            "phase F1 gate against itself is empty."
        ),
    )
    changes: list[CompositionChange]
    counts: dict[str, int] = Field(
        description="How many changes each section holds, including the sections with none.",
    )


@router.post(
    "/diff",
    response_model=CompositionDiffResponse,
    operation_id="diffCompositions",
    summary="Compare two compositions",
    responses={422: {"description": "One of the two documents is not a composition."}},
)
async def diff_compositions(
    request: CompositionDiffRequest,
    caller: Optional[User] = Depends(get_optional_user),
) -> CompositionDiffResponse:
    """Compare two Composition2Yaml documents and return the typed change list.

    Nothing is read from or written to storage, so no account is required: the request
    carries both operands and the response is a pure function of them.
    """
    before = _parse(request.before, "before")
    after = _parse(request.after, "after")
    return _diff_response(before, after)


def _diff_response(before, after) -> CompositionDiffResponse:
    """The one response body both diff forms return.

    The module docstring promised that the stored-version form would be "an addition here,
    not a rewrite: the response body does not change". Built in one place, that is a
    property of the code rather than of two handlers that happen to agree.
    """
    changes = diff(before, after)
    counts = dict.fromkeys(SECTIONS, 0)
    for change in changes:
        counts[change.section] += 1
    return CompositionDiffResponse(
        identical=not changes,
        changes=[CompositionChange(**change.as_dict()) for change in changes],
        counts=counts,
    )


def _parse(source: str, which: str):
    try:
        return parse(source)
    except TextError as error:
        raise HTTPException(status_code=422, detail=f"{which}: {error}") from error
    except Exception as error:  # a malformed YAML document is the caller's mistake too
        raise HTTPException(
            status_code=422, detail=f"{which}: not a readable composition: {error}",
        ) from error


# --------------------------------------------------------------- the stored composition
#
# Phase F2. The module docstring above was written when nothing stored a composition and it
# promised that the stored-version diff would be "an addition here, not a rewrite". It is
# both: the response body of a diff does not change, and the rest of the surface lives
# under a project, because every other artifact kind does -- a collection, a study, a case.
# A composition that was the one artifact reachable at the root would have had to
# reimplement the organization scoping and the role checks that ``require_project`` gives.
#
# The two diff forms therefore sit in different places on purpose. ``POST /v1/compositions
# /diff`` above takes two bodies, needs no account and reads nothing; the one below names
# two sealed versions of one stored composition and is read under the project's roles.

project_router = APIRouter(
    prefix="/v1/organizations/{org}/projects/{project}",
    tags=["Compositions"],
)

#: The media type a composition's source is stored under. One spelling, the registered one.
SOURCE_MEDIA_TYPE = "application/yaml"


async def _project_context(
    session: AsyncSession, org: str, project: str, user: User, minimum: OrganizationRole,
) -> tuple[Organization, Project]:
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise api_error(404, "not_found", "Organization not found.")
    return organization, await require_project(session, organization, project, user, minimum)


async def _composition(session: AsyncSession, project_id: uuid.UUID, reference: str) -> Artifact:
    """By id or by slug, like a collection: both are things a caller holds."""
    try:
        parsed = uuid.UUID(reference)
    except ValueError:
        parsed = None
    found = (await session.execute(select(Artifact).join(ProjectArtifact).where(
        ProjectArtifact.project_id == project_id, Artifact.kind == "Composition",
        Artifact.id == parsed if parsed else Artifact.name == reference))).scalars().first()
    if found is None:
        raise api_error(404, "not_found", "Composition not found.")
    return found


async def _latest_ordinal(session: AsyncSession, artifact_id: uuid.UUID) -> int | None:
    return await session.scalar(
        select(func.max(ArtifactVersion.ordinal)).where(ArtifactVersion.artifact_id == artifact_id),
    )


def _version_view(artifact: Artifact, version: ArtifactVersion) -> CompositionVersionView:
    return CompositionVersionView(
        id=version.id, composition_id=artifact.id, ordinal=version.ordinal,
        version=version.version, content_digest=version.content_digest,
        version_digest=version.version_digest, based_on_id=version.based_on_id,
        created_at=version.created_at,
    )


async def _composition_view(
    session: AsyncSession, artifact: Artifact, project_id: uuid.UUID,
) -> CompositionView:
    return CompositionView(
        id=artifact.id, project_id=project_id, slug=artifact.name, name=artifact.display_name,
        description=artifact.description, latest_version=await _latest_ordinal(session, artifact.id),
        created_by_id=artifact.created_by_id, created_at=artifact.created_at,
    )


async def _sealed(
    session: AsyncSession, artifact: Artifact, reference: str,
) -> ArtifactVersion:
    """One sealed version by its label, its ordinal or its id, newest first on a tie.

    Three spellings because three are in use elsewhere in the library, and a caller holding
    one of them should not have to convert. The ordinal is the authority on order: a
    version's ``created_at`` is display metadata and two sealed in the same second tie.
    """
    try:
        parsed = uuid.UUID(reference)
    except ValueError:
        parsed = None
    query = select(ArtifactVersion).where(ArtifactVersion.artifact_id == artifact.id)
    if parsed is not None:
        query = query.where(ArtifactVersion.id == parsed)
    elif reference.isdigit():
        query = query.where(ArtifactVersion.ordinal == int(reference))
    else:
        query = query.where(ArtifactVersion.version == reference)
    found = (await session.execute(query.order_by(ArtifactVersion.ordinal.desc()))).scalars().first()
    if found is None:
        raise api_error(404, "not_found", f"Composition has no version {reference!r}.")
    return found


@project_router.get(
    "/compositions", response_model=list[CompositionView], operation_id="listCompositions",
)
async def list_compositions(
    org: str, project: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[CompositionView]:
    """Every composition of the project, by slug."""
    _organization, found_project = await _project_context(
        session, org, project, user, OrganizationRole.VIEWER,
    )
    rows = (await session.execute(select(Artifact).join(ProjectArtifact).where(
        ProjectArtifact.project_id == found_project.id, Artifact.kind == "Composition",
        Artifact.archived == False,  # noqa: E712 - a SQL predicate, not a Python truth test
    ).order_by(Artifact.name))).scalars().all()
    return [await _composition_view(session, row, found_project.id) for row in rows]


@project_router.post(
    "/compositions", response_model=CompositionView, status_code=201,
    operation_id="createComposition",
)
async def create_composition(
    org: str, project: str, payload: CompositionCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionView:
    """The identity, with no version yet: a name to cite before there is anything to cite."""
    organization, found_project = await _project_context(
        session, org, project, user, OrganizationRole.MEMBER,
    )
    duplicate = (await session.execute(select(Artifact).join(ProjectArtifact).where(
        ProjectArtifact.project_id == found_project.id, Artifact.kind == "Composition",
        Artifact.name == payload.slug,
        Artifact.archived == False,  # noqa: E712 - archiving frees the slug, by design
    ))).scalars().first()
    if duplicate is not None:
        raise api_error(409, "slug_conflict", "That composition slug is in use.")
    artifact = Artifact(
        organization_id=organization.id, namespace=str(organization.id), name=payload.slug,
        display_name=payload.name, description=payload.description, kind="Composition",
        created_by_id=user.id,
    )
    session.add(artifact)
    await session.flush()
    session.add(ProjectArtifact(project_id=found_project.id, artifact_id=artifact.id))
    await session.flush()
    _audit_event(session, user, "composition.created", artifact, organization.id)
    return await _composition_view(session, artifact, found_project.id)


@project_router.get(
    "/compositions/{composition}", response_model=CompositionView,
    operation_id="getComposition",
)
async def get_composition(
    org: str, project: str, composition: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionView:
    _organization, found_project = await _project_context(
        session, org, project, user, OrganizationRole.VIEWER,
    )
    found = await _composition(session, found_project.id, composition)
    return await _composition_view(session, found, found_project.id)


@project_router.get(
    "/compositions/{composition}/versions", response_model=list[CompositionVersionView],
    operation_id="listCompositionVersions",
)
async def list_composition_versions(
    org: str, project: str, composition: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[CompositionVersionView]:
    """Newest first, by ordinal. The order is the server's, not the document's."""
    _organization, found_project = await _project_context(
        session, org, project, user, OrganizationRole.VIEWER,
    )
    found = await _composition(session, found_project.id, composition)
    rows = (await session.execute(
        select(ArtifactVersion).where(ArtifactVersion.artifact_id == found.id)
        .order_by(ArtifactVersion.ordinal.desc()),
    )).scalars().all()
    return [_version_view(found, row) for row in rows]


@project_router.post(
    "/compositions/{composition}/versions", response_model=CompositionVersionView,
    status_code=201, operation_id="createCompositionVersion",
)
async def create_composition_version(
    org: str, project: str, composition: str, payload: CompositionVersionCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionVersionView:
    """Seal the source as the next version, or return the version that already holds it.

    Re-sending an unchanged document is a no-op that answers 201 with the existing version
    rather than sealing a second one: the content digest is over the exact source bytes, so
    "the same composition" is a measurable claim and not an editorial one. That is SPHERE's
    immutability property reached from the other side -- it refuses a changed published
    version; this refuses an unchanged new one.
    """
    organization, found_project = await _project_context(
        session, org, project, user, OrganizationRole.MEMBER,
    )
    found = await _composition(session, found_project.id, composition)

    content, _contracts = validate_content(
        "Composition", DraftContent(content=payload.source, media_type=SOURCE_MEDIA_TYPE),
    )
    content_digest = digest_bytes(content)
    existing = await session.scalar(select(ArtifactVersion).where(
        ArtifactVersion.artifact_id == found.id,
        ArtifactVersion.content_digest == content_digest,
    ))
    if existing is not None:
        return _version_view(found, existing)

    based_on: ArtifactVersion | None = None
    if payload.based_on is not None:
        based_on = await session.get(ArtifactVersion, payload.based_on)
        if based_on is None:
            raise api_error(422, "unknown_origin", "The version this one is based on does not exist.")

    # Lock the identity before taking an ordinal or a label, as the collection library does:
    # two writers sealing at once would otherwise agree on the same next ordinal.
    await session.execute(select(Artifact.id).where(Artifact.id == found.id).with_for_update())
    ordinal = int(await _latest_ordinal(session, found.id) or 0) + 1
    label = payload.version or str(ordinal)
    clash = await session.scalar(select(ArtifactVersion).where(
        ArtifactVersion.artifact_id == found.id, ArtifactVersion.version == label))
    if clash is not None:
        raise api_error(409, "immutable_version", "Version label already identifies different content.")

    blob = await store_blob(session, found, user, content, SOURCE_MEDIA_TYPE)
    manifest = {
        "apiVersion": "openbinding/artifact/v1", "kind": "Composition",
        "identity": {"namespace": found.namespace, "name": found.name, "version": label},
        "contentDigest": content_digest, "mediaType": SOURCE_MEDIA_TYPE,
        "contracts": [], "dependencies": [],
    }
    created = ArtifactVersion(
        artifact_id=found.id, ordinal=ordinal, version=label, blob_id=blob.id,
        content_digest=content_digest, version_digest=digest(manifest), manifest=manifest,
        based_on_id=based_on.id if based_on else None, created_by_id=user.id,
    )
    session.add(created)
    await session.flush()
    _audit_event(session, user, "composition.version.created", created, organization.id,
                 digest=content_digest)
    return _version_view(found, created)


@project_router.get(
    "/compositions/{composition}/versions/{version}/content",
    operation_id="getCompositionVersionContent",
    # ``response_class=Response`` so the success response is not inferred as JSON with an
    # empty schema, which is what the OpenAPI contract test refuses: a declared 200 has to
    # name a concrete media schema. The bytes are the sealed source, and the Content-Type
    # comes from the manifest rather than from this declaration.
    response_class=Response,
    responses={200: {
        "description": "The sealed Composition2Yaml source, byte for byte.",
        "content": {SOURCE_MEDIA_TYPE: {"schema": {"type": "string"}}},
    }},
)
async def get_composition_version_content(
    org: str, project: str, composition: str, version: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    """The source as it was sealed, byte for byte, with its digest as a strong ETag."""
    _organization, found_project = await _project_context(
        session, org, project, user, OrganizationRole.VIEWER,
    )
    found = await _composition(session, found_project.id, composition)
    sealed = await _sealed(session, found, version)
    content, media_type = await version_content(session, sealed)
    return Response(
        content=content, media_type=media_type,
        headers={"ETag": f'"{sealed.content_digest}"'},
    )


@project_router.get(
    "/compositions/{composition}/diff", response_model=CompositionDiffResponse,
    operation_id="diffCompositionVersions",
    responses={422: {"description": "A stored version is not a readable composition."}},
)
async def diff_composition_versions(
    org: str, project: str, composition: str,
    from_: str = Query(..., alias="from", min_length=1, description="The earlier version."),
    to: str = Query(..., min_length=1, description="The later version."),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionDiffResponse:
    """The stored-version form the module docstring promised.

    The response body is the one ``POST /v1/compositions/diff`` returns, which was the
    promise: the same typed change list, sectioned the same way. Only the operands differ --
    two sealed versions of one stored composition rather than two documents in a request.
    """
    _organization, found_project = await _project_context(
        session, org, project, user, OrganizationRole.VIEWER,
    )
    found = await _composition(session, found_project.id, composition)
    earlier, later = await _sealed(session, found, from_), await _sealed(session, found, to)
    before_bytes, _ = await version_content(session, earlier)
    after_bytes, _ = await version_content(session, later)
    return _diff_response(
        _parse(before_bytes.decode(), "from"), _parse(after_bytes.decode(), "to"),
    )
