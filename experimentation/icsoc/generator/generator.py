from __future__ import annotations

import csv
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from itertools import product
from pathlib import Path
from typing import Any

from . import __version__
from .orchestration import (
    derive_transitions,
    parse_orchestration,
    routing_entries,
)
from .pricing import FaaSPricing
from .security import infer_task_security, node_security_score
from .utils import (
    is_near_region,
    load_json,
    parse_number,
    safe_id,
    seeded_uniform,
    stable_hash,
    trigger_event,
    unique_sorted,
    write_json,
)


@dataclass
class GenerationReports:
    candidate_rows: list[dict[str, Any]] = field(default_factory=list)
    pricing_rows: list[dict[str, Any]] = field(default_factory=list)
    non_cloud_cost_rows: list[dict[str, Any]] = field(default_factory=list)
    latency_rows: list[dict[str, Any]] = field(default_factory=list)
    security_rows: list[dict[str, Any]] = field(default_factory=list)
    budget_rows: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class BimPackage:
    """A Git-readable BIM v1 package before it is written to disk."""

    root: dict[str, Any]
    documents: dict[str, dict[str, Any]]


@dataclass
class InfraContext:
    seed: str
    size: str
    path: Path
    raw: dict[str, Any]
    nodes: dict[str, dict[str, Any]]
    services: list[dict[str, Any]]
    event_generators: list[dict[str, Any]]
    pools: dict[str, dict[str, Any]]
    pool_by_original_node: dict[str, str]
    pool_kinds: dict[str, str]
    pool_latency: dict[str, dict[str, float]]
    node_monthly_costs: dict[str, float]


def generate_dataset(
    dataset: str | Path,
    pricing_dir: str | Path,
    config: dict[str, Any],
    seed: int,
    out: str | Path,
    *,
    applications: set[str] | None = None,
    dataset_seeds: set[str] | None = None,
    sizes: set[str] | None = None,
) -> GenerationReports:
    dataset = Path(dataset)
    out = Path(out)
    reports = GenerationReports()
    pricing = FaaSPricing(pricing_dir)
    apps = load_json(dataset / "applications.json")
    infra_root = dataset / "infrastructures"

    for app in apps:
        app_id = safe_id(app["orchestration_id"])
        if (
            applications
            and app_id not in applications
            and app["orchestration_id"] not in applications
        ):
            continue
        orchestration = parse_orchestration(app["orchestration_structure"])
        flow = derive_transitions(orchestration)
        security = infer_task_security(app, orchestration, config)
        reports.security_rows.extend(security.trace_rows)

        for seed_dir in sorted(p for p in infra_root.iterdir() if p.is_dir()):
            if dataset_seeds and seed_dir.name not in dataset_seeds:
                continue
            for infra_path in sorted(
                seed_dir.glob("infrastructure_*.json"),
                key=lambda p: _infra_size(p.name),
            ):
                size = str(_infra_size(infra_path.name))
                if sizes and size not in sizes and infra_path.stem not in sizes:
                    continue
                infra = build_infra_context(infra_path, config, seed, reports)
                instance, instance_report_rows = build_instance(
                    app=app,
                    workflow=orchestration.workflow,
                    flow=flow,
                    task_calls=orchestration.calls,
                    security_thresholds=security.task_thresholds,
                    infra=infra,
                    pricing=pricing,
                    config=config,
                    generator_seed=seed,
                    reports=reports,
                )
                target = out / "instances" / app_id / seed_dir.name / infra_path.stem
                write_instance_package(target, instance)
                reports.candidate_rows.extend(instance_report_rows)

    write_reports(out / "reports", reports)
    return reports


def write_instance_package(target: Path, package: BimPackage) -> None:
    """Write a deterministic Git-readable BIM v1 package directory."""
    target.mkdir(parents=True, exist_ok=True)
    expected_files = {"instance.json", *package.documents}
    for existing in target.iterdir():
        if existing.is_file() and existing.name not in expected_files:
            existing.unlink()
    for relative_path, document in package.documents.items():
        write_json(target / relative_path, document)
    write_json(target / "instance.json", package.root)


def _infra_size(filename: str) -> int:
    return int(filename.split("infrastructure_", 1)[1].split(".", 1)[0])


def build_infra_context(
    infra_path: Path,
    config: dict[str, Any],
    generator_seed: int,
    reports: GenerationReports,
) -> InfraContext:
    raw = load_json(infra_path)
    seed = infra_path.parent.name
    size = str(_infra_size(infra_path.name))
    nodes = {node["name"]: node for node in raw.get("nodes", [])}
    pool_by_original_node: dict[str, str] = {}
    pool_kinds: dict[str, str] = {}
    pools: dict[str, dict[str, Any]] = {}
    node_monthly_costs: dict[str, float] = {}

    for node in raw.get("nodes", []):
        node_id = safe_id(node["name"])
        pool_by_original_node[node["name"]] = node_id
        kind = str(node.get("type", "node")).upper()
        pool_kinds[node_id] = kind
        declared_capacity = _node_capacity(node)
        capacity = {
            dimension: float(declared_capacity.get(dimension, 0.0))
            for dimension in ("memory_mb", "vcpu", "mhz", "concurrency")
        }
        pools[node_id] = {
            "name": node["name"],
            "kind": kind,
            "capacity": capacity,
            "properties": {
                "source": "original_dataset",
                "provider": safe_id(node.get("provider", "unknown")),
                "node_type": node.get("type", "unknown"),
            },
        }
        node_monthly_costs[node["name"]] = _node_monthly_cost(
            node, seed, generator_seed, config
        )
        reports.non_cloud_cost_rows.append(
            {
                "dataset_seed": seed,
                "infrastructure": infra_path.stem,
                "node_id": node["name"],
                "kind": node.get("type", "unknown"),
                "memory_mb": node.get("hardware_caps", {}).get("memory"),
                "vcpu": node.get("hardware_caps", {}).get("v_cpu"),
                "mhz": node.get("hardware_caps", {}).get("mhz"),
                "node_monthly_cost": round(node_monthly_costs[node["name"]], 8),
                "generator_seed": generator_seed,
            }
        )

    for provider, regions in config["cloud_regions"].items():
        for region in regions:
            pool_id = safe_id(f"{provider}.faas.{region}")
            pool_kinds[pool_id] = "CLOUD_FAAS"
            pools[pool_id] = {
                "name": f"{provider.upper()} FaaS {region}",
                "kind": "CLOUD_FAAS",
                "capacity": {
                    "memory_mb": 0.0,
                    "vcpu": 0.0,
                    "mhz": 0.0,
                    "concurrency": float(config["cloud_faas_capacity"]["concurrency"]),
                },
                "properties": {
                    "source": "generated_cloud_faas",
                    "commercial_provider": provider,
                    "region": region,
                },
            }

    pool_latency = build_latency_matrix(
        raw,
        pools,
        pool_by_original_node,
        config,
        generator_seed,
        reports,
        seed,
        infra_path.stem,
    )
    return InfraContext(
        seed=seed,
        size=size,
        path=infra_path,
        raw=raw,
        nodes=nodes,
        services=raw.get("services", []),
        event_generators=raw.get("event_generators", []),
        pools=pools,
        pool_by_original_node=pool_by_original_node,
        pool_kinds=pool_kinds,
        pool_latency=pool_latency,
        node_monthly_costs=node_monthly_costs,
    )


