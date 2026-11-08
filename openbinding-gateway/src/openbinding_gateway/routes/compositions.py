"""The composition endpoints: the language over HTTP, and the stored composition.

The repository's standing rule is that every operation reachable from the web interface is
also a documented API endpoint. Two groups of them live here.

**The authoring surface**, under ``/v1/compositions``, is the language itself, served: what
the Studio's editor asks of a document while it is being written. The editor has no YAML
parser of its own, by decision -- ``composition/text.py`` is the only authority on the
syntax, and a second parser in the browser would be a second definition of the language --
so everything it needs to know about a document it asks here.

======================  =============================================================
``POST /validate``      every problem, located -- the keystroke operation
``POST /parse``         the document as written and as canonical, for a form
``POST /serialise``     the text, written back from the document a form edited
``POST /compile``       whether it compiles, the digests that identify it, the files
``POST /package``       the ``.bim.zip`` itself, to take elsewhere
``POST /import``        a composition read back from an existing BIM package
``POST /diff``          what changed between two documents
``GET /language``       the templates, operators, neutral rules and defaults of a form
``GET /schema``         the JSON Schema: the enumerations and patterns of a form
======================  =============================================================

Every one of them reads what the request carries and stores nothing, so none needs an
account: there is nothing an account would protect. An API key still needs
``instances:read``, except for the two descriptions of the language, which are open like
``/v1/schemas``. The ones that read a document answer **200 whatever the document says**, with
``valid``, ``complete`` and every diagnostic, for the reason ``/validate`` gives below; a
malformed *request* is still a 422. ``/package`` and ``/import`` answer 422 when there is
nothing to hand back, and say why; ``/diff`` answers 422 when either document is not a
composition, because a change list between a composition and nothing has no meaning.

**The work runs on pools of its own, never on the event loop, and each pool says when it is
full.** Reading, writing, emitting and the building of every large response happen on a small
pool of their own threads, and compiling, which runs the container's compiler in this
process, on another; each admits a bounded number of waiting requests and answers ``503`` with
``Retry-After`` past it, rather than queueing without end. The rest of the gateway does not
wait behind either. **And the work is bounded by what it produces, not only by what it is
sent**: a source is bounded in length; a document is bounded in the text it would write
before it is written; and a composition is bounded in the feature values and the neutral
substitutions its package would hold before it is emitted, because those grow with
candidates times properties while the source grows with their sum.

**The stored composition**, under a project, is phase F2: a composition kept as a sealed,
versioned artifact, its diff between two sealed versions, and its fork.
"""

from __future__ import annotations

import asyncio
import functools
import json
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Callable, Literal, Optional, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from bim_core import CompileError, PackageError
from bim_core.canonical import canonical_json, digest, digest_bytes

from ..access import public_read
from ..access.dependencies import get_current_user, get_optional_user, session_dependency
from ..artifacts import can_read, store_blob, validate_content, version_content
from ..collaboration import organization_by_ref, require_project
from ..composition import LANGUAGE_ID
from ..composition import diagnostics as codes
from ..composition.bpmn import BpmnError
from ..composition.checks import completeness
from ..composition.diagnostics import MAX_LISTED, CompositionError, listed
from ..composition.diff import SECTIONS, diff
from ..composition.emit import emit, emitted_size, property_neutral, provenance
from ..composition.model import RATIO_TEMPLATES, TEMPLATES, Composition
from ..composition.neutral import (
    ALLOWED,
    BLOCK_DEFAULTS,
    RATIO_NEUTRALS,
    SEQUENCE_NEUTRALS,
    Unbounded,
    infer_neutral,
)
from ..composition.read import ImportError_, import_bim
from ..composition.spans import placed
from ..composition.syntax import TooLong, dump, load
from ..composition.text import (
    PROPERTY_DEFAULTS,
    TextError,
    compose,
    document,
    parse,
    schema,
    unrepresentable,
)
from ..core.jsonio import strict_json_loads
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
from ..integrations import bim, packages
from ..models.artifacts import DraftContent
from ..models.errors import api_error
from ..models.platform import (
    CompositionCreate,
    CompositionForkRequest,
    CompositionVersionCreate,
    CompositionVersionView,
    CompositionView,
)
from ..services import instances
from ..services.snapshots import Compilation

router = APIRouter(prefix="/v1/compositions", tags=["Compositions"])

#: The longest source any of these routes reads, and writes: 256 KiB, three times the largest
#: composition of the corpus outside one experiment (02_stock_market_sample, 84 KB). Measured
#: on the libyaml-backed reader, 256 KiB read in 0.8 to 0.9 seconds at every nesting depth
#: from 1 to 61; at 520 KB the same lists took 3 seconds, and 14 at one depth, so the cost
#: stops being linear above it. The routes are open to anyone, so the bound sits where the
#: cost is still known. The eight ICWS ``zhang2014`` instances of the corpus (333 KB each)
#: are past it: they import as ``composition_too_large``.
MAX_SOURCE_CHARS = 262_144

#: The most feature values a package these routes emit may hold, counting a neutral written
#: for every property that does not apply to a candidate: twelve times the corpus's largest
#: catalog (8,358 values). The substitutions are bounded on their own, because each is also a
#: provenance record in the response, and no composition in the corpus has one.
MAX_FEATURE_VALUES = 100_000
MAX_SUBSTITUTIONS = 10_000

#: The longest request body ``/serialise`` reads, which carries the document as JSON. Twice
#: the source bound, because JSON indented by a client runs longer than the YAML it stands
#: for: measured on that same composition, 1.55 times the source indented and 0.87 times it
#: compact. Measured on the raw body rather than by writing the document out again, which
#: would recurse through whatever depth the client sent.
MAX_DOCUMENT_BYTES = 2 * MAX_SOURCE_CHARS

#: The longest diagnostic message returned. The schema's messages quote the value at fault,
#: and a value can be as long as the document.
MAX_MESSAGE_CHARS = 1_000

#: The media type of a downloaded package, the one ``/v1/examples`` serves.
PACKAGE_MEDIA_TYPE = "application/vnd.bim+zip"

#: A composition id, matched whole. The schema's pattern is applied with ``re.search``, where
#: ``$`` also matches before a final newline, so ``"fleet\n"`` passes it; a filename built
#: from that would put a line break in a response header.
_COMPOSITION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")

_T = TypeVar("_T")


def _audit_event(session, user: User, action: str, target, organization_id, **detail) -> None:
    session.add(AuditEvent(
        organization_id=organization_id, actor_id=user.id, action=action,
        target_type=target.__class__.__name__, target_id=getattr(target, "id", None),
        detail=detail,
    ))


# ------------------------------------------------------------------- the authoring surface
#
# Two pools, each with a bound on how many requests may wait for it. A pool of its own keeps
# a burst of composition work from occupying the threads the rest of the gateway shares --
# the BIM port's, the database driver's -- and the bound turns a queue that would grow with
# every anonymous request into an answer the client can act on.

_READERS = ThreadPoolExecutor(max_workers=2, thread_name_prefix="composition-read")
_READING = threading.BoundedSemaphore(16)
_COMPILERS = ThreadPoolExecutor(max_workers=2, thread_name_prefix="composition-compile")
_COMPILING = threading.BoundedSemaphore(8)


async def _on(
    pool: ThreadPoolExecutor, gate: threading.BoundedSemaphore, busy: Callable[[], HTTPException],
    function: Callable[..., _T], *args: Any,
) -> _T:
    if not gate.acquire(blocking=False):
        raise busy()
    try:
        return await asyncio.get_running_loop().run_in_executor(
            pool, functools.partial(function, *args),
        )
    finally:
        gate.release()


