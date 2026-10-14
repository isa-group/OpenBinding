"""Small synthetic BIM packages for the directory/ZIP equivalence tests: no corpus, no dataset.

Every package is the same problem (two service tasks, two catalogs of two candidates, two constraint sets of
which one has two constraints) written down in a chosen order.  Only the *declaration order* of JSON object
members changes between variants; the members, and therefore the meaning, are always the same.  The files are
pretty-printed in declaration order (as an author writes them in Git); ``InstancePackage.to_zip()`` rewrites
them with sorted members.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

#: Variants: which objects are declared out of alphabetical order.  ``ordered`` is alphabetical everywhere.
VARIANTS: dict[str, dict[str, bool]] = {
    "ordered": {},
    "unordered-catalogs": {"catalogs": True},
    "unordered-candidates": {"candidates": True},
    "unordered-constraint-sets": {"constraint_sets": True},
    "unordered-constraints": {"constraints": True},
}


def _maybe_reversed(items: dict[str, Any], reverse: bool) -> dict[str, Any]:
    return dict(reversed(list(items.items()))) if reverse else dict(items)


def _catalog(name: str, provider: str, latency: int, cost: int, reverse: bool) -> dict[str, Any]:
    candidates = {
        identifier: {
            "provider": {"resource": name, "id": provider},
            "provides": "svc/v1",
            "features": {"latency": latency + offset, "cost": cost + offset},
        }
        for offset, identifier in enumerate(("c1", "c2"))
    }
    return {
        "apiVersion": "qos-binding/v1",
        "kind": "CandidateCatalog",
        "metadata": {"name": name},
        "spec": {
            "providers": {provider: {"name": provider.upper()}},
            "featureBindings": {
                "latency": {"resource": "app", "id": "latency"},
                "cost": {"resource": "app", "id": "cost"},
            },
            "candidates": _maybe_reversed(candidates, reverse),
        },
    }


def documents(*, catalogs: bool = False, candidates: bool = False, constraint_sets: bool = False,
              constraints: bool = False) -> dict[str, dict[str, Any]]:
    """The documents of one variant by file name; each flag declares that kind of object in reverse order."""
    hard_constraints = {
        "budget": {"assert": "features.cost <= 50", "enforcement": "hard"},
        "limit": {"assert": "features.latency <= 100", "enforcement": "hard"},
    }
    return {
        "instance.json": {
            "apiVersion": "bim/v1",
            "kind": "Instance",
            "metadata": {"name": "synthetic-equivalence"},
            "spec": {
                "profile": "qos-binding/v1",
                "resources": {
                    "application": {"app": "application.json"},
                    "candidateCatalog": _maybe_reversed(
                        {"cat-a": "catalog-a.json", "cat-b": "catalog-b.json"}, catalogs
                    ),
                    "constraintSet": _maybe_reversed({"hard": "hard.json", "soft": "soft.json"}, constraint_sets),
                    "optimization": {"opt": "optimization.json"},
                },
            },
        },
        "application.json": {
            "apiVersion": "qos-binding/v1",
            "kind": "Application",
            "metadata": {"name": "app"},
            "spec": {
                "tasks": {"t1": "svc/v1", "t2": "svc/v1"},
                "features": {
                    "latency": {"unit": "ms", "direction": "minimize", "aggregation": "sum"},
                    "cost": {"unit": "eur", "direction": "minimize", "scope": "selectedCandidate", "aggregation": "sum"},
                },
                "workflow": {
                    "sequence": [
                        {"task": {"resource": "app", "id": "t1"}},
                        {"task": {"resource": "app", "id": "t2"}},
                    ]
                },
            },
        },
        "catalog-a.json": _catalog("cat-a", "pa", 10, 5, candidates),
        "catalog-b.json": _catalog("cat-b", "pb", 20, 7, candidates),
        "hard.json": {
            "apiVersion": "qos-binding/v1",
            "kind": "ConstraintSet",
            "metadata": {"name": "hard"},
            "spec": {"constraints": _maybe_reversed(hard_constraints, constraints)},
        },
        "soft.json": {
            "apiVersion": "qos-binding/v1",
            "kind": "ConstraintSet",
            "metadata": {"name": "soft"},
            "spec": {
                "constraints": {
                    "limit": {"assert": "has(tasks.t1.provider)", "enforcement": "soft", "penalty": 2},
                }
            },
        },
        "optimization.json": {
            "apiVersion": "qos-binding/v1",
            "kind": "Optimization",
            "metadata": {"name": "opt"},
            "spec": {
                "criteria": [
                    {
                        "id": "latency",
                        "feature": {"resource": "app", "id": "latency"},
                        "normalize": {"min": 0, "max": 100, "clamp": False},
                    },
                    {
                        "id": "cost",
                        "feature": {"resource": "app", "id": "cost"},
                        "normalize": {"min": 0, "max": 20, "clamp": False},
                    },
                ],
                "penalties": [{"constraint": {"resource": "soft", "id": "limit"}, "weight": 1}],
            },
        },
    }


def files(variant: str) -> dict[str, bytes]:
    """The bytes of a variant, pretty-printed with the members in declaration order."""
    return {
        name: (json.dumps(document, indent=2) + "\n").encode("utf-8")
        for name, document in documents(**VARIANTS[variant]).items()
    }


def write(root: Path, variant: str, *, reverse_creation: bool = False) -> Path:
    """Write a variant as a directory; ``reverse_creation`` creates the files in the opposite order."""
    root.mkdir(parents=True, exist_ok=True)
    contents = files(variant)
    for name in sorted(contents, reverse=reverse_creation):
        (root / name).write_bytes(contents[name])
    return root
