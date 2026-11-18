"""The problems API: ``/v1/organizations/{org}/problems``.

A problem belongs to an organization and is created by uploading a closed ``.bim.zip`` as the raw request
body (D13). VIEWER reads, MEMBER uploads and edits, ADMIN deletes. The two uploads (a new problem, a new
revision of one) are also the Workbench's two save actions.
"""

from __future__ import annotations

import re
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.responses import Response as RawResponse
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, session_dependency
from ....access.work_limits import limit_work
from ....collaboration import organization_by_ref, require_role
from ....core import revision as etags
from ....core.like import LIKE_ESCAPE, like_contains
from ....db.models import (
    BindingCase,
    BindingCaseRevision,
    Organization,
    OrganizationRole,
    ProblemCompilation,
    User,
)
from ....integrations import bim
from ....models.errors import CONFLICT_RESPONSE, NOT_FOUND_RESPONSE, ErrorResponse, api_error
from ....services.engines import compatible_modes
from ....services.entitlements import entitlement_service
from ...shared.application import audit
from ..application import problems
from ..application import sphere
from ..application.facts import compilation_facts
from ..application.origins import value_sources
from ..application.package import PackageRequest, read_package
from ..domain.compilation import analysis_summary, resource_contracts
from ..domain.origin import SPHERE_PRODUCER, ProblemOrigin
from .schemas import (
    RevisionSphere,
    SphereApplyRequest,
    SphereExpandRequest,
    SphereExpandView,
    SphereRecipeView,
    CompilationIr,
    CompilationSummary,
    CompilationView,
    LatestRevision,
    PackageFile,
    ProblemFactsView,
    ProblemList,
    ProblemUpdate,
    ProblemUpload,
    ProblemView,
    RevisionDetail,
    RevisionView,
)

router = APIRouter(prefix="/v1/organizations/{org}/problems", tags=["Problems"])

ZIP_MEDIA_TYPES = ("application/vnd.bim+zip", "application/zip")
PACKAGE_BODY: dict[str, Any] = {
    "requestBody": {
        "required": True,
        "description": "A closed BIM package (`.bim.zip`) as the raw request body.",
        "content": {media_type: {"schema": {"type": "string", "format": "binary"}} for media_type in ZIP_MEDIA_TYPES},
    }
}
UPLOAD_RESPONSES: dict[int | str, dict[str, Any]] = {
    402: {"model": ErrorResponse, "description": "The account's plan has no room (`quota_exceeded`: maxProblems or maxRepositoryStorage)."},
    409: {"model": ErrorResponse, "description": "The slug is in use in this organization (`slug_conflict`)."},
    413: {"model": ErrorResponse, "description": "The package exceeds the upload limit."},
    415: {"model": ErrorResponse, "description": "The body is not a `.bim.zip`."},
    422: {"description": "The toolchain refused the package (`invalid_instance`, with located diagnostics)."},
}
_PRODUCER = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_FILENAME = re.compile(r'filename="?([^";]{1,255})"?')


# -- Access ---------------------------------------------------------------------------------------------


async def _organization(session: AsyncSession, org: str, user: User, minimum: OrganizationRole) -> Organization:
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")
    await require_role(session, organization, user, minimum)
    return organization


async def _problem(session: AsyncSession, organization: Organization, ref: str) -> BindingCase:
    found = await problems.problem_by_ref(session, organization.id, ref)
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Problem not found.")
    return found


async def _revision(session: AsyncSession, problem: BindingCase, ref: str) -> BindingCaseRevision:
    found = await problems.revision_by_ref(session, problem, ref)
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Problem revision not found.")
    return found


def _upload_limit() -> int:
    """The smaller of the toolchain's compressed-package limit and ``MAX_PACKAGE_BYTES``."""
    return min(bim.package_limits()["max_compressed_bytes"], entitlement_service.upload_limit())