def _readers_busy() -> HTTPException:
    return api_error(
        503, "composition_busy", "The composition readers are busy; retry shortly.",
        headers={"Retry-After": "1"},
    )


def _compilers_busy() -> HTTPException:
    # The platform's code for a compiler that cannot take more work now.
    return api_error(
        503, "bim_unavailable", "The BIM toolchain is busy; retry shortly.",
        headers={"Retry-After": "5"},
    )


async def _read(function: Callable[..., _T], *args: Any) -> _T:
    """Composition work, on the readers' pool."""
    return await _on(_READERS, _READING, _readers_busy, function, *args)


#: Every ``503`` the authoring routes can answer, for their OpenAPI declaration.
_BUSY = {503: {"description": "The readers or the compiler are busy; ``Retry-After`` says when to retry."}}


class CompositionValidateRequest(BaseModel):
    """One Composition2Yaml document, as the author is writing it."""

    model_config = ConfigDict(extra="forbid")

    source: str = Field(
        max_length=MAX_SOURCE_CHARS,
        description=(
            "The composition, as YAML source. An empty buffer is a document like any other: "
            "the answer says it is not a composition."
        ),
    )


class CompositionSourceRequest(BaseModel):
    """One Composition2Yaml document, as YAML source."""

    model_config = ConfigDict(extra="forbid")

    source: str = Field(max_length=MAX_SOURCE_CHARS, description="The composition, as YAML source.")


class CompositionSerialiseRequest(BaseModel):
    """One composition as the JSON-shaped document a form edits."""

    model_config = ConfigDict(extra="forbid")

    document: dict[str, Any] = Field(
        description=(
            "The composition as a document of the shape ``GET /v1/compositions/schema`` "
            "describes -- the ``written`` or the canonical ``document`` of ``POST "
            "/v1/compositions/parse``, edited."
        ),
    )
    form: Literal["written", "canonical"] = Field(
        "written",
        description=(
            "``written`` writes the document out as it was sent -- templates, explicit "
            "defaults and key order kept, only comments and formatting lost. ``canonical`` "
            "writes the composition it means: templates expanded, defaults but the unit omitted."
        ),
    )


class CompositionSpanView(BaseModel):
    """Where in the source a diagnostic is about, one-based, as a person counts lines."""

    line: int
    column: int
    end_line: int
    end_column: int


class CompositionDiagnosticView(BaseModel):
    """One problem, addressed to the author rather than to the compiler."""

    code: str = Field(description="A ``c2y_`` code, never a container one.")
    message: str
    path: str = Field(description="The element at fault, e.g. ``properties.cost.domain``.")
    severity: str = Field(
        description=(
            "``error`` when the document cannot be read as a composition, ``incomplete`` "
            "when it can and still lacks something it needs before a version is sealed."
        ),
    )
    span: Optional[CompositionSpanView] = Field(
        None, description="Where in the source; absent when there is no source to point into.",
    )


class CompositionValidateResponse(BaseModel):
    """What an editor needs after every keystroke."""

    valid: bool = Field(description="The document reads as a composition.")
    complete: bool = Field(
        description="It also has everything a sealed version needs; implies ``valid``.",
    )
    diagnostics: list[CompositionDiagnosticView]


class CompositionNeutralView(BaseModel):
    """The neutral a property contributes where it does not participate, and its origin."""

    value: Optional[float] = Field(
        None, description="Absent while the property's domain lacks the bound it is read from.",
    )
    source: str = Field(
        description=(
            "``declared`` when the author wrote it, ``inferred`` when the rule gave it, "
            "``unbounded`` while there is nothing yet to infer it from."
        ),
    )


class CompositionParseResponse(CompositionValidateResponse):
    """The validation, and the document in both of its forms when there is one."""

    written: Optional[dict[str, Any]] = Field(
        None,
        description=(
            "The document as the author wrote it -- templates, explicit defaults and key "
            "order kept, comments not -- when the text is YAML a composition may be written "
            "in, valid or not. What a form edits and sends back to ``/serialise`` to change "
            "nothing but what was edited."
        ),
    )
    document: Optional[dict[str, Any]] = Field(
        None,
        description=(
            "The composition as its canonical document: templates expanded into the policy "
            "they stand for, defaults but the unit omitted. Where a form reads what a field effectively "
            "is. Absent when the document is not valid."
        ),
    )
    neutrals: Optional[dict[str, CompositionNeutralView]] = Field(
        None,
        description=(
            "Each property's neutral as the emitter will write it -- what a form shows where "
            "the author left the neutral blank. Absent when the document is not valid."
        ),
    )


class CompositionSerialiseResponse(CompositionValidateResponse):
    """The text, and the validation of it."""

    source: Optional[str] = Field(
        None,
        description=(
            "The composition as YAML source, in the form asked for -- or, when it is not "
            "valid, written out as it was sent, so an editor can always switch to its text. "
            "Absent only when the document holds a value YAML text cannot carry."
        ),
    )
    canonical: bool = Field(
        False, description="``source`` is the canonical form rather than the form sent.",
    )
    document: Optional[dict[str, Any]] = Field(
        None, description="The canonical document, as in the parse response. Absent when not valid.",
    )
    neutrals: Optional[dict[str, CompositionNeutralView]] = Field(
        None, description="Each property's neutral, as in the parse response.",
    )


class CompositionContainerDiagnosticView(BaseModel):
    """One refusal of the container's compiler, addressed to the package it was given.

    Its address is a generated document and a JSON pointer into it, not the author's
    source: the container never saw the YAML. The Studio's own checks catch what they can
    before compiling, so this list is what is left to the container. Its fields are the
    container's own, spelled as the container spells them.
    """

    model_config = ConfigDict(extra="allow")

    code: str = Field(description="The container's code, e.g. ``missing_feature``.")
    message: str
    resource: Optional[str] = Field(None, description="The generated resource at fault.")
    pointer: Optional[str] = Field(None, description="A JSON pointer into that resource.")


class CompositionPackageView(BaseModel):
    """The package a composition compiles to, and the digests that identify it."""

    files: dict[str, Any] = Field(
        description="Every entry of the package, by name, as the JSON document it holds.",
    )
    ir_digest: str = Field(description="The digest of the lowered problem: what solvers see.")
    compilation_digest: str = Field(description="This package, compiled by this toolchain.")
    package_digest: str = Field(
        description=(
            "The digest of the package's canonical archive -- the bytes, and the ``ETag``, "
            "``POST /v1/compositions/package`` returns for the same source."
        ),
    )
    instance_digest: Optional[str] = None


class CompositionCompileResponse(CompositionValidateResponse):
    """Whether a composition compiles, and to what."""

    compiled: bool = Field(
        description=(
            "The composition is complete and the container's compiler accepted the package "
            "it emits. When false, ``diagnostics`` or ``container_diagnostics`` say why."
        ),
    )
    container_diagnostics: list[CompositionContainerDiagnosticView] = Field(default_factory=list)
    package: Optional[CompositionPackageView] = None
    provenance: Optional[dict[str, Any]] = Field(
        None,
        description=(
            "What the Studio decided that the package cannot say -- today, every neutral "
            "written onto a candidate a property does not apply to (``substitutions``). It "
            "is not inside the package because the compiler refuses an entry the manifest "
            "does not declare; it travels beside it. Present whenever the package was emitted."
        ),
    )


