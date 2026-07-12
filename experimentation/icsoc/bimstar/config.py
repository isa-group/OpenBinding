from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any, Mapping

import yaml


DEFAULT_CONFIG: dict[str, Any] = {
    "cloud_regions": {
        "aws": ["eu-west-1", "us-east-1"],
        "azure": ["westeurope", "eastus"],
        "gcp": ["europe-west1", "us-central1"],
    },
    "cloud_memory_mb_domain": [128, 256, 512, 1024, 2048, 4096],
    "workload_defaults": {
        "invocations_per_month": 1_000_000,
        "avg_duration_ms": 120,
        "data_out_mb": 0.05,
        "concurrency": 20,
    },
    "objective": {"weights": {"latency": 0.33, "cost": 0.34, "security": 0.33}},
    "security": {
        "labels": {"low": 0.33, "medium": 0.66, "top": 1.0},
        "node_scores": {"none": 0.33, "pubKeyE": 0.66, "pubKeyE+antiTamp": 1.0},
    },
    "non_cloud_costs": {
        "base_monthly_usd": {"edge": [2, 15], "fog": [15, 80], "cloud": [30, 200]},
        "coefficients": {"memory_gb": 1.5, "vcpu": 2.5, "mhz_per_1000": 1.0},
    },
    "cloud_faas_capacity": {"concurrency": 1_000_000},
    "pricing_constraints": {
        "enabled": True,
        # Global budget = factor * cost of the cheapest locally-eligible binding
        # (aggregated over the composition tree). factor >= 1 keeps the budget
        # satisfiable in the local-constraint relaxation.
        "global_budget_factor": 1.5,
        # Per-task budget = this quantile of the locally-eligible candidate
        # costs, so at least one candidate per task stays within budget.
        "local_budget_quantile": 0.75,
    },
    # Provider/region-aware cloud latency model; disjoint ranges per class so
    # same-provider < cross-provider and intra-geo < inter-geo by construction.
    "latency_generation": {
        "region_geo": {
            "eu-west-1": "eu",
            "us-east-1": "us",
            "westeurope": "eu",
            "eastus": "us",
            "europe-west1": "eu",
            "us-central1": "us",
        },
        "cloud_same_provider_same_region_ms": [1, 3],
        "cloud_same_provider_intra_geo_ms": [8, 18],
        "cloud_same_provider_inter_geo_ms": [60, 85],
        "cloud_cross_provider_intra_geo_ms": [20, 35],
        "cloud_cross_provider_inter_geo_ms": [90, 130],
        "original_to_cloud_intra_geo_ms": [20, 60],
        "original_to_cloud_inter_geo_ms": [80, 150],
    },
}


def deep_merge(base: dict[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    out = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, Mapping) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = deepcopy(value)
    return out


def load_config(path: str | Path | None) -> dict[str, Any]:
    if path is None:
        return deepcopy(DEFAULT_CONFIG)
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"Configuration must be a mapping: {path}")
    return deep_merge(DEFAULT_CONFIG, raw)