def _node_capacity(node: dict[str, Any]) -> dict[str, float]:
    hw = node.get("hardware_caps", {})
    return {
        "memory_mb": parse_number(hw.get("memory", 0)),
        "vcpu": parse_number(hw.get("v_cpu", 0)),
        "mhz": parse_number(hw.get("mhz", 0)),
    }


def _task_demand(function: dict[str, Any]) -> dict[str, float]:
    hw = function.get("hw_reqs", {})
    return {
        "memory_mb": parse_number(hw.get("memory", 0)),
        "vcpu": parse_number(hw.get("v_cpu", 0)),
        "mhz": parse_number(hw.get("mhz", 0)),
    }


def _node_monthly_cost(
    node: dict[str, Any], dataset_seed: str, generator_seed: int, config: dict[str, Any]
) -> float:
    kind = str(node.get("type", "edge")).lower()
    ranges = config["non_cloud_costs"]["base_monthly_usd"]
    low, high = ranges.get(kind, ranges.get("edge", [2, 15]))
    base = seeded_uniform(
        float(low),
        float(high),
        generator_seed,
        dataset_seed,
        node["name"],
        "node-cost-v1",
    )
    coeffs = config["non_cloud_costs"]["coefficients"]
    hw = node.get("hardware_caps", {})
    memory_gb = (
        0
        if str(hw.get("memory")).lower() == "inf"
        else parse_number(hw.get("memory", 0)) / 1024.0
    )
    vcpu = (
        0 if str(hw.get("v_cpu")).lower() == "inf" else parse_number(hw.get("v_cpu", 0))
    )
    mhz = 0 if str(hw.get("mhz")).lower() == "inf" else parse_number(hw.get("mhz", 0))
    return (
        base
        + coeffs["memory_gb"] * memory_gb
        + coeffs["vcpu"] * vcpu
        + coeffs["mhz_per_1000"] * (mhz / 1000.0)
    )


def build_latency_matrix(
    raw: dict[str, Any],
    pools: dict[str, dict[str, Any]],
    pool_by_original_node: dict[str, str],
    config: dict[str, Any],
    generator_seed: int,
    reports: GenerationReports,
    dataset_seed: str,
    infra_name: str,
) -> dict[str, dict[str, float]]:
    pool_ids = list(pools)
    matrix = {pid: {pid: 0.0} for pid in pool_ids}

    for link in raw.get("links", []):
        a = pool_by_original_node.get(link["nodeA"])
        b = pool_by_original_node.get(link["nodeB"])
        if not a or not b:
            continue
        latency = float(link["latency"])
        matrix.setdefault(a, {})[b] = latency
        matrix.setdefault(b, {})[a] = latency

    pool_meta = {name: pool.get("properties", {}) for name, pool in pools.items()}
    pool_kind = {name: pool.get("kind") for name, pool in pools.items()}
    for a in pool_ids:
        for b in pool_ids:
            if b in matrix.setdefault(a, {}):
                continue
            latency = generated_latency(
                a, b, pool_kind, pool_meta, config, generator_seed, dataset_seed
            )
            matrix[a][b] = latency
            matrix.setdefault(b, {})[a] = latency
            reports.latency_rows.append(
                {
                    "dataset_seed": dataset_seed,
                    "infrastructure": infra_name,
                    "source_pool": a,
                    "target_pool": b,
                    "latency_ms": latency,
                    "source": "generated",
                    "generator_seed": generator_seed,
                }
            )
    return matrix


def _region_geo(region: str, lat_cfg: dict[str, Any]) -> str:
    geo = (lat_cfg.get("region_geo") or {}).get(region)
    if geo:
        return str(geo)
    # Fallback for regions missing from the config table.
    return "eu" if is_near_region(region) else "us"


def generated_latency(
    a: str,
    b: str,
    pool_kind: dict[str, str],
    pool_meta: dict[str, dict[str, Any]],
    config: dict[str, Any],
    generator_seed: int,
    dataset_seed: str,
) -> float:
    """Synthetic latency for pool pairs not covered by the original dataset.

    Cloud-to-cloud links follow a provider/geography model with disjoint
    ranges per class, so that same-provider links (private backbone) are
    always faster than cross-provider links (public peering) within the same
    geography class, and intra-geo links are always faster than inter-geo
    ones. Original-node-to-cloud links depend only on the cloud region's
    geography (the edge/fog infrastructure has no declared location and is
    assumed to sit in the EU, next to its event generators).
    """
    lat_cfg = config["latency_generation"]
    a_cloud = pool_kind.get(a) == "CLOUD_FAAS"
    b_cloud = pool_kind.get(b) == "CLOUD_FAAS"
    region_a = str(pool_meta.get(a, {}).get("region", ""))
    region_b = str(pool_meta.get(b, {}).get("region", ""))

    if a_cloud and b_cloud:
        provider_a = str(pool_meta.get(a, {}).get("commercial_provider", ""))
        provider_b = str(pool_meta.get(b, {}).get("commercial_provider", ""))
        same_provider = provider_a == provider_b and provider_a != ""
        same_geo = _region_geo(region_a, lat_cfg) == _region_geo(region_b, lat_cfg)
        if same_provider and region_a == region_b:
            low, high = lat_cfg["cloud_same_provider_same_region_ms"]
        elif same_provider and same_geo:
            low, high = lat_cfg["cloud_same_provider_intra_geo_ms"]
        elif same_provider:
            low, high = lat_cfg["cloud_same_provider_inter_geo_ms"]
        elif same_geo:
            low, high = lat_cfg["cloud_cross_provider_intra_geo_ms"]
        else:
            low, high = lat_cfg["cloud_cross_provider_inter_geo_ms"]
    else:
        region = region_a if a_cloud else region_b
        if _region_geo(region, lat_cfg) == "eu":
            low, high = lat_cfg["original_to_cloud_intra_geo_ms"]
        else:
            low, high = lat_cfg["original_to_cloud_inter_geo_ms"]
    return round(
        seeded_uniform(
            float(low), float(high), generator_seed, dataset_seed, a, b, "latency-v2"
        ),
        3,
    )