class CompositionRoundTripView(BaseModel):
    """Whether the imported composition compiles back to the problem the package was."""

    ir_digest: Optional[str] = Field(
        None, description="The IR digest of the imported composition, compiled again.",
    )
    exact: bool = Field(
        description=(
            "The two IR digests are equal: the composition is the package, as far as anything "
            "a solver sees. Section 11.2's gate proves this for the 82 packages of the corpus; "
            "this is the same test, for the one package uploaded."
        ),
    )
    container_diagnostics: list[CompositionContainerDiagnosticView] = Field(
        default_factory=list,
        description="Why the compile back failed, when it did: ``exact`` is then false.",
    )


class CompositionImportResponse(CompositionValidateResponse):
    """A BIM package, read back as a composition."""

    source: str = Field(description="The composition, as canonical YAML source.")
    document: Optional[dict[str, Any]] = Field(
        None, description="The same composition as its document. Absent when not valid.",
    )
    neutrals: Optional[dict[str, CompositionNeutralView]] = None
    ir_digest: str = Field(description="The IR digest of the package as uploaded.")
    round_trip: Optional[CompositionRoundTripView] = Field(
        None,
        description=(
            "The imported composition compiled again and compared. Absent when it is not "
            "valid, or when what it lacks is something the emitter cannot write -- a goal "
            "with nothing to normalize over, a neutral with no bound."
        ),
    )


class CompositionTemplateView(BaseModel):
    """What a ``template`` fills in, and the neutral it implies."""

    direction: str
    aggregate: dict[str, str] = Field(description="The operator of each of the five blocks.")
    domain: str = Field(description="The domain kind it gives a property that declares none.")
    neutral: Optional[float] = Field(
        None, description="The neutral, when the template alone decides it.",
    )
    neutral_from: Optional[str] = Field(
        None,
        description=(
            "When it does not: the domain bound the neutral is read from (``min`` or "
            "``max``), which the property must then declare."
        ),
    )


class CompositionBlockView(BaseModel):
    """One aggregation block: its operator when none is stated, and the ones it accepts."""

    default: str
    operators: list[str]


class CompositionNeutralRuleView(BaseModel):
    """The neutral one sequence operator implies."""

    sequence: str
    value: Optional[float] = Field(None, description="A constant neutral, for sum and product.")
    bound: Optional[str] = Field(
        None, description="Otherwise the domain bound it is read from: ``min`` or ``max``.",
    )
    ratio: Optional[float] = Field(
        None, description="What a ratio domain gives instead, whatever bounds it states.",
    )


class CompositionLanguageView(BaseModel):
    """The tables of the language a form needs, from the code that applies them."""

    language: str = Field(description="The language and version these tables describe.")
    templates: dict[str, CompositionTemplateView]
    blocks: dict[str, CompositionBlockView] = Field(
        description=(
            "Each block of an ``aggregate``: the operator it takes when the author names only "
            "some of the five, and the operators it accepts."
        ),
    )
    neutral_rules: list[CompositionNeutralRuleView]
    property_defaults: dict[str, str] = Field(
        description=(
            "What a property is when it says nothing more. There is no default direction: "
            "without a template the schema requires one."
        ),
    )


@dataclass(frozen=True)
class _Reading:
    """One document, read: the composition when there is one, and every diagnostic."""

    composition: Optional[Composition]
    complete: bool
    diagnostics: list[CompositionDiagnosticView]
    #: The document as loaded from the text, when the text loaded and JSON can hold it.
    written: Optional[dict[str, Any]] = None
    #: The canonical document and the neutrals, when asked for and the composition is valid.
    canonical: Optional[dict[str, Any]] = None
    neutrals: Optional[dict[str, CompositionNeutralView]] = None

    @property
    def valid(self) -> bool:
        return self.composition is not None


@dataclass(frozen=True)
class _Emitted:
    """One composition, emitted: the documents, their canonical archive, and the provenance."""

    files: dict[str, Any]
    archive: bytes
    provenance: list[dict[str, Any]]


@dataclass
class _Compiled:
    """One composition, emitted and put to the container's compiler."""

    emitted: _Emitted
    compilation: Optional[Compilation]
    container: list[CompositionContainerDiagnosticView] = field(default_factory=list)


def _diagnostic(item, severity: str) -> CompositionDiagnosticView:
    span = item.span
    message = item.message
    if len(message) > MAX_MESSAGE_CHARS:
        message = message[: MAX_MESSAGE_CHARS - 1] + "…"
    return CompositionDiagnosticView(
        code=item.code, message=message, path=item.path, severity=severity,
        span=CompositionSpanView(
            line=span.line, column=span.column, end_line=span.end_line, end_column=span.end_column,
        ) if span is not None else None,
    )


def _views(items, severity: str) -> list[CompositionDiagnosticView]:
    return [_diagnostic(item, severity) for item in listed(items)]


def _unreadable(error: Exception) -> list[CompositionDiagnosticView]:
    message = f"not a readable composition: {type(error).__name__}"
    return [CompositionDiagnosticView(code=codes.SCHEMA, message=message, path="", severity="error")]


def _read_source(source: str, forms: bool = False) -> _Reading:
    """A YAML source, read the way ``/validate`` describes. Runs on the readers' pool.

    ``parse`` in two steps, so the document as written is kept: it is what a form edits, and
    it exists even when the composition it describes does not. With ``forms``, the canonical
    document and the neutrals are built here too, off the event loop.
    """
    try:
        loaded = load(source)
    except CompositionError as error:
        return _Reading(None, False, _views(error.diagnostics, "error"))
    written = (
        loaded if forms and isinstance(loaded, dict) and not unrepresentable(loaded) else None
    )
    try:
        composition = compose(loaded)
    except CompositionError as error:
        refused = placed(CompositionError(listed(error.diagnostics)), source).diagnostics
        return _Reading(None, False, _views(refused, "error"), written)
    except Exception as error:  # noqa: BLE001 - a typed document must never become a 500
        return _Reading(None, False, _unreadable(error), written)
    missing = completeness(composition)
    if missing:
        # The same path every refusal takes to its position, rather than a second one: a
        # completeness diagnostic is built with a path and no span, exactly like a reader's.
        missing = placed(CompositionError(listed(missing)), source).diagnostics
    return _Reading(
        composition, not missing, _views(missing, "incomplete"), written,
        document(composition) if forms else None, _neutrals(composition) if forms else None,
    )


def _neutrals(composition: Composition) -> dict[str, CompositionNeutralView]:
    """Every property's neutral, from the emitter's own function.

    Coherence has already refused a neutral outside its domain, so what is left is a value,
    or a bound not yet written, which completeness reports.
    """
    found: dict[str, CompositionNeutralView] = {}
    for name, prop in composition.properties.items():
        try:
            value, source = property_neutral(prop)
        except Unbounded:
            found[name] = CompositionNeutralView(value=None, source="unbounded")
            continue
        found[name] = CompositionNeutralView(value=value, source=source)
    return found


def _too_large(message: str) -> HTTPException:
    return api_error(422, "composition_too_large", message)


def _package_files(composition: Composition, with_provenance: bool = False) -> _Emitted:
    """The package's documents, its canonical archive and its provenance. Runs on the pool.

    Counted before it is built: a package's catalog grows with candidates times the
    properties that do not apply to them, so a short source can emit a long one. The archive
    holds the documents in RFC 8785 canonical form, which is the form the toolchain hashes:
    so the bytes ``/package`` returns are exactly the archive whose ``package_digest``
    ``/compile`` reports, and anyone can check one against the other.
    """
    values, substitutions = emitted_size(composition)
    if values > MAX_FEATURE_VALUES or substitutions > MAX_SUBSTITUTIONS:
        raise _too_large(
            f"The package would hold {values} feature values, {substitutions} of them neutrals "
            f"written where a property does not apply, past the {MAX_FEATURE_VALUES} and "
            f"{MAX_SUBSTITUTIONS} the authoring surface emits.",
        )
    files = emit(composition)
    parsed = {name: json.loads(content) for name, content in files.items()}
    archive = packages.zip_files({name: canonical_json(value) for name, value in parsed.items()})
    return _Emitted(parsed, archive, provenance(composition) if with_provenance else [])


