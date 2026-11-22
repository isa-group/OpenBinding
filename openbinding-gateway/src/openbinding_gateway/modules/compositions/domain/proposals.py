"""Proposals (F6, plan §8): the step-kind registry and the rules every kind shares. Pure: no session, no I/O.

A proposal is a typed list of steps, built and validated in code from a request (the web form; F7's tools), stored
with each step's base revisions, shown, and applied only after its author confirms. Whatever makes the request never
writes; it only proposes. This module holds what does not need the database:

* the statuses (lower-case, as every OpenBinding enum) and :data:`STEP_LIMIT`;
* the :class:`StepKind` protocol each kind implements (its parameters, referenceable parameters and outputs, whether
  it is destructive, the key permission it needs, and the builder, pre-flight and apply halves), and
  :data:`REGISTRY`, where ``application.proposals`` registers ``seal_derived`` and ``adopt`` and F7 adds its own;
* references between steps, ``@s<n>.<output>`` (:func:`parse_reference`, :func:`references_in`);
* :func:`normalise_phrase`, how a typed confirmation phrase is compared (adapted from SPHERE, MIT, at ``73779a8a``:
  ``frontend/src/modules/orbit/components/plan-card.tsx``, ``normalizePhrase``).

The plan model, the supersession, the phrase and the executor follow SPHERE's ORBIT (``OrbitPlanService``,
``OrbitPlanRepository``, ``OrbitExecutorService``); see ``docs/adr/0058-proposals-and-the-executor.md``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterator, Literal, Mapping, Protocol, runtime_checkable

#: The most steps one proposal holds (the ``proposal_steps`` ordinal CHECK says the same).
STEP_LIMIT = 8

ProposalStatus = Literal["pending", "executing", "completed", "partial", "failed", "cancelled", "superseded", "stale"]
StepStatus = Literal["pending", "done", "failed", "skipped"]
Origin = Literal["web", "mcp", "chat"]

#: The statuses a proposal never leaves.
TERMINAL: frozenset[str] = frozenset({"completed", "partial", "failed", "cancelled", "superseded", "stale"})

#: Why a pending proposal is stale at confirm (its base no longer holds); nothing is applied.
STALE_REASONS = (
    "head_version_changed", "derivation_changed", "environment_changed", "environment_missing", "run_unreadable",
    "version_missing", "composition_archived",
)

_REFERENCE = re.compile(r"@s([1-9][0-9]?)\.([a-z][A-Za-z]{0,31})")


@dataclass(frozen=True, slots=True)
class Reference:
    """``@s<step>.<output>``: the output ``output`` of the earlier step ``step``."""

    step: int
    output: str

    def __str__(self) -> str:
        return f"@s{self.step}.{self.output}"


def parse_reference(value: Any) -> Reference | None:
    """The reference ``value`` is, or ``None`` when it is not one (any other value, including a malformed ``@s``)."""
    if not isinstance(value, str):
        return None
    found = _REFERENCE.fullmatch(value)
    return Reference(int(found.group(1)), found.group(2)) if found else None


def looks_like_reference(value: Any) -> bool:
    """Whether ``value`` claims to be a reference (starts with ``@s``), well formed or not."""
    return isinstance(value, str) and value.startswith("@s")


def references_in(params: Any, prefix: str = "") -> Iterator[tuple[str, Any]]:
    """Every string in ``params`` that claims to be a reference, with its dotted parameter path."""
    if isinstance(params, Mapping):
        for key, value in params.items():
            yield from references_in(value, f"{prefix}.{key}" if prefix else str(key))
    elif isinstance(params, (list, tuple)):
        for index, value in enumerate(params):
            yield from references_in(value, f"{prefix}.{index}")
    elif looks_like_reference(params):
        yield prefix, params


def at_path(params: Mapping[str, Any], path: str) -> Any:
    """The value at the dotted ``path`` of ``params`` (``None`` when absent)."""
    value: Any = params
    for part in path.split("."):
        if not isinstance(value, Mapping):
            return None
        value = value.get(part)
    return value


def with_path(params: Mapping[str, Any], path: str, value: Any) -> dict[str, Any]:
    """A copy of ``params`` with ``value`` at the dotted ``path``."""
    head, _, rest = path.partition(".")
    copied = dict(params)
    copied[head] = with_path(copied.get(head) or {}, rest, value) if rest else value
    return copied


def normalise_phrase(phrase: str | None) -> str:
    """A typed phrase as it is compared: trimmed, inner whitespace collapsed, lower case (SPHERE's ``plan-card.tsx``)."""
    return " ".join((phrase or "").split()).lower()


@runtime_checkable
class StepKind(Protocol):
    """One kind of step. ``context`` is the application's (session, organization, composition, caller); ``step`` the
    stored row. A kind never commits in ``build``, ``check_base`` or ``check_deferred``; ``apply`` may (a seal and an
    adoption each commit by themselves) and raises the refusal its writer raises.

    * ``params_model``: validates the stored parameters (a pydantic model; referenceable ones may hold a reference);
    * ``referenceable``: dotted parameter paths that may hold ``@s<n>.<output>``;
    * ``outputs``: what the step's ``result`` names for later steps (``seal_derived``: ``version``);
    * ``destructive``: such a step goes alone, behind a typed phrase;
    * ``key_permission``: what a personal API key needs for this step (checked by the executor at confirm);
    * ``build(context, params, referenced, ordinal)`` -> the stored ``params``, ``base``, ``preview``, ``description``,
      ``warnings`` and the phrase of a destructive step; ``referenced`` maps a referenceable path to its reference;
    * ``check_base(context, step)`` -> the stale reasons of the stored base (deferred parts are not checked here);
    * ``check_permission(context, step)`` -> raises 403 when the confirming caller may not run this step;
    * ``apply(context, step, outputs)`` -> the result (``outputs``: earlier steps' results by ordinal), after
      ``check_deferred`` checked the parts decided by earlier steps.
    """

    name: str
    params_model: Any
    referenceable: frozenset[str]
    outputs: frozenset[str]
    destructive: bool
    key_permission: str

    async def build(self, context: Any, params: dict[str, Any], referenced: dict[str, Reference],
                    ordinal: int) -> Any: ...

    async def check_base(self, context: Any, step: Any) -> list[dict[str, Any]]: ...

    async def check_permission(self, context: Any, step: Any) -> None: ...

    async def check_deferred(self, context: Any, step: Any, outputs: dict[int, dict[str, Any]]) -> None: ...

    async def apply(self, context: Any, step: Any, outputs: dict[int, dict[str, Any]]) -> dict[str, Any]: ...


#: Every step kind, by name. ``application.proposals`` registers F6's two; F7 adds its own and widens the CHECK.
REGISTRY: dict[str, StepKind] = {}


def register(kind: StepKind) -> StepKind:
    """Add ``kind`` to the registry (a kind is registered once; a test-only kind is removed after its test)."""
    if kind.name in REGISTRY and REGISTRY[kind.name] is not kind:
        raise ValueError(f"step kind {kind.name!r} is already registered")
    REGISTRY[kind.name] = kind
    return kind


def unregister(name: str) -> None:
    REGISTRY.pop(name, None)


__all__ = [
    "REGISTRY",
    "STALE_REASONS",
    "STEP_LIMIT",
    "TERMINAL",
    "Origin",
    "ProposalStatus",
    "Reference",
    "StepKind",
    "StepStatus",
    "at_path",
    "looks_like_reference",
    "normalise_phrase",
    "parse_reference",
    "references_in",
    "register",
    "unregister",
    "with_path",
]
