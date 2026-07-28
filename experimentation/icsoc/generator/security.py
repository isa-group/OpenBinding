from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .orchestration import OrchNode
from .utils import safe_id, trigger_labels


LABEL_ORDER = {"low": 1, "medium": 2, "top": 3}
ORDER_LABEL = {v: k for k, v in LABEL_ORDER.items()}


@dataclass
class SecurityResult:
    task_thresholds: dict[str, float]
    trace_rows: list[dict[str, Any]]


def _label_order(value: str | None) -> int:
    if not value:
        return LABEL_ORDER["low"]
    return LABEL_ORDER.get(value.strip().lower(), LABEL_ORDER["low"])


def _label_name(order: int) -> str:
    return ORDER_LABEL.get(max(LABEL_ORDER.values()) if order > 3 else max(1, order), "low")


def node_security_score(caps: list[str], config: dict[str, Any]) -> tuple[str, float]:
    cap_set = set(caps or [])
    scores = config["security"]["node_scores"]
    if {"pubKeyE", "antiTamp"}.issubset(cap_set):
        return "top", float(scores["pubKeyE+antiTamp"])
    if "pubKeyE" in cap_set:
        return "medium", float(scores["pubKeyE"])
    return "low", float(scores["none"])


def infer_task_security(
    app: dict[str, Any],
    root: OrchNode,
    config: dict[str, Any],
) -> SecurityResult:
    functions = {f["id"]: f for f in app.get("functions", [])}
    variable_labels: dict[str, int] = {}
    thresholds: dict[str, float] = {}
    trace_rows: list[dict[str, Any]] = []
    label_values = config["security"]["labels"]
    # Output labelling mode:
    #   variable  - per-variable dataflow: an output named like an existing
    #               variable carries that datum and keeps its label; only new
    #               variables inherit the task's required level (join).
    #   saturate  - classic non-interference: every output inherits the join
    #               of all inputs and the control context. On pipeline-shaped
    #               orchestrations this creeps every task to the top label,
    #               collapsing the security objective to a constant.
    output_mode = str(config["security"].get("output_propagation", "variable")).lower()
    trigger_label_values = trigger_labels(app.get("trigger", ""))

    def input_label(token: str) -> int:
        text = str(token).strip()
        if not text or text == "_":
            return LABEL_ORDER["low"]
        if text.lower() in LABEL_ORDER:
            return LABEL_ORDER[text.lower()]
        return variable_labels.get(text, LABEL_ORDER["low"])

    def output_label(token: str, default: int) -> int:
        text = str(token).strip()
        if not text or text == "_":
            return default
        if text.lower() in LABEL_ORDER:
            return LABEL_ORDER[text.lower()]
        return default

    def process(current: OrchNode, context: int) -> int:
        if current.kind == "TASK":
            assert current.task_id is not None
            fn = functions[current.task_id]

            # Seed unknown first-input variables from trigger labels by position.
            for idx, token in enumerate(fn.get("inputs", [])):
                text = str(token).strip()
                if text and text != "_" and text.lower() not in LABEL_ORDER and text not in variable_labels:
                    if idx < len(trigger_label_values):
                        variable_labels[text] = _label_order(trigger_label_values[idx])

            in_order = max([input_label(t) for t in fn.get("inputs", [])] or [LABEL_ORDER["low"]])
            required_order = max(context, in_order)
            required_label = _label_name(required_order)
            thresholds[safe_id(current.task_id)] = float(label_values[required_label])

            for token in fn.get("outputs", []):
                text = str(token).strip()
                if text and text != "_" and text.lower() not in LABEL_ORDER:
                    if output_mode == "variable":
                        variable_labels.setdefault(text, required_order)
                    else:
                        variable_labels[text] = output_label(text, required_order)

            trace_rows.append(
                {
                    "application": app["orchestration_id"],
                    "task": current.task_id,
                    "context_label": _label_name(context),
                    "input_label": _label_name(in_order),
                    "required_label": required_label,
                    "threshold": label_values[required_label],
                }
            )
            return required_order

        if current.kind == "SEQ":
            last = context
            for child in current.children:
                last = process(child, context)
            return last

        if current.kind == "AND":
            return max(process(child, context) for child in current.children)

        if current.kind == "IF":
            assert current.guard is not None and current.then_branch is not None and current.else_branch is not None
            guard_label = process(current.guard, context)
            branch_context = max(context, guard_label)
            before = dict(variable_labels)
            then_label = process(current.then_branch, branch_context)
            then_vars = dict(variable_labels)
            variable_labels.clear()
            variable_labels.update(before)
            else_label = process(current.else_branch, branch_context)
            else_vars = dict(variable_labels)
            variable_labels.clear()
            variable_labels.update(before)
            for name in set(then_vars) | set(else_vars):
                variable_labels[name] = max(then_vars.get(name, before.get(name, 1)), else_vars.get(name, before.get(name, 1)))
            return max(guard_label, then_label, else_label)

        raise ValueError(f"Unsupported node kind for security: {current.kind}")

    process(root, LABEL_ORDER["low"])
    return SecurityResult(task_thresholds=thresholds, trace_rows=trace_rows)