def _container_diagnostics(error: CompileError) -> list[CompositionContainerDiagnosticView]:
    items = bim.problem_for(error)[3]
    views = [CompositionContainerDiagnosticView(**item) for item in items[:MAX_LISTED]]
    if len(items) > MAX_LISTED:
        views.append(CompositionContainerDiagnosticView(
            code=codes.MORE, message=f"{len(items) - MAX_LISTED} more refusals are not listed",
        ))
    return views


async def _port_compile(archive: bytes) -> dict[str, Any]:
    """The archive, compiled through the BIM port on the compilers' pool.

    No registered resource is passed, and none is needed: the emitter writes every resource
    into the package and pins nothing from a registry.
    """
    return await _on(_COMPILERS, _COMPILING, _compilers_busy, bim.get_bim().compile, archive, [])


async def _compile(composition: Composition, with_provenance: bool = False) -> _Compiled:
    """Emit, then compile; the container's refusal is reported, not raised."""
    emitted = await _read(_package_files, composition, with_provenance)
    try:
        result = await _port_compile(emitted.archive)
    except CompileError as error:
        return _Compiled(emitted, None, _container_diagnostics(error))
    except PackageError as error:
        # The archive itself refused -- an entry past the toolchain's limits, say. The
        # emitted size is bounded first, so this is the container's last word, not a 500.
        return _Compiled(emitted, None, [CompositionContainerDiagnosticView(
            code="package_error", message=str(error),
        )])
    return _Compiled(emitted, Compilation.from_result(emitted.archive, result))


@router.post(
    "/validate",
    response_model=CompositionValidateResponse,
    operation_id="validateComposition",
    summary="Validate a composition and locate every problem in its source",
    responses=_BUSY,
)
async def validate_composition(
    request: CompositionValidateRequest,
    caller: Optional[User] = Depends(get_optional_user),
) -> CompositionValidateResponse:
    """Every problem in the document, each with a code, a path and the region of source.

    **It answers 200 whatever the document says**, which is a deliberate departure from
    ``POST /v1/validate``, where an invalid BIM package is a 422. The request -- validate this
    text -- always succeeds; the answer may be that the text has problems. And one of the two
    kinds of answer is not an error at all: an *incomplete* composition is a draft, readable
    and editable, that only lacks something before it can be sealed. Splitting the status by
    severity would hand an editor two response shapes for one question it asks after every
    keystroke. A malformed *request* -- no ``source``, an unknown field -- is still a 422.

    The two severities are the split ``checks`` measured. ``error`` is everything that makes
    the document unreadable: a YAML syntax error -- which includes the YAML a composition may
    not use, such as an alias or a duplicate key -- a reader refusal, a coherence check, the
    schema. ``incomplete`` is ``checks.completeness`` -- a task nobody declared, a goal over a
    property that does not exist, an empty market, a property whose neutral has no bound to
    come from yet -- which ``parse`` lets a draft have and sealing does not.

    Nothing is read from or written to storage, so no account is required, for the same
    reason the two-body diff needs none.
    """
    reading = await _read(_read_source, request.source)
    return CompositionValidateResponse(
        valid=reading.valid, complete=reading.complete, diagnostics=reading.diagnostics,
    )


@router.post(
    "/parse",
    response_model=CompositionParseResponse,
    operation_id="parseComposition",
    summary="Read a composition into the documents a form edits",
    responses=_BUSY,
)
async def parse_composition(
    request: CompositionSourceRequest,
    caller: Optional[User] = Depends(get_optional_user),
) -> CompositionParseResponse:
    """The validation ``/validate`` gives, and the document in the two forms a form needs.

    ``written`` is the document as the author wrote it: templates, explicit defaults and key
    order kept, comments and formatting not, because they are not part of a document. It is
    what a form edits, and it is there even when the composition is not valid, so a form
    can open a broken document to fix it. ``document`` is the composition it means, in
    canonical form -- templates expanded into the direction and aggregation they stand for,
    defaults but the unit omitted -- and it is where a form reads what a field effectively is.

    Sending ``written`` back to ``/serialise`` after an edit changes nothing but the edit and
    the formatting; sending the canonical ``document`` back normalizes the text. Section 12
    records which is lost where.

    ``neutrals`` gives each property's neutral as the package will carry it, because a form
    shows it where the author left the field blank and computing it in the browser would be a
    second statement of the rule.

    Answers 200 whatever the document says, like ``/validate``.
    """
    reading = await _read(_read_source, request.source, True)
    return CompositionParseResponse(
        valid=reading.valid, complete=reading.complete, diagnostics=reading.diagnostics,
        written=reading.written, document=reading.canonical, neutrals=reading.neutrals,
    )


def _written(document_: Any) -> str:
    """A document as source, the writing stopped once it passes what the surface reads."""
    try:
        return dump(document_, limit=MAX_SOURCE_CHARS)
    except TooLong as error:
        raise _too_large(
            f"The document writes as more than {MAX_SOURCE_CHARS} characters of source, the "
            "most the authoring surface reads.",
        ) from error


def _serialised(body: bytes, form: str) -> CompositionSerialiseResponse:
    """A form's document, judged and written. Runs on the readers' pool.

    The document is written out first and read back by ``parse``, which is the whole of the
    judgment: the YAML a document writes as is the YAML ``parse`` reads, so a form cannot
    build a composition the text editor would refuse, and every diagnostic is located in the
    text the response returns. The writing itself is bounded, and stops once it passes what
    the surface reads: block YAML indents every line by its depth and folds a long string into
    lines indented the same way, so a document can write many times its JSON.
    """
    try:
        sent = strict_json_loads(body)["document"]
    except PackageError as error:
        return CompositionSerialiseResponse(
            valid=False, complete=False,
            diagnostics=[CompositionDiagnosticView(
                code=codes.SYNTAX, message=str(error), path="", severity="error",
            )],
        )
    problems = unrepresentable(sent)
    if problems:
        # Nothing to write out: a value YAML text cannot carry, or nesting that would exhaust
        # the writer. Answered by path, which is what the form has.
        return CompositionSerialiseResponse(
            valid=False, complete=False, diagnostics=_views(problems, "error"),
        )
    written = _written(sent)
    reading = _read_source(written, True)
    if reading.composition is None or form == "written":
        return CompositionSerialiseResponse(
            valid=reading.valid, complete=reading.complete, diagnostics=reading.diagnostics,
            source=written, canonical=False, document=reading.canonical, neutrals=reading.neutrals,
        )
    canonical = _written(document(reading.composition))
    if parse(canonical) != reading.composition:
        # parse(serialise(m)) == m is the text layer's stated property, tested over every
        # model the gate produces. A document for which it fails is a fault in the writer,
        # and returning text that means something else would hide it.
        raise RuntimeError("the canonical source does not read back as the same composition")
    missing = completeness(reading.composition)
    located = placed(CompositionError(listed(missing)), canonical).diagnostics if missing else ()
    return CompositionSerialiseResponse(
        valid=True, complete=not missing, diagnostics=_views(located, "incomplete"),
        source=canonical, canonical=True, document=reading.canonical, neutrals=reading.neutrals,
    )