def _provenance(request: Request, producer: str | None) -> dict[str, Any] | None:
    provenance: dict[str, Any] = {}
    if producer:
        if not _PRODUCER.match(producer):
            raise api_error(422, "invalid_producer", "A producer is 1 to 64 lowercase letters, digits, dots, underscores and hyphens.")
        provenance["producer"] = producer
    match = _FILENAME.search(request.headers.get("content-disposition", ""))
    if match:
        provenance["filename"] = match.group(1)
    return provenance or None


# -- Views ------------------------------------------------------------------------------------------------


def _summary(row: ProblemCompilation) -> CompilationSummary:
    return CompilationSummary(
        id=row.id, compilation_digest=row.compilation_digest, compiler_digest=row.compiler_digest,
        semantic_digest=row.semantic_digest, ir_digest=row.ir_digest, binding_space=analysis_summary(row.ir, row.analysis)["bindingSpace"],
        created_at=row.created_at, current=row.compiler_digest == bim.toolchain_digest(),
    )


def _problem_view(
    problem: BindingCase,
    latest: BindingCaseRevision | None = None,
    compilation: ProblemCompilation | None = None,
    revision_count: int | None = None,
) -> ProblemView:
    return ProblemView(
        revision_count=revision_count if revision_count is not None else (latest.revision if latest else 0),
        id=problem.id, organization_id=problem.organization_id, slug=problem.slug, name=problem.name,
        description=problem.description, created_by_id=problem.created_by_id,
        created_at=problem.created_at, updated_at=problem.updated_at,
        latest_revision=LatestRevision(
            id=latest.id, revision=latest.revision, package_digest=latest.package_digest, origin=latest.origin,
            created_at=latest.created_at,
            current_compilation=_summary(compilation) if compilation is not None else None,
        ) if latest is not None else None,
    )


def _sphere_of(provenance: dict[str, Any] | None) -> RevisionSphere | None:
    if not provenance or provenance.get("producer") != SPHERE_PRODUCER or not provenance.get("recipeDigest"):
        return None
    return RevisionSphere(
        recipeDigest=provenance["recipeDigest"],
        sources=[{"title": item.get("title") or "", "versionLabel": item.get("versionLabel")}
                 for item in provenance.get("sources") or [] if isinstance(item, dict)],
    )


def _revision_view(row: BindingCaseRevision) -> RevisionView:
    return RevisionView(
        id=row.id, problem_id=row.binding_case_id, revision=row.revision, package_digest=row.package_digest,
        instance_digest=row.instance_digest, package_size=row.package_size, provenance=row.provenance,
        origin=row.origin, created_by_id=row.created_by_id, created_at=row.created_at,
        sphere=_sphere_of(row.provenance),
    )


def _upload_view(upload: problems.Upload) -> ProblemUpload:
    return ProblemUpload(
        problem=_problem_view(upload.problem, upload.revision, upload.compilation),
        revision=_revision_view(upload.revision),
        compilation=_summary(upload.compilation),
        created=upload.created,
    )


# -- Routes ---------------------------------------------------------------------------------------------


