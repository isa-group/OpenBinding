"""A tiny BIM package, compiled once, for questions that need *some* IR but not the caller's.

Two uses:

* the deterministic conformance probe an Engine registration has to solve
  (``routes.v1._verify_registration``), whose IR has as many criteria as the mode asks for;
* resolving the options of an Engine mode when there is no IR to run (sealing a library version,
  defining a study): the toolchain's ``compatibility`` takes an IR, and the answer about options does
  not depend on which.
"""

from __future__ import annotations

from typing import Any

from bim_core.canonical import canonical_json

from ..integrations import bim, packages

#: Compiled probes, by toolchain and number of criteria: an IR only belongs to the toolchain that made it.
_PROBES: dict[tuple[str, int], dict[str, Any]] = {}


def probe_files(objective_count: int = 1) -> dict[str, bytes]:
    """The files of a package with one task, one candidate and ``objective_count`` criteria."""
    feature_ids = [f"probe-objective-{index + 1}" for index in range(objective_count)]
    application = {
        "apiVersion": "qos-binding/v1",
        "kind": "Application",
        "metadata": {"name": "probe-application"},
        "spec": {
            "tasks": {"probe-task": {"requires": "bim.conformance.probe"}},
            "features": {
                feature_id: {
                    "unit": "1",
                    "direction": "minimize",
                    "scope": "selectedCandidate",
                    "aggregation": "sum",
                    "domain": {"kind": "real", "minimum": 0, "maximum": 1},
                }
                for feature_id in feature_ids
            },
            "workflow": {
                "task": {"resource": "probe-application", "id": "probe-task"}
            },
        },
    }
    candidates = {
        "apiVersion": "qos-binding/v1",
        "kind": "CandidateCatalog",
        "metadata": {"name": "probe-catalog"},
        "spec": {
            "featureBindings": {
                feature_id: {"resource": "probe-application", "id": feature_id}
                for feature_id in feature_ids
            },
            "candidates": {
                "probe-candidate": {
                    "provides": "bim.conformance.probe",
                    "features": {feature_id: 0 for feature_id in feature_ids},
                }
            }
        },
    }
    optimization = {
        "apiVersion": "qos-binding/v1",
        "kind": "Optimization",
        "metadata": {"name": "probe-optimization"},
        "spec": {
            "criteria": [
                {"id": feature_id, "feature": {"resource": "probe-application", "id": feature_id}}
                for feature_id in feature_ids
            ],
        },
    }
    instance = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": "bim-engine-conformance-probe"},
        "spec": {
            "profile": "qos-binding/v1",
            "resources": {
                "application": {"probe-application": "application.json"},
                "candidateCatalog": {"probe-catalog": "candidates.json"},
                "optimization": {"probe-optimization": "optimization.json"},
            }
        },
    }
    return {
        "instance.json": canonical_json(instance),
        "application.json": canonical_json(application),
        "candidates.json": canonical_json(candidates),
        "optimization.json": canonical_json(optimization),
    }


async def probe_ir(objective_count: int = 1) -> dict[str, Any]:
    """The IR of the probe package, compiled by the toolchain in use (and remembered)."""
    key = (bim.toolchain_digest(), objective_count)
    ir = _PROBES.get(key)
    if ir is None:
        result = await bim.abim().compile(packages.zip_files(probe_files(objective_count)))
        ir = _PROBES[key] = result["ir"]
    return ir