@router.post(
    "/serialise",
    response_model=CompositionSerialiseResponse,
    operation_id="serialiseComposition",
    summary="Write a composition document as YAML source",
    responses={
        422: {"description": "The request is malformed, or its body is past the size limit."},
        **_BUSY,
    },
)
async def serialise_composition(
    request: CompositionSerialiseRequest,
    raw: Request,
    caller: Optional[User] = Depends(get_optional_user),
) -> CompositionSerialiseResponse:
    """A document a form edited, written as YAML source and judged as text would be.

    The inverse of ``/parse``. ``form`` chooses the text: ``written`` (the default) writes the
    document out as it was sent, so a template stays a template and an explicit default stays
    explicit -- only comments and formatting are lost, because a document has none.
    ``canonical`` writes the composition it means instead, normalized. Either way the text is
    read back by exactly the rules any source is, so a form cannot build a composition the
    text editor would refuse, and every diagnostic is located in the returned ``source``.

    **The text comes back even when the document is not valid**, written out as it was sent:
    an editor can always switch from its form to its text, where located diagnostics help
    most. Only a value YAML cannot carry leaves ``source`` empty, answered by path.

    The body is read as strict JSON, as the platform reads every document it is sent: a
    duplicated member or a ``NaN`` is a ``c2y_syntax`` refusal here, not a value silently
    kept or kept last.

    Answers 200 whatever the document says, like ``/validate``. A body past twice the source
    limit is refused as a malformed request (``document_too_large``), and so is a document that
    would write as more source than the authoring surface reads (``composition_too_large``).
    """
    body = await raw.body()
    if len(body) > MAX_DOCUMENT_BYTES:
        raise api_error(
            422, "document_too_large", f"The request body is longer than {MAX_DOCUMENT_BYTES} bytes.",
        )
    return await _read(_serialised, body, request.form)


@router.post(
    "/compile",
    response_model=CompositionCompileResponse,
    operation_id="compileComposition",
    summary="Compile a composition and report its package and digests",
    responses=_BUSY,
)
async def compile_composition(
    request: CompositionSourceRequest,
    caller: Optional[User] = Depends(get_optional_user),
) -> CompositionCompileResponse:
    """Whether the composition compiles, the package it compiles to, and its digests.

    The composition is read, checked complete, emitted as an ordinary BIM package and handed
    to the container's compiler through the platform's BIM port -- the same compiler every
    uploaded package meets. ``ir_digest`` identifies the problem a solver sees, and is what
    makes a composition citable; ``package`` holds every generated document, so an editor can
    show what the composition became without unpacking anything.

    Answers 200 whatever the document says, like ``/validate``: ``compiled`` is false when the
    document is not valid, not complete, or refused by the container, and the diagnostics say
    which. The container's refusals are addressed to a generated document and a JSON pointer,
    not to the source, because the container never saw the source: the Studio's own checks
    catch what they can before compiling, and ``container_diagnostics`` is what is left.
    Being complete is necessary for compiling and not sufficient: an exclusive with no stated
    distribution, for one, waits for a channel that does not exist yet, and the container
    refuses it.

    Compiling runs the container's compiler, so an editor compiles on request, not at every
    keystroke: ``/validate`` is the keystroke operation. A composition whose package would hold
    more feature values or neutral substitutions than the authoring surface emits is refused
    as ``composition_too_large`` (422) before anything is emitted.
    """
    reading = await _read(_read_source, request.source)
    if reading.composition is None or not reading.complete:
        return CompositionCompileResponse(
            compiled=False, valid=reading.valid, complete=reading.complete,
            diagnostics=reading.diagnostics,
        )
    compiled = await _compile(reading.composition, True)
    record = {"substitutions": compiled.emitted.provenance}
    if compiled.compilation is None:
        return CompositionCompileResponse(
            compiled=False, valid=True, complete=True, diagnostics=reading.diagnostics,
            container_diagnostics=compiled.container, provenance=record,
        )
    compilation = compiled.compilation
    return CompositionCompileResponse(
        compiled=True, valid=True, complete=True, diagnostics=reading.diagnostics,
        package=CompositionPackageView(
            files=compiled.emitted.files,
            ir_digest=compilation.ir_digest,
            compilation_digest=compilation.compilation_digest,
            package_digest=compilation.package_digest,
            instance_digest=compilation.instance_digest,
        ),
        provenance=record,
    )


def _filename(composition: Composition) -> str:
    identifier = composition.composition
    return f"{identifier}.bim.zip" if _COMPOSITION_ID.fullmatch(identifier) else "composition.bim.zip"


@router.post(
    "/package",
    operation_id="packageComposition",
    summary="Download a composition as a BIM package",
    response_class=Response,
    responses={
        200: {
            "description": "The package, as a canonical .bim.zip archive.",
            "headers": {
                "ETag": {
                    "description": "The package digest, as ``/compile`` reports it.",
                    "schema": {"type": "string"},
                },
                "Digest": {
                    "description": "SHA-256 of the returned archive, as /v1/examples writes it.",
                    "schema": {"type": "string"},
                },
                "Content-Disposition": {
                    "description": "Suggested filename: the composition's id, then .bim.zip.",
                    "schema": {"type": "string"},
                },
            },
            "content": {PACKAGE_MEDIA_TYPE: {"schema": {"type": "string", "format": "binary"}}},
        },
        422: {
            "description": (
                "The composition is not valid (``invalid_composition``), not complete "
                "(``incomplete_composition``), refused by the container "
                "(``invalid_instance``), or would emit past the authoring surface's bounds "
                "(``composition_too_large``); the diagnostics say where."
            ),
        },
        **_BUSY,
    },
)
async def package_composition(
    request: CompositionSourceRequest,
    caller: Optional[User] = Depends(get_optional_user),
) -> Response:
    """The composition as the ``.bim.zip`` it compiles to: an ordinary BIM v1 package.

    The archive is canonical -- every document in RFC 8785 form, entries sorted, timestamps
    fixed -- so its digest is the ``package_digest`` ``/compile`` reports for the same source,
    sent as the ``ETag``, and downloading the same composition twice gives the same bytes.
    Nothing in it says it was generated: it uploads, validates and solves like any
    hand-written package. ``provenance.json`` is not in it, because the compiler refuses an
    entry the manifest does not declare; ``/compile`` returns it beside the package.

    **This one answers 422 when there is no package to give**, unlike the rest of the
    authoring surface: a download either has bytes or it has nothing, and a 200 carrying no
    archive would be a response a browser saves as a broken file. An editor asks
    ``/compile`` first; this is the button, not the keystroke.
    """
    reading = await _read(_read_source, request.source)
    if reading.composition is None:
        raise api_error(
            422, "invalid_composition", "The document is not a readable composition.",
            diagnostics=[item.model_dump() for item in reading.diagnostics],
        )
    if not reading.complete:
        raise api_error(
            422, "incomplete_composition",
            "The composition lacks something it needs before it can be compiled.",
            diagnostics=[item.model_dump() for item in reading.diagnostics],
        )
    compiled = await _compile(reading.composition)
    if compiled.compilation is None:
        raise api_error(
            422, "invalid_instance", "The container's compiler refused the package.",
            diagnostics=[item.model_dump(exclude_none=True) for item in compiled.container],
        )
    return Response(
        compiled.emitted.archive,
        media_type=PACKAGE_MEDIA_TYPE,
        headers={
            "Content-Disposition": f'attachment; filename="{_filename(reading.composition)}"',
            "Digest": f"sha-256={digest_bytes(compiled.emitted.archive).removeprefix('sha256-')}",
            "ETag": f'"{compiled.compilation.package_digest}"',
        },
    )


#: What completeness reports that the emitter cannot write: the round trip of an import with
#: one of these is not attempted.
_UNWRITABLE = frozenset({codes.GOAL_RANGE, codes.GOAL_UNKNOWN, codes.PROPERTY_NEUTRAL})

