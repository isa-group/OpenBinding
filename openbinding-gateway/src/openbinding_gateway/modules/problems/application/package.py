"""Reading an uploaded ``.bim.zip`` body, within a size limit, without seeing a framework object.

Every package route takes the raw body (D13): the problem upload, a new revision, the Workbench's save,
QACOForge's push and ``/v1/bim/validate``. The route hands over a ``PackageRequest`` (the headers, the way
to read the body and the limit, resolved when needed); the toolchain judges the content.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Mapping

from fastapi import HTTPException

BIM_ZIP_TYPES = frozenset({"application/zip", "application/octet-stream", "application/vnd.bim+zip", "application/x-bim+zip"})


@dataclass(frozen=True)
class PackageRequest:
    """An upload as the application sees it: no framework object, and a limit asked for only when it applies."""

    headers: Mapping[str, str]
    read_body: Callable[[], Awaitable[bytes]]
    max_compressed: Callable[[], int]

    @property
    def content_type(self) -> str:
        return (self.headers.get("content-type") or "").split(";", 1)[0].strip().lower()


async def read_package(request: PackageRequest) -> bytes:
    """The body of a ``.bim.zip`` upload, within the size limit (415 for another media type, 413 past the limit)."""
    if request.content_type not in BIM_ZIP_TYPES:
        raise HTTPException(
            status_code=415,
            detail={"code": "unsupported_media_type", "message": "BIM packages are uploaded as a .bim.zip body (application/vnd.bim+zip or application/zip)"},
        )
    ceiling = request.max_compressed()
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > ceiling:
        raise HTTPException(status_code=413, detail={"code": "payload_too_large", "message": f"request body exceeds {ceiling} bytes"})
    body = await request.read_body()
    if len(body) > ceiling:
        raise HTTPException(status_code=413, detail={"code": "payload_too_large", "message": f"request body exceeds {ceiling} bytes"})
    return body