def build_instance(
    *,
    app: dict[str, Any],
    workflow: dict[str, Any],
    flow: Any,
    task_calls: dict[str, Any],
    security_thresholds: dict[str, float],
    infra: InfraContext,
    pricing: FaaSPricing,
    config: dict[str, Any],
    generator_seed: int,
    reports: GenerationReports,
) -> tuple[BimPackage, list[dict[str, Any]]]:
    app_id = safe_id(app["orchestration_id"])
    functions = {safe_id(f["id"]): f for f in app.get("functions", [])}
    service_types = unique_sorted(
        [safe_id(s["type"]) for s in infra.services]
        + [
            safe_id(req["type"])
            for fn in app.get("functions", [])
            for req in (fn.get("service_reqs", []) or [])
        ]
    )
    service_ids = unique_sorted(safe_id(s["name"]) for s in infra.services)
    metrics = base_metric_definitions(service_types, service_ids)
    providers = build_providers(infra)
    tasks = {
        safe_id(function["id"]): f"service/{safe_id(function['id'])}"
        for function in app.get("functions", [])
    }
    candidates: dict[str, dict[str, Any]] = {}
    demands: list[dict[str, Any]] = []
    candidate_report_rows: list[dict[str, Any]] = []
    constraints = build_security_constraints(security_thresholds)
    constraints.update(build_service_constraints(app))

    for task_name, function in functions.items():
        task_candidates, task_demands, report_row = generate_task_candidates(
            app_id=app_id,
            function=function,
            task_call=task_calls[task_name],
            infra=infra,
            pricing=pricing,
            config=config,
            generator_seed=generator_seed,
            metric_names=list(metrics),
            security_threshold=security_thresholds.get(task_name, 0.33),
            reports=reports,
        )
        candidates.update(task_candidates)
        demands.extend(task_demands)
        candidate_report_rows.append(report_row)

    first_task_bounds = {
        name: float(call.latency_bound_ms or 0) for name, call in task_calls.items()
    }
    event_constraints, event_pools, event_latencies = build_event_latency(
        app, flow, infra, first_task_bounds
    )

    transitions = dict(event_constraints)
    for index, edge in enumerate(flow.transitions, start=1):
        source = edge["from"]
        target = edge["to"]
        name = safe_id(f"latency_{index}_{source['id']}_to_{target['id']}")
        transitions[name] = {
            **edge,
            "enforcement": "hard",
            "metric": {"resource": "application", "id": "latency"},
        }

    pricing_cfg = config.get("pricing_constraints", {}) or {}
    if pricing_cfg.get("enabled", True):
        pricing_constraints, normalize_bounds = build_pricing_artifacts(
            app_id=app_id,
            task_names=list(tasks),
            candidates=candidates,
            demands=demands,
            workflow=workflow,
            security_thresholds=security_thresholds,
            transitions=transitions,
            config=config,
            infra=infra,
            event_latencies=event_latencies,
            reports=reports,
        )
        constraints.update(pricing_constraints)
    else:
        normalize_bounds = _fallback_normalization_bounds(candidates)

    name = safe_id(f"{app_id}_{infra.seed}_{infra.path.stem}")
    application = {
        "apiVersion": "qos-binding/v1",
        "kind": "Application",
        "metadata": {"name": f"{name}_application"},
        "spec": {"tasks": tasks, "metrics": metrics, "workflow": workflow},
    }
    catalog = {
        "apiVersion": "qos-binding/v1",
        "kind": "CandidateCatalog",
        "metadata": {"name": f"{name}_catalog"},
        "spec": {
            "providers": providers,
            "metricBindings": {
                metric_name: {"resource": "application", "id": metric_name}
                for metric_name in metrics
            },
            "candidates": candidates,
        },
    }
    constraint_set = {
        "apiVersion": "qos-binding/v1",
        "kind": "ConstraintSet",
        "metadata": {"name": f"{name}_constraints"},
        "spec": {"constraints": constraints},
    }
    objective_weights = config["objective"]["weights"]
    optimization = {
        "apiVersion": "qos-binding/v1",
        "kind": "Optimization",
        "metadata": {"name": f"{name}_optimization"},
        "spec": {
            "mode": "weighted",
            "terms": [
                {
                    "metric": {"resource": "application", "id": metric_name},
                    "weight": abs(float(objective_weights.get(metric_name, 1.0)))
                    or 1.0,
                    "normalize": {**normalize_bounds[metric_name], "clamp": True},
                }
                for metric_name in ("latency", "cost", "security")
            ],
            **(
                {
                    "penalties": [
                        {
                            "constraint": {
                                "resource": "constraints",
                                "id": constraint_name,
                            },
                            "weight": 1.0,
                        }
                        for constraint_name, constraint in constraints.items()
                        if constraint["enforcement"] == "soft"
                    ]
                }
                if any(value["enforcement"] == "soft" for value in constraints.values())
                else {}
            ),
        },
    }
    network = [
        {
            "from": {"resource": "placement", "id": source},
            "to": {"resource": "placement", "id": target},
            "latency": latency,
        }
        for source in sorted(infra.pool_latency)
        for target, latency in sorted(infra.pool_latency[source].items())
        if source <= target
    ]
    events = {
        event_name: {
            "pool": {"resource": "placement", "id": event_pools[event_name]},
            "latency": [
                {
                    "pool": {"resource": "placement", "id": pool_name},
                    "latency": latency,
                }
                for pool_name, latency in sorted(values.items())
            ],
        }
        for event_name, values in sorted(event_latencies.items())
    }
    placement = {
        "apiVersion": "qos-binding-placement/v1",
        "kind": "Placement",
        "metadata": {"name": f"{name}_placement"},
        "spec": {
            "pools": infra.pools,
            "demands": demands,
            "networkMode": "symmetric",
            "network": network,
            "events": events,
            "transitions": transitions,
            "capacityRules": [
                {
                    "resources": ["memory_mb", "vcpu", "mhz", "concurrency"],
                    "scope": "selectedCandidate",
                }
            ],
            "globalLatency": {
                "metric": {"resource": "application", "id": "latency"},
                "includeExecution": True,
                "exclusive": "routing",
                "parallel": "max",
            },
        },
    }

    entries = routing_entries(workflow)
    documents: dict[str, dict[str, Any]] = {
        "application.json": application,
        "candidates.json": catalog,
        "constraints.json": constraint_set,
        "optimization.json": optimization,
        "placement.json": placement,
    }
    application_resources = {
        "application": "application.json",
        "placement": "placement.json",
    }
    if entries:
        documents["routing.json"] = {
            "apiVersion": "qos-binding/v1",
            "kind": "RoutingOverlay",
            "metadata": {"name": f"{name}_routing"},
            "spec": {"entries": entries},
        }
        application_resources["routing"] = "routing.json"
    instance = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {
            "name": name,
            "version": "1.0.0",
            "description": (
                f"{app['name']} on {infra.path.stem} ({infra.seed}). "
                "Generated BIM v1 instance from the ICSOC placement dataset."
            ),
            "annotations": {
                "source_dataset": "experimentation/icsoc/original_dataset",
                "application_id": app_id,
                "dataset_seed": infra.seed,
                "infrastructure": infra.path.name,
                "generator_seed": generator_seed,
                "generator_version": __version__,
            },
        },
        "spec": {
            "profile": "qos-binding/v1",
            "resources": {
                "application": application_resources,
                "candidateCatalog": {"catalog": "candidates.json"},
                "constraintSet": {"constraints": "constraints.json"},
                "optimization": {"optimization": "optimization.json"},
            },
        },
    }
    return BimPackage(root=instance, documents=documents), candidate_report_rows


def _fallback_normalization_bounds(
    candidates: dict[str, dict[str, Any]],
) -> dict[str, dict[str, float]]:
    bounds: dict[str, dict[str, float]] = {}
    for metric_name in ("latency", "cost", "security"):
        values = [
            float(candidate["metrics"][metric_name])
            for candidate in candidates.values()
            if isinstance(candidate.get("metrics", {}).get(metric_name), (int, float))
        ]
        if values:
            minimum, maximum = min(values), max(values)
            bounds[metric_name] = {
                "min": minimum,
                "max": maximum if maximum > minimum else minimum + 1.0,
            }
    return bounds


