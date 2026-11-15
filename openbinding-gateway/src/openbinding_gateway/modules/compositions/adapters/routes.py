"""The compositions of an organization and their versions: ``/v1/organizations/{org}/compositions``.

VIEWER reads and checks a document against its problem, MEMBER creates, edits and seals versions, ADMIN
deletes. A composition the caller cannot read answers as a missing one: 404 for a non-member and for a
composition of another organization, never 403. A member whose role is too weak for a write gets 403
``organization_forbidden``. Edits take an optional ``If-Match`` (the ``ETag`` of a read or an earlier edit).

A version is sealed from a Composition2Yaml document sent as YAML (at most 256 KiB): it is read, judged
and, when it links a problem, evaluated by the toolchain; its canonical bytes and the evaluation are then
stored, immutable. Sealing and checking count against the caller's ``evaluate`` budget. Two versions are
compared from their stored bytes; a version is forked into another organization as a new composition, whose
first version is sealed through the same pipeline (also the ``evaluate`` budget).

A sealed version is evaluated again from its stored bytes: by the installed toolchain, whose evaluation is
stored (one per toolchain release), with some tasks bound otherwise (nothing stored), and around its binding
(the toolchain's one-task alternatives). The three count against the ``evaluate`` budget.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.responses import JSONResponse
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
from ....security.apikeys import authenticated_api_key, boundary_of
from ..application import compositions, evaluate, language, seal, versions
from ..application.fork import NameTaken, fork_composition
from ..application.language import diagnostic_view
from ..domain.records import values_json
from .language_routes import MAX_DOCUMENT_BYTES, YAML_BODY, YAML_MEDIA_TYPES, document_body
from .schemas import (
    CheckResult,
    CompositionCreate,
    CompositionEvaluate,
    CompositionKindName,
    CompositionList,
    CompositionNeighborhoodResponse,
    CompositionOrganization,
    CompositionFork,
    CompositionUpdate,
    CompositionVersionDiff,
    CompositionVersionList,
    CompositionVersionSummary,
    CompositionVersionView,
    CompositionView,
    EvaluateResult,
    EvaluationCompilation,
    EvaluationView,
    EvidenceRun,
    ForkNameTaken,
    ForkResult,
    SealResult,
    VersionCompilation,
    VersionLink,
    VersionName,
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
        forked_from=version.forked_from,
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


# -- Diff and fork ---------------------------------------------------------------------------------------

_BUSY = {429: {**_ERROR, "description": "Every Composition2Yaml slot of this process is taken (`composition_busy`)."}}


def _name(version: CompositionVersion) -> dict[str, Any]:
    return {"id": version.id, "label": version.label}


@router.get(
    "/{composition}/diff",
    response_model=CompositionVersionDiff,
    operation_id="diffCompositionVersions",
    summary="Compare two versions of a composition",
    description=(
        "What changed from version `from` to version `to`, read from their stored bytes, in SPHERE's "
        "PricingDiff shape with a `comparison` (see `diffCompositions`). `to` is the latest version by "
        "default, and `from` the one before `to`. Versions of two compositions are compared with "
        "`diffCompositions` on their contents."
    ),
    responses={
        **_UNREADABLE,
        422: {
            **_ERROR,
            "description": "A default the composition cannot give: no version yet, or none before `to` (`diff_version_missing`).",
        },
        **_BUSY,
    },
)
async def diff_composition_versions(
    org: str,
    composition: str,
    from_version: str | None = Query(default=None, alias="from", description="The earlier version: id, label or ordinal."),
    to_version: str | None = Query(default=None, alias="to", description="The later version: id, label or ordinal."),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict[str, Any]:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    found = await compositions.required_composition(session, organization, composition)
    before, after = await versions.diff_pair(session, found, from_version, to_version)
    compared = await language.diff_stored(before.content, after.content)
    return {"from": _name(before), "to": _name(after), **compared}


def _key_reaches(user: User, organization: Organization, slug: str) -> bool:
    """Whether the authenticating API key's boundary covers a composition ``slug`` of ``organization``.

    The fork's target is named in its body, so the route-level boundary check sees only the source.
    """
    key = authenticated_api_key(user)
    boundary = boundary_of(key) if key is not None else None
    if boundary is None:
        return True
    if not boundary:
        return False
    if "organizations" in boundary and not {str(organization.id), organization.slug} & boundary["organizations"]:
        return False
    return "slugs" not in boundary or slug in boundary["slugs"]


@router.post(
    "/{composition}/fork",
    status_code=status.HTTP_201_CREATED,
    response_model=ForkResult,
    operation_id="forkComposition",
    summary="Fork a version of a composition into another organization",
    description=(
        "Create a new composition in `targetOrganization` whose first version is the source version's "
        "document with `composition:` set to the new slug, sealed again through the same pipeline. The "
        "caller must read the source and be a MEMBER of the target. Without `slug` the fork takes the "
        "source's, and when the target holds it already nothing is written: 200 `nameTaken` names the "
        "composition that holds it. A version that links a problem is forked only with `dropProblem`, which "
        "removes its `problem` and `evidence` and declares its values."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        200: {"model": ForkNameTaken, "description": "Nothing was forked: the source's slug is taken in the target."},
        201: {"headers": {
            "ETag": etags.ETAG_HEADER,
            "Location": {"description": "The new composition.", "schema": {"type": "string"}},
        }},
        403: {
            **_ERROR,
            "description": (
                "The caller's role in the target is too weak (`organization_forbidden`), its plan lacks the "
                "`repository` feature (`feature_not_entitled`), or its API key does not reach the target "
                "(`api_key_boundary`)."
            ),
        },
        **_UNREADABLE,
        409: {
            **CONFLICT_RESPONSE,
            "description": (
                "The target is the source's own organization (`composition_fork_same_organization`), the version "
                "links a problem and `dropProblem` is not set (`composition_fork_problem_unreadable`), or the "
                "given `slug` is in use in the target (`slug_conflict`)."
            ),
        },
        422: {"description": "The forked document has errors (`composition_invalid`); `diagnostics` lists each one."},
        **_BUSY,
    },
)
async def fork_composition_version(
    org: str,
    composition: str,
    payload: CompositionFork,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Any:
    source_organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    source = await compositions.required_composition(session, source_organization, composition)
    version = await versions.required_version(session, source, payload.version)
    target = await compositions.organization_for(session, payload.target_organization, user, OrganizationRole.MEMBER)
    if not _key_reaches(user, target, payload.slug or source.slug):
        raise api_error(
            status.HTTP_403_FORBIDDEN, "api_key_boundary",
            "This API key is restricted from the requested method or resource.",
        )
    outcome = await fork_composition(
        session, source_organization, source, version, target,
        actor=user, slug=payload.slug, name=payload.name, description=payload.description,
        drop_problem=payload.drop_problem,
    )
    if isinstance(outcome, NameTaken):
        existing = outcome.existing
        return JSONResponse(status_code=status.HTTP_200_OK, content=ForkNameTaken(
            nameTaken=True, existingComposition={"id": existing.id, "slug": existing.slug, "name": existing.name},
        ).model_dump(mode="json", by_alias=True))
    created = outcome.composition
    (detail,) = await versions.details(session, [outcome.sealed.version])
    etags.set_etag(response, created)
    response.headers["Location"] = f"/v1/organizations/{target.slug}/compositions/{created.slug}"
    return ForkResult(
        composition=_view(created, target, versions.Summary(outcome.sealed.version, 1)),
        version=_version_view(detail),
        droppedProblem=outcome.dropped_problem,
    )


# -- Re-evaluation, other bindings and the neighbourhood ------------------------------------------------

_NOT_LINKED = "the version links no problem (`composition_not_linked`)"
_EMPTY = {409: {**CONFLICT_RESPONSE, "description": "The composition has no version to default to (`composition_empty`)."}}


@router.post(
    "/{composition}/versions/{version}/evaluations",
    status_code=status.HTTP_201_CREATED,
    response_model=EvaluationView,
    operation_id="reevaluateCompositionVersion",
    summary="Evaluate a version with the installed toolchain",
    description=(
        "Store the installed toolchain's evaluation of the version, read from its stored bytes and the "
        "problem it links: one per toolchain release, whatever its outcome (`verified`, `binding_invalid`, "
        "`semantics_changed`). 200 with the evaluation when it already exists; a version linked to no "
        "problem answers its declared evaluation. The version itself never changes."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        200: {"model": EvaluationView, "description": "The installed toolchain had evaluated the version already."},
        **_UNREADABLE,
        422: {
            **_ERROR,
            "description": (
                "The installed toolchain could not evaluate the version, for example its package no longer "
                "compiles (`evaluation_invalid`); `diagnostics` says why."
            ),
        },
        **_BUSY,
        **_TOOLCHAIN_DOWN,
    },
)
async def reevaluate_composition_version(
    org: str,
    composition: str,
    version: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> EvaluationView:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.MEMBER)
    found = await compositions.required_composition(session, organization, composition)
    row = await versions.required_version(session, found, version)
    outcome = await evaluate.reevaluate(session, organization, found, row, actor=user)
    (detail,) = await versions.details(session, [row])
    response.status_code = status.HTTP_201_CREATED if outcome.created else status.HTTP_200_OK
    return _evaluation_view(outcome.evaluation, detail.current, detail)


@router.post(
    "/{composition}/evaluate",
    response_model=EvaluateResult,
    operation_id="evaluateComposition",
    summary="Evaluate another binding of a version",
    description=(
        "Have the installed toolchain evaluate the binding of a version (the latest by default) with the "
        "tasks `binding` names bound to those candidates, the others as the version binds them. Nothing is "
        "stored. A binding the toolchain evaluated answers 200, `valid` false when it reports a hard "
        "violation; one it could not evaluate is 422 `evaluation_invalid`."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        **_UNREADABLE,
        **_EMPTY,
        422: {
            **_ERROR,
            "description": (
                f"The binding could not be evaluated (`evaluation_invalid`; a finding about a rebound task points "
                f"at `/binding/<task>`), or {_NOT_LINKED}."
            ),
        },
        **_BUSY,
        **_TOOLCHAIN_DOWN,
    },
)
async def evaluate_composition(
    org: str,
    composition: str,
    payload: CompositionEvaluate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> EvaluateResult:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    found = await compositions.required_composition(session, organization, composition)
    evaluated = await evaluate.evaluate_binding(
        session, organization, found, version_ref=payload.version, binding=payload.binding, caller=user,
    )
    return EvaluateResult(
        version=VersionName(**_name(evaluated.version)),
        valid=evaluated.valid,
        values=_values(dict(evaluated.values)),
        violations=evaluated.violations,
        diagnostics=[diagnostic_view(item) for item in evaluated.diagnostics],
    )


@router.get(
    "/{composition}/neighborhood",
    response_model=CompositionNeighborhoodResponse,
    operation_id="getCompositionNeighborhood",
    summary="Evaluate the one-task alternatives of a version's binding",
    description=(
        "The toolchain's canonical one-task counterfactuals of a version's binding (the latest version by "
        "default), on the installed toolchain's compilation of the problem it links: at most `limit` "
        "alternatives, within a cooperative two-second budget. Each move also names its candidate as a "
        "document does. Nothing is stored."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        **_UNREADABLE,
        **_EMPTY,
        422: {
            **_ERROR,
            "description": (
                f"The toolchain cannot analyse the binding or the task (`analysis_invalid`), {_NOT_LINKED}, or the "
                "installed toolchain reads the problem differently (`c2y_compilation_semantics_changed`)."
            ),
        },
        **_BUSY,
        **_TOOLCHAIN_DOWN,
    },
)
async def get_composition_neighborhood(
    org: str,
    composition: str,
    version: str | None = Query(default=None, max_length=64, description="The version: id, label or ordinal; the latest by default."),
    task: str | None = Query(default=None, max_length=256, description="Only the alternatives of this task."),
    limit: int = Query(default=32, ge=1, le=128, description="At most this many alternatives are evaluated."),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict[str, Any]:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    found = await compositions.required_composition(session, organization, composition)
    row, result = await evaluate.neighbourhood(
        session, organization, found, version_ref=version, task=task, limit=limit,
    )
    return {**result, "version": _name(row)}
