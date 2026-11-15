"""The stateless BIM language services: ``/v1/bim`` (D25).

They store nothing and belong to no organization. ``POST /v1/bim/validate`` compiles a package with the
same path as the problem upload; ``GET /v1/bim/templates*`` serve the example packages the Workbench
starts from. They answer ``application/problem+json``, as the BIM routes always have.
"""

from __future__ import annotations

from typing import Any

from bim_core.canonical import digest_bytes
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import authorize_counted_key, counted_caller, optional_session
from ....access.work_limits import limit_work_of_counted_caller
from ....db.models import User
from ....integrations import bim
from ....models.problem import problem_response
from ....services.entitlements import entitlement_service
from ..application.package import PackageRequest, read_package
from ..application.templates import TemplateProblem, template_package, template_paths
from ..application.validate import validate_package

router = APIRouter(prefix="/v1/bim", tags=["BIM"])

ZIP_MEDIA_TYPES = ("application/vnd.bim+zip", "application/zip")
#: ``include``: a comma list over ``ir`` and ``facts``; anything else is a 422 ``validation_error``.
INCLUDE_PATTERN = r"^(ir|facts)(,(ir|facts))*$"


def max_compressed(caller: User | None) -> int:
    """The upload limit: the toolchain's package limit for a visitor, ``MAX_PACKAGE_BYTES`` for an account."""
    if caller is None:
        return bim.package_limits()["max_compressed_bytes"]
    return entitlement_service.upload_limit()


@router.post(
    "/validate",
    operation_id="validateBimPackage",
    summary="Validate a BIM package and find the engine modes that fit it",
    dependencies=[Depends(limit_work_of_counted_caller)],
    openapi_extra={
        "requestBody": {
            "required": True,
            "description": "A BIM package (`.bim.zip`) as the raw request body. Nothing is stored.",
            "content": {media_type: {"schema": {"type": "string", "format": "binary"}} for media_type in ZIP_MEDIA_TYPES},
        }
    },
)
async def validate_bim_package(
    request: Request,
    include: str | None = Query(
        default=None,
        pattern=INCLUDE_PATTERN,
        description="A comma list over `ir` (also return the IR and its source map) and `facts` (also return the "
        "facts of the compiled problem, as `getProblemCompilationFacts` answers them).",
    ),
    caller: User | None = Depends(counted_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
) -> dict[str, Any]:
    # Counted for anybody; a key must carry ``problems:read`` (validation writes nothing).
    authorize_counted_key(request, caller)
    archive = await read_package(PackageRequest(request.headers, request.body, lambda: max_compressed(caller)))
    included = set(include.split(",")) if include else set()
    return await validate_package(
        archive, caller, session, include_ir="ir" in included, include_facts="facts" in included,
    )


@router.get("/templates", operation_id="listBimTemplates", summary="List the templates a problem can start from")
async def list_bim_templates() -> dict[str, Any]:
    return {"templates": template_paths()}


@router.get(
    "/templates/{template:path}",
    operation_id="getBimTemplate",
    summary="Download one template as a .bim.zip",
    response_class=Response,
    responses={200: {
        "description": "The template package.",
        "headers": {
            "Digest": {"description": "SHA-256 digest of the returned archive.", "schema": {"type": "string"}},
            "Content-Disposition": {"description": "Suggested .bim.zip filename.", "schema": {"type": "string"}},
        },
        "content": {"application/vnd.bim+zip": {"schema": {"type": "string", "format": "binary"}}},
    }},
)
async def get_bim_template(template: str) -> Response:
    try:
        found = await template_package(template)
    except TemplateProblem as exc:
        return problem_response(exc.status, exc.code, exc.detail)
    return Response(
        found.archive,
        media_type="application/vnd.bim+zip",
        headers={
            "Content-Disposition": f'attachment; filename="{found.name}.bim.zip"',
            "Digest": f"sha-256={digest_bytes(found.archive).removeprefix('sha256-')}",
        },
    )