def base_metric_definitions(
    service_types: list[str],
    service_names: list[str],
) -> dict[str, dict[str, Any]]:
    metrics: dict[str, dict[str, Any]] = {
        "latency": {
            "unit": "ms",
            "direction": "minimize",
            "scope": "invocation",
            "aggregation": {
                "sequence": "sum",
                "parallel": "max",
                "exclusive": "weightedSum",
                "repeat": "scale",
                "selection": "sum",
            },
            "domain": {"kind": "real", "minimum": 0.0, "maximum": 1_000_000.0},
        },
        "cost": {
            "unit": "USD/month",
            "direction": "minimize",
            "scope": "invocation",
            "aggregation": "sum",
            "domain": {"kind": "real", "minimum": 0.0, "maximum": 1_000_000.0},
        },
        "security": {
            "unit": "score",
            "direction": "maximize",
            "scope": "invocation",
            "aggregation": "min",
            "domain": {"kind": "real", "minimum": 0.0, "maximum": 1.0},
        },
    }
    for service_type in service_types:
        metrics[f"has_service_{service_type}"] = {
            "unit": "boolean",
            "direction": "maximize",
            "scope": "invocation",
            "aggregation": "max",
            "domain": {"kind": "real", "minimum": 0.0, "maximum": 1.0},
        }
    for service_name in service_names:
        metrics[f"bind_service_{service_name}"] = {
            "unit": "boolean",
            "direction": "maximize",
            "scope": "invocation",
            "aggregation": "max",
            "domain": {"kind": "real", "minimum": 0.0, "maximum": 1.0},
        }
    return metrics


def build_providers(infra: InfraContext) -> dict[str, dict[str, str]]:
    ids = {
        safe_id(node.get("provider", "unknown")): node.get("provider", "unknown")
        for node in infra.nodes.values()
    }
    ids.update({"aws": "AWS", "azure": "Azure", "gcp": "Google Cloud"})
    return {name: {"name": label} for name, label in sorted(ids.items())}


def build_security_constraints(
    security_thresholds: dict[str, float],
) -> dict[str, dict[str, Any]]:
    return {
        safe_id(f"security_min_{task_name}"): {
            "assert": (
                f"tasks.{task_name}.metrics.security >= "
                f"{json_number(round(float(threshold), 6))}"
            ),
            "enforcement": "hard",
        }
        for task_name, threshold in sorted(security_thresholds.items())
    }


def build_service_constraints(app: dict[str, Any]) -> dict[str, dict[str, Any]]:
    constraints: dict[str, dict[str, Any]] = {}
    for function in app.get("functions", []):
        task_name = safe_id(function["id"])
        for req in function.get("service_reqs", []) or []:
            service_type = safe_id(req["type"])
            constraints[safe_id(f"{task_name}_requires_{service_type}")] = {
                "assert": f"tasks.{task_name}.metrics.has_service_{service_type} == 1",
                "enforcement": "hard",
            }
    return constraints


def json_number(value: Any) -> str:
    return (
        str(int(value))
        if isinstance(value, float) and value.is_integer()
        else str(value)
    )


