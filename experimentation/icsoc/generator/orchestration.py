from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Any

from .utils import safe_id


@dataclass
class OrchNode:
    kind: str
    task_id: str | None = None
    bindings: list[str] = field(default_factory=list)
    latency_bound_ms: float | None = None
    children: list["OrchNode"] = field(default_factory=list)
    guard: "OrchNode | None" = None
    then_branch: "OrchNode | None" = None
    else_branch: "OrchNode | None" = None


TOKEN_RE = re.compile(r"\s*([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[\[\](),])")


class OrchestrationParser:
    def __init__(self, text: str):
        self.tokens = [m.group(1) for m in TOKEN_RE.finditer(text)]
        joined = "".join(self.tokens)
        compact = re.sub(r"\s+", "", text)
        if joined != compact:
            raise ValueError(f"Unsupported orchestration syntax near: {text}")
        self.pos = 0

    def parse(self) -> OrchNode:
        node = self._expr()
        if self.pos != len(self.tokens):
            raise ValueError(f"Unexpected trailing token: {self.tokens[self.pos]}")
        return node

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

    def _expr(self) -> OrchNode:
        head = self._take()
        if head == "fun":
            return self._fun()
        if head == "seq":
            self._expect("(")
            first = self._expr()
            self._expect(",")
            second = self._expr()
            self._expect(")")
            return OrchNode(kind="SEQ", children=[first, second])
        if head == "par":
            self._expect("(")
            children: list[OrchNode]
            if self._peek() == "[":
                self._expect("[")
                children = [self._expr()]
                while self._peek() == ",":
                    self._expect(",")
                    children.append(self._expr())
                self._expect("]")
            else:
                children = [self._expr()]
                self._expect(",")
                children.append(self._expr())
            self._expect(")")
            return OrchNode(kind="AND", children=children)
        if head == "if":
            self._expect("(")
            guard = self._expr()
            self._expect(",")
            then_branch = self._expr()
            self._expect(",")
            else_branch = self._expr()
            self._expect(")")
            return OrchNode(kind="IF", guard=guard, then_branch=then_branch, else_branch=else_branch)
        raise ValueError(f"Unsupported orchestration expression '{head}'")

    def _fun(self) -> OrchNode:
        self._expect("(")
        task_id = self._take()
        self._expect(",")
        bindings = self._binding_list()
        self._expect(",")
        latency = float(self._take())
        self._expect(")")
        return OrchNode(kind="TASK", task_id=task_id, bindings=bindings, latency_bound_ms=latency)

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


def parse_orchestration(text: str) -> OrchNode:
    return OrchestrationParser(text).parse()


def collect_task_calls(node: OrchNode) -> dict[str, OrchNode]:
    out: dict[str, OrchNode] = {}

    def walk(current: OrchNode) -> None:
        if current.kind == "TASK" and current.task_id:
            out[current.task_id] = current
        for child in current.children:
            walk(child)
        if current.guard:
            walk(current.guard)
        if current.then_branch:
            walk(current.then_branch)
        if current.else_branch:
            walk(current.else_branch)

    walk(node)
    return out


def to_bim_composition(node: OrchNode) -> dict[str, Any]:
    counter = 0

    def next_id(prefix: str) -> str:
        nonlocal counter
        counter += 1
        return safe_id(f"n_{counter}_{prefix}")

    def convert(current: OrchNode) -> dict[str, Any]:
        if current.kind == "TASK":
            assert current.task_id is not None
            return {"id": next_id(current.task_id), "kind": "TASK", "task_id": safe_id(current.task_id)}
        if current.kind == "SEQ":
            return {"id": next_id("seq"), "kind": "SEQ", "children": [convert(c) for c in current.children]}
        if current.kind == "AND":
            return {"id": next_id("and"), "kind": "AND", "children": [convert(c) for c in current.children]}
        if current.kind == "IF":
            assert current.guard is not None and current.then_branch is not None and current.else_branch is not None
            xor = {
                "id": next_id("xor"),
                "kind": "XOR",
                "branches": [
                    {"p": 0.5, "child": convert(current.then_branch)},
                    {"p": 0.5, "child": convert(current.else_branch)},
                ],
            }
            return {"id": next_id("if_seq"), "kind": "SEQ", "children": [convert(current.guard), xor]}
        raise ValueError(f"Unsupported node kind: {current.kind}")

    return {"type": "STRUCTURED", "root": convert(node)}


@dataclass
class FlowInfo:
    first: set[str]
    last: set[str]
    transitions: list[tuple[str, str, float]]


def derive_transitions(node: OrchNode, task_latency: dict[str, float]) -> FlowInfo:
    if node.kind == "TASK":
        assert node.task_id is not None
        tid = safe_id(node.task_id)
        return FlowInfo(first={tid}, last={tid}, transitions=[])

    if node.kind in {"SEQ", "AND"}:
        infos = [derive_transitions(child, task_latency) for child in node.children]
        transitions: list[tuple[str, str, float]] = []
        for info in infos:
            transitions.extend(info.transitions)
        if node.kind == "SEQ":
            for left, right in zip(infos, infos[1:]):
                for from_task in sorted(left.last):
                    for to_task in sorted(right.first):
                        transitions.append((from_task, to_task, task_latency[to_task]))
            return FlowInfo(first=infos[0].first, last=infos[-1].last, transitions=transitions)
        first = set().union(*(info.first for info in infos))
        last = set().union(*(info.last for info in infos))
        return FlowInfo(first=first, last=last, transitions=transitions)

    if node.kind == "IF":
        assert node.guard is not None and node.then_branch is not None and node.else_branch is not None
        guard = derive_transitions(node.guard, task_latency)
        then_info = derive_transitions(node.then_branch, task_latency)
        else_info = derive_transitions(node.else_branch, task_latency)
        transitions = [*guard.transitions, *then_info.transitions, *else_info.transitions]
        for branch in (then_info, else_info):
            for from_task in sorted(guard.last):
                for to_task in sorted(branch.first):
                    transitions.append((from_task, to_task, task_latency[to_task]))
        return FlowInfo(
            first=guard.first,
            last=set(then_info.last) | set(else_info.last),
            transitions=transitions,
        )

    raise ValueError(f"Unsupported node kind: {node.kind}")
