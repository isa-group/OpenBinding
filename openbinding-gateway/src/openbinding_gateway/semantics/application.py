"""Application model, orchestration part (G of M_A = (T, G, Lambda)).

Reading of the composition tree: which tasks it can execute, and the XOR
scenarios it expands into. Each scenario fixes one branch per XOR node,
turning the tree into a precedence DAG over tasks - the structure the
end-to-end latency is scheduled on.
"""

from __future__ import annotations

import itertools
from typing import Any, Dict, List, Sequence, Tuple

from .errors import PlacementError

EVENT_SOURCE = "event"
TASK_SOURCE = "task"


def composition_task_ids(node: Dict[str, Any]) -> set:
    """Task ids the composition can execute, across every XOR branch."""
    kind = node.get("kind")
    if kind == "TASK":
        return {node.get("task_id")}
    if kind in ("SEQ", "AND"):
        found = set()
        for child in node.get("children", []) or []:
            found |= composition_task_ids(child)
        return found
    if kind == "XOR":
        found = set()
        for branch in node.get("branches", []) or []:
            found |= composition_task_ids(branch.get("child", {}) or {})
        return found
    if kind == "LOOP":
        return composition_task_ids(node.get("body", {}) or {})
    return set()


def _collect_xor_nodes(node: Dict[str, Any], acc: List[Dict[str, Any]]) -> None:
    kind = node.get("kind")
    if kind == "XOR":
        acc.append(node)
        for branch in node.get("branches", []) or []:
            _collect_xor_nodes(branch.get("child", {}) or {}, acc)
    elif kind in ("SEQ", "AND"):
        for child in node.get("children", []) or []:
            _collect_xor_nodes(child, acc)
    elif kind == "LOOP":
        _collect_xor_nodes(node.get("body", {}) or {}, acc)


def _build_dag(
    node: Dict[str, Any],
    entries: List[Tuple[str, str]],
    choice: Dict[str, int],
    preds: Dict[str, List[Tuple[str, str]]],
    order: List[str],
) -> List[Tuple[str, str]]:
    """Thread entry points through the tree, recording task predecessors.

    Returns the exit points (sources) of ``node``. Fork/join semantics emerge
    from the entry sets: an AND joins because the next consumer receives the
    exits of every branch and must wait for the slowest one.
    """
    kind = node.get("kind")

    if kind == "TASK":
        task_id = node.get("task_id")
        if task_id in preds:
            raise PlacementError(
                f"Task '{task_id}' appears more than once in the composition; "
                "the BIM' latency model requires a single occurrence per task"
            )
        preds[task_id] = list(entries)
        order.append(task_id)
        return [(TASK_SOURCE, task_id)]

    if kind == "ELEMENT":
        return list(entries)

    if kind == "SEQ":
        current = list(entries)
        for child in node.get("children", []) or []:
            current = _build_dag(child, current, choice, preds, order)
        return current

    if kind == "AND":
        exits: List[Tuple[str, str]] = []
        for child in node.get("children", []) or []:
            exits.extend(_build_dag(child, list(entries), choice, preds, order))
        return exits

    if kind == "XOR":
        branches = node.get("branches", []) or []
        idx = choice[id(node)] if id(node) in choice else choice.get(node.get("id"))
        return _build_dag(branches[idx].get("child", {}) or {}, entries, choice, preds, order)

    if kind == "LOOP":
        raise PlacementError("LOOP nodes are not supported by the BIM' latency model")

    raise PlacementError(f"Unsupported composition node kind '{kind}'")


def build_scenarios(
    root: Dict[str, Any], event_ids: Sequence[str]
) -> List[Dict[str, Any]]:
    """Enumerate XOR scenarios of the composition tree.

    Each scenario is ``{"prob", "preds", "order", "sinks"}`` where ``preds``
    maps every active task to its predecessor sources (``("task", id)`` or
    ``("event", id)``), ``order`` is a topological order of the active tasks
    and ``sinks`` are the exit tasks of the scenario.
    """
    xor_nodes: List[Dict[str, Any]] = []
    _collect_xor_nodes(root, xor_nodes)

    branch_indices = [range(len(n.get("branches", []) or [])) for n in xor_nodes]
    entries = [(EVENT_SOURCE, eid) for eid in event_ids]

    scenarios: List[Dict[str, Any]] = []
    for combo in itertools.product(*branch_indices) if xor_nodes else [()]:
        prob = 1.0
        choice: Dict[Any, int] = {}
        for xor_node, idx in zip(xor_nodes, combo):
            choice[id(xor_node)] = idx
            prob *= float(xor_node["branches"][idx].get("p", 0.0))

        preds: Dict[str, List[Tuple[str, str]]] = {}
        order: List[str] = []
        exits = _build_dag(root, list(entries), choice, preds, order)
        sinks = [src_id for src_kind, src_id in exits if src_kind == TASK_SOURCE]

        # An XOR branch may be unreachable in this scenario (nested XOR inside
        # a non-chosen branch), in which case its choice simply never applies.
        scenarios.append({"prob": prob, "preds": preds, "order": order, "sinks": sinks})

    return scenarios
