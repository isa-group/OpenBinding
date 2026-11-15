"""The compositions of an organization and their versions: ``/v1/organizations/{org}/compositions``.

VIEWER reads and checks a document against its problem, MEMBER creates, edits and seals versions, ADMIN
deletes. A composition the caller cannot read answers as a missing one: 404 for a non-member and for a
composition of another organization, never 403. A member whose role is too weak for a write gets 403
``organization_forbidden``. Edits take an optional ``If-Match`` (the ``ETag`` of a read or an earlier edit).

A version is sealed from a Composition2Yaml document sent as YAML (at most 256 KiB): it is read, judged
and, when it links a problem, evaluated by the toolchain; its canonical bytes and the evaluation are then
stored, immutable. Sealing and checking count against the caller's ``evaluate`` budget.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, session_dependency
from ....access.work_limits import limit_work
from ....core import revision as etags
from ....db.models import (
    Composition,
    CompositionEvaluation,
    CompositionKind,
    CompositionVersion,
    Organization,
    OrganizationRole,
    User,
    ValuesStatus,
)
from ....models.errors import (
    CONFLICT_RESPONSE,
    NOT_FOUND_RESPONSE,
    UNAVAILABLE_RESPONSE,
    ErrorResponse,
    api_error,
)
from ..application import compositions, seal, versions
from ..application.language import diagnostic_view
from ..domain.records import values_json
from .language_routes import MAX_DOCUMENT_BYTES, YAML_BODY, YAML_MEDIA_TYPES, document_body
from .schemas import (
    CheckResult,
    CompositionCreate,
    CompositionKindName,
    CompositionList,
    CompositionOrganization,
    CompositionUpdate,
    CompositionVersionList,
    CompositionVersionSummary,
    CompositionVersionView,
    CompositionView,
    EvaluationCompilation,
    EvaluationView,
    EvidenceRun,
    SealResult,
    VersionCompilation,
    VersionLink,
    VersionProblem,
    VersionRevision,
)

router = APIRouter(prefix="/v1/organizations/{org}/compositions", tags=["Compositions"])

_UNREADABLE: dict[int | str, dict[str, Any]] = {
    404: {**NOT_FOUND_RESPONSE, "description": "No such organization or composition, or the caller cannot read it."},
}


def _summary(version: CompositionVersion | None) -> CompositionVersionSummary | None:
    if version is None:
        return None
    return CompositionVersionSummary(
        id=version.id, ordinal=version.ordinal, label=version.label, values_status=version.values_status.value,
        created_at=version.created_at,
    )


def _view(
    composition: Composition, organization: Organization, summary: versions.Summary | None = None,
) -> CompositionView:
    return CompositionView(
        id=composition.id, slug=composition.slug, name=composition.name, description=composition.description,
        kind=composition.kind.value, archived=composition.archived,
        organization=CompositionOrganization(id=organization.id, slug=organization.slug),
        latest_version=_summary(summary.latest) if summary else None,
        version_count=summary.count if summary else 0,
        created_by_id=composition.created_by_id, created_at=composition.created_at, updated_at=composition.updated_at,
    )


async def _viewed(session: AsyncSession, composition: Composition, organization: Organization) -> CompositionView:
    summary = (await versions.summaries(session, [composition.id]))[composition.id]
    return _view(composition, organization, summary)


@router.get("", response_model=CompositionList, operation_id="listCompositions", responses=_UNREADABLE)
async def list_compositions(
    org: str,
    kind: CompositionKindName | None = Query(default=None),
    q: str | None = Query(default=None, max_length=160, description="Text in the name or the slug."),
    archived: bool | None = Query(default=None, description="Only archived (`true`) or only active (`false`) ones."),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionList:
    """The organization's compositions, by name."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    page = await compositions.list_compositions(
        session, organization.id, kind=CompositionKind(kind) if kind else None, q=q, archived=archived,
        limit=limit, offset=offset,
    )
    found = await versions.summaries(session, [row.id for row in page.compositions])
    return CompositionList(
        compositions=[_view(row, organization, found[row.id]) for row in page.compositions],
        total=page.total, limit=limit, offset=offset,
    )


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=CompositionView,
    operation_id="createComposition",
    responses={
        201: {"headers": {"ETag": etags.ETAG_HEADER}},
        **_UNREADABLE,
        409: {**CONFLICT_RESPONSE, "description": "The slug is in use in this organization (`slug_conflict`)."},
    },
)
async def create_composition(
    org: str,
    payload: CompositionCreate,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionView:
    """Create an empty composition: no version yet."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.MEMBER)
    created = await compositions.create_composition(
        session, organization, user, slug=payload.slug, name=payload.name, description=payload.description,
        kind=CompositionKind(payload.kind),
    )
    etags.set_etag(response, created)
    return _view(created, organization, versions.Summary(None, 0))


@router.get(
    "/{composition}",
    response_model=CompositionView,
    operation_id="getComposition",
    responses={**etags.ETAG_RESPONSE, **_UNREADABLE},
)
async def get_composition(
    org: str,
    composition: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionView:
    """One composition, by slug or id."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    found = await compositions.required_composition(session, organization, composition)
    etags.set_etag(response, found)
    return await _viewed(session, found, organization)


@router.patch(
    "/{composition}",
    response_model=CompositionView,
    operation_id="updateComposition",
    responses={**etags.EDIT_RESPONSES, **_UNREADABLE},
)
async def update_composition(
    org: str,
    composition: str,
    payload: CompositionUpdate,
    response: Response,
    if_match: str | None = etags.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionView:
    """Rename, describe, archive or restore a composition."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.MEMBER)
    found = await compositions.required_composition(session, organization, composition)
    await etags.guard(session, found, if_match)
    updated = await compositions.update_composition(
        session, found, user, name=payload.name, description=payload.description, archived=payload.archived,
    )
    etags.set_etag(response, updated)
    return await _viewed(session, updated, organization)


@router.delete(
    "/{composition}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteComposition",
    responses=_UNREADABLE,
)
async def delete_composition(
    org: str,
    composition: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    """Delete a composition with its versions and their evaluations."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.ADMIN)
    found = await compositions.required_composition(session, organization, composition)
    await compositions.delete_composition(session, found, user)


# -- Versions --------------------------------------------------------------------------------------------

_ERROR = {"model": ErrorResponse}
_DOCUMENT_REFUSALS: dict[int | str, dict[str, Any]] = {
    413: {**_ERROR, "description": f"The document is longer than {MAX_DOCUMENT_BYTES} bytes (`limitBytes`)."},
    415: {**_ERROR, "description": "The document is not sent as YAML."},
}
_TOOLCHAIN_DOWN = {503: {**UNAVAILABLE_RESPONSE, "description": "The toolchain does not answer (`bim_unavailable`)."}}
_VERSION_ETAG = {"ETag": {"description": "The version's content digest, quoted.", "schema": {"type": "string"}}}


def _values(values: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    return {name: {"value": value["value"], "unit": value["unit"]} for name, value in (values or {}).items()}


def _evaluation_view(
    evaluation: CompositionEvaluation, current: CompositionEvaluation | None, detail: versions.Detail | None = None,
) -> EvaluationView:
    compiled = None
    if evaluation.compilation_id is not None:
        row = detail.compilations.get(evaluation.compilation_id) if detail is not None else None
        compiled = EvaluationCompilation(
            id=evaluation.compilation_id,
            compilation_digest=evaluation.compilation_digest or "",
            compiler_digest=evaluation.compiler_digest or "",
            semantic_digest=evaluation.semantic_digest or (row.semantic_digest if row is not None else ""),
            toolchain=dict(evaluation.toolchain or {}),
        )
    result = evaluation.result or {}
    return EvaluationView(
        id=evaluation.id,
        basis=evaluation.basis.value,
        outcome=evaluation.outcome.value,
        values=_values(evaluation.values),
        violations=list(result.get("violations") or []),
        diagnostics=list(evaluation.diagnostics or []),
        compilation=compiled,
        current=current is not None and current.id == evaluation.id,
        created_at=evaluation.created_at,
    )


def _version_view(detail: versions.Detail, *, analytics: bool = True) -> CompositionVersionView:
    version, current, link = detail.version, detail.current, detail.link
    linked = None
    if link is not None:
        linked = VersionLink(
            problem=VersionProblem(id=link.problem.id, slug=link.problem.slug, name=link.problem.name),
            revision=VersionRevision(id=link.revision.id, revision=link.revision.revision),
            linked_compilation=VersionCompilation(
                id=link.compilation.id, compilation_digest=link.compilation.compilation_digest,
                semantic_digest=link.compilation.semantic_digest,
            ),
        )
    return CompositionVersionView(
        id=version.id,
        ordinal=version.ordinal,
        label=version.label,
        syntax_version=version.syntax_version,
        kind=version.kind.value,
        values_status=version.values_status.value,
        verified=(
            version.values_status == ValuesStatus.VERIFIED and current is not None
            and current.outcome.value == "verified"
        ),
        content_digest=version.content_digest,
        size_bytes=version.size_bytes,
        values=_values(current.values if current is not None else None),
        problem=linked,
        offering=version.offering,
        evidence_run=EvidenceRun(id=version.evidence_job_id) if version.evidence_job_id else None,
        based_on=version.based_on,
        analytics=version.analytics if analytics else None,
        evaluations=[_evaluation_view(item, current, detail) for item in detail.evaluations],
        current_evaluation_id=current.id if current is not None else None,
        created_by_id=version.created_by_id,
        created_at=version.created_at,
    )


def _content_tag(version: CompositionVersion) -> str:
    return f'"{version.content_digest}"'


def _invalid(diagnostics) -> Exception:
    return api_error(
        422, "composition_invalid", "The document has errors; `diagnostics` says where.",
        diagnostics=[diagnostic_view(item) for item in diagnostics],
    )


@router.get(
    "/{composition}/versions",
    response_model=CompositionVersionList,
    operation_id="listCompositionVersions",
    responses=_UNREADABLE,
)
async def list_composition_versions(
    org: str,
    composition: str,
    include: Literal["analytics"] | None = Query(
        default=None, description="`analytics`: each version with the summary of its document.",
    ),
    order: Literal["newest", "oldest"] = Query(
        default="newest", description="`newest` first (the default) or `oldest` first, as evolution charts read them.",
    ),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionVersionList:
    """The composition's versions, each with its values, value status and evaluations."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    found = await compositions.required_composition(session, organization, composition)
    rows, total = await versions.list_versions(session, found, order=order, limit=limit, offset=offset)
    shown = await versions.details(session, rows)
    return CompositionVersionList(
        versions=[_version_view(item, analytics=include == "analytics") for item in shown],
        total=total, limit=limit, offset=offset,
    )


@router.post(
    "/{composition}/versions",
    status_code=status.HTTP_201_CREATED,
    response_model=SealResult,
    operation_id="createCompositionVersion",
    summary="Seal a version of a composition",
    description=(
        "Read the document, judge it and, when it links a problem, have the toolchain check its binding and "
        "compute its values; then store its canonical text as a new, immutable version with that evaluation. "
        "The same canonical text sealed again answers 200 with the version that holds it."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        200: {
            "description": "The canonical text was already sealed: the version that holds it.",
            "headers": _VERSION_ETAG, "model": SealResult,
        },
        201: {"headers": {"Location": {"description": "The new version.", "schema": {"type": "string"}}, **_VERSION_ETAG}},
        **_UNREADABLE,
        409: {**CONFLICT_RESPONSE, "description": "Another content holds this `version:` (`version_label_taken`)."},
        **_DOCUMENT_REFUSALS,
        422: {"description": "The document has errors (`composition_invalid`); `diagnostics` lists each one, located."},
        **_TOOLCHAIN_DOWN,
    },
    openapi_extra=YAML_BODY,
)
async def create_composition_version(
    org: str,
    composition: str,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> SealResult:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.MEMBER)
    found = await compositions.required_composition(session, organization, composition)
    raw = await document_body(request, YAML_MEDIA_TYPES, MAX_DOCUMENT_BYTES, "A document")
    checked = await seal.check(session, organization, found, raw, user)
    if not checked.valid or checked.assessment is None:
        raise _invalid(checked.diagnostics)
    sealed = await seal.persist(session, found, checked.assessment, actor=user)
    (detail,) = await versions.details(session, [sealed.version])
    response.status_code = status.HTTP_201_CREATED if sealed.created else status.HTTP_200_OK
    response.headers["ETag"] = _content_tag(sealed.version)
    if sealed.created:
        response.headers["Location"] = (
            f"/v1/organizations/{organization.slug}/compositions/{found.slug}/versions/{sealed.version.id}"
        )
    return SealResult(
        version=_version_view(detail),
        evaluation=_evaluation_view(sealed.evaluation, detail.current, detail),
        diagnostics=[diagnostic_view(item) for item in checked.diagnostics],
    )


@router.post(
    "/{composition}/versions/check",
    response_model=CheckResult,
    operation_id="checkCompositionVersion",
    summary="Check a document as a seal would, storing nothing",
    description=(
        "Every diagnostic a seal of this document would give, against its problem and by the toolchain, "
        "and the canonical text a seal would store: 200 whether or not the document is valid."
    ),
    dependencies=[Depends(limit_work)],
    responses={**_UNREADABLE, **_DOCUMENT_REFUSALS, **_TOOLCHAIN_DOWN},
    openapi_extra=YAML_BODY,
)
async def check_composition_version(
    org: str,
    composition: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CheckResult:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    found = await compositions.required_composition(session, organization, composition)
    raw = await document_body(request, YAML_MEDIA_TYPES, MAX_DOCUMENT_BYTES, "A document")
    checked = await seal.check(session, organization, found, raw, user)
    assessment = checked.assessment
    valid = checked.valid and assessment is not None and assessment.effective is not None
    values_status = None
    if assessment is not None:
        values_status = "declared" if assessment.document.problem is None else "verified"
    return CheckResult(
        valid=valid,
        values_status=values_status,
        values=values_json(assessment.effective.values) if valid else None,
        content=assessment.content if valid else None,
        diagnostics=[diagnostic_view(item) for item in checked.diagnostics],
    )


@router.get(
    "/{composition}/versions/{version}",
    response_model=CompositionVersionView,
    operation_id="getCompositionVersion",
    responses={200: {"headers": _VERSION_ETAG}, **_UNREADABLE},
)
async def get_composition_version(
    org: str,
    composition: str,
    version: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionVersionView:
    """One version, by id, label or ordinal."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    found = await compositions.required_composition(session, organization, composition)
    row = await versions.required_version(session, found, version)
    (detail,) = await versions.details(session, [row])
    response.headers["ETag"] = _content_tag(row)
    return _version_view(detail)


@router.get(
    "/{composition}/versions/{version}/content",
    response_class=Response,
    operation_id="getCompositionVersionContent",
    summary="Download a version's Composition2Yaml text",
    description="The canonical text the version stores. It never changes: `ETag` is its digest.",
    responses={
        200: {
            "description": "The canonical text.",
            "headers": _VERSION_ETAG,
            "content": {"application/yaml": {"schema": {"type": "string"}}},
        },
        304: {"description": "The caller's copy (`If-None-Match`) is the content."},
        **_UNREADABLE,
    },
)
async def get_composition_version_content(
    org: str,
    composition: str,
    version: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    found = await compositions.required_composition(session, organization, composition)
    row = await versions.required_version(session, found, version)
    tag = _content_tag(row)
    headers = {"ETag": tag, "Cache-Control": "private, immutable"}
    if tag in {item.strip() for item in request.headers.get("if-none-match", "").split(",")}:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(content=row.content.encode("utf-8"), media_type="application/yaml; charset=utf-8", headers=headers)