def generate_task_candidates(
    *,
    app_id: str,
    function: dict[str, Any],
    task_call: Any,
    infra: InfraContext,
    pricing: FaaSPricing,
    config: dict[str, Any],
    generator_seed: int,
    metric_names: list[str],
    security_threshold: float,
    reports: GenerationReports,
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    task_name = safe_id(function["id"])
    demand = _task_demand(function)
    service_reqs = function.get("service_reqs", []) or []
    counters = Counter()
    candidates: dict[str, dict[str, Any]] = {}
    demands: list[dict[str, Any]] = []

    for node in infra.nodes.values():
        pool_id = infra.pool_by_original_node[node["name"]]
        counters["original_considered"] += 1
        if not _supports_software(node, function):
            counters["filtered_by_sw"] += 1
            continue
        if not _supports_hardware(node, demand):
            counters["filtered_by_hw"] += 1
            continue
        service_sets = service_options_for_pool(
            pool_id, service_reqs, task_call.bindings, infra
        )
        if service_reqs and not service_sets:
            counters["filtered_by_service"] += 1
            continue
        score_label, security_score = node_security_score(
            node.get("security_caps", []), config
        )
        base_cost = original_candidate_cost(
            node, demand, infra.node_monthly_costs[node["name"]]
        )
        for selected_services in service_sets or [[]]:
            candidate_name = candidate_key(
                task_name, pool_id, selected_services, "orig"
            )
            candidates[candidate_name] = {
                "name": f"{function['id']} on {node['name']}",
                "provider": {
                    "resource": "catalog",
                    "id": safe_id(node.get("provider", "unknown")),
                },
                "provides": f"service/{task_name}",
                "properties": {
                    "description": (
                        f"Original {node.get('type')} node, security={score_label}"
                    )
                },
                "metrics": candidate_metrics(
                    metric_names,
                    base_cost,
                    security_score,
                    selected_services,
                ),
            }
            demands.append(
                {
                    "candidate": {"resource": "catalog", "id": candidate_name},
                    "pool": {"resource": "placement", "id": pool_id},
                    "resources": demand,
                }
            )
            counters["non_cloud_candidates"] += 1
            reports.pricing_rows.append(
                pricing_row(
                    app_id,
                    infra,
                    task_name,
                    candidate_name,
                    "original",
                    "",
                    "",
                    0,
                    0,
                    base_cost,
                )
            )

    workload = config["workload_defaults"]
    for provider, regions in config["cloud_regions"].items():
        for region in regions:
            pool_id = safe_id(f"{provider}.faas.{region}")
            service_sets = service_options_for_pool(
                pool_id, service_reqs, task_call.bindings, infra
            )
            if service_reqs and not service_sets:
                counters["cloud_filtered_by_service"] += 1
                continue
            for memory_mb in cloud_memory_variants(function, config):
                try:
                    cost = pricing.estimate(
                        provider,
                        region,
                        invocations_per_month=float(workload["invocations_per_month"]),
                        avg_duration_ms=float(workload["avg_duration_ms"]),
                        memory_mb=float(memory_mb),
                        vcpu=float(demand["vcpu"] or 1),
                    )
                except KeyError:
                    counters["cloud_filtered_by_pricing"] += 1
                    continue
                for selected_services in service_sets or [[]]:
                    candidate_name = candidate_key(
                        task_name,
                        pool_id,
                        selected_services,
                        f"mem{memory_mb}",
                    )
                    candidates[candidate_name] = {
                        "name": f"{function['id']} on {provider.upper()} {region} ({memory_mb} MB)",
                        "provider": {"resource": "catalog", "id": safe_id(provider)},
                        "provides": f"service/{task_name}",
                        "properties": {
                            "description": "Generated regional FaaS candidate"
                        },
                        "metrics": candidate_metrics(
                            metric_names,
                            cost,
                            1.0,
                            selected_services,
                        ),
                    }
                    demands.append(
                        {
                            "candidate": {"resource": "catalog", "id": candidate_name},
                            "pool": {"resource": "placement", "id": pool_id},
                            "resources": {
                                "concurrency": float(workload["concurrency"])
                            },
                        }
                    )
                    counters["cloud_candidates"] += 1
                    reports.pricing_rows.append(
                        pricing_row(
                            app_id,
                            infra,
                            task_name,
                            candidate_name,
                            provider,
                            region,
                            memory_mb,
                            workload["invocations_per_month"],
                            workload["avg_duration_ms"],
                            cost,
                        )
                    )

    counters["filtered_by_security"] = 0
    counters["total_candidates"] = len(candidates)
    return (
        candidates,
        demands,
        {
            "application": app_id,
            "dataset_seed": infra.seed,
            "infrastructure": infra.path.stem,
            "infra_size": infra.size,
            "task": task_name,
            "security_threshold": security_threshold,
            **dict(counters),
        },
    )


def _supports_software(node: dict[str, Any], function: dict[str, Any]) -> bool:
    caps = set(node.get("software_caps", []))
    return set(function.get("sw_reqs", [])).issubset(caps)


def _supports_hardware(node: dict[str, Any], demand: dict[str, float]) -> bool:
    hw = node.get("hardware_caps", {})
    for key, source_key in (("memory_mb", "memory"), ("vcpu", "v_cpu"), ("mhz", "mhz")):
        raw = hw.get(source_key, 0)
        if str(raw).lower() == "inf":
            continue
        if parse_number(raw) < demand[key]:
            return False
    return True


def service_options_for_pool(
    pool_id: str,
    service_reqs: list[dict[str, Any]],
    explicit_bindings: list[str],
    infra: InfraContext,
) -> list[list[dict[str, Any]]]:
    if not service_reqs:
        return [[]]
    options: list[list[dict[str, Any]]] = []
    explicit = [b.lower() for b in explicit_bindings]
    for req in service_reqs:
        req_type = req["type"]
        req_latency = float(req.get("latency", 1_000_000))
        matching = []
        for service in infra.services:
            if service.get("type") != req_type:
                continue
            if explicit and not any(
                service["name"].lower().startswith(prefix.lower())
                for prefix in explicit
            ):
                continue
            service_pool = infra.pool_by_original_node.get(service["node"])
            if not service_pool:
                continue
            if infra.pool_latency[pool_id][service_pool] <= req_latency:
                matching.append(service)
        if not matching:
            return []
        options.append(matching)
    return [list(items) for items in product(*options)]


def original_candidate_cost(
    node: dict[str, Any], demand: dict[str, float], node_monthly_cost: float
) -> float:
    hw = node.get("hardware_caps", {})
    fractions = []
    for demand_key, hw_key in (
        ("memory_mb", "memory"),
        ("vcpu", "v_cpu"),
        ("mhz", "mhz"),
    ):
        raw = hw.get(hw_key, 0)
        if str(raw).lower() == "inf":
            continue
        cap = parse_number(raw)
        if cap > 0:
            fractions.append(demand[demand_key] / cap)
    fraction = max(fractions) if fractions else 0.01
    return round(max(0.000001, node_monthly_cost * fraction), 8)


def cloud_memory_variants(
    function: dict[str, Any], config: dict[str, Any]
) -> list[int]:
    required = parse_number(function.get("hw_reqs", {}).get("memory", 128))
    domain = [int(v) for v in config["cloud_memory_mb_domain"]]
    return [value for value in domain if value >= required] or [max(domain)]


def candidate_key(
    task_name: str,
    pool_name: str,
    services: list[dict[str, Any]],
    variant: str,
) -> str:
    service_part = (
        "_".join(safe_id(s["name"]) for s in services) if services else "nosvc"
    )
    digest = stable_hash(task_name, pool_name, service_part, variant, length=8)
    return safe_id(f"cand_{task_name}_{pool_name}_{variant}_{digest}")


def candidate_metrics(
    metric_names: list[str],
    cost: float,
    security: float,
    selected_services: list[dict[str, Any]],
) -> dict[str, float]:
    metrics = {name: 0.0 for name in metric_names}
    metrics["latency"] = 0.0
    metrics["cost"] = round(float(cost), 8)
    metrics["security"] = round(float(security), 6)
    for service in selected_services:
        metrics[f"has_service_{safe_id(service['type'])}"] = 1.0
        metrics[f"bind_service_{safe_id(service['name'])}"] = 1.0
    return metrics


def pricing_row(
    app_id: str,
    infra: InfraContext,
    task_name: str,
    candidate_name: str,
    provider: str,
    region: str,
    memory_mb: Any,
    invocations: Any,
    duration_ms: Any,
    cost: float,
) -> dict[str, Any]:
    return {
        "application": app_id,
        "dataset_seed": infra.seed,
        "infrastructure": infra.path.stem,
        "task": task_name,
        "candidate": candidate_name,
        "provider": provider,
        "region": region,
        "memory_mb": memory_mb,
        "invocations": invocations,
        "duration_ms": duration_ms,
        "cost": round(float(cost), 8),
    }


def _quantile(sorted_values: list[float], q: float) -> float:
    """Linear-interpolation quantile of a pre-sorted list (numpy 'linear')."""
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return sorted_values[0]
    position = q * (len(sorted_values) - 1)
    lower = int(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    fraction = position - lower
    return sorted_values[lower] * (1.0 - fraction) + sorted_values[upper] * fraction


def fold_over_workflow(
    node: dict[str, Any],
    per_task: dict[str, float],
    operators: dict[str, str],
) -> float:
    """Aggregate values directly over BIM v1 workflow blocks."""
    reference = node.get("task")
    if reference:
        return per_task[reference["id"]]
    if "sequence" in node or "parallel" in node:
        block = "sequence" if "sequence" in node else "parallel"
        values = [
            fold_over_workflow(child, per_task, operators) for child in node[block]
        ]
        return _apply_fold(operators[block], values)
    if "exclusive" in node:
        values = [
            fold_over_workflow(branch["flow"], per_task, operators)
            for branch in node["exclusive"]
        ]
        if operators["exclusive"] == "weightedSum":
            probability = 1.0 / len(values)
            return sum(probability * value for value in values)
        return _apply_fold(operators["exclusive"], values)
    if "repeat" in node:
        repeat = node["repeat"]
        count = float(repeat.get("count", repeat.get("expectedCount", 1.0)))
        return count * fold_over_workflow(repeat["body"], per_task, operators)
    if node.get("empty") is True:
        return 0.0
    raise ValueError(f"Unsupported BIM workflow block for fold: {node!r}")


def _apply_fold(operator: str, values: list[float]) -> float:
    if operator == "min":
        return min(values)
    if operator == "max":
        return max(values)
    return sum(values)


_COST_OPERATORS = {"sequence": "sum", "parallel": "sum", "exclusive": "weightedSum"}
_SECURITY_OPERATORS = {"sequence": "min", "parallel": "min", "exclusive": "min"}


def _latency_norm_bounds(
    workflow: dict[str, Any],
    infra: InfraContext,
    event_latencies: dict[str, dict[str, float]],
    min_exec: dict[str, float] | None = None,
    max_exec: dict[str, float] | None = None,
) -> tuple[float, float]:
    """Sound [min, max] bounds for the end-to-end latency of any binding.

    The makespan is monotone in every transfer latency and every execution
    latency, so scheduling the scenario DAGs with constant extremal transfer
    latencies and per-task extremal execution latencies yields valid bounds.

    The generator enumerates its own finite BIM workflow here because
    normalization is part of the generated source contract, not engine state.
    """
    min_exec = min_exec or {}
    max_exec = max_exec or {}
    all_event = [v for row in event_latencies.values() for v in row.values()]
    min_event = min(all_event) if all_event else 0.0
    max_event = max(all_event) if all_event else 0.0
    max_lat = max(
        (v for row in infra.pool_latency.values() for v in row.values()),
        default=0.0,
    )

    exclusive_nodes: list[dict[str, Any]] = []

    def collect_exclusives(node: dict[str, Any]) -> None:
        if "exclusive" in node:
            exclusive_nodes.append(node)
            for branch in node["exclusive"]:
                collect_exclusives(branch["flow"])
        for block in ("sequence", "parallel"):
            for child in node.get(block, []):
                collect_exclusives(child)
        if "repeat" in node:
            collect_exclusives(node["repeat"]["body"])

    def build_dag(
        node: dict[str, Any],
        entries: list[tuple[str, str]],
        choices: dict[int, int],
        predecessors: dict[str, list[tuple[str, str]]],
        order: list[str],
    ) -> list[tuple[str, str]]:
        reference = node.get("task")
        if reference:
            task_name = reference["id"]
            if task_name in predecessors:
                raise ValueError(
                    f"task {task_name!r} appears more than once in the workflow"
                )
            predecessors[task_name] = list(entries)
            order.append(task_name)
            return [("task", task_name)]
        if "sequence" in node:
            current = list(entries)
            for child in node["sequence"]:
                current = build_dag(child, current, choices, predecessors, order)
            return current
        if "parallel" in node:
            exits: list[tuple[str, str]] = []
            for child in node["parallel"]:
                exits.extend(
                    build_dag(child, list(entries), choices, predecessors, order)
                )
            return exits
        if "exclusive" in node:
            branches = node["exclusive"]
            return build_dag(
                branches[choices[id(node)]]["flow"],
                entries,
                choices,
                predecessors,
                order,
            )
        if "repeat" in node:
            return build_dag(
                node["repeat"]["body"], entries, choices, predecessors, order
            )
        if node.get("empty") is True:
            return list(entries)
        raise ValueError(f"unsupported BIM workflow block in latency bounds: {node!r}")

    collect_exclusives(workflow)
    scenarios: list[dict[str, Any]] = []
    combinations = (
        product(*(range(len(node["exclusive"])) for node in exclusive_nodes))
        if exclusive_nodes
        else [()]
    )
    for combination in combinations:
        choices = {id(node): index for node, index in zip(exclusive_nodes, combination)}
        probability = 1.0
        for node, _index in zip(exclusive_nodes, combination):
            probability *= 1.0 / len(node["exclusive"])
        predecessors: dict[str, list[tuple[str, str]]] = {}
        order: list[str] = []
        entries = [("event", event_id) for event_id in sorted(event_latencies)]
        exits = build_dag(workflow, entries, choices, predecessors, order)
        scenarios.append(
            {
                "prob": probability,
                "preds": predecessors,
                "order": order,
                "sinks": [
                    source_id
                    for source_kind, source_id in exits
                    if source_kind == "task"
                ],
            }
        )

    def makespan(transfer: float, event: float, exec_of: dict[str, float]) -> float:
        total = 0.0
        for scenario in scenarios:
            finish: dict[str, float] = {}
            for task_name in scenario["order"]:
                start = 0.0
                for src_kind, src_id in scenario["preds"][task_name]:
                    ready = 0.0 if src_kind == "event" else finish[src_id]
                    start = max(
                        start, ready + (event if src_kind == "event" else transfer)
                    )
                finish[task_name] = start + float(exec_of.get(task_name, 0.0))
            sinks = scenario["sinks"] or scenario["order"]
            total += scenario["prob"] * max((finish[t] for t in sinks), default=0.0)
        return total

    return makespan(0.0, min_event, min_exec), makespan(max_lat, max_event, max_exec)


def _latency_arc_consistent_pools(
    task_names: list[str],
    by_task: dict[str, list[str]],
    candidate_pools: dict[str, str],
    transitions: dict[str, dict[str, Any]],
    infra: InfraContext,
    event_latencies: dict[str, dict[str, float]],
) -> dict[str, set[str]]:
    """AC-3 filtering of per-task pool domains w.r.t. transition constraints.

    A pool survives for a task if, for every incident transition bound, some
    pool in the neighbour task's domain is within the bound (and, for event
    transitions, the event latency itself is within the bound). Any feasible
    binding only uses surviving pools, so budgets derived from the filtered
    candidate sets are anchored to latency-plausible costs.
    """
    domains: dict[str, set[str]] = {
        task_name: {
            candidate_pools[candidate_name]
            for candidate_name in by_task.get(task_name, [])
        }
        for task_name in task_names
    }

    binary: list[tuple[str, str, float]] = []
    for transition in transitions.values():
        bound = float(transition["maximum"])
        source = transition["from"]
        target_name = transition["to"]["id"]
        if source["resource"] == "placement":
            event_row = event_latencies.get(source["id"], {})
            domains[target_name] = {
                pool
                for pool in domains.get(target_name, set())
                if event_row.get(pool, float("inf")) <= bound + 1e-9
            }
        else:
            binary.append((source["id"], target_name, bound))

    latency = infra.pool_latency
    changed = True
    while changed:
        changed = False
        for source_name, target_name, bound in binary:
            dom_from = domains.get(source_name, set())
            dom_to = domains.get(target_name, set())
            keep_from = {
                p
                for p in dom_from
                if any(latency[p][q] <= bound + 1e-9 for q in dom_to)
            }
            keep_to = {
                q
                for q in dom_to
                if any(latency[p][q] <= bound + 1e-9 for p in keep_from)
            }
            if keep_from != dom_from:
                domains[source_name] = keep_from
                changed = True
            if keep_to != dom_to:
                domains[target_name] = keep_to
                changed = True
    return domains


def _cheapest_feasible_witness(
    task_names: list[str],
    eligible_by_task: dict[str, list[str]],
    candidate_pools: dict[str, str],
    demand_of: dict[str, dict[str, float]],
    infra: InfraContext,
    transitions: dict[str, dict[str, Any]],
    event_latencies: dict[str, dict[str, float]],
    node_budget: int = 500_000,
) -> dict[str, str] | None:
    """Cheapest-first backtracking search for a certified feasible binding.

    AC-3 only guarantees arc consistency, so budgets anchored to per-task
    cheapest eligible candidates can jointly violate the transition bounds
    (or pool capacities) and render the instance UNSAT. The witness returned
    here satisfies security eligibility (already folded into the eligible
    sets), every transition constraint and every pool capacity, so budgets
    anchored to it keep the instance certifiably satisfiable.
    """
    capacity_of = {
        name: dict(pool.get("capacity") or {}) for name, pool in infra.pools.items()
    }
    latency = infra.pool_latency

    event_bounds: dict[str, list[tuple[str, float]]] = defaultdict(list)
    binary_bounds: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for transition in transitions.values():
        bound = float(transition["maximum"])
        source = transition["from"]
        target_name = transition["to"]["id"]
        if source["resource"] == "placement":
            event_bounds[target_name].append((source["id"], bound))
        else:
            source_name = source["id"]
            # Index by both endpoints so a task is checked against every
            # already-assigned neighbour as soon as it gets a pool.
            binary_bounds[target_name].append((source_name, bound))
            binary_bounds[source_name].append((target_name, bound))

    order = sorted(
        (name for name in task_names if eligible_by_task.get(name)),
        key=lambda name: len(eligible_by_task[name]),
    )
    if len(order) < len(task_names):
        return None  # some task has no eligible candidate at all

    assignment: dict[str, str] = {}
    pool_of: dict[str, str] = {}
    usage: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    expansions = 0

    def fits(task_name: str, candidate_name: str) -> bool:
        pool = candidate_pools[candidate_name]
        for event_id, bound in event_bounds.get(task_name, ()):
            if event_latencies.get(event_id, {}).get(pool, float("inf")) > bound + 1e-9:
                return False
        for other, bound in binary_bounds.get(task_name, ()):
            other_pool = pool_of.get(other)
            if other_pool is not None and latency[pool][other_pool] > bound + 1e-9:
                return False
        capacity = capacity_of.get(pool) or {}
        demand = demand_of.get(candidate_name) or {}
        for resource, needed in demand.items():
            cap = capacity.get(resource)
            if (
                cap is not None
                and usage[pool][resource] + float(needed) > float(cap) + 1e-9
            ):
                return False
        return True

    def search(depth: int) -> bool:
        nonlocal expansions
        if depth == len(order):
            return True
        task_name = order[depth]
        for candidate_name in eligible_by_task[task_name]:
            expansions += 1
            if expansions > node_budget:
                return False
            if not fits(task_name, candidate_name):
                continue
            pool = candidate_pools[candidate_name]
            assignment[task_name] = candidate_name
            pool_of[task_name] = pool
            for resource, needed in (demand_of.get(candidate_name) or {}).items():
                usage[pool][resource] += float(needed)
            if search(depth + 1):
                return True
            for resource, needed in (demand_of.get(candidate_name) or {}).items():
                usage[pool][resource] -= float(needed)
            del assignment[task_name]
            del pool_of[task_name]
        return False

    return dict(assignment) if search(0) else None


def build_pricing_artifacts(
    *,
    app_id: str,
    task_names: list[str],
    candidates: dict[str, dict[str, Any]],
    demands: list[dict[str, Any]],
    workflow: dict[str, Any],
    security_thresholds: dict[str, float],
    transitions: dict[str, dict[str, Any]],
    config: dict[str, Any],
    infra: InfraContext,
    event_latencies: dict[str, dict[str, float]],
    reports: GenerationReports,
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, float]]]:
    """Pricing (budget) constraints and canonical normalization bounds.

    - Eligibility is latency-aware: candidate pools are filtered by AC-3 over
      the transition constraints, then by the task's security threshold.
    - Per-task budget: quantile of the eligible candidates' costs, raised if
      needed to the cost of a certified feasible witness binding (cheapest
      backtracking assignment satisfying transitions + capacities), so the
      emitted instance stays satisfiable.
    - Global budget: factor x cost of the witness binding, aggregated over
      the BIM workflow.
    - Normalization bounds: per-metric [min, max] of the aggregated value
      over any binding (folds of per-task extremes; scheduler bounds for the
      end-to-end latency), shared by every engine through the instance.
    """
    cfg = config.get("pricing_constraints", {}) or {}
    factor = float(cfg.get("global_budget_factor", 1.5))
    quantile = float(cfg.get("local_budget_quantile", 0.75))
    slack = float(cfg.get("global_budget_slack", 0.25))

    by_task: dict[str, list[str]] = defaultdict(list)
    known_tasks = set(task_names)
    for candidate_name, candidate in candidates.items():
        provided = candidate["provides"]
        capabilities = [provided] if isinstance(provided, str) else provided
        for capability in capabilities:
            if capability.startswith("service/") and capability[8:] in known_tasks:
                by_task[capability[8:]].append(candidate_name)
    candidate_pools = {
        demand["candidate"]["id"]: demand["pool"]["id"] for demand in demands
    }

    ac_domains = _latency_arc_consistent_pools(
        task_names,
        by_task,
        candidate_pools,
        transitions,
        infra,
        event_latencies,
    )

    demand_of = {
        demand["candidate"]["id"]: dict(demand.get("resources") or {})
        for demand in demands
    }
    eligible_by_task: dict[str, list[str]] = {}
    for task_name in task_names:
        threshold = float(security_thresholds.get(task_name, 0.0))
        pool_domain = ac_domains.get(task_name, set())
        eligible_by_task[task_name] = sorted(
            (
                candidate_name
                for candidate_name in by_task.get(task_name, [])
                if float(candidates[candidate_name]["metrics"]["security"])
                >= threshold - 1e-9
                and candidate_pools.get(candidate_name) in pool_domain
            ),
            key=lambda candidate_name: float(
                candidates[candidate_name]["metrics"]["cost"]
            ),
        )
    witness = _cheapest_feasible_witness(
        task_names,
        eligible_by_task,
        candidate_pools,
        demand_of,
        infra,
        transitions,
        event_latencies,
    )

    constraints: dict[str, dict[str, Any]] = {}
    min_cost_eligible: dict[str, float] = {}
    local_budget_by_task: dict[str, float] = {}
    min_cost_all: dict[str, float] = {}
    max_cost_all: dict[str, float] = {}
    min_sec_all: dict[str, float] = {}
    max_sec_all: dict[str, float] = {}

    for task_name in task_names:
        task_candidates = by_task.get(task_name, [])
        if not task_candidates:
            continue
        costs_all = [
            float(candidates[name]["metrics"]["cost"]) for name in task_candidates
        ]
        securities_all = [
            float(candidates[name]["metrics"]["security"]) for name in task_candidates
        ]
        threshold = float(security_thresholds.get(task_name, 0.0))
        pool_domain = ac_domains.get(task_name, set())
        latency_feasible = bool(pool_domain)
        eligible_costs = [
            float(candidates[name]["metrics"]["cost"])
            for name in eligible_by_task[task_name]
        ]
        security_feasible = bool(eligible_costs)
        if not eligible_costs:
            # Degenerate fallback (latency/security-infeasible task): derive
            # budgets from the security-only filter, then from all candidates.
            eligible_costs = [
                float(candidates[name]["metrics"]["cost"])
                for name in task_candidates
                if float(candidates[name]["metrics"]["security"]) >= threshold - 1e-9
            ] or costs_all

        local_budget = round(_quantile(sorted(eligible_costs), quantile), 8)
        # Anchor to the certified feasible witness: its candidate must stay
        # within the local budget, otherwise the joint transition/capacity
        # structure can make the emitted instance UNSAT.
        witness_cost = (
            float(candidates[witness[task_name]]["metrics"]["cost"])
            if witness and task_name in witness
            else None
        )
        if witness_cost is not None and witness_cost > local_budget:
            local_budget = round(witness_cost, 8)
        local_budget_by_task[task_name] = local_budget
        constraints[safe_id(f"budget_local_{task_name}")] = {
            "assert": (
                f"tasks.{task_name}.metrics.cost <= {json_number(local_budget)}"
            ),
            "enforcement": "hard",
        }
        # The global budget builds on the witness binding (feasible w.r.t.
        # transitions and capacities); without a witness it falls back to the
        # cheapest candidate within all local requirements.
        if witness_cost is not None:
            min_cost_eligible[task_name] = witness_cost
        else:
            within_local = [c for c in eligible_costs if c <= local_budget + 1e-9]
            min_cost_eligible[task_name] = (
                min(within_local) if within_local else min(eligible_costs)
            )
        min_cost_all[task_name] = min(costs_all)
        max_cost_all[task_name] = max(costs_all)
        min_sec_all[task_name] = min(securities_all)
        max_sec_all[task_name] = max(securities_all)

        reports.budget_rows.append(
            {
                "application": app_id,
                "dataset_seed": infra.seed,
                "infrastructure": infra.path.stem,
                "task": task_name,
                "security_threshold": threshold,
                "eligible_candidates": len(eligible_costs),
                "latency_feasible": latency_feasible,
                "security_feasible": security_feasible,
                "witness_found": witness is not None,
                "witness_cost": round(witness_cost, 8)
                if witness_cost is not None
                else None,
                "ac_pool_domain_size": len(pool_domain),
                "local_budget_quantile": quantile,
                "local_budget": local_budget,
                "min_eligible_cost": round(min_cost_eligible[task_name], 8),
            }
        )

    cheapest_eligible = fold_over_workflow(
        workflow,
        min_cost_eligible,
        _COST_OPERATORS,
    )
    if witness is not None:
        # Certified-feasible budget with controlled difficulty: the budget
        # always covers the witness binding (so the instance is satisfiable)
        # plus a configurable share of the headroom up to the loosest sensible
        # budget (every task at its local budget). A pure factor on the
        # cheapest witness collapses the feasible region when ultra-cheap
        # cloud candidates anchor it (random search then never finds a
        # feasible binding), so slack interpolates instead of multiplying.
        local_fold = fold_over_workflow(
            workflow,
            local_budget_by_task,
            _COST_OPERATORS,
        )
        global_budget = round(
            cheapest_eligible + slack * max(0.0, local_fold - cheapest_eligible), 8
        )
    else:
        global_budget = round(factor * cheapest_eligible, 8)
    constraints = {
        safe_id(f"budget_global_{app_id}"): {
            "assert": f"metrics.cost <= {json_number(global_budget)}",
            "enforcement": "hard",
        },
        **constraints,
    }

    min_exec_lat: dict[str, float] = {}
    max_exec_lat: dict[str, float] = {}
    for task_name in task_names:
        exec_lats = [
            float(candidates[name]["metrics"].get("latency", 0.0))
            for name in by_task.get(task_name, [])
        ]
        if exec_lats:
            min_exec_lat[task_name] = min(exec_lats)
            max_exec_lat[task_name] = max(exec_lats)
    lat_min, lat_max = _latency_norm_bounds(
        workflow,
        infra,
        event_latencies,
        min_exec_lat,
        max_exec_lat,
    )
    normalize_bounds = {
        "cost": {
            "min": round(
                fold_over_workflow(workflow, min_cost_all, _COST_OPERATORS),
                8,
            ),
            "max": round(
                fold_over_workflow(workflow, max_cost_all, _COST_OPERATORS),
                8,
            ),
        },
        "latency": {"min": round(lat_min, 6), "max": round(lat_max, 6)},
        "security": {
            "min": round(
                fold_over_workflow(workflow, min_sec_all, _SECURITY_OPERATORS),
                6,
            ),
            "max": round(
                fold_over_workflow(workflow, max_sec_all, _SECURITY_OPERATORS),
                6,
            ),
        },
    }

    reports.budget_rows.append(
        {
            "application": app_id,
            "dataset_seed": infra.seed,
            "infrastructure": infra.path.stem,
            "task": "__global__",
            "global_budget_factor": factor,
            "global_budget_slack": slack,
            "witness_found": witness is not None,
            "cheapest_eligible_binding_cost": round(cheapest_eligible, 8),
            "global_budget": global_budget,
            "norm_cost_min": normalize_bounds["cost"]["min"],
            "norm_cost_max": normalize_bounds["cost"]["max"],
            "norm_latency_min": normalize_bounds["latency"]["min"],
            "norm_latency_max": normalize_bounds["latency"]["max"],
            "norm_security_min": normalize_bounds["security"]["min"],
            "norm_security_max": normalize_bounds["security"]["max"],
        }
    )

    return constraints, normalize_bounds


