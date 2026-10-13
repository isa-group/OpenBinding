"""Instance packages and snapshots, as the application uses them: upload, validate, snapshot, read back.

``routes.v1`` authenticates the caller, hands over what it read from the request and turns the outcome into a
response. What it hands over is a ``PackageRequest`` (the headers, the way to read the body and the size
limits, resolved when they are needed) so that this module never sees a ``Request``. A problem with a code of
its own is an ``InstanceProblem``; a package the toolchain refuses is the ``HTTPException`` that
``compile_upload`` and ``read_package`` raise, as they always were.

Compiling and persisting are ``services.snapshots``: the deduplication by digest inside the owner, the
immutability of a snapshot and who may see it live there and are not repeated here. The route passes the
compiler and the persister it resolved, so that replacing them on the route (as the tests do) still works.
"""

from __future__ import annotations

from dataclasses import dataclass
from email.parser import BytesParser
from email.policy import default as email_policy
from typing import Any, Awaitable, Callable, Mapping, NamedTuple

from bim_core import PackageError
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.jsonio import strict_json_loads
from ..db.models import BindingIRSnapshot, InstanceSnapshot, User
from .engines import compatible_modes
from .entitlements import EntitlementsUnavailable, entitlement_service
from .snapshots import Compilation, compile_resolved, owned_snapshot, package_file_digests

BIM_ZIP_TYPES = frozenset({"application/zip", "application/octet-stream", "application/vnd.bim+zip", "application/x-bim+zip"})

Compiler = Callable[[bytes, AsyncSession | None, User | None], Awaitable[Compilation]]
Persister = Callable[[Compilation, User | None, AsyncSession | None], Awaitable[str | None]]