#: How a refused upload is named. ``read_package`` raises bare-string errors, which would
#: otherwise leave with no code at all.
_UPLOAD_CODES = {413: "payload_too_large", 415: "unsupported_media_type"}


def _max_compressed() -> int:
    return bim.package_limits()["max_compressed_bytes"]


def _max_expanded() -> int:
    return bim.package_limits()["max_expanded_bytes"]


def _inexpressible(message: str) -> HTTPException:
    return api_error(422, "inexpressible_package", message)


def _imported(archive: bytes, ir: dict[str, Any]) -> tuple[Composition, str]:
    """The accepted archive, read back as a composition and written as source.

    Runs on the readers' pool. ``compile`` is the IR the port already produced for this
    archive: a BPMN workflow is read by delegation, as the container reduced it, and
    ``reduce_package`` asks for the compilation of exactly the entries it was given -- this
    archive's. So a BPMN import costs no second compile, and the function says so if anything
    ever asks it about other entries.
    """
    files = packages.read_files(archive)

    def compiled(given: Any) -> dict[str, Any]:
        if given is not files:
            raise RuntimeError("the importer asked to compile entries other than the upload's")
        return ir

    try:
        composition = import_bim(files, compile=compiled)
    except RecursionError as error:
        raise _inexpressible("The package nests too deeply for this version of the importer.") from error
    except (ImportError_, BpmnError) as error:
        raise _inexpressible(f"This version of the language cannot express the package: {error}") from error
    except (KeyError, TypeError, AttributeError, ValueError, ArithmeticError) as error:
        # The container accepted the package, so its shape is valid BIM; this is a shape the
        # importer was not written for. Named rather than left to become a 500, without the
        # raw error's text, which can quote the package.
        raise _inexpressible(
            f"The package has a shape this version of the importer does not read "
            f"({type(error).__name__}).",
        ) from error
    return composition, _written(document(composition))


@router.post(
    "/import",
    response_model=CompositionImportResponse,
    operation_id="importComposition",
    summary="Import a composition from a BIM package",
    responses=_BUSY,
)
async def import_composition(
    request: Request,
    caller: Optional[User] = Depends(get_optional_user),
) -> CompositionImportResponse:
    """An existing BIM v1 package, read back as a composition the editor can open.

    The body is the ``.bim.zip`` itself, as ``POST /v1/instances/validate`` takes it, within
    the smaller of the toolchain's package limit and the gateway's JSON body ceiling: the
    import is not an upload route, whose ceiling is 512 MiB buffered whole.
    The archive is compiled first, through the BIM port, so the container's own limits and
    checks judge it before anything here opens it; a package it refuses is a 422 with its
    diagnostics. Only then is it read back -- a BPMN workflow by delegation, from that same
    compilation -- written as canonical source, and read again by the language's own rules.

    **The import is exact up to what a solver sees, and says whether it was.** The
    composition is compiled once more and its IR digest compared with the upload's:
    ``round_trip.exact``. What the IR does not carry, the import cannot recover, and the
    language's importer is honest about it (``composition/read.py``): document titles and
    annotations, branch conditions, a fixed task (it comes back an open task with one
    candidate), a property's ``applies_to``. None of these moves the digest; all of them are
    gone. A value the importer makes explicit -- an inferred neutral, a goal's range -- comes
    back as if the author had written it.

    **It answers 422 when there is nothing to open**: an archive the container refuses
    (``invalid_instance``, ``invalid_package``), one this version of the language cannot
    express (``inexpressible_package``), or one that imports as a composition too long for an
    editor (``composition_too_large``). An import that reads as source and is then not valid,
    or not complete, is a 200 with the source and its located diagnostics, because the author
    can open the text and finish it; the round trip is compiled whenever the emitter can
    write what came back.
    """
    try:
        archive = await instances.read_package(instances.PackageRequest(
            headers=request.headers, read_body=request.body,
            max_compressed=_max_compressed, max_expanded=_max_expanded,
        ))
    except HTTPException as error:
        raise api_error(
            error.status_code, _UPLOAD_CODES.get(error.status_code, "invalid_package"),
            str(error.detail),
        ) from error
    try:
        result = await _port_compile(archive)
    except CompileError as error:
        raise api_error(
            422, "invalid_instance", "The container's compiler refused the package.",
            diagnostics=[item.model_dump(exclude_none=True) for item in _container_diagnostics(error)],
        ) from error
    except PackageError as error:
        raise api_error(422, "invalid_package", str(error)) from error
    except RecursionError as error:
        # The toolchain recurses through a package's documents, and an upload may nest as
        # deep as it likes: a package it cannot even walk is refused, not a 500.
        raise api_error(422, "invalid_package", "The package nests too deeply to read.") from error
    original = Compilation.from_result(archive, result)
    composition, source = await _read(_imported, archive, original.ir)
    reading = await _read(_read_source, source, True)
    if reading.composition is None:
        # The importer validates nothing, so what it returns is judged by the language like
        # any document -- and handed back like one: the text, with every problem located in
        # it, for the author to open and fix.
        return CompositionImportResponse(
            valid=False, complete=False, diagnostics=reading.diagnostics, source=source,
            ir_digest=original.ir_digest,
        )
    round_trip = None
    if not {item.code for item in reading.diagnostics} & _UNWRITABLE:
        # Whenever the emitter can write it, which is every complete composition and most
        # incomplete ones: a task the workflow never reaches, which the container accepts,
        # still round-trips. What completeness reports that the emitter cannot write -- a
        # goal with nothing to normalize over or over nothing at all, a neutral with no
        # bound -- skips it.
        again = await _compile(reading.composition)
        round_trip = CompositionRoundTripView(
            ir_digest=again.compilation.ir_digest if again.compilation is not None else None,
            exact=again.compilation is not None and again.compilation.ir_digest == original.ir_digest,
            container_diagnostics=again.container,
        )
    return CompositionImportResponse(
        valid=True, complete=reading.complete, diagnostics=reading.diagnostics,
        source=source, document=reading.canonical, neutrals=reading.neutrals,
        ir_digest=original.ir_digest, round_trip=round_trip,
    )


@lru_cache(maxsize=1)
def _language() -> CompositionLanguageView:
    """The language's tables, built once from the code that applies them."""
    templates: dict[str, CompositionTemplateView] = {}
    for name, (direction, aggregation) in TEMPLATES.items():
        blocks = {
            "sequence": aggregation.sequence,
            "parallel": aggregation.parallel,
            "exclusive": aggregation.exclusive,
            "repeat": aggregation.repeat,
            "selection": aggregation.selection,
        }
        kind = "ratio" if name in RATIO_TEMPLATES else PROPERTY_DEFAULTS["domain"]
        try:
            neutral, bound = infer_neutral(blocks, kind), None
        except Unbounded as error:
            neutral, bound = None, "max" if error.bound == "maximum" else "min"
        templates[name] = CompositionTemplateView(
            direction=direction, aggregate=blocks, domain=kind,
            neutral=neutral, neutral_from=bound,
        )
    rules = []
    for operator, rule in SEQUENCE_NEUTRALS.items():
        if isinstance(rule, str):
            rules.append(CompositionNeutralRuleView(
                sequence=operator, bound="max" if rule == "maximum" else "min",
                ratio=RATIO_NEUTRALS[operator],
            ))
        else:
            rules.append(CompositionNeutralRuleView(sequence=operator, value=rule))
    return CompositionLanguageView(
        language=LANGUAGE_ID,
        templates=templates,
        blocks={
            block: CompositionBlockView(default=default, operators=sorted(ALLOWED[block]))
            for block, default in BLOCK_DEFAULTS.items()
        },
        neutral_rules=rules,
        property_defaults=dict(PROPERTY_DEFAULTS),
    )


