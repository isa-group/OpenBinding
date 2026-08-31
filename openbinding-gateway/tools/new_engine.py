"""Create a BIM v1 Engine manifest template without executable package code."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a bim/v1 Engine manifest")
    parser.add_argument("name")
    parser.add_argument("--namespace", default="local")
    parser.add_argument("--algorithm", default="external")
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    document = {
        "apiVersion": "bim/v1",
        "kind": "Engine",
        "metadata": {"namespace": args.namespace, "name": args.name, "version": "1.0.0"},
        "spec": {"modes": [{
            "id": "default",
            "profile": "qos-binding/v1",
            "ir": {"apiVersion": "bim/v1", "kind": "BindingProblem"},
            "algorithm": args.algorithm,
            "capabilities": {
                "workflowNodes": {"selector": "only", "values": ["task", "sequence"]},
                "metricScopes": {"selector": "only", "values": ["invocation"]},
                "aggregations": {"selector": "only", "values": ["sequence.sum"]},
                "constraints": {"selector": "only", "values": ["hard.aggregate-bound"]},
                "optimization": {"selector": "only", "values": ["satisfy"]},
                "expressions": {
                    "selector": "only",
                    "values": ["literal", "compare", "path.metrics"],
                },
                "placement": {"selector": "none"},
                "irExtensions": {"selector": "none"},
            },
            "optionsSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "limits": {"maxTimeBudgetMs": 60_000},
            "guarantees": {
                "termination": ["FEASIBLE", "UNKNOWN"],
                "exact": False,
            },
        }]},
    }
    output = args.output or Path(f"{args.name}.json")
    output.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
