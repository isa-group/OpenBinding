"""Builders shared by the evaluation tests: a small two-catalog package that needs no corpus.

``envelope``, ``package``, ``base_package`` and ``EXECUTION_MODE`` are those of
``openbinding-gateway/tests/test_bim_v1_language_final.py``.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from bim_core import InstancePackage

BINDING = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-b", "id": "c1"}}
SAME_CATALOG_BINDING = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-a", "id": "c1"}}


def envelope(kind, name, spec):
    api_version = "qos-binding-placement/v1" if kind == "Placement" else "qos-binding/v1"
    return {"apiVersion": api_version, "kind": kind, "metadata": {"name": name}, "spec": spec}


def package(documents, resources, name="final-language"):
    root = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": name},
        "spec": {"profile": "qos-binding/v1", "resources": resources},
    }
    files = {"instance.json": json.dumps(root, allow_nan=False).encode()}
    files.update({
        path: (value if isinstance(value, bytes) else json.dumps(value, allow_nan=False).encode())
        for path, value in documents.items()
    })
    return InstancePackage(files)


def base_package(*, workflow=None, optimization=None, placement=None):
    workflow = workflow or {
        "sequence": [
            {"task": {"resource": "app", "id": "t1"}},
            {"repeat": {"body": {"task": {"resource": "app", "id": "t2"}}, "expectedCount": 2.0}},
            {"task": {"resource": "app", "id": "local"}},
        ]
    }
    application = envelope(
        "Application",
        "app",
        {
            "tasks": {"t1": "svc/v1", "t2": "svc/v1", "local": {"kind": "local"}},
            "features": {
                "latency": {"unit": "ms", "direction": "minimize", "aggregation": "sum"},
                "cost": {"unit": "eur", "direction": "minimize", "scope": "selectedCandidate", "aggregation": "sum"},
            },
            "workflow": workflow,
        },
    )
    catalog_a = envelope(
        "CandidateCatalog",
        "catalog-a",
        {
            "providers": {"pa": {"name": "A"}},
            "featureBindings": {
                "latency": {"resource": "app", "id": "latency"},
                "cost": {"resource": "app", "id": "cost"},
            },
            "candidates": {
                "c1": {
                    "provider": {"resource": "cat-a", "id": "pa"},
                    "provides": "svc/v1",
                    "features": {"latency": 10, "cost": 5},
                }
            },
        },
    )
    catalog_b = envelope(
        "CandidateCatalog",
        "catalog-b",
        {
            "providers": {"pb": {"name": "B"}},
            "featureBindings": {
                "latency": {"resource": "app", "id": "latency"},
                "cost": {"resource": "app", "id": "cost"},
            },
            "candidates": {
                "c1": {
                    "provider": {"resource": "cat-b", "id": "pb"},
                    "provides": ["svc/v1"],
                    "features": {"latency": 20, "cost": 7},
                }
            },
        },
    )
    hard = envelope(
        "ConstraintSet",
        "hard",
        {"constraints": {"limit": {"assert": "features.latency <= 100", "enforcement": "hard"}}},
    )
    soft = envelope(
        "ConstraintSet",
        "soft",
        {"constraints": {"limit": {"assert": "has(tasks.t1.provider)", "enforcement": "soft", "penalty": 2}}},
    )
    optimization = optimization or envelope(
        "Optimization",
        "opt",
        {
            "criteria": [
                {"id": "latency", "feature": {"resource": "app", "id": "latency"}, "normalize": {"min": 0, "max": 100, "clamp": False}},
                {"id": "cost", "feature": {"resource": "app", "id": "cost"}, "normalize": {"min": 0, "max": 20, "clamp": False}},
            ],
            "penalties": [{"constraint": {"resource": "soft", "id": "limit"}, "weight": 1}],
        },
    )
    documents = {
        "application.json": application,
        "catalog-a.json": catalog_a,
        "catalog-b.json": catalog_b,
        "hard.json": hard,
        "soft.json": soft,
        "optimization.json": optimization,
    }
    resources = {
        "application": {"app": "application.json"},
        "candidateCatalog": {"cat-a": "catalog-a.json", "cat-b": "catalog-b.json"},
        "constraintSet": {"hard": "hard.json", "soft": "soft.json"},
        "optimization": {"opt": "optimization.json"},
    }
    if placement is not None:
        documents["placement.json"] = placement
        resources["candidateCatalog"]["place"] = "placement.json"
    return package(documents, resources)


EXECUTION_MODE = {
    "capabilities": {
        "scalarizations": {
            "selector": "only",
            "values": [
                {"id": "weighted-sum", "objectiveTypes": ["SINGLE"], "weightPolicy": "required"},
                {"id": "pareto-front", "objectiveTypes": ["MULTI", "MANY"], "weightPolicy": "forbidden"},
                {"id": "feasibility", "objectiveTypes": ["SINGLE"], "weightPolicy": "forbidden"},
            ],
        }
    }
}


DEMO_BINDING = {
    "t1": {"resource": "catalog", "id": "c1a"},
    "t2": {"resource": "catalog", "id": "c2a"},
    "t3": {"resource": "catalog", "id": "c3a"},
}


def demo_package(demo, latency, *, domain=None, extra=None, constraint=None, alternative=None):
    """The corpus demo (``examples/demo/01_simple_seq``) with ``latency`` as the value of candidate c1a."""
    from bim_core import load_package

    value = load_package(demo)
    application = json.loads(value.files["application.json"])
    catalog = json.loads(value.files["candidates.json"])
    candidates = catalog["spec"]["candidates"]
    candidates["c1a"]["features"]["latency"] = latency
    if alternative is not None:
        candidates["c1b"]["features"]["latency"] = alternative
    if domain is not None:
        application["spec"]["features"]["latency"]["domain"] = domain
    if extra is not None:
        application["spec"]["features"]["extra"] = {"unit": "ms"}
        catalog["spec"]["featureBindings"]["extra"] = {"resource": "application", "id": "extra"}
        candidates["c1a"]["features"]["extra"] = extra
        candidates["c1b"]["features"]["extra"] = 3
    value.files["application.json"] = json.dumps(application).encode()
    value.files["candidates.json"] = json.dumps(catalog).encode()
    if constraint is not None:
        instance = json.loads(value.files["instance.json"])
        instance["spec"]["resources"]["constraintSet"] = {"limits": "constraints.json"}
        value.files["instance.json"] = json.dumps(instance).encode()
        value.files["constraints.json"] = json.dumps(
            envelope("ConstraintSet", "limits", {"constraints": {"limit": {"assert": constraint, "enforcement": "hard"}}})
        ).encode()
    return value


def problem_with_criteria(count: int):
    """Anything with a ``document``: ``resolve_optimization`` only reads the criteria of the IR."""
    return SimpleNamespace(
        document={
            "spec": {
                "optimization": {
                    "criteria": [{"id": f"criterion-{index}"} for index in range(count)],
                }
            }
        }
    )