def build_event_latency(
    app: dict[str, Any],
    flow: Any,
    infra: InfraContext,
    first_task_bounds: dict[str, float],
) -> tuple[dict[str, dict[str, Any]], dict[str, str], dict[str, dict[str, float]]]:
    event = trigger_event(app.get("trigger", ""))
    event_pools: dict[str, str] = {}
    event_latencies: dict[str, dict[str, float]] = {}
    transitions: dict[str, dict[str, Any]] = {}
    pool_names = list(infra.pools)
    for generator in infra.event_generators:
        events = {trigger_event(e) for e in generator.get("events", [])}
        if event not in events:
            continue
        event_name = safe_id(f"{generator['name']}_{event}")
        source_pool = infra.pool_by_original_node[generator["node"]]
        event_pools[event_name] = source_pool
        event_latencies[event_name] = {
            pool_name: infra.pool_latency[source_pool][pool_name]
            for pool_name in pool_names
        }
        for first_task in sorted(flow.first, key=lambda reference: reference["id"]):
            task_name = first_task["id"]
            transition_name = safe_id(f"latency_{event_name}_to_{task_name}")
            transitions[transition_name] = {
                "from": {"resource": "placement", "id": event_name},
                "to": first_task,
                "maximum": float(first_task_bounds[task_name]),
                "enforcement": "hard",
                "metric": {"resource": "application", "id": "latency"},
            }
    return transitions, event_pools, event_latencies


def write_reports(report_dir: Path, reports: GenerationReports) -> None:
    report_dir.mkdir(parents=True, exist_ok=True)
    write_csv(report_dir / "candidate_generation_summary.csv", reports.candidate_rows)
    write_csv(report_dir / "pricing_trace.csv", reports.pricing_rows)
    write_csv(report_dir / "non_cloud_costs.csv", reports.non_cloud_cost_rows)
    write_csv(report_dir / "latency_trace.csv", reports.latency_rows)
    write_csv(report_dir / "security_trace.csv", reports.security_rows)
    write_csv(report_dir / "budget_trace.csv", reports.budget_rows)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames: list[str] = []
    seen = set()
    for row in rows:
        for key in row:
            if key not in seen:
                seen.add(key)
                fieldnames.append(key)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
