"""Composition templates: ``/v1/compositions/templates`` and ``POST /v1/organizations/{org}/compositions/from-template``.

Anybody reads the catalog (a visitor is charged one ``read`` request, as for the public compositions). A MEMBER
instantiates a template in one action: the template's problem (revision 1, then one revision per SPHERE recipe)
and a composition whose first version is derived from the template's binding of that problem's latest revision
(``application.templates``). Instantiating compiles and evaluates, so it counts against the ``compile`` budget.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, session_dependency
from ....access.work_limits import charge_anonymous_read, limit_work
from ....core import revision as etags
from ....db.models import OrganizationRole, User
from ....models.errors import CONFLICT_RESPONSE, NOT_FOUND_RESPONSE, ErrorResponse
from ..application import compositions, versions
from ..application import templates as catalog_module
from .routes import _evaluation_view, _version_view, _viewed
from .schemas import (
    CompositionFromTemplate,
    CompositionInstantiated,
    CompositionTemplateList,
    CompositionTemplateSummary,
    CompositionTemplateView,
    InstantiatedProblem,
    TemplateCompositionView,
    TemplateOperation,
    TemplateProblemView,
)

public_router = APIRouter(prefix="/v1/compositions/templates", tags=["Composition templates"])
router = APIRouter(prefix="/v1/organizations/{org}/compositions", tags=["Composition templates"])

_MISSING: dict[int | str, dict[str, Any]] = {404: {**NOT_FOUND_RESPONSE, "description": "No such template."}}


def _summary(found: catalog_module.Template) -> dict[str, Any]:
    available = catalog_module.availability(found)
    return {
        "id": found.id, "title": found.title, "summary": found.summary, "kind": found.kind, "tasks": found.tasks,
        "hasOffering": found.has_offering, "available": available.available,
        "unavailableReason": available.reason,
    }


@public_router.get(
    "",
    response_model=CompositionTemplateList,
    operation_id="listCompositionTemplates",
    summary="List the templates a composition can start from",
    dependencies=[Depends(charge_anonymous_read)],
)
async def list_composition_templates() -> CompositionTemplateList:
    return CompositionTemplateList(
        templates=[CompositionTemplateSummary(**_summary(found)) for found in catalog_module.catalog()],
    )


@public_router.get(
    "/{template}",
    response_model=CompositionTemplateView,
    operation_id="getCompositionTemplate",
    summary="Read one composition template",
    dependencies=[Depends(charge_anonymous_read)],
    responses=_MISSING,
)
async def get_composition_template(template: str) -> CompositionTemplateView:
    found = catalog_module.template(template)
    spec = found.composition
    return CompositionTemplateView(
        **_summary(found),
        problem=TemplateProblemView(slug=found.problem["slug"], name=found.problem["name"], revisions=1 + len(found.recipes)),
        composition=TemplateCompositionView(
            slug=spec["slug"], name=spec["name"], label=spec["label"], workflow=spec["workflow"],
            binding=dict(spec["binding"]), offering=dict(spec["offering"]) if "offering" in spec else None,
        ),
        operation=TemplateOperation(expectedUsers=found.operation.get("expectedUsers")),
    )


@router.post(
    "/from-template",
    status_code=status.HTTP_201_CREATED,
    response_model=CompositionInstantiated,
    operation_id="createCompositionFromTemplate",
    summary="Start a composition from a template",
    description=(
        "Create the template's problem (revision 1, then one revision per SPHERE import recipe, previewed and "
        "applied as a member would) and a composition whose first version is derived from the template's binding "
        "of the latest revision, with its offering read when it is sealed. No environment is created: "
        "`operation` holds defaults for one. Needs the `repository` feature and room for a problem."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        201: {"headers": {"ETag": etags.ETAG_HEADER}},
        404: {**NOT_FOUND_RESPONSE, "description": "No such organization or template, or the caller is not a member."},
        409: {
            **CONFLICT_RESPONSE,
            "description": (
                "Nothing was written: the composition or problem slug is in use (`slug_conflict`, `field` names "
                "which), or the template reads SPHERE and SPHERE is off (`template_needs_sphere`)."
            ),
        },
        502: {
            "model": ErrorResponse,
            "description": (
                "The template stopped after its problem was created (`template_incomplete`): the problem is kept, "
                "`problem` and `revision` name it, `cause` says what failed; no composition was made."
            ),
        },
    },
)
async def create_composition_from_template(
    org: str,
    payload: CompositionFromTemplate,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionInstantiated:
    organization = await compositions.organization_for(session, org, user, OrganizationRole.MEMBER)
    made = await catalog_module.instantiate(
        session, organization, user, payload.template,
        slug=payload.slug, name=payload.name, problem_slug=payload.problemSlug,
    )
    (detail,) = await versions.details(session, [made.sealed.version])
    etags.set_etag(response, made.composition)
    response.headers["Location"] = f"/v1/organizations/{organization.slug}/compositions/{made.composition.slug}"
    return CompositionInstantiated(
        template=made.template.id,
        composition=await _viewed(session, made.composition, organization),
        problem=InstantiatedProblem(slug=made.problem_slug, revision=made.revision.revision),
        version=_version_view(detail),
        evaluation=_evaluation_view(made.sealed.evaluation, detail.current, detail),
        operation=TemplateOperation(expectedUsers=made.template.operation.get("expectedUsers")),
    )
