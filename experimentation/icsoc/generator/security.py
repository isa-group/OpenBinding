from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .orchestration import Orchestration
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
    return ORDER_LABEL.get(
        max(LABEL_ORDER.values()) if order > 3 else max(1, order), "low"
    )


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
    orchestration: Orchestration,
    config: dict[str, Any],
) -> SecurityResult:
    functions = {
        safe_id(function["id"]): function for function in app.get("functions", [])
    }
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

    def process(current: dict[str, Any], context: int) -> int:
        reference = current.get("task")
        if reference:
            task_name = reference["id"]
            fn = functions[task_name]

            # Seed unknown first-input variables from trigger labels by position.
            for idx, token in enumerate(fn.get("inputs", [])):
                text = str(token).strip()
                if (
                    text
                    and text != "_"
                    and text.lower() not in LABEL_ORDER
                    and text not in variable_labels
                    and idx < len(trigger_label_values)
                ):
                    variable_labels[text] = _label_order(trigger_label_values[idx])

            in_order = max(
                [input_label(t) for t in fn.get("inputs", [])] or [LABEL_ORDER["low"]]
            )
            required_order = max(context, in_order)
            required_label = _label_name(required_order)
            thresholds[task_name] = float(label_values[required_label])

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
                    "task": task_name,
                    "context_label": _label_name(context),
                    "input_label": _label_name(in_order),
                    "required_label": required_label,
                    "threshold": label_values[required_label],
                }
            )
            return required_order

        if "sequence" in current:
            children = current["sequence"]
            # The original dataset's conditional is represented natively as a
            # guard followed by an exclusive block. Its guard raises the
            # information-flow context for both branches.
            if len(children) == 2 and "exclusive" in children[1]:
                guard_label = process(children[0], context)
                branch_label = process(children[1], max(context, guard_label))
                return max(guard_label, branch_label)
            last = context
            for child in children:
                last = process(child, context)
            return last

        if "parallel" in current:
            return max(process(child, context) for child in current["parallel"])

        if "exclusive" in current:
            before = dict(variable_labels)
            branch_labels: list[int] = []
            branch_variables: list[dict[str, int]] = []
            for branch in current["exclusive"]:
                variable_labels.clear()
                variable_labels.update(before)
                branch_labels.append(process(branch["flow"], context))
                branch_variables.append(dict(variable_labels))
            variable_labels.clear()
            variable_labels.update(before)
            names = set(before)
            for values in branch_variables:
                names.update(values)
            for name in names:
                variable_labels[name] = max(
                    values.get(name, before.get(name, LABEL_ORDER["low"]))
                    for values in branch_variables
                )
            return max(branch_labels, default=context)

        if "repeat" in current:
            return process(current["repeat"]["body"], context)

        if current.get("empty") is True:
            return context

        raise ValueError(f"Unsupported BIM workflow block for security: {current!r}")

    process(orchestration.workflow, LABEL_ORDER["low"])
    return SecurityResult(task_thresholds=thresholds, trace_rows=trace_rows)
