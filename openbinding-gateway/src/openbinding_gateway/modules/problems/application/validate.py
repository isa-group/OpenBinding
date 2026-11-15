"""Validate a package without storing anything: the stateless ``POST /v1/bim/validate`` (D25).

The compile is the same ``compile_package`` the upload uses, so a package that validates is a package
that saves. Anybody may call it, signed in or not; the engine modes reported are the ones the caller can
see. Nothing is written.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from ....db.models import User
from ....domain.binding_space import BindingSpace
from ....models.errors import api_error
from ....services.engines import compatible_modes
from ....services.entitlements import entitlement_service
from ..domain.compilation import analysis_summary
from .compile import compile_package


async def validate_package(
    archive: bytes,
    caller: User | None,
    session: AsyncSession | None,
    *,
    include_ir: bool = False,
) -> dict[str, Any]:
    """Compile ``archive`` and report its identities, its analysis and the engine modes that fit it.

    With ``include_ir`` the IR and its source map come back too (the same compile, the same work class):
    the Workbench's IR view and workflow drawing read them.
    """
    compilation = await compile_package(archive)
    refusal = entitlement_service.binding_space_refusal(BindingSpace.from_analysis(compilation.analysis))
    if refusal is not None:
        raise api_error(refusal.status, refusal.code, refusal.detail, **refusal.extra)
    body: dict[str, Any] = {
        "valid": True,
        "instanceDigest": compilation.instance_digest,
        "packageDigest": compilation.package_digest,
        "irDigest": compilation.ir_digest,
        "fileDigests": compilation.file_digests,
        "resourceDigests": compilation.resource_digests,
        "analysis": analysis_summary(compilation.ir, compilation.analysis),
        "compatibleModes": await compatible_modes(compilation.ir, caller, session),
        "diagnostics": [],
    }
    if include_ir:
        body["ir"] = compilation.ir
        body["sourceMap"] = compilation.source_map
    return body