@router.get(
    "/language",
    response_model=CompositionLanguageView,
    operation_id="describeCompositionLanguage",
    summary="Describe the templates, operators and defaults of the composition language",
)
async def describe_composition_language() -> CompositionLanguageView:
    """What a property form needs to show before the author has written anything.

    The five templates with the direction, the five-block aggregation and the domain each
    fills in, and the neutral it implies -- or, for ``throughput``, the bound the property
    has to declare for there to be one. Each block's default operator and the operators it
    accepts. The neutral rule per sequence operator, for explaining a value; the value itself
    comes from ``/parse``, never from applying the rule in the browser. The defaults of a
    property that says nothing more.

    Every value is read from the code that applies it -- ``model.TEMPLATES``, the tables of
    ``neutral.py``, ``text.PROPERTY_DEFAULTS`` -- not restated, so this cannot drift from what
    the reader does. Open to every caller and every API key, like ``/v1/schemas``: it
    describes the language, not anyone's data.
    """
    return _language()


@lru_cache(maxsize=1)
def _schema_bytes() -> bytes:
    return json.dumps(schema(), separators=(",", ":"), ensure_ascii=False).encode("utf-8")


@router.get(
    "/schema",
    operation_id="getCompositionSchema",
    summary="Get the JSON Schema of a composition document",
    # ``Response`` rather than ``JSONResponse`` so the success response is declared only as
    # the media type below, not also as JSON with an empty schema.
    response_class=Response,
    responses={
        200: {
            "description": "The JSON Schema (Draft 2020-12) of a Composition2Yaml document.",
            "content": {"application/schema+json": {"schema": {"type": "object"}}},
        },
    },
)
async def get_composition_schema() -> Response:
    """The JSON Schema every composition document is judged against.

    The shape ``/parse`` returns and ``/serialise`` takes, with the enumerations and patterns
    a form validates a field against before sending it. It is the schema ``parse`` itself
    consults -- the same file, not a copy. Open to every caller and every API key, like
    ``/v1/schemas``.
    """
    return Response(_schema_bytes(), media_type="application/schema+json")


class CompositionDiffRequest(BaseModel):
    """Two Composition2Yaml documents, as the author writes them."""

    model_config = ConfigDict(extra="forbid")

    before: str = Field(
        min_length=1, max_length=MAX_SOURCE_CHARS,
        description="The earlier composition, as YAML source.",
    )
    after: str = Field(
        min_length=1, max_length=MAX_SOURCE_CHARS,
        description="The later composition, as YAML source.",
    )


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
    responses={422: {"description": "One of the two documents is not a composition."}, **_BUSY},
)
async def diff_compositions(
    request: CompositionDiffRequest,
    caller: Optional[User] = Depends(get_optional_user),
) -> CompositionDiffResponse:
    """Compare two Composition2Yaml documents and return the typed change list.

    Nothing is read from or written to storage, so no account is required: the request
    carries both operands and the response is a pure function of them.
    """
    return await _read(_diff_sources, request.before, request.after)


def _diff_sources(before: str, after: str) -> CompositionDiffResponse:
    return _diff_response(_parse(before, "before"), _parse(after, "after"))


