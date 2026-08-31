from __future__ import annotations

import re
from dataclasses import dataclass
from itertools import pairwise
from typing import Any

from .utils import safe_id

APPLICATION_RESOURCE = "application"


@dataclass(frozen=True)
class TaskCall:
    """Source-only details attached to a native BIM task reference."""

    task: dict[str, str]
    bindings: tuple[str, ...]
    latency_bound_ms: float


@dataclass(frozen=True)
class Orchestration:
    """The original dataset orchestration represented as BIM v1 workflow data."""

    workflow: dict[str, Any]
    calls: dict[str, TaskCall]


@dataclass(frozen=True)
class WorkflowFlow:
    """Entry, exit and transfer information expressed with BIM references."""

    first: tuple[dict[str, str], ...]
    last: tuple[dict[str, str], ...]
    transitions: tuple[dict[str, Any], ...]


TOKEN_RE = re.compile(r"\s*([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[\[\](),])")


class OrchestrationParser:
    """Parse the external ICSOC dataset DSL directly into BIM v1 blocks."""

    def __init__(self, text: str, application_resource: str = APPLICATION_RESOURCE):
        self.tokens = [match.group(1) for match in TOKEN_RE.finditer(text)]
        joined = "".join(self.tokens)
        compact = re.sub(r"\s+", "", text)
        if joined != compact:
            raise ValueError(f"Unsupported orchestration syntax near: {text}")
        self.pos = 0
        self.application_resource = application_resource
        self.calls: dict[str, TaskCall] = {}
        self._exclusive_counter = 0

    def parse(self) -> Orchestration:
        workflow = self._expression()
        if self.pos != len(self.tokens):
            raise ValueError(f"Unexpected trailing token: {self.tokens[self.pos]}")
        return Orchestration(workflow=workflow, calls=dict(self.calls))

    def _peek(self) -> str | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def _take(self) -> str:
        if self.pos >= len(self.tokens):
            raise ValueError("Unexpected end of orchestration")
        token = self.tokens[self.pos]
        self.pos += 1
        return token

    def _expect(self, expected: str) -> None:
        actual = self._take()
        if actual != expected:
            raise ValueError(f"Expected '{expected}', got '{actual}'")

    def _expression(self) -> dict[str, Any]:
        head = self._take()
        if head == "fun":
            return self._task()
        if head == "seq":
            self._expect("(")
            first = self._expression()
            self._expect(",")
            second = self._expression()
            self._expect(")")
            return {"sequence": [first, second]}
        if head == "par":
            self._expect("(")
            if self._peek() == "[":
                self._expect("[")
                children = [self._expression()]
                while self._peek() == ",":
                    self._expect(",")
                    children.append(self._expression())
                self._expect("]")
            else:
                children = [self._expression()]
                self._expect(",")
                children.append(self._expression())
            self._expect(")")
            return {"parallel": children}
        if head == "if":
            self._expect("(")
            guard = self._expression()
            self._expect(",")
            then_branch = self._expression()
            self._expect(",")
            else_branch = self._expression()
            self._expect(")")
            self._exclusive_counter += 1
            group = safe_id(f"exclusive_{self._exclusive_counter}")
            return {
                "sequence": [
                    guard,
                    {
                        "exclusive": [
                            {"id": f"{group}_branch_1", "flow": then_branch},
                            {"id": f"{group}_branch_2", "flow": else_branch},
                        ]
                    },
                ]
            }
        raise ValueError(f"Unsupported orchestration expression '{head}'")

    def _task(self) -> dict[str, Any]:
        self._expect("(")
        source_name = self._take()
        self._expect(",")
        bindings = self._binding_list()
        self._expect(",")
        latency = float(self._take())
        self._expect(")")
        name = safe_id(source_name)
        reference = {"resource": self.application_resource, "id": name}
        if name in self.calls:
            raise ValueError(
                f"Task {source_name!r} appears more than once in the orchestration"
            )
        self.calls[name] = TaskCall(
            task=reference,
            bindings=tuple(bindings),
            latency_bound_ms=latency,
        )
        return {"task": reference}

    def _binding_list(self) -> list[str]:
        self._expect("[")
        if self._peek() == "]":
            self._expect("]")
            return []
        bindings = [self._take()]
        while self._peek() == ",":
            self._expect(",")
            bindings.append(self._take())
        self._expect("]")
        return bindings


def parse_orchestration(
    text: str,
    application_resource: str = APPLICATION_RESOURCE,
) -> Orchestration:
    return OrchestrationParser(text, application_resource).parse()


def routing_entries(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Build the separate BIM routing overlay from native exclusive branches."""
    entries: list[dict[str, Any]] = []

    def walk(node: dict[str, Any]) -> None:
        for branch in node.get("exclusive", []):
            entries.append(
                {
                    "target": {
                        "resource": APPLICATION_RESOURCE,
                        "id": branch["id"],
                    },
                    "probability": 0.5,
                }
            )
            walk(branch["flow"])
        for key in ("sequence", "parallel"):
            for child in node.get(key, []):
                walk(child)
        repeat = node.get("repeat")
        if repeat:
            walk(repeat["body"])

    walk(workflow)
    return entries


def _reference_key(reference: dict[str, str]) -> tuple[str, str]:
    return reference["resource"], reference["id"]


def _unique_references(references: list[dict[str, str]]) -> tuple[dict[str, str], ...]:
    unique: dict[tuple[str, str], dict[str, str]] = {}
    for reference in references:
        unique[_reference_key(reference)] = reference
    return tuple(unique[key] for key in sorted(unique))


def derive_transitions(orchestration: Orchestration) -> WorkflowFlow:
    """Derive bounded task-to-task transfers from a native BIM workflow."""

    def visit(node: dict[str, Any]) -> WorkflowFlow:
        reference = node.get("task")
        if reference:
            return WorkflowFlow(first=(reference,), last=(reference,), transitions=())

        if "sequence" in node:
            children = [visit(child) for child in node["sequence"]]
            transitions: list[dict[str, Any]] = [
                transition for child in children for transition in child.transitions
            ]
            for left, right in pairwise(children):
                for source in left.last:
                    for target in right.first:
                        call = orchestration.calls[target["id"]]
                        transitions.append(
                            {
                                "from": source,
                                "to": target,
                                "maximum": float(call.latency_bound_ms),
                            }
                        )
            return WorkflowFlow(
                first=children[0].first,
                last=children[-1].last,
                transitions=tuple(transitions),
            )

        if "parallel" in node or "exclusive" in node:
            branch_nodes = node.get("parallel") or [
                branch["flow"] for branch in node["exclusive"]
            ]
            branches = [visit(child) for child in branch_nodes]
            return WorkflowFlow(
                first=_unique_references(
                    [reference for branch in branches for reference in branch.first]
                ),
                last=_unique_references(
                    [reference for branch in branches for reference in branch.last]
                ),
                transitions=tuple(
                    transition
                    for branch in branches
                    for transition in branch.transitions
                ),
            )

        if "repeat" in node:
            return visit(node["repeat"]["body"])
        if node.get("empty") is True:
            return WorkflowFlow(first=(), last=(), transitions=())
        raise ValueError(f"Unsupported BIM workflow block: {node!r}")

    return visit(orchestration.workflow)
