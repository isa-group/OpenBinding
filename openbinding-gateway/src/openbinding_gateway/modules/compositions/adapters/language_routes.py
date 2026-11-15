"""The stateless Composition2Yaml services: ``/v1/compositions`` (validate, parse, serialise, diff, schema).

They store nothing and belong to no organization, as the BIM services do: anybody may call
them. Each POST is counted against the caller's ``read`` budget (``access/work_limits.py``),
an API key must carry ``compositions:read``, and the work runs under the per-process language
slots (429 ``composition_busy``). The handlers bound each document before reading it, since
the request-body ceiling of a route without an upload is far larger than a document may be.
They answer ``application/problem+json``, as ``/v1/bim/*`` does; a document with errors is
422 ``composition_invalid`` with the located ``c2y_*`` diagnostics.
"""

from __future__ import annotations

import hashlib
from typing import Any, Literal

from bim_core import PackageError
from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import Response
from pydantic import ValidationError

from ....access.dependencies import authorize_counted_key, counted_caller
from ....access.work_limits import limit_work_of_counted_caller
from ....composition import SUPPORTED_SYNTAX_VERSIONS, SYNTAX_VERSION, text
from ....core.jsonio import strict_json_loads
from ....db.models import User
from ....models.errors import api_error
from ....models.problem import validation_diagnostics
from ..application import language
from ..application.language import LanguageRefusal
from .schemas import DiffRequest, DiffResult, ParseResult, ValidateResult

router = APIRouter(prefix="/v1/compositions", tags=["Composition2Yaml"])

#: The longest document a request may carry, in bytes: the language's own limit.
MAX_DOCUMENT_BYTES = text.MAX_SOURCE_BYTES
#: The longest JSON document ``serialise`` reads: twice a document, for JSON's quoting.
MAX_JSON_DOCUMENT_BYTES = 2 * MAX_DOCUMENT_BYTES
#: The longest diff request: two documents, each as a JSON string, which may quote every
#: character of the text (``\\uXXXX``).
MAX_DIFF_BODY_BYTES = 2 * 6 * MAX_DOCUMENT_BYTES

YAML_MEDIA_TYPES = ("application/yaml", "text/yaml", "application/x-yaml")
JSON_MEDIA_TYPE = "application/json"
SCHEMA_MEDIA_TYPE = "application/schema+json"

_PROBLEM = {"application/problem+json": {"schema": {"$ref": "#/components/schemas/Problem"}}}


def _refusal(description: str) -> dict[str, Any]:
    return {"description": description, "content": _PROBLEM}


_TOO_LARGE = _refusal("The document is longer than a document may be (`limitBytes`).")
_WRONG_TYPE = _refusal("The request media type is not one this service reads.")
_INVALID = _refusal("The document has errors: `code` is `composition_invalid`, and `diagnostics` lists each one, located.")
YAML_BODY = {
    "requestBody": {
        "required": True,
        "description": f"A Composition2Yaml document, as YAML text in UTF-8, at most {MAX_DOCUMENT_BYTES} bytes.",
        "content": {media_type: {"schema": {"type": "string"}} for media_type in YAML_MEDIA_TYPES},
    }
}