@router.get("", response_model=ProblemList, operation_id="listProblems")
async def list_problems(
    org: str,
    q: str | None = Query(default=None, max_length=160),
    origin: ProblemOrigin | None = Query(default=None, description="Only problems whose latest revision came from here."),
    composition: str | None = Query(
        default=None, max_length=64,
        description="Only problems a version of this composition (slug or id) links; none for an unknown one.",
    ),
    sort: Literal["name", "recent"] = Query(
        default="name",
        description="`name` (by name, then slug) or `recent` (newest latest revision first; a problem with none by its creation).",
    ),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProblemList:
    """The organization's problems, each with its latest revision and that revision's current compilation."""
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    query = select(BindingCase).where(BindingCase.organization_id == organization.id)
    if origin is not None:
        query = query.where(problems.latest_origin_is(origin))
    if composition is not None:
        linked = await problems.linked_by_composition(session, organization.id, composition)
        if linked is None:
            return ProblemList(problems=[], total=0, limit=limit, offset=offset)
        query = query.where(linked)
    if q:
        pattern = like_contains(q)
        query = query.where(or_(
            BindingCase.name.ilike(pattern, escape=LIKE_ESCAPE),
            BindingCase.slug.ilike(pattern, escape=LIKE_ESCAPE),
        ))
    total = int(await session.scalar(select(func.count()).select_from(query.subquery())) or 0)
    order = (BindingCase.name, BindingCase.slug)
    if sort == "recent":
        latest_at = (
            select(func.max(BindingCaseRevision.created_at))
            .where(BindingCaseRevision.binding_case_id == BindingCase.id)
            .correlate(BindingCase)
            .scalar_subquery()
        )
        order = (func.coalesce(latest_at, BindingCase.created_at).desc(), *order)
    rows = (await session.scalars(query.order_by(*order).offset(offset).limit(limit))).all()
    latest = await problems.latest_revisions(session, [row.id for row in rows])
    compiled = await problems.current_compilations(session, [revision.id for revision in latest.values()])
    counted = await problems.revision_counts(session, [row.id for row in rows])
    return ProblemList(
        problems=[
            _problem_view(
                row, latest.get(row.id), compiled.get(latest[row.id].id) if row.id in latest else None,
                counted.get(row.id, 0),
            )
            for row in rows
        ],
        total=total, limit=limit, offset=offset,
    )


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=ProblemUpload,
    operation_id="createProblem",
    openapi_extra=PACKAGE_BODY,
    responses=UPLOAD_RESPONSES,
    dependencies=[Depends(limit_work)],
)
async def create_problem(
    org: str,
    request: Request,
    slug: str | None = Query(default=None, max_length=64, description="Defaults from the Instance's metadata.name."),
    name: str | None = Query(default=None, min_length=1, max_length=160),
    description: str | None = Query(default=None, max_length=2000),
    producer: str | None = Query(default=None, max_length=64, description="What produced the package (recorded as provenance)."),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProblemUpload:
    """Create a problem whose revision 1 is the uploaded package."""
    organization = await _organization(session, org, user, OrganizationRole.MEMBER)
    provenance = _provenance(request, producer)
    archive = await read_package(PackageRequest(request.headers, request.body, _upload_limit))
    upload = await problems.create_problem(
        session, organization, archive, user, slug=slug, name=name, description=description, provenance=provenance,
    )
    return _upload_view(upload)


@router.get(
    "/{problem}",
    response_model=ProblemView,
    operation_id="getProblem",
    responses={**etags.ETAG_RESPONSE, 404: NOT_FOUND_RESPONSE},
)
async def get_problem(
    org: str,
    problem: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProblemView:
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found = await _problem(session, organization, problem)
    latest = (await problems.latest_revisions(session, [found.id])).get(found.id)
    compiled = (await problems.current_compilations(session, [latest.id])).get(latest.id) if latest else None
    etags.set_etag(response, found)
    return _problem_view(found, latest, compiled)


@router.patch(
    "/{problem}",
    response_model=ProblemView,
    operation_id="updateProblem",
    responses={**etags.EDIT_RESPONSES, 404: NOT_FOUND_RESPONSE},
)
async def update_problem(
    org: str,
    problem: str,
    payload: ProblemUpdate,
    response: Response,
    if_match: str | None = etags.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProblemView:
    organization = await _organization(session, org, user, OrganizationRole.MEMBER)
    found = await _problem(session, organization, problem)
    await etags.guard(session, found, if_match)
    if payload.name is not None:
        found.name = payload.name
    if payload.description is not None:
        found.description = payload.description
    await session.flush()
    audit(session, user, "problem.updated", "BindingCase", found.id, organization.id)
    etags.set_etag(response, found)
    latest = (await problems.latest_revisions(session, [found.id])).get(found.id)
    return _problem_view(found, latest)


@router.delete(
    "/{problem}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteProblem",
    responses={404: NOT_FOUND_RESPONSE, 409: CONFLICT_RESPONSE},
)
async def delete_problem(
    org: str,
    problem: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    """Delete a problem nothing has run on and no composition links.

    409 `problem_has_runs` when a run or a study names a revision, `problem_has_compositions` when a sealed
    composition version does. Its stored files stay.
    """
    organization = await _organization(session, org, user, OrganizationRole.ADMIN)
    found = await _problem(session, organization, problem)
    await problems.delete_problem(session, found, user)


@router.get("/{problem}/revisions", response_model=list[RevisionView], operation_id="listProblemRevisions")
async def list_problem_revisions(
    org: str,
    problem: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[RevisionView]:
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found = await _problem(session, organization, problem)
    rows = (await session.scalars(
        select(BindingCaseRevision).where(BindingCaseRevision.binding_case_id == found.id)
        .order_by(BindingCaseRevision.revision)
    )).all()
    return [_revision_view(row) for row in rows]


@router.post(
    "/{problem}/revisions",
    status_code=status.HTTP_201_CREATED,
    response_model=ProblemUpload,
    operation_id="createProblemRevision",
    openapi_extra=PACKAGE_BODY,
    responses={
        200: {"model": ProblemUpload, "description": "The package is already a revision of this problem; nothing was stored."},
        **{code: value for code, value in UPLOAD_RESPONSES.items() if code != 409},
    },
    dependencies=[Depends(limit_work)],
)
async def create_problem_revision(
    org: str,
    problem: str,
    request: Request,
    response: Response,
    producer: str | None = Query(default=None, max_length=64),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProblemUpload:
    """Add the uploaded package as the next revision (201), or answer the revision it already is (200)."""
    organization = await _organization(session, org, user, OrganizationRole.MEMBER)
    found = await _problem(session, organization, problem)
    provenance = _provenance(request, producer)
    archive = await read_package(PackageRequest(request.headers, request.body, _upload_limit))
    upload = await problems.add_revision(session, found, archive, user, provenance=provenance)
    if not upload.created:
        response.status_code = status.HTTP_200_OK
    return _upload_view(upload)


@router.get(
    "/{problem}/revisions/{revision}",
    response_model=RevisionDetail,
    operation_id="getProblemRevision",
)
async def get_problem_revision(
    org: str,
    problem: str,
    revision: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> RevisionDetail:
    """One revision: its digests, root document, file manifest and compilations (the current one marked)."""
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found = await _revision(session, await _problem(session, organization, problem), revision)
    compilations = (await session.scalars(
        select(ProblemCompilation).where(ProblemCompilation.revision_id == found.id)
        .order_by(ProblemCompilation.created_at, ProblemCompilation.id)
    )).all()
    return RevisionDetail(
        **_revision_view(found).model_dump(),
        document=found.document,
        files=[PackageFile.model_validate(item) for item in found.files or []],
        resource_digests=found.resource_digests or {},
        compilations=[_summary(row) for row in compilations],
    )


@router.get(
    "/{problem}/revisions/{revision}/source",
    operation_id="getProblemRevisionSource",
    response_class=RawResponse,
    responses={200: {
        "description": "The revision's package, as uploaded. `ETag` is its package digest; `Digest` the digest of these bytes.",
        "content": {"application/vnd.bim+zip": {"schema": {"type": "string", "format": "binary"}}},
    }},
)
async def get_problem_revision_source(
    org: str,
    problem: str,
    revision: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> RawResponse:
    from ...shared.application import read_verified
    from ....db.models import Blob

    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found_problem = await _problem(session, organization, problem)
    found = await _revision(session, found_problem, revision)
    blob = await session.get(Blob, found.package_blob_id)
    if blob is None:
        raise api_error(409, "content_unavailable", "The stored package of this revision is unavailable.")
    content = read_verified(blob)
    return RawResponse(
        content=content,
        media_type="application/vnd.bim+zip",
        headers={
            "Content-Disposition": f'attachment; filename="{found_problem.slug}-v{found.revision}.bim.zip"',
            "ETag": f'"{found.package_digest}"',
            "Digest": f"sha-256={blob.digest.removeprefix('sha256-')}",
            "Cache-Control": "private, no-store",
        },
    )


@router.get(
    "/{problem}/revisions/{revision}/compilation",
    response_model=CompilationView,
    operation_id="getProblemCompilation",
    dependencies=[Depends(limit_work)],
)
async def get_problem_compilation(
    org: str,
    problem: str,
    revision: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompilationView:
    """The compilation by the installed toolchain (compiled now on a miss): analysis, resources, compatible modes."""
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found = await _revision(session, await _problem(session, organization, problem), revision)
    row = await problems.compile_or_get(session, found, release_transaction=True)
    return CompilationView(
        **_summary(row).model_dump(),
        revision_id=row.revision_id,
        toolchain=row.toolchain or {},
        analysis=analysis_summary(row.ir, row.analysis),
        resources=resource_contracts(row.ir),
        compatible_modes=await compatible_modes(row.ir, user, session),
    )


@router.get(
    "/{problem}/revisions/{revision}/compilations/{compilation}/ir",
    response_model=CompilationIr,
    operation_id="getProblemCompilationIr",
)
async def get_problem_compilation_ir(
    org: str,
    problem: str,
    revision: str,
    compilation: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompilationIr:
    """The IR of one compilation, with its source map."""
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found = await _revision(session, await _problem(session, organization, problem), revision)
    row = await session.scalar(select(ProblemCompilation).where(
        ProblemCompilation.id == compilation, ProblemCompilation.revision_id == found.id,
    ))
    if row is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Compilation not found.")
    return CompilationIr(id=row.id, ir_digest=row.ir_digest, ir=row.ir, source_map=row.source_map or {})


@router.get(
    "/{problem}/revisions/{revision}/compilations/{compilation}/facts",
    response_model=ProblemFactsView,
    operation_id="getProblemCompilationFacts",
    summary="Read the facts of one compilation",
    responses={
        200: {"headers": {
            "ETag": {"description": "The compilation digest, the digest of the revision's value origins (`package` "
                     "without any) and `.facts`, quoted: the facts never change.", "schema": {"type": "string"}},
            "Cache-Control": {"description": "`private, immutable`.", "schema": {"type": "string"}},
        }},
        304: {"description": "The caller's copy (`If-None-Match`) is the facts."},
        404: NOT_FOUND_RESPONSE,
        422: {"description": "The compiled problem cannot be read (`problem_facts_unreadable`, with `reason`)."},
    },
)
async def get_problem_compilation_facts(
    org: str,
    problem: str,
    revision: str,
    compilation: str,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Any:
    """The facts of one compilation, named by its id or its `compilation_digest`: its tasks and the candidates
    each may take (as a document writes them), every candidate's values with units and origins, the features,
    the workflow in the Composition2Yaml shape, the constraints, the objectives and the binding-space size; every
    candidate's scalar properties, and, for a revision a SPHERE import wrote, where each value came from (its
    `source`) and the upstream plan each generated candidate was chosen from (`provenance`).

    The same projection `POST /v1/bim/validate?include=facts` answers for a package that is not stored.
    """
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found = await _revision(session, await _problem(session, organization, problem), revision)
    row = await problems.compilation_by_ref(session, found.id, compilation)
    if row is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Compilation not found.")
    # Two revisions with the same bytes (one generated, one uploaded) share a compilation digest, not their origins.
    origins = await value_sources(session, found.id)
    tag = f'"{row.compilation_digest}.{origins.digest or "package"}.facts"'
    headers = {"ETag": tag, "Cache-Control": "private, immutable"}
    if tag in {item.strip() for item in request.headers.get("if-none-match", "").split(",")}:
        return RawResponse(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    facts = compilation_facts(
        row.ir, row.source_map, analysis_summary(row.ir, row.analysis), ir_digest=row.ir_digest,
        sources=origins.sources, provenance=origins.provenance,
    )
    response.headers.update(headers)
    return facts


# -- SPHERE imports ---------------------------------------------------------------------------------------------

#: The largest SPHERE import request body.
SPHERE_BODY_LIMIT = 256 * 1024
SPHERE_RESPONSES: dict[int | str, dict[str, Any]] = {
    404: NOT_FOUND_RESPONSE,
    409: {"model": ErrorResponse, "description": "`problem_exists` (a new problem's slug is taken), "
          "`revision_moved` (another revision was added since; with `latest`) or `sphere_preview_stale` "
          "(the recipe generates another package than the preview)."},
    413: {"model": ErrorResponse, "description": "The request body exceeds 256 KiB."},
}


async def _sphere_body_limit(request: Request) -> None:
    if len(await request.body()) > SPHERE_BODY_LIMIT:
        raise api_error(413, "payload_too_large", f"A SPHERE import request is at most {SPHERE_BODY_LIMIT} bytes.")


@router.post(
    "/{problem}/sphere/expand",
    response_model=SphereExpandView,
    operation_id="expandSphereRecipe",
    summary="Preview the candidates a SPHERE import recipe generates",
    responses=SPHERE_RESPONSES,
    dependencies=[Depends(_sphere_body_limit), Depends(limit_work)],
)
async def expand_sphere_recipe(
    org: str,
    problem: str,
    payload: SphereExpandRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Any:
    """Read every pricing the recipe names (snapshotting each), generate the BIM package over the base revision
    (or a new problem whose slug is `{problem}`), compile it and answer the candidates, why each is (in)eligible,
    the changes against the base, the facts with their value sources and the package digest apply expects.

    The `sphere_*` findings, and the compiler's on the generated package, come back located with a 200.
    """
    organization = await _organization(session, org, user, OrganizationRole.MEMBER)
    preview = await sphere.expand(
        session, organization, problem, payload.recipe, payload.base.revision if payload.base else None, user,
    )
    return preview.view


@router.post(
    "/{problem}/sphere/apply",
    status_code=status.HTTP_201_CREATED,
    response_model=ProblemUpload,
    operation_id="applySphereRecipe",
    summary="Store what a SPHERE import recipe generates",
    responses={
        200: {"model": ProblemUpload, "description": "The problem already has that package; nothing was stored."},
        402: UPLOAD_RESPONSES[402],
        422: {"description": "The recipe is refused (`sphere_recipe_invalid`, `sphere_recipe_refused`, with "
              "`diagnostics`) or the toolchain refused the package (`invalid_instance`)."},
        **SPHERE_RESPONSES,
    },
    dependencies=[Depends(_sphere_body_limit), Depends(limit_work)],
)
async def apply_sphere_recipe(
    org: str,
    problem: str,
    payload: SphereApplyRequest,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProblemUpload:
    """Store the package a pinned recipe generates as a new problem (`base` null) or as the revision after
    `base`, exactly as its preview showed (`expect.packageDigest`), with the recipe in its provenance and the
    origin of every generated value. An apply repeated after it succeeded answers the same revision (200).
    """
    organization = await _organization(session, org, user, OrganizationRole.MEMBER)
    upload = await sphere.apply(
        session, organization, problem, payload.recipe, payload.base.revision if payload.base else None,
        payload.expect.packageDigest, user, name=payload.name,
    )
    if not upload.created:
        response.status_code = status.HTTP_200_OK
    return _upload_view(upload)


@router.get(
    "/{problem}/sphere/recipe",
    response_model=SphereRecipeView,
    operation_id="getSphereRecipe",
    summary="Read the SPHERE recipe that generated a revision",
    responses={404: NOT_FOUND_RESPONSE},
)
async def get_sphere_recipe(
    org: str,
    problem: str,
    revision: int | None = Query(default=None, ge=1, description="Defaults to the newest revision SPHERE generated."),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> SphereRecipeView:
    """The pinned recipe of revision `revision`, or of the newest revision a SPHERE import generated; 404 when
    none did."""
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found = await _problem(session, organization, problem)
    row, recipe = await sphere.recipe_of(session, found, revision)
    return SphereRecipeView(revision=row.revision, recipeDigest=row.provenance["recipeDigest"], recipe=dict(recipe.document))
