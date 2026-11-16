"""The Composition2Yaml services: validate, parse, serialise and diff a document, and diff two stored ones.

Each one runs the pure library (``openbinding_gateway.composition.text``) in a worker thread
under one :func:`~.slots.language_slot`, so a large document never blocks the event loop and
the work in flight is bounded per process. The deployment's SPHERE registry aliases are the
only context: none of these services knows an organization, a composition or a problem, so
the checks against a problem belong to the organization's routes.

A document arrives as bytes and is decoded as UTF-8, strictly: a byte that is not UTF-8 is
``c2y_syntax`` at its line, as any other text the reader cannot read. Diagnostics leave
through :func:`diagnostic_view`: code, message, severity, dotted path, JSON Pointer and span,
the span ``None`` where there is no text to point into (a JSON document).
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, TypeVar

from ....composition import diff as composition_diff
from ....composition import text
from ....composition.diagnostics import SYNTAX, CompositionError, Diagnostic, Span
from ....core.settings import get_settings
from .slots import language_slot

T = TypeVar("T")

#: The two sides of a diff, as the diagnostics of a refused one name them.
SIDES = ("before", "after")


class LanguageRefusal(Exception):
    """A document with errors: every diagnostic, as the wire carries them."""

    def __init__(self, diagnostics: list[dict[str, Any]]) -> None:
        self.diagnostics = diagnostics
        super().__init__(f"{len(diagnostics)} diagnostics")


def diagnostic_view(item: Diagnostic, **extra: str) -> dict[str, Any]:
    """One diagnostic as the wire carries it (``CompositionDiagnosticView``)."""
    span = item.span
    view: dict[str, Any] = {
        "code": item.code,
        "message": item.message,
        "severity": item.severity,
        "path": item.path,
        "pointer": item.pointer if item.pointer is not None else "",
        "span": None if span is None else {
            "line": span.line, "column": span.column, "end_line": span.end_line, "end_column": span.end_column,
        },
    }
    view.update(extra)
    return view


def context() -> text.Context:
    """What a reading here depends on beyond the text: the deployment's registry aliases."""
    return text.Context(registries=get_settings().sphere_registry_aliases)


def decode(raw: bytes) -> str | Diagnostic:
    """The document's text; a byte that is not UTF-8 is ``c2y_syntax`` where it stands."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as error:
        before = raw[: error.start].decode("utf-8")
        line = before.count("\n") + 1
        column = len(before) - (before.rfind("\n") + 1) + 1
        return Diagnostic(
            code=SYNTAX,
            message=f"the document is not UTF-8 text: byte {error.start} cannot be decoded",
            path="",
            pointer="",
            span=Span(line=line, column=column, end_line=line, end_column=column + 1),
        )


def _read(raw: bytes) -> text.Reading:
    decoded = decode(raw)
    if isinstance(decoded, Diagnostic):
        return text.Reading(None, (decoded,))
    return text.read(decoded, context=context())


async def _run(work: Callable[..., T], *arguments: Any) -> T:
    async with language_slot():
        return await asyncio.to_thread(work, *arguments)


async def validate(raw: bytes) -> text.Reading:
    """The editor's lint: every diagnostic of a document, errors, warnings and infos alike."""
    return await _run(_read, raw)


def _parse(raw: bytes) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    reading = _read(raw)
    if reading.document is None:
        raise LanguageRefusal([diagnostic_view(item) for item in reading.diagnostics])
    return text.document(reading.document), [diagnostic_view(item) for item in reading.diagnostics]


async def parse(raw: bytes) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The document as the JSON model an editor mutates, and its warnings and infos.

    Raises :class:`LanguageRefusal` when the document has an error.
    """
    return await _run(_parse, raw)


def _serialise(source: Any) -> str:
    reading = text.compose(source, context=context())
    if reading.document is None:
        raise LanguageRefusal([diagnostic_view(item) for item in reading.diagnostics])
    try:
        return text.serialise(reading.document)
    except CompositionError as error:
        raise LanguageRefusal([diagnostic_view(item) for item in error.diagnostics]) from None


async def serialise(source: Any) -> str:
    """A JSON document's canonical text; raises :class:`LanguageRefusal` when it has an error."""
    return await _run(_serialise, source)


def _diff(before: bytes, after: bytes) -> dict[str, Any]:
    readings = {side: _read(raw) for side, raw in zip(SIDES, (before, after), strict=True)}
    refused = [
        diagnostic_view(item, document=side)
        for side, reading in readings.items() if reading.document is None
        for item in reading.diagnostics
    ]
    if refused:
        raise LanguageRefusal(refused)
    was, now = (readings[side].document for side in SIDES)
    assert was is not None and now is not None
    return composition_diff.diff(was, now)


async def diff(before: bytes, after: bytes) -> dict[str, Any]:
    """What changed from one document to another (SPHERE's PricingDiff shape, with ``comparison``);
    raises :class:`LanguageRefusal`, each diagnostic naming its ``document``, when either side has an error."""
    return await _run(_diff, before, after)


def _diff_stored(before: str, after: str) -> dict[str, Any]:
    return composition_diff.diff(text.read_stored(before), text.read_stored(after))


async def diff_stored(before: str, after: str) -> dict[str, Any]:
    """What changed from one sealed version's content to another's.

    Stored bytes are read in the stored mode: they read when they were sealed, whatever registries the
    deployment defines today.
    """
    return await _run(_diff_stored, before, after)


def _document_stored(content: str) -> dict[str, Any]:
    return text.document(text.read_stored(content))


async def document_stored(content: str) -> dict[str, Any]:
    """A sealed version's content as the canonical JSON model, read in the stored mode: the version reads
    as it was sealed, whatever registries the deployment defines today, and no fresh check runs."""
    return await _run(_document_stored, content)


__all__ = [
    "LanguageRefusal",
    "SIDES",
    "context",
    "decode",
    "diagnostic_view",
    "diff",
    "diff_stored",
    "document_stored",
    "parse",
    "serialise",
    "validate",
]
