"""The Composition2Yaml goldens: what each document reads to, and the exact bytes it writes.

``golden/valid/NN_name.yaml`` reads with exactly the diagnostics of its optional
``.notes.json`` (warnings and infos, each with its span) and serialises to exactly the bytes
of ``NN_name.canonical.yaml``. ``golden/invalid/name.yaml`` reads to exactly the list of its
``.expected.json``: code, severity, path, pointer and span, in order. An optional
``.context.json`` gives the deployment's registries and the entity's slug.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from _paths import TESTS_DIR
from openbinding_gateway.composition import text
from openbinding_gateway.composition.diagnostics import Diagnostic

GOLDEN = TESTS_DIR / "composition" / "golden"


def _sources(kind: str) -> list[Path]:
    return sorted(
        path for path in (GOLDEN / kind).glob("*.yaml") if not path.name.endswith(".canonical.yaml")
    )


def _sibling(source: Path, suffix: str) -> Path:
    return source.with_name(source.name.removesuffix(".yaml") + suffix)


def _context(source: Path) -> text.Context:
    path = _sibling(source, ".context.json")
    if not path.is_file():
        return text.Context()
    given = json.loads(path.read_text(encoding="utf-8"))
    return text.Context(registries=frozenset(given.get("registries", ())), entity_slug=given.get("entity_slug"))


def _listed(diagnostics: tuple[Diagnostic, ...]) -> list[dict]:
    return [
        {
            "code": item.code,
            "severity": item.severity,
            "path": item.path,
            "pointer": item.pointer,
            "span": None if item.span is None
            else [item.span.line, item.span.column, item.span.end_line, item.span.end_column],
        }
        for item in diagnostics
    ]


VALID = _sources("valid")
INVALID = _sources("invalid")


def test_there_are_goldens() -> None:
    assert len(VALID) >= 7 and len(INVALID) >= 20


@pytest.mark.parametrize("source", VALID, ids=lambda path: path.stem)
def test_a_valid_golden_reads_with_its_notes_and_writes_its_canonical_bytes(source: Path) -> None:
    reading = text.read(source.read_text(encoding="utf-8"), context=_context(source))
    notes = _sibling(source, ".notes.json")
    expected = json.loads(notes.read_text(encoding="utf-8")) if notes.is_file() else []
    assert _listed(reading.diagnostics) == expected
    assert reading.valid and reading.document is not None
    canonical = _sibling(source, ".canonical.yaml").read_text(encoding="utf-8")
    assert text.serialise(reading.document) == canonical


@pytest.mark.parametrize("source", INVALID, ids=lambda path: path.stem)
def test_an_invalid_golden_reads_to_exactly_its_diagnostics(source: Path) -> None:
    reading = text.read(source.read_text(encoding="utf-8"), context=_context(source))
    expected = json.loads(_sibling(source, ".expected.json").read_text(encoding="utf-8"))
    assert _listed(reading.diagnostics) == expected
    assert not reading.valid and reading.document is None


@pytest.mark.parametrize("source", INVALID, ids=lambda path: path.stem)
def test_every_invalid_golden_is_located(source: Path) -> None:
    """Every structural refusal underlines something in the text."""
    reading = text.read(source.read_text(encoding="utf-8"), context=_context(source))
    assert all(item.span is not None for item in reading.errors)


def test_a_document_past_the_size_limit_is_refused_before_it_is_read() -> None:
    """Generated rather than committed: a golden of 256 KiB would be most of the directory."""
    source = (GOLDEN / "valid" / "01_declared_minimal.yaml").read_text(encoding="utf-8")
    padded = source + "#" * (text.MAX_SOURCE_BYTES - len(source.encode("utf-8")) + 1) + "\n"
    reading = text.read(padded)
    assert _listed(reading.diagnostics) == [
        {"code": "c2y_too_long", "severity": "error", "path": "", "pointer": "", "span": None},
    ]