class InstanceProblem(Exception):
    """A refusal the HTTP layer renders as ``application/problem+json``."""

    def __init__(self, status: int, code: str, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class PackageRequest:
    """An upload as this module sees it: no framework object, and limits asked for only when they apply."""

    headers: Mapping[str, str]
    read_body: Callable[[], Awaitable[bytes]]
    max_compressed: Callable[[], int]
    max_expanded: Callable[[], int]

    @property
    def content_type(self) -> str:
        return (self.headers.get("content-type") or "").split(";", 1)[0].lower()


class SnapshotArchive(NamedTuple):
    """The stored source package of a snapshot."""

    snapshot_id: str
    content: bytes
    package_digest: str


async def read_package(request: PackageRequest) -> bytes:
    """The body of a ``.bim.zip`` upload, within the package size limit (the toolchain judges its content)."""
    if request.content_type not in BIM_ZIP_TYPES:
        raise HTTPException(
            status_code=415,
            detail="BIM source uploads must use a .bim.zip media type",
        )
    ceiling = request.max_compressed()
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > ceiling:
        raise HTTPException(status_code=413, detail=f"request body exceeds {ceiling} bytes")
    body = await request.read_body()
    if len(body) > ceiling:
        raise HTTPException(status_code=413, detail=f"request body exceeds {ceiling} bytes")
    return body


def multipart_zip(body: bytes, content_type: str, max_compressed: Callable[[], int]) -> bytes:
    """Parse one bounded MIME file part without trusting its supplied name."""
    if "\r" in content_type or "\n" in content_type or len(content_type) > 4096:
        raise PackageError("invalid multipart Content-Type")
    try:
        envelope = (
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("ascii")
            + body
        )
    except UnicodeEncodeError as exc:
        raise PackageError("multipart Content-Type must be ASCII") from exc
    message = BytesParser(policy=email_policy).parsebytes(envelope)
    if not message.is_multipart():
        raise PackageError("multipart/form-data requires a valid boundary")
    files: list[bytes] = []
    for part in message.iter_parts():
        if part.get_content_disposition() != "form-data" or part.get_filename() is None:
            continue
        transfer_encoding = (part.get("Content-Transfer-Encoding") or "binary").casefold()
        if transfer_encoding not in {"binary", "8bit"}:
            raise PackageError("multipart ZIP must use binary transfer encoding")
        content = part.get_payload(decode=True)
        if not isinstance(content, bytes) or not content:
            raise PackageError("multipart ZIP part is empty")
        if len(content) > max_compressed():
            raise PackageError(f"compressed package exceeds {max_compressed()} bytes")
        files.append(content)
    if len(files) != 1:
        raise PackageError("multipart request must contain exactly one ZIP file part")
    return files[0]


async def compile_upload(
    archive: bytes,
    session: AsyncSession | None,
    caller: User | None = None,
    *,
    compiler: Compiler = compile_resolved,
) -> Compilation:
    """Compile an upload; a package the toolchain cannot read is ``422`` with its message."""
    try:
        return await compiler(archive, session, caller)
    except PackageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


async def validate_legacy(
    request: PackageRequest,
    session: AsyncSession | None,
    *,
    compiler: Compiler = compile_resolved,
) -> dict[str, Any]:
    """Compile an upload on behalf of nobody in particular and report its identities."""
    compilation = await compile_upload(await read_package(request), session, compiler=compiler)
    return {
        "valid": True,
        "instanceDigest": compilation.instance_digest,
        "packageDigest": compilation.package_digest,
        "fileDigests": compilation.file_digests,
        "resourceDigests": compilation.resource_digests,
        "irDigest": compilation.ir_digest,
        "diagnostics": [],
    }


async def _validation_archive(request: PackageRequest, caller: User | None, session: AsyncSession | None) -> bytes:
    """The package to validate: the upload itself, or the stored archive of a snapshot the caller may see."""
    if request.content_type in BIM_ZIP_TYPES:
        return await read_package(request)
    body = await request.read_body()
    if len(body) > request.max_expanded():
        raise InstanceProblem(413, "payload_too_large", f"request body exceeds {request.max_expanded()} bytes")
    payload = strict_json_loads(body)
    snapshot_id = payload.get("snapshot") if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or set(payload) != {"snapshot"} or not isinstance(snapshot_id, str) or not snapshot_id:
        raise InstanceProblem(
            422,
            "snapshot_or_package_required",
            "BIM validation accepts an exact snapshot reference or a .bim.zip upload",
        )
    snapshot = await owned_snapshot(snapshot_id, caller, session)
    if snapshot is None:
        raise InstanceProblem(404, "not_found", "Snapshot not found")
    return snapshot.source_archive


async def validate_package(
    request: PackageRequest,
    caller: User | None,
    session: AsyncSession | None,
    *,
    compiler: Compiler = compile_resolved,
) -> dict[str, Any]:
    """Validate an upload or a snapshot of the caller, within the caller's plan, and name the engines that fit."""
    try:
        archive = await _validation_archive(request, caller, session)
        compilation = await compile_upload(archive, session, caller, compiler=compiler)
    except PackageError as exc:
        raise InstanceProblem(422, "invalid_request", str(exc)) from exc
    if caller is not None:
        try:
            caps = await entitlement_service.caps_for(caller.id)
        except EntitlementsUnavailable as exc:
            raise InstanceProblem(exc.status, exc.code, str(exc)) from exc
        if entitlement_service.complexity_too_large(compilation.binding_space_log10, caps):
            raise InstanceProblem(
                402,
                "instance_complexity_too_large",
                "instance binding space exceeds the caller plan limit",
            )
    spec = compilation.spec
    return {
        "valid": True,
        "instanceDigest": compilation.instance_digest,
        "packageDigest": compilation.package_digest,
        "fileDigests": compilation.file_digests,
        "resourceDigests": compilation.resource_digests,
        "irDigest": compilation.ir_digest,
        "analysis": {
            "tasks": len(spec.get("application", {}).get("tasks", [])),
            "candidates": compilation.analysis["candidates"],
            "constraints": len(spec.get("constraints", [])),
            "placement": bool(spec.get("placement")),
            "bindingSpace": str(compilation.binding_space_cardinality),
        },
        "compatibleModes": await compatible_modes(compilation.ir, caller, session),
        "diagnostics": [],
    }


async def create_snapshot(
    request: PackageRequest,
    caller: User | None,
    session: AsyncSession | None,
    *,
    compiler: Compiler = compile_resolved,
    persist: Persister,
) -> dict[str, Any]:
    """Compile an upload and keep it as a snapshot of the caller; the same package twice is the same snapshot."""
    compilation = await compile_upload(await read_package(request), session, caller, compiler=compiler)
    snapshot_id = await persist(compilation, caller, session)
    if snapshot_id is None:
        raise InstanceProblem(503, "database_unavailable", "Snapshots require database")
    return {
        "id": snapshot_id,
        "kind": "InstanceSnapshot",
        "instanceDigest": compilation.instance_digest,
        "packageDigest": compilation.package_digest,
        "irDigest": compilation.ir_digest,
        "fileDigests": compilation.file_digests,
        "resourceDigests": compilation.resource_digests,
    }


async def _stored_ir(session: AsyncSession, snapshot: InstanceSnapshot) -> BindingIRSnapshot | None:
    return (
        await session.execute(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id))
    ).scalars().first()