def _diff_response(before, after) -> CompositionDiffResponse:
    """The one response body both diff forms return.

    The first version of this module promised that the stored-version form would be "an
    addition here, not a rewrite: the response body does not change". Built in one place,
    that is a property of the code rather than of two handlers that happen to agree.
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
            status_code=422, detail=f"{which}: not a readable composition ({type(error).__name__})",
        ) from error


# --------------------------------------------------------------- the stored composition
#
# Phase F2. This module's first docstring was written when nothing stored a composition, and it
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


async def _visitor_may_see(session: AsyncSession, project: Project, artifact: Artifact) -> bool:
    """A read-only visitor sees the project's own compositions, and others' only while published.

    The same narrowing the collection routes apply, and for the same reason: a public
    project may link an artifact that belongs to another organization -- a fork's origin,
    for instance -- and a public project is not a way to read one that is not published.
    """
    if not public_read.is_public_read(session):
        return True
    return artifact.organization_id == project.organization_id or await can_read(
        session, artifact, None,
    )


async def _readable(session: AsyncSession, project: Project, reference: str) -> Artifact:
    found = await _composition(session, project.id, reference)
    if not await _visitor_may_see(session, project, found):
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


async def _seal_version(
    session: AsyncSession, user: User, artifact: Artifact, organization_id: uuid.UUID,
    source: str, *, label: str | None, based_on: ArtifactVersion | None,
) -> CompositionVersionView:
    """Seal the source as the artifact's next version, or return the one that already holds it.

    Shared by the version route and the fork, so "sealing a version" means one thing. The
    dedup is what makes re-forking an unchanged origin a no-op rather than a second copy.
    """
    content, _contracts = validate_content(
        "Composition", DraftContent(content=source, media_type=SOURCE_MEDIA_TYPE),
    )
    content_digest = digest_bytes(content)
    existing = await session.scalar(select(ArtifactVersion).where(
        ArtifactVersion.artifact_id == artifact.id,
        ArtifactVersion.content_digest == content_digest,
    ))
    if existing is not None:
        return _version_view(artifact, existing)

    # Lock the identity before taking an ordinal or a label, as the collection library does:
    # two writers sealing at once would otherwise agree on the same next ordinal.
    await session.execute(select(Artifact.id).where(Artifact.id == artifact.id).with_for_update())
    ordinal = int(await _latest_ordinal(session, artifact.id) or 0) + 1
    chosen = label or str(ordinal)
    clash = await session.scalar(select(ArtifactVersion).where(
        ArtifactVersion.artifact_id == artifact.id, ArtifactVersion.version == chosen))
    if clash is not None:
        raise api_error(409, "immutable_version", "Version label already identifies different content.")

    blob = await store_blob(session, artifact, user, content, SOURCE_MEDIA_TYPE)
    manifest = {
        "apiVersion": "openbinding/artifact/v1", "kind": "Composition",
        "identity": {"namespace": artifact.namespace, "name": artifact.name, "version": chosen},
        "contentDigest": content_digest, "mediaType": SOURCE_MEDIA_TYPE,
        "contracts": [], "dependencies": [],
    }
    created = ArtifactVersion(
        artifact_id=artifact.id, ordinal=ordinal, version=chosen, blob_id=blob.id,
        content_digest=content_digest, version_digest=digest(manifest), manifest=manifest,
        based_on_id=based_on.id if based_on else None, created_by_id=user.id,
    )
    session.add(created)
    await session.flush()
    _audit_event(session, user, "composition.version.created", created, organization_id,
                 digest=content_digest)
    return _version_view(artifact, created)


async def _existing_fork(
    session: AsyncSession, origin: Artifact, target_project_id: uuid.UUID,
) -> Artifact | None:
    """The fork of this origin that already lives in the target project, if there is one.

    This is the question SPHERE answers with a denormalised ``forkedFrom`` record, and its
    reason is written there: *"to match a re-fork of the same origin to the fork already
    living in the target organization, instead of creating a duplicate pricing every time
    the origin gets a new version"*. Here the edge itself answers it -- any version of the
    candidate whose ``based_on_id`` belongs to the origin -- which is the query
    ``ix_artifact_versions_based_on_id`` exists for. No copy to keep in step, and the
    foreign key is ``RESTRICT``, so the lineage cannot go stale underneath it.
    """
    origin_versions = select(ArtifactVersion.id).where(ArtifactVersion.artifact_id == origin.id)
    return (await session.execute(
        select(Artifact)
        .join(ProjectArtifact, ProjectArtifact.artifact_id == Artifact.id)
        .join(ArtifactVersion, ArtifactVersion.artifact_id == Artifact.id)
        .where(
            ProjectArtifact.project_id == target_project_id,
            Artifact.kind == "Composition",
            Artifact.id != origin.id,
            Artifact.archived == False,  # noqa: E712 - an archived fork is not the live one
            ArtifactVersion.based_on_id.in_(origin_versions),
        )
        .order_by(Artifact.created_at)
        .limit(1),
    )).scalars().first()


async def _latest_sealed(session: AsyncSession, artifact: Artifact) -> ArtifactVersion:
    """The newest version by ordinal, which is the one a fork takes when none is named."""
    found = (await session.execute(
        select(ArtifactVersion).where(ArtifactVersion.artifact_id == artifact.id)
        .order_by(ArtifactVersion.ordinal.desc()).limit(1),
    )).scalars().first()
    if found is None:
        raise api_error(404, "no_version", "A composition with no sealed version cannot be forked.")
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
    return [await _composition_view(session, row, found_project.id) for row in rows
            if await _visitor_may_see(session, found_project, row)]


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
    found = await _readable(session, found_project, composition)
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
    found = await _readable(session, found_project, composition)
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

    based_on: ArtifactVersion | None = None
    if payload.based_on is not None:
        based_on = await session.get(ArtifactVersion, payload.based_on)
        if based_on is None:
            raise api_error(422, "unknown_origin", "The version this one is based on does not exist.")
    return await _seal_version(
        session, user, found, organization.id, payload.source,
        label=payload.version, based_on=based_on,
    )


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
    found = await _readable(session, found_project, composition)
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
    from_: Optional[str] = Query(None, alias="from", min_length=1, description="The earlier version."),
    to: Optional[str] = Query(None, min_length=1, description="The later version."),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionDiffResponse:
    """The stored-version form the module docstring promised.

    The response body is the one ``POST /v1/compositions/diff`` returns, which was the
    promise: the same typed change list, sectioned the same way. Only the operands differ --
    two sealed versions of one stored composition rather than two documents in a request.

    **Both operands are optional, and omitting them compares the last two versions.** The
    default is the one the compare screen already uses for a binding case -- the previous
    version against the latest -- so the question a reader arrives with, "what changed?",
    needs no parameters. A composition with fewer than two versions has no pair to compare
    and answers 404.

    Declaring them required would have been the obvious way to write it and was wrong for a
    second reason: FastAPI validates query parameters **before** any dependency runs, so a
    caller with no access to the project got a 422 about a missing parameter instead of the
    403 the project's privacy owes them -- the route answered about a private project's
    existence to someone who could not read it. Authorization comes first here.
    """
    _organization, found_project = await _project_context(
        session, org, project, user, OrganizationRole.VIEWER,
    )
    found = await _readable(session, found_project, composition)
    if from_ is None or to is None:
        recent = (await session.execute(
            select(ArtifactVersion).where(ArtifactVersion.artifact_id == found.id)
            .order_by(ArtifactVersion.ordinal.desc()).limit(2),
        )).scalars().all()
        if len(recent) < 2:
            raise api_error(
                404, "no_pair_to_compare",
                "A composition needs two sealed versions before there is a change to report.",
            )
        later_default, earlier_default = recent[0], recent[1]
        from_ = from_ if from_ is not None else str(earlier_default.ordinal)
        to = to if to is not None else str(later_default.ordinal)
    earlier, later = await _sealed(session, found, from_), await _sealed(session, found, to)
    before_bytes, _ = await version_content(session, earlier)
    after_bytes, _ = await version_content(session, later)
    return _diff_response(
        _parse(before_bytes.decode(), "from"), _parse(after_bytes.decode(), "to"),
    )


@project_router.post(
    "/compositions/{composition}/fork", response_model=CompositionVersionView,
    status_code=201, operation_id="forkComposition",
    responses={409: {"description": "The target project already holds that slug."}},
)
async def fork_composition(
    org: str, project: str, composition: str, payload: CompositionForkRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionVersionView:
    """Take a version of this composition into another project, or update the fork already there.

    Two accesses, deliberately different: the origin is read under **VIEWER** and the target
    needs **MEMBER**, because the fork is a write there.

    **An outsider cannot fork a public composition in one call, and that is the public-read
    mechanism rather than a gap here.** ``access/public_read.py`` binds eligibility to the
    *request*: a request is eligible only when its method is GET and its template is listed.
    This is a POST, so the origin read inside it is never eligible however public the origin
    project is. The path that does work keeps the lineage intact and needs nothing new --
    read the sealed source (a listed GET), then seal it in your own project naming the origin
    version in ``based_on``. Two calls, and the same edge. Measured, with a test for it.

    **Re-forking does not duplicate.** If the target project already holds a fork of this
    origin, the new version is sealed on it rather than creating a second artifact. That is
    SPHERE's rule and its stated reason: *"to match a re-fork of the same origin to the fork
    already living in the target organization, instead of creating a duplicate pricing every
    time the origin gets a new version"*. Re-forking an **unchanged** origin version seals
    nothing at all, because the content digest already identifies it.

    The lineage is the `based_on_id` edge itself, not a copy of the origin's identity. The
    column needed no widening: it is a foreign key to `artifact_versions.id` with no
    same-artifact restriction, so it already crosses artifacts, and it is `RESTRICT`, so the
    origin cannot be deleted out from under a fork. SPHERE denormalises the record because
    there an origin *can* disappear; here the database refuses.
    """
    _origin_organization, origin_project = await _project_context(
        session, org, project, user, OrganizationRole.VIEWER,
    )
    origin = await _readable(session, origin_project, composition)
    taken = (
        await _sealed(session, origin, payload.version)
        if payload.version is not None
        else await _latest_sealed(session, origin)
    )

    target_organization, target_project = await _project_context(
        session, payload.target_organization, payload.target_project, user,
        OrganizationRole.MEMBER,
    )
    if target_project.id == origin_project.id and (payload.slug or origin.name) == origin.name:
        raise api_error(
            409, "slug_conflict",
            "A fork in the origin's own project needs a slug of its own.",
        )

    source, _media_type = await version_content(session, taken)
    existing = await _existing_fork(session, origin, target_project.id)
    if existing is not None:
        return await _seal_version(
            session, user, existing, target_organization.id, source.decode(),
            label=None, based_on=taken,
        )

    slug = payload.slug or origin.name
    duplicate = (await session.execute(select(Artifact).join(ProjectArtifact).where(
        ProjectArtifact.project_id == target_project.id, Artifact.kind == "Composition",
        Artifact.name == slug,
        Artifact.archived == False,  # noqa: E712 - archiving frees the slug, by design
    ))).scalars().first()
    if duplicate is not None:
        raise api_error(409, "slug_conflict", "That composition slug is in use in the target project.")

    fork = Artifact(
        organization_id=target_organization.id, namespace=str(target_organization.id),
        name=slug, display_name=origin.display_name, description=origin.description,
        kind="Composition", created_by_id=user.id,
    )
    session.add(fork)
    await session.flush()
    session.add(ProjectArtifact(project_id=target_project.id, artifact_id=fork.id))
    await session.flush()
    _audit_event(session, user, "composition.forked", fork, target_organization.id,
                 origin=str(origin.id), origin_version=str(taken.id))
    return await _seal_version(
        session, user, fork, target_organization.id, source.decode(),
        label=None, based_on=taken,
    )
