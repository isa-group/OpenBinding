"""What an assessment leaves to be stored: the evaluation of one version, before it has a row.

An :class:`EvaluationDraft` holds every column of a composition evaluation but its own id, the version it
belongs to and who stored it, which only sealing knows. A linked version is evaluated by the toolchain
(``basis = "bim"``), once per toolchain release (its ``compiler_digest`` is the ``basis_key``); a declared
one is not evaluated at all (``basis = "declared"``, ``basis_key = "declared"``), and its values are the
author's. The values are kept as the toolchain returned them, never recomputed.

A :class:`DerivationDraft` is the edge a derived version stores: the source it was derived from (a run's
solution, or a binding given with a problem revision), the binding in BIM form and where it was evaluated.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Mapping

from ....composition.diagnostics import Diagnostic
from ....composition.document import Value

Basis = Literal["bim", "declared"]
Outcome = Literal["verified", "binding_invalid", "semantics_changed", "declared"]
Source = Literal["run", "binding"]

#: The basis key of an evaluation that is not the toolchain's.
DECLARED = "declared"


def basis_key(compiler_digest: str | None) -> str:
    """What makes an evaluation unique within its version: the toolchain's ``compilerDigest``, or ``declared``."""
    return DECLARED if compiler_digest is None else compiler_digest


def values_json(values: Iterable[tuple[str, Value]]) -> dict[str, dict[str, Any]]:
    """The values as stored: ``{name: {value, unit}}``, the numbers unchanged."""
    return {name: {"value": value.value, "unit": value.unit} for name, value in values}


@dataclass(frozen=True, slots=True)
class EvaluationDraft:
    """One evaluation of a version, every column but its id, its version and who stored it."""

    basis: Basis
    basis_key: str
    outcome: Outcome
    values: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    #: The revision and the compilation evaluated (the installed toolchain's), for ``basis = "bim"``.
    revision_id: uuid.UUID | None = None
    compilation_id: uuid.UUID | None = None
    compiler_digest: str | None = None
    compilation_digest: str | None = None
    semantic_digest: str | None = None
    ir_digest: str | None = None
    toolchain: Mapping[str, Any] | None = None
    #: The binding as the toolchain was given it, ``{task: {resource, id}}``.
    binding: Mapping[str, Mapping[str, str]] | None = None
    #: What the toolchain's evaluation returned, as it returned it.
    result: Mapping[str, Any] | None = None
    #: What the assessment found, every severity; located in the version's content when it is stored.
    diagnostics: tuple[Diagnostic, ...] = ()

    @classmethod
    def declared(cls, values: Iterable[tuple[str, Value]], diagnostics: Iterable[Diagnostic] = ()) -> "EvaluationDraft":
        """The evaluation of a version linked to no problem: the author's values."""
        return cls(
            basis="declared", basis_key=DECLARED, outcome="declared",
            values=values_json(values), diagnostics=tuple(diagnostics),
        )


@dataclass(frozen=True, slots=True)
class DerivationDraft:
    """How a version was derived, every column but its id, its version and who stored it."""

    source: Source
    revision_id: uuid.UUID
    #: The compilation the derived document links: the run's, for a run.
    compilation_id: uuid.UUID
    #: ``{task: {resource, id}}``, as the toolchain was given it.
    binding: Mapping[str, Mapping[str, str]]
    binding_digest: str
    #: ``{toolchain, irDigest, semanticDigest, evaluatedCompilationId, run}``.
    provenance: Mapping[str, Any]
    job_id: uuid.UUID | None = None
    point: int | None = None


__all__ = [
    "DECLARED",
    "Basis",
    "DerivationDraft",
    "EvaluationDraft",
    "Outcome",
    "Source",
    "basis_key",
    "values_json",
]