async def _visible_snapshot(snapshot_id: str, caller: User | None, session: AsyncSession | None) -> InstanceSnapshot:
    snapshot = await owned_snapshot(snapshot_id, caller, session)
    if snapshot is None:
        raise InstanceProblem(404, "not_found", "Snapshot not found")
    return snapshot


async def snapshot_detail(snapshot_id: str, caller: User | None, session: AsyncSession | None) -> dict[str, Any]:
    """A snapshot of the caller with its compiled IR, for the ``/snapshots`` resource."""
    if session is None:
        raise InstanceProblem(503, "database_unavailable", "Snapshots require database")
    snapshot = await _visible_snapshot(snapshot_id, caller, session)
    ir = await _stored_ir(session, snapshot)
    return {
        "id": str(snapshot.id),
        "ownerId": str(snapshot.owner_id) if snapshot.owner_id else None,
        "instanceDigest": snapshot.instance_digest,
        "packageDigest": snapshot.package_digest,
        "archiveSize": len(snapshot.source_archive) if snapshot.source_archive else 0,
        "createdAt": snapshot.created_at.isoformat() if snapshot.created_at else None,
        "ir": {
            "id": str(ir.id),
            "digest": ir.ir_digest,
            "document": ir.document,
            "sourceMap": ir.source_map,
            "compilerVersion": ir.compiler_version,
            "createdAt": ir.created_at.isoformat() if ir.created_at else None,
        } if ir else None,
    }


async def snapshot_archive(snapshot_id: str, caller: User | None, session: AsyncSession | None) -> SnapshotArchive:
    """The stored package of a snapshot of the caller, for the ``/snapshots`` resource."""
    if session is None:
        raise InstanceProblem(503, "database_unavailable", "Snapshots require database")
    snapshot = await owned_snapshot(snapshot_id, caller, session)
    if snapshot is None or not snapshot.source_archive:
        raise InstanceProblem(404, "not_found", "Snapshot archive not found")
    return SnapshotArchive(str(snapshot.id), snapshot.source_archive, snapshot.package_digest)


async def instance_view(snapshot_id: str, caller: User | None, session: AsyncSession | None) -> dict[str, Any]:
    """A snapshot the caller may see, as the ``/instances`` resource describes it."""
    snapshot = await _visible_snapshot(snapshot_id, caller, session)
    ir = await _stored_ir(session, snapshot)
    return {
        "id": snapshot_id,
        "kind": "InstanceSnapshot",
        "instanceDigest": snapshot.instance_digest,
        "packageDigest": snapshot.package_digest,
        "irDigest": ir.ir_digest if ir else None,
        "fileDigests": package_file_digests(snapshot.root_document, ir.document if ir else {}),
        "resourceDigests": snapshot.resource_digests,
        "instance": snapshot.root_document,
        "createdAt": snapshot.created_at.isoformat(),
    }


async def instance_source(snapshot_id: str, caller: User | None, session: AsyncSession | None) -> bytes:
    """The package a snapshot the caller may see was made from."""
    return (await _visible_snapshot(snapshot_id, caller, session)).source_archive


async def instance_ir(snapshot_id: str, caller: User | None, session: AsyncSession | None) -> dict[str, Any]:
    """The compiled IR of a snapshot the caller may see."""
    snapshot = await _visible_snapshot(snapshot_id, caller, session)
    ir = await _stored_ir(session, snapshot)
    if ir is None:
        raise InstanceProblem(404, "not_found", "IR not found")
    return ir.document