def _media_type(request: Request) -> str:
    return (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()


async def document_body(request: Request, media_types: tuple[str, ...], limit: int, what: str) -> bytes:
    """The raw body, refused at the transport: 415 for another media type, 413 past ``limit`` bytes."""
    if _media_type(request) not in media_types:
        raise api_error(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            f"{what} is sent as {' or '.join(media_types)}.",
        )
    body = await request.body()
    if len(body) > limit:
        raise _too_large(len(body), limit, what)
    return body


def _too_large(size: int, limit: int, what: str) -> Exception:
    return api_error(
        413,
        "payload_too_large",
        f"{what} is {size} bytes long, past the {limit} bytes it may be.",
        limitBytes=limit,
    )


def _invalid(refusal: LanguageRefusal) -> Exception:
    return api_error(
        422,
        "composition_invalid",
        "The document has errors; `diagnostics` says where.",
        diagnostics=refusal.diagnostics,
    )


@router.post(
    "/validate",
    operation_id="validateComposition",
    summary="Lint a Composition2Yaml document",
    description=(
        "Every diagnostic of the document, located in its text: 200 whether or not it is valid. "
        "The document is judged on its own and against this deployment's SPHERE registries; "
        "nothing is stored."
    ),
    response_model=ValidateResult,
    dependencies=[Depends(limit_work_of_counted_caller)],
    responses={413: _TOO_LARGE, 415: _WRONG_TYPE},
    openapi_extra=YAML_BODY,
)
async def validate_composition(request: Request, caller: User | None = Depends(counted_caller)) -> dict[str, Any]:
    # Counted for anybody; a key must carry ``compositions:read`` (nothing is stored).
    authorize_counted_key(request, caller)
    raw = await document_body(request, YAML_MEDIA_TYPES, MAX_DOCUMENT_BYTES, "A document")
    reading = await language.validate(raw)
    return {"valid": reading.valid, "diagnostics": [language.diagnostic_view(item) for item in reading.diagnostics]}


@router.post(
    "/parse",
    operation_id="parseComposition",
    summary="Read a Composition2Yaml document into its JSON model",
    description=(
        "The canonical form of a valid document, as the JSON an editor mutates, with its warnings "
        "and infos. A document with an error is refused with 422 `composition_invalid`."
    ),
    response_model=ParseResult,
    dependencies=[Depends(limit_work_of_counted_caller)],
    responses={413: _TOO_LARGE, 415: _WRONG_TYPE, 422: _INVALID},
    openapi_extra=YAML_BODY,
)
async def parse_composition(request: Request, caller: User | None = Depends(counted_caller)) -> dict[str, Any]:
    authorize_counted_key(request, caller)
    raw = await document_body(request, YAML_MEDIA_TYPES, MAX_DOCUMENT_BYTES, "A document")
    try:
        document, diagnostics = await language.parse(raw)
    except LanguageRefusal as refusal:
        raise _invalid(refusal) from None
    return {"document": document, "diagnostics": diagnostics}


@router.post(
    "/serialise",
    operation_id="serialiseComposition",
    summary="Write a Composition2Yaml document as its canonical text",
    description=(
        "A document given as JSON (the model `parseComposition` answers), written as its canonical "
        "YAML: one key order, the binding in workflow order, the values sorted. Diagnostics of a "
        "refused document have a path and a pointer, and no span."
    ),
    response_class=Response,
    dependencies=[Depends(limit_work_of_counted_caller)],
    responses={
        200: {
            "description": "The canonical text of the document.",
            "content": {"application/yaml": {"schema": {"type": "string"}}},
        },
        413: _TOO_LARGE,
        415: _WRONG_TYPE,
        422: _INVALID,
    },
    openapi_extra={
        "requestBody": {
            "required": True,
            "description": f"A Composition2Yaml document as JSON, at most {MAX_JSON_DOCUMENT_BYTES} bytes.",
            "content": {JSON_MEDIA_TYPE: {"schema": {"type": "object"}}},
        }
    },
)
async def serialise_composition(request: Request, caller: User | None = Depends(counted_caller)) -> Response:
    authorize_counted_key(request, caller)
    raw = await document_body(request, (JSON_MEDIA_TYPE,), MAX_JSON_DOCUMENT_BYTES, "A JSON document")
    try:
        source = strict_json_loads(raw)
    except PackageError as error:
        raise _invalid(LanguageRefusal([{
            "code": "c2y_syntax", "message": str(error), "severity": "error", "path": "", "pointer": "", "span": None,
        }])) from None
    try:
        written = await language.serialise(source)
    except LanguageRefusal as refusal:
        raise _invalid(refusal) from None
    return Response(content=written.encode("utf-8"), media_type="application/yaml")


@router.post(
    "/diff",
    operation_id="diffCompositions",
    summary="Compare two Composition2Yaml documents",
    description=(
        "What changed from `before` to `after`, section by section. Either side with an error is "
        "refused with 422 `composition_invalid`, each diagnostic naming its `document`."
    ),
    response_model=DiffResult,
    dependencies=[Depends(limit_work_of_counted_caller)],
    responses={413: _TOO_LARGE, 415: _WRONG_TYPE, 422: _INVALID},
    openapi_extra={
        "requestBody": {
            "required": True,
            "description": f"The two documents as YAML text, each at most {MAX_DOCUMENT_BYTES} bytes.",
            "content": {JSON_MEDIA_TYPE: {"schema": DiffRequest.model_json_schema()}},
        }
    },
)
async def diff_compositions(request: Request, caller: User | None = Depends(counted_caller)) -> dict[str, Any]:
    authorize_counted_key(request, caller)
    raw = await document_body(request, (JSON_MEDIA_TYPE,), MAX_DIFF_BODY_BYTES, "A diff request")
    try:
        sides = DiffRequest.model_validate(strict_json_loads(raw))
    except PackageError as error:
        raise api_error(422, "invalid_request", str(error)) from None
    except ValidationError as error:
        diagnostics = validation_diagnostics(
            {**item, "loc": ("body", *item.get("loc", ()))} for item in error.errors(include_input=False)
        )
        raise api_error(
            422, "validation_error",
            "A diff request is an object with the texts `before` and `after`.", diagnostics=diagnostics,
        ) from None
    encoded = {side: getattr(sides, side).encode("utf-8", errors="surrogatepass") for side in language.SIDES}
    for side, value in encoded.items():
        if len(value) > MAX_DOCUMENT_BYTES:
            raise _too_large(len(value), MAX_DOCUMENT_BYTES, f"The {side} document")
    try:
        changes = await language.diff(encoded["before"], encoded["after"])
    except LanguageRefusal as refusal:
        raise _invalid(refusal) from None
    return {"changes": changes}


def _etag(content: bytes) -> str:
    return f'"sha256-{hashlib.sha256(content).hexdigest()}"'


@router.get(
    "/schema",
    operation_id="getCompositionSchema",
    summary="Download the JSON Schema of Composition2Yaml",
    description=(
        "The JSON Schema of one `syntaxVersion` (the latest by default), as it ships. It checks "
        "a document's structure; the coherence rules are the validator's."
    ),
    response_class=Response,
    responses={200: {
        "description": "The schema. `ETag` is the digest of these bytes.",
        "headers": {"ETag": {"description": "Digest of the schema's bytes.", "schema": {"type": "string"}}},
        "content": {SCHEMA_MEDIA_TYPE: {"schema": {"type": "object"}}},
    }},
)
async def get_composition_schema(
    request: Request,
    syntax_version: Literal[SUPPORTED_SYNTAX_VERSIONS] = Query(  # type: ignore[valid-type]
        default=SYNTAX_VERSION, alias="syntaxVersion", description="The syntax version whose schema to serve.",
    ),
) -> Response:
    content = text.schema_text(syntax_version).encode("utf-8")
    tag = _etag(content)
    headers = {"ETag": tag, "Cache-Control": "public, max-age=3600"}
    if tag in {item.strip() for item in request.headers.get("if-none-match", "").split(",")}:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(content=content, media_type=SCHEMA_MEDIA_TYPE, headers=headers)
