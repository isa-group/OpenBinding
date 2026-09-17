"""Verify BIM's authoring-burden and semantic-equivalence benchmarks.

The benchmark deliberately measures semantic *control fields*, not bytes or
irreducible problem payload. See docs/CONCISENESS.md for the complete method.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import Counter
from collections.abc import Mapping
from itertools import product
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
GATEWAY_SRC = ROOT / "openbinding-gateway" / "src"
if str(GATEWAY_SRC) not in sys.path:
    sys.path.insert(0, str(GATEWAY_SRC))

BENCHMARKS = ROOT / "tools" / "bim_conciseness_benchmarks.json"
SEMANTIC_IR_FIELDS = (
    "application",
    "candidates",
    "eligibility",
    "routing",
    "constraints",
    "placement",
    "optimization",
    "extensions",
)


def _documents(package: Path) -> dict[str, dict[str, Any]]:
    documents: dict[str, dict[str, Any]] = {}
    for path in sorted(package.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        kind = document.get("kind")
        if kind != "Instance":
            if not isinstance(kind, str) or kind in documents:
                raise ValueError(f"{package}: every benchmark resource kind must be unique")
            documents[kind] = document
    return documents


def _add(counter: Counter[str], category: str, amount: int = 1) -> None:
    if amount:
        counter[category] += amount


def count_semantic_controls(package: Path) -> Counter[str]:
    """Count explicit, author-controlled BIM behavior slots in one package.

    Identifiers, reference coordinates, envelopes, metadata, generated catalog
    observations, and irreducible workflow/topology payload are intentionally
    outside this measure. Optional defaults only cost a field when authored.
    """

    documents = _documents(package)
    application = documents["Application"]["spec"]
    controls: Counter[str] = Counter()

    for task in application.get("tasks", {}).values():
        if isinstance(task, Mapping) and "kind" in task:
            _add(controls, "taskSemantics")

    for feature in application.get("features", {}).values():
        if not isinstance(feature, Mapping):
            continue
        for field in ("type", "unit", "direction", "scope", "neutral"):
            if field in feature:
                _add(controls, "featureInterpretation")
        domain = feature.get("domain")
        if isinstance(domain, str):
            _add(controls, "featureInterpretation")
        elif isinstance(domain, Mapping):
            _add(
                controls,
                "featureInterpretation",
                sum(field in domain for field in ("kind", "minimum", "maximum")),
            )
        aggregation = feature.get("aggregation")
        if isinstance(aggregation, str):
            _add(controls, "aggregation")
        elif isinstance(aggregation, Mapping):
            _add(controls, "aggregation", len(aggregation))

    workflow = application.get("workflow", {})
    if isinstance(workflow, Mapping) and "bpmn" in workflow:
        _add(controls, "workflowDialect")

    constraint_set = documents.get("ConstraintSet", {}).get("spec", {})
    for constraint in constraint_set.get("constraints", {}).values():
        if isinstance(constraint, Mapping):
            _add(
                controls,
                "constraints",
                sum(field in constraint for field in ("when", "assert", "enforcement", "penalty")),
            )

    optimization = documents["Optimization"]["spec"]
    _add(controls, "optimization", sum(field in optimization for field in ("mode", "type")))
    for term in optimization.get("terms", []):
        if not isinstance(term, Mapping):
            continue
        _add(controls, "optimization", sum(field in term for field in ("direction", "weight")))
        normalization = term.get("normalize")
        if isinstance(normalization, Mapping):
            _add(
                controls,
                "optimization",
                sum(field in normalization for field in ("min", "max", "clamp")),
            )
    for penalty in optimization.get("penalties", []):
        if isinstance(penalty, Mapping) and "weight" in penalty:
            _add(controls, "optimization")

    routing = documents.get("RoutingOverlay", {}).get("spec", {})
    if "uniform" in routing:
        _add(controls, "routing")

    placement = documents.get("Placement", {}).get("spec", {})
    for pool in placement.get("pools", {}).values():
        if isinstance(pool, Mapping) and "kind" in pool:
            _add(controls, "placement")
    if "networkMode" in placement:
        _add(controls, "placement")
    for transition in placement.get("transitions", {}).values():
        if isinstance(transition, Mapping):
            _add(
                controls,
                "placement",
                sum(field in transition for field in ("enforcement", "penalty")),
            )
    for rule in placement.get("capacityRules", []):
        if isinstance(rule, Mapping) and "scope" in rule:
            _add(controls, "placement")
    global_latency = placement.get("globalLatency", {})
    if isinstance(global_latency, Mapping):
        _add(
            controls,
            "placement",
            sum(field in global_latency for field in ("includeExecution", "exclusive", "parallel")),
        )

    return controls


def _semantic_projection(problem: Mapping[str, Any]) -> dict[str, Any]:
    spec = problem["spec"]
    return {field: spec[field] for field in SEMANTIC_IR_FIELDS}


def _projection_digest(problem: Mapping[str, Any]) -> str:
    payload = json.dumps(
        _semantic_projection(problem),
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _candidate_feature(spec: Mapping[str, Any], reference: Mapping[str, str], feature_id: str) -> float:
    catalog = spec["candidates"][reference["resource"]]
    aliases = [
        alias
        for alias, target in catalog["featureBindings"].items()
        if target["resource"] == spec["application"]["resource"] and target["id"] == feature_id
    ]
    if len(aliases) != 1:
        raise ValueError(f"feature {feature_id!r} has no unique catalog binding")
    return float(catalog["candidates"][reference["id"]]["features"][aliases[0]])


def _normalization_ranges(compiled: Any, *, enumeration_limit: int = 10_000) -> dict[str, list[float]]:
    """Prove the observed range of every normalized objective feature.

    Small spaces are exhaustive. Large spaces use pointwise extrema, which are
    exact for the non-negative monotone operators admitted by these benchmarks.
    """

    spec = compiled.document["spec"]
    terms = [term for term in spec["optimization"]["terms"] if "normalize" in term]
    features = [term["feature"]["id"] for term in terms]
    eligibility = spec["eligibility"]
    tasks = list(eligibility)
    combinations = math.prod(len(eligibility[task]) for task in tasks)
    ranges = {feature_id: [math.inf, -math.inf] for feature_id in features}

    def observe(binding: Mapping[str, Mapping[str, str]]) -> None:
        values = compiled.evaluate_binding(binding)
        for feature_id in features:
            value = float(values[feature_id])
            ranges[feature_id][0] = min(ranges[feature_id][0], value)
            ranges[feature_id][1] = max(ranges[feature_id][1], value)

    if combinations <= enumeration_limit:
        for choices in product(*(eligibility[task] for task in tasks)):
            observe(dict(zip(tasks, choices, strict=True)))
    else:
        application_features = spec["application"]["features"]
        for feature_id in features:
            feature = application_features[feature_id]
            if feature["scope"] != "invocation":
                raise ValueError("large-space range proof requires invocation-scoped features")
            if any(
                _candidate_feature(spec, reference, feature_id) < 0
                for choices in eligibility.values()
                for reference in choices
            ):
                raise ValueError("large-space range proof requires non-negative candidate values")
            operators = feature["aggregation"]
            if any(
                not isinstance(operator, str)
                or operator not in {"sum", "product", "min", "max", "weightedSum", "weightedProduct", "scale", "power", "identity"}
                for operator in operators.values()
            ):
                raise ValueError("large-space range proof requires built-in monotone operators")
            for choose_maximum in (False, True):
                binding = {
                    task: (max if choose_maximum else min)(
                        choices,
                        key=lambda reference, selected_feature=feature_id: _candidate_feature(
                            spec, reference, selected_feature
                        ),
                    )
                    for task, choices in eligibility.items()
                }
                observe(binding)

    for term in terms:
        feature_id = term["feature"]["id"]
        lower, upper = ranges[feature_id]
        bounds = term["normalize"]
        if lower < bounds["min"] - 1e-12 or upper > bounds["max"] + 1e-12:
            raise ValueError(
                f"normalization for {feature_id!r} does not contain reachable range [{lower}, {upper}]"
            )
    return ranges


def _close(actual: Any, expected: Any) -> bool:
    if isinstance(expected, float):
        return isinstance(actual, (int, float)) and not isinstance(actual, bool) and math.isclose(
            float(actual), expected, rel_tol=1e-12, abs_tol=1e-12
        )
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            _close(left, right) for left, right in zip(actual, expected, strict=True)
        )
    if isinstance(expected, Mapping):
        return isinstance(actual, Mapping) and all(
            key in actual and _close(actual[key], value) for key, value in expected.items()
        )
    return actual == expected


def run_benchmarks() -> dict[str, Any]:
    from openbinding_gateway.v1.compiler import compile_instance
    from openbinding_gateway.v1.package import load_package

    configuration = json.loads(BENCHMARKS.read_text(encoding="utf-8"))
    minimum = float(configuration["minimumReduction"])
    results: dict[str, Any] = {}

    for name, benchmark in configuration["cases"].items():
        package = ROOT / benchmark["package"]
        controls = count_semantic_controls(package)
        current = sum(controls.values())
        baseline = sum(benchmark["baseline"].values())
        reduction = (baseline - current) / baseline

        compiled = compile_instance(load_package(package))
        projection_digest = _projection_digest(compiled.document)
        normalization_ranges = _normalization_ranges(compiled)
        evaluation = compiled.evaluate(benchmark["probe"]["binding"])
        actual_probe = {
            "features": evaluation["features"],
            "mode": evaluation["objectives"]["mode"],
            "score": evaluation["objectives"]["score"],
            "penalty": evaluation["objectives"]["penalty"],
            "violations": sorted(item["constraint"]["id"] for item in evaluation["violations"]),
        }

        errors: list[str] = []
        if current != benchmark["expectedControls"]:
            errors.append(f"expected {benchmark['expectedControls']} controls, found {current}")
        if reduction + 1e-12 < minimum:
            errors.append(f"reduction {reduction:.3%} is below {minimum:.3%}")
        if projection_digest != benchmark["semanticProjectionSha256"]:
            errors.append("compiled semantic projection changed")
        if not _close(normalization_ranges, benchmark["normalizationRanges"]):
            errors.append("normalization range proof changed")
        expected_probe = {field: benchmark["probe"][field] for field in actual_probe}
        if not _close(actual_probe, expected_probe):
            errors.append("authoritative evaluation probe changed")
        comparison = benchmark["historicalComparison"]
        if comparison["status"] not in {"exact", "normative-change"}:
            errors.append("historical comparison has an unknown status")
        equiv = comparison.get("equivalentFeatures", comparison.get("equivalentMetrics"))
        if not _close(actual_probe["features"], equiv):
            errors.append("features declared equivalent to the audited baseline changed")
        if comparison["status"] == "exact" and not _close(
            actual_probe["score"], comparison["objectiveScore"]
        ):
            errors.append("objective declared equivalent to the audited baseline changed")

        results[name] = {
            "package": benchmark["package"],
            "baseline": baseline,
            "current": current,
            "reduction": reduction,
            "controls": dict(sorted(controls.items())),
            "semanticProjectionSha256": projection_digest,
            "normalizationRanges": normalization_ranges,
            "historicalComparison": comparison,
            "probe": actual_probe,
            "errors": errors,
        }

    return {
        "method": configuration["method"],
        "baselineRevision": configuration["baselineRevision"],
        "minimumReduction": minimum,
        "cases": results,
        "ok": all(not result["errors"] for result in results.values()),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify BIM authoring conciseness and semantics")
    parser.add_argument("--json", action="store_true", help="emit the complete machine-readable report")
    args = parser.parse_args()
    report = run_benchmarks()
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        for name, result in report["cases"].items():
            status = "PASS" if not result["errors"] else "FAIL"
            print(
                f"{status} {name}: {result['baseline']} -> {result['current']} "
                f"semantic controls ({result['reduction']:.1%} reduction)"
            )
            for error in result["errors"]:
                print(f"  {error}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
