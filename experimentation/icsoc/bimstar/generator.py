from __future__ import annotations

from collections import Counter, defaultdict
import csv
from dataclasses import dataclass, field
from itertools import product
from pathlib import Path
from typing import Any

from . import __version__
from .orchestration import collect_task_calls, derive_transitions, parse_orchestration, to_bim_composition
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


@dataclass
class InfraContext:
    seed: str
    size: str
    path: Path
    raw: dict[str, Any]
    nodes: dict[str, dict[str, Any]]
    services: list[dict[str, Any]]
    event_generators: list[dict[str, Any]]
    pools: list[dict[str, Any]]
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
        if applications and app_id not in applications and app["orchestration_id"] not in applications:
            continue
        root = parse_orchestration(app["orchestration_structure"])
        task_calls = collect_task_calls(root)
        task_latency = {safe_id(tid): float(call.latency_bound_ms or 0) for tid, call in task_calls.items()}
        flow = derive_transitions(root, task_latency)
        composition = to_bim_composition(root)
        security = infer_task_security(app, root, config)
        reports.security_rows.extend(security.trace_rows)

        for seed_dir in sorted(p for p in infra_root.iterdir() if p.is_dir()):
            if dataset_seeds and seed_dir.name not in dataset_seeds:
                continue
            for infra_path in sorted(seed_dir.glob("infrastructure_*.json"), key=lambda p: _infra_size(p.name)):
                size = str(_infra_size(infra_path.name))
                if sizes and size not in sizes and infra_path.stem not in sizes:
                    continue
                infra = build_infra_context(infra_path, config, seed, reports)
                instance, instance_report_rows = build_instance(
                    app=app,
                    composition=composition,
                    root=root,
                    flow=flow,
                    task_calls=task_calls,
                    security_thresholds=security.task_thresholds,
                    infra=infra,
                    pricing=pricing,
                    config=config,
                    generator_seed=seed,
                    reports=reports,
                )
                target = (
                    out
                    / "instances"
                    / app_id
                    / seed_dir.name
                    / f"{infra_path.stem}.bimstar.json"
                )
                write_json(target, instance)
                reports.candidate_rows.extend(instance_report_rows)

    write_reports(out / "reports", reports)
    return reports


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
    pools: list[dict[str, Any]] = []
    node_monthly_costs: dict[str, float] = {}

    for node in raw.get("nodes", []):
        node_id = safe_id(node["name"])
        pool_by_original_node[node["name"]] = node_id
        kind = str(node.get("type", "node")).upper()
        pool_kinds[node_id] = kind
        capacity = _node_capacity(node)
        pools.append(
            {
                "id": node_id,
                "name": node["name"],
                "kind": kind,
                "capacity": capacity,
                "metadata": {
                    "source": "original_dataset",
                    "provider": safe_id(node.get("provider", "unknown")),
                    "node_type": node.get("type", "unknown"),
                },
            }
        )
        node_monthly_costs[node["name"]] = _node_monthly_cost(node, seed, generator_seed, config)
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
            pools.append(
                {
                    "id": pool_id,
                    "name": f"{provider.upper()} FaaS {region}",
                    "kind": "CLOUD_FAAS",
                    "capacity": {"concurrency": float(config["cloud_faas_capacity"]["concurrency"])},
                    "metadata": {
                        "source": "generated_cloud_faas",
                        "commercial_provider": provider,
                        "region": region,
                    },
                }
            )

    pool_latency = build_latency_matrix(raw, pools, pool_by_original_node, config, generator_seed, reports, seed, infra_path.stem)
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


def _node_monthly_cost(node: dict[str, Any], dataset_seed: str, generator_seed: int, config: dict[str, Any]) -> float:
    kind = str(node.get("type", "edge")).lower()
    ranges = config["non_cloud_costs"]["base_monthly_usd"]
    low, high = ranges.get(kind, ranges.get("edge", [2, 15]))
    base = seeded_uniform(float(low), float(high), generator_seed, dataset_seed, node["name"], "node-cost-v1")
    coeffs = config["non_cloud_costs"]["coefficients"]
    hw = node.get("hardware_caps", {})
    memory_gb = 0 if str(hw.get("memory")).lower() == "inf" else parse_number(hw.get("memory", 0)) / 1024.0
    vcpu = 0 if str(hw.get("v_cpu")).lower() == "inf" else parse_number(hw.get("v_cpu", 0))
    mhz = 0 if str(hw.get("mhz")).lower() == "inf" else parse_number(hw.get("mhz", 0))
    return base + coeffs["memory_gb"] * memory_gb + coeffs["vcpu"] * vcpu + coeffs["mhz_per_1000"] * (mhz / 1000.0)


def build_latency_matrix(
    raw: dict[str, Any],
    pools: list[dict[str, Any]],
    pool_by_original_node: dict[str, str],
    config: dict[str, Any],
    generator_seed: int,
    reports: GenerationReports,
    dataset_seed: str,
    infra_name: str,
) -> dict[str, dict[str, float]]:
    pool_ids = [p["id"] for p in pools]
    matrix = {pid: {pid: 0.0} for pid in pool_ids}

    for link in raw.get("links", []):
        a = pool_by_original_node.get(link["nodeA"])
        b = pool_by_original_node.get(link["nodeB"])
        if not a or not b:
            continue
        latency = float(link["latency"])
        matrix.setdefault(a, {})[b] = latency
        matrix.setdefault(b, {})[a] = latency

    pool_meta = {p["id"]: p.get("metadata", {}) for p in pools}
    pool_kind = {p["id"]: p.get("kind") for p in pools}
    for a in pool_ids:
        for b in pool_ids:
            if b in matrix.setdefault(a, {}):
                continue
            latency = generated_latency(a, b, pool_kind, pool_meta, config, generator_seed, dataset_seed)
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
    return round(seeded_uniform(float(low), float(high), generator_seed, dataset_seed, a, b, "latency-v2"), 3)


def build_instance(
    *,
    app: dict[str, Any],
    composition: dict[str, Any],
    root: Any,
    flow: Any,
    task_calls: dict[str, Any],
    security_thresholds: dict[str, float],
    infra: InfraContext,
    pricing: FaaSPricing,
    config: dict[str, Any],
    generator_seed: int,
    reports: GenerationReports,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    app_id = safe_id(app["orchestration_id"])
    functions = {safe_id(f["id"]): f for f in app.get("functions", [])}
    service_types = unique_sorted(
        [safe_id(s["type"]) for s in infra.services]
        + [safe_id(req["type"]) for fn in app.get("functions", []) for req in (fn.get("service_reqs", []) or [])]
    )
    service_ids = unique_sorted(safe_id(s["name"]) for s in infra.services)
    feature_defs = base_feature_defs(service_types, service_ids)
    feature_ids = [f["id"] for f in feature_defs]
    providers = build_providers(infra)
    tasks = [{"id": safe_id(f["id"]), "name": f["id"]} for f in app.get("functions", [])]
    candidates: list[dict[str, Any]] = []
    candidate_bindings: list[dict[str, Any]] = []
    candidate_report_rows: list[dict[str, Any]] = []
    constraints = build_security_constraints(security_thresholds)
    constraints.extend(build_service_constraints(app))

    for task_id, function in functions.items():
        task_candidates, task_bindings, report_row = generate_task_candidates(
            app_id=app_id,
            function=function,
            task_call=task_calls[function["id"]],
            infra=infra,
            pricing=pricing,
            config=config,
            generator_seed=generator_seed,
            feature_ids=feature_ids,
            security_threshold=security_thresholds.get(task_id, 0.33),
            reports=reports,
        )
        candidates.extend(task_candidates)
        candidate_bindings.extend(task_bindings)
        candidate_report_rows.append(report_row)

    first_task_bounds = {safe_id(tid): float(call.latency_bound_ms or 0) for tid, call in task_calls.items()}
    event_constraints, event_pools, event_latencies = build_event_latency(app, flow, infra, first_task_bounds)

    policies = aggregation_policies(feature_ids)
    transition_constraints = [*event_constraints]
    for idx, (from_task, to_task, bound) in enumerate(flow.transitions, start=1):
        transition_constraints.append(
            {
                "id": safe_id(f"latency_{idx}_{from_task}_to_{to_task}"),
                "from_task": from_task,
                "to_task": to_task,
                "op": "<=",
                "value": float(bound),
                "hard": True,
            }
        )

    pricing_cfg = config.get("pricing_constraints", {}) or {}
    if pricing_cfg.get("enabled", True):
        pricing_constraints, normalize_bounds = build_pricing_artifacts(
            app_id=app_id,
            tasks=tasks,
            candidates=candidates,
            candidate_bindings=candidate_bindings,
            composition=composition,
            security_thresholds=security_thresholds,
            transition_constraints=transition_constraints,
            config=config,
            infra=infra,
            event_latencies=event_latencies,
            reports=reports,
        )
        constraints.extend(pricing_constraints)
        for feature_id, bounds in normalize_bounds.items():
            policies[feature_id]["normalize"] = {"type": "minmax", "bounds": bounds}

    instance = {
        "metadata": {
            "id": safe_id(f"{app_id}_{infra.seed}_{infra.path.stem}"),
            "name": f"{app['name']} on {infra.path.stem} ({infra.seed})",
            "version": "1.0.0",
            "created_at": "2026-07-05T00:00:00Z",
            "description": "Generated BIM* instance from the ICSOC placement dataset.",
            "source_dataset": "experimentation/icsoc/original_dataset",
            "application_id": app_id,
            "dataset_seed": infra.seed,
            "infrastructure": infra.path.name,
            "generator_seed": generator_seed,
            "generator_version": __version__,
        },
        "features": feature_defs,
        "providers": providers,
        "tasks": tasks,
        "candidates": candidates,
        "composition": composition,
        "aggregation_policies": policies,
        "constraints": constraints,
        "objective": {
            "type": "MONO",
            "targets": ["latency", "cost", "security"],
            "weights": config["objective"]["weights"],
            "weights_sum_to_one": True,
        },
        "resource_model": {
            "resources": ["memory_mb", "vcpu", "mhz", "concurrency"],
            "pools": infra.pools,
            "candidate_bindings": candidate_bindings,
            "constraints": [
                {
                    "id": "accumulated_node_capacity",
                    "kind": "RESOURCE_CAPACITY",
                    "scope": "POOL_KIND",
                    "pool_kinds": ["EDGE", "FOG", "CLOUD"],
                    "resources": ["memory_mb", "vcpu", "mhz"],
                    "hard": True,
                },
                {
                    "id": "cloud_concurrency_capacity",
                    "kind": "RESOURCE_CAPACITY",
                    "scope": "POOL_KIND",
                    "pool_kinds": ["CLOUD_FAAS"],
                    "resources": ["concurrency"],
                    "hard": True,
                },
            ],
        },
        "latency_model": {
            "unit": "ms",
            "pool_latency_matrix_ms": infra.pool_latency,
            "event_generator_pools": event_pools,
            "event_latency_matrix_ms": event_latencies,
            "transition_constraints": transition_constraints,
            "global_latency": {
                "attribute_id": "latency",
                "include_execution_latency_feature": True,
                "xor_semantics": "EXPECTED",
                "and_semantics": "MAX",
            },
        },
    }
    return instance, candidate_report_rows


def base_feature_defs(service_types: list[str], service_ids: list[str]) -> list[dict[str, Any]]:
    features = [
        {
            "id": "latency",
            "name": "Latency",
            "direction": "MINIMIZE",
            "unit": "ms",
            "scale": "RATIO",
            "valid_range": {"min": 0, "max": 1_000_000},
        },
        {
            "id": "cost",
            "name": "Expected monthly cost",
            "direction": "MINIMIZE",
            "unit": "USD/month",
            "scale": "RATIO",
            "valid_range": {"min": 0, "max": 1_000_000},
        },
        {
            "id": "security",
            "name": "Security score",
            "direction": "MAXIMIZE",
            "unit": "score",
            "scale": "RATIO",
            "valid_range": {"min": 0, "max": 1},
        },
    ]
    for service_type in service_types:
        features.append(
            {
                "id": f"has.service.{service_type}",
                "name": f"Has service {service_type}",
                "direction": "MAXIMIZE",
                "unit": "boolean",
                "scale": "RATIO",
                "valid_range": {"min": 0, "max": 1},
            }
        )
    for service_id in service_ids:
        features.append(
            {
                "id": f"bind.service.{service_id}",
                "name": f"Binds service {service_id}",
                "direction": "MAXIMIZE",
                "unit": "boolean",
                "scale": "RATIO",
                "valid_range": {"min": 0, "max": 1},
            }
        )
    return features


def build_providers(infra: InfraContext) -> list[dict[str, str]]:
    ids = {safe_id(node.get("provider", "unknown")): node.get("provider", "unknown") for node in infra.nodes.values()}
    ids.update({"aws": "AWS", "azure": "Azure", "gcp": "Google Cloud"})
    return [{"id": pid, "name": name} for pid, name in sorted(ids.items())]


def aggregation_policies(feature_ids: list[str]) -> dict[str, Any]:
    policies: dict[str, Any] = {
        "cost": {
            "neutral": 0,
            "compose": {"seq": {"fn": "SUM"}, "and": {"fn": "SUM"}, "xor": {"fn": "SCALED_SUM"}},
        },
        "latency": {
            "neutral": 0,
            "compose": {"seq": {"fn": "SUM"}, "and": {"fn": "MAX"}, "xor": {"fn": "SCALED_SUM"}},
        },
        "security": {
            "neutral": 1,
            "compose": {"seq": {"fn": "MIN"}, "and": {"fn": "MIN"}, "xor": {"fn": "MIN"}},
        },
    }
    for fid in feature_ids:
        if fid.startswith("has.service.") or fid.startswith("bind.service."):
            policies[fid] = {
                "neutral": 0,
                "compose": {"seq": {"fn": "MAX"}, "and": {"fn": "MAX"}, "xor": {"fn": "MAX"}},
            }
    return policies


def build_security_constraints(security_thresholds: dict[str, float]) -> list[dict[str, Any]]:
    return [
        {
            "id": safe_id(f"security_min_{task_id}"),
            "kind": "ATTRIBUTE_BOUND",
            "scope": "LOCAL",
            "tasks": [task_id],
            "attribute_id": "security",
            "op": ">=",
            "value": round(float(threshold), 6),
            "hard": True,
        }
        for task_id, threshold in sorted(security_thresholds.items())
    ]


def build_service_constraints(app: dict[str, Any]) -> list[dict[str, Any]]:
    constraints = []
    for function in app.get("functions", []):
        task_id = safe_id(function["id"])
        for req in function.get("service_reqs", []) or []:
            service_type = safe_id(req["type"])
            constraints.append(
                {
                    "id": safe_id(f"{task_id}_requires_{service_type}"),
                    "kind": "ATTRIBUTE_BOUND",
                    "scope": "LOCAL",
                    "tasks": [task_id],
                    "attribute_id": f"has.service.{service_type}",
                    "op": "==",
                    "value": 1,
                    "hard": True,
                }
            )
    return constraints


def generate_task_candidates(
    *,
    app_id: str,
    function: dict[str, Any],
    task_call: Any,
    infra: InfraContext,
    pricing: FaaSPricing,
    config: dict[str, Any],
    generator_seed: int,
    feature_ids: list[str],
    security_threshold: float,
    reports: GenerationReports,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    task_id = safe_id(function["id"])
    demand = _task_demand(function)
    service_reqs = function.get("service_reqs", []) or []
    counters = Counter()
    candidates: list[dict[str, Any]] = []
    bindings: list[dict[str, Any]] = []

    for node in infra.nodes.values():
        pool_id = infra.pool_by_original_node[node["name"]]
        counters["original_considered"] += 1
        if not _supports_software(node, function):
            counters["filtered_by_sw"] += 1
            continue
        if not _supports_hardware(node, demand):
            counters["filtered_by_hw"] += 1
            continue
        service_sets = service_options_for_pool(pool_id, service_reqs, task_call.bindings, infra)
        if service_reqs and not service_sets:
            counters["filtered_by_service"] += 1
            continue
        score_label, security_score = node_security_score(node.get("security_caps", []), config)
        base_cost = original_candidate_cost(node, demand, infra.node_monthly_costs[node["name"]])
        for selected_services in service_sets or [[]]:
            cid = candidate_id(task_id, pool_id, selected_services, "orig")
            features = candidate_features(feature_ids, base_cost, security_score, selected_services)
            candidates.append(
                {
                    "id": cid,
                    "name": f"{function['id']} on {node['name']}",
                    "task_id": task_id,
                    "provider_id": safe_id(node.get("provider", "unknown")),
                    "features": features,
                    "description": f"Original {node.get('type')} node, security={score_label}",
                }
            )
            bindings.append({"candidate_id": cid, "pool_id": pool_id, "demand": demand})
            counters["non_cloud_candidates"] += 1
            reports.pricing_rows.append(
                pricing_row(app_id, infra, task_id, cid, "original", "", "", 0, 0, base_cost)
            )

    workload = config["workload_defaults"]
    for provider, regions in config["cloud_regions"].items():
        for region in regions:
            pool_id = safe_id(f"{provider}.faas.{region}")
            service_sets = service_options_for_pool(pool_id, service_reqs, task_call.bindings, infra)
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
                    cid = candidate_id(task_id, pool_id, selected_services, f"mem{memory_mb}")
                    features = candidate_features(feature_ids, cost, 1.0, selected_services)
                    candidates.append(
                        {
                            "id": cid,
                            "name": f"{function['id']} on {provider.upper()} {region} ({memory_mb} MB)",
                            "task_id": task_id,
                            "provider_id": safe_id(provider),
                            "features": features,
                            "description": "Generated regional FaaS candidate",
                        }
                    )
                    bindings.append(
                        {
                            "candidate_id": cid,
                            "pool_id": pool_id,
                            "demand": {"concurrency": float(workload["concurrency"])},
                        }
                    )
                    counters["cloud_candidates"] += 1
                    reports.pricing_rows.append(
                        pricing_row(
                            app_id,
                            infra,
                            task_id,
                            cid,
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
    return candidates, bindings, {
        "application": app_id,
        "dataset_seed": infra.seed,
        "infrastructure": infra.path.stem,
        "infra_size": infra.size,
        "task": task_id,
        "security_threshold": security_threshold,
        **dict(counters),
    }


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
            if explicit and not any(service["name"].lower().startswith(prefix.lower()) for prefix in explicit):
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


def original_candidate_cost(node: dict[str, Any], demand: dict[str, float], node_monthly_cost: float) -> float:
    hw = node.get("hardware_caps", {})
    fractions = []
    for demand_key, hw_key in (("memory_mb", "memory"), ("vcpu", "v_cpu"), ("mhz", "mhz")):
        raw = hw.get(hw_key, 0)
        if str(raw).lower() == "inf":
            continue
        cap = parse_number(raw)
        if cap > 0:
            fractions.append(demand[demand_key] / cap)
    fraction = max(fractions) if fractions else 0.01
    return round(max(0.000001, node_monthly_cost * fraction), 8)


def cloud_memory_variants(function: dict[str, Any], config: dict[str, Any]) -> list[int]:
    required = parse_number(function.get("hw_reqs", {}).get("memory", 128))
    domain = [int(v) for v in config["cloud_memory_mb_domain"]]
    return [value for value in domain if value >= required] or [max(domain)]


def candidate_id(task_id: str, pool_id: str, services: list[dict[str, Any]], variant: str) -> str:
    service_part = "_".join(safe_id(s["name"]) for s in services) if services else "nosvc"
    digest = stable_hash(task_id, pool_id, service_part, variant, length=8)
    return safe_id(f"cand_{task_id}_{pool_id}_{variant}_{digest}")


def candidate_features(
    feature_ids: list[str],
    cost: float,
    security: float,
    selected_services: list[dict[str, Any]],
) -> dict[str, float]:
    features = {fid: 0.0 for fid in feature_ids}
    features["latency"] = 0.0
    features["cost"] = round(float(cost), 8)
    features["security"] = round(float(security), 6)
    for service in selected_services:
        features[f"has.service.{safe_id(service['type'])}"] = 1.0
        features[f"bind.service.{safe_id(service['name'])}"] = 1.0
    return features


def pricing_row(
    app_id: str,
    infra: InfraContext,
    task_id: str,
    candidate_id_value: str,
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
        "task": task_id,
        "candidate": candidate_id_value,
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


def fold_over_composition(node: dict[str, Any], per_task: dict[str, float], fns: dict[str, str]) -> float:
    """Aggregate per-task values over the composition tree with fixed policies."""
    kind = node["kind"]
    if kind == "TASK":
        return per_task[node["task_id"]]
    if kind in ("SEQ", "AND"):
        values = [fold_over_composition(child, per_task, fns) for child in node["children"]]
        return _apply_fold(fns["seq" if kind == "SEQ" else "and"], values)
    if kind == "XOR":
        fn = fns["xor"]
        values = [fold_over_composition(branch["child"], per_task, fns) for branch in node["branches"]]
        if fn in ("SCALED_SUM", "WEIGHTED_SUM", "SUM"):
            return sum(branch["p"] * value for branch, value in zip(node["branches"], values))
        return _apply_fold(fn, values)
    raise ValueError(f"Unsupported node kind for fold: {kind}")


def _apply_fold(fn: str, values: list[float]) -> float:
    if fn == "MIN":
        return min(values)
    if fn == "MAX":
        return max(values)
    return sum(values)


_COST_FNS = {"seq": "SUM", "and": "SUM", "xor": "SCALED_SUM"}
_SECURITY_FNS = {"seq": "MIN", "and": "MIN", "xor": "MIN"}


def _latency_norm_bounds(
    composition: dict[str, Any],
    tasks: list[dict[str, Any]],
    infra: InfraContext,
    event_latencies: dict[str, dict[str, float]],
    min_exec: dict[str, float] | None = None,
    max_exec: dict[str, float] | None = None,
) -> tuple[float, float]:
    """Sound [min, max] bounds for the end-to-end latency of any binding.

    The makespan is monotone in every transfer latency and every execution
    latency, so scheduling the scenario DAGs with constant extremal transfer
    latencies and per-task extremal execution latencies yields valid bounds.
    Falls back to a coarse upper bound if the gateway evaluator is missing.
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

    try:
        from openbinding_gateway.validation.engine_plugins.bimstar import build_scenarios
    except ImportError:
        return 0.0, max_event + (len(tasks) + 1) * max_lat + sum(max_exec.values())

    scenarios = build_scenarios(composition["root"], sorted(event_latencies.keys()))

    def makespan(transfer: float, event: float, exec_of: dict[str, float]) -> float:
        total = 0.0
        for scenario in scenarios:
            finish: dict[str, float] = {}
            for task_id in scenario["order"]:
                start = 0.0
                for src_kind, src_id in scenario["preds"][task_id]:
                    ready = 0.0 if src_kind == "event" else finish[src_id]
                    start = max(start, ready + (event if src_kind == "event" else transfer))
                finish[task_id] = start + float(exec_of.get(task_id, 0.0))
            sinks = scenario["sinks"] or scenario["order"]
            total += scenario["prob"] * max((finish[t] for t in sinks), default=0.0)
        return total

    return makespan(0.0, min_event, min_exec), makespan(max_lat, max_event, max_exec)


def _latency_arc_consistent_pools(
    tasks: list[dict[str, Any]],
    by_task: dict[str, list[dict[str, Any]]],
    candidate_pools: dict[str, str],
    transition_constraints: list[dict[str, Any]],
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
        task["id"]: {candidate_pools[c["id"]] for c in by_task.get(task["id"], [])}
        for task in tasks
    }

    binary: list[tuple[str, str, float]] = []
    for tc in transition_constraints:
        bound = float(tc["value"])
        to_task = tc["to_task"]
        if tc.get("from_event") is not None:
            event_row = event_latencies.get(tc["from_event"], {})
            domains[to_task] = {
                pool for pool in domains.get(to_task, set())
                if event_row.get(pool, float("inf")) <= bound + 1e-9
            }
        elif tc.get("from_task") is not None:
            binary.append((tc["from_task"], to_task, bound))

    latency = infra.pool_latency
    changed = True
    while changed:
        changed = False
        for from_task, to_task, bound in binary:
            dom_from = domains.get(from_task, set())
            dom_to = domains.get(to_task, set())
            keep_from = {
                p for p in dom_from
                if any(latency[p][q] <= bound + 1e-9 for q in dom_to)
            }
            keep_to = {
                q for q in dom_to
                if any(latency[p][q] <= bound + 1e-9 for p in keep_from)
            }
            if keep_from != dom_from:
                domains[from_task] = keep_from
                changed = True
            if keep_to != dom_to:
                domains[to_task] = keep_to
                changed = True
    return domains


def _cheapest_feasible_witness(
    tasks: list[dict[str, Any]],
    eligible_by_task: dict[str, list[dict[str, Any]]],
    candidate_pools: dict[str, str],
    demand_of: dict[str, dict[str, float]],
    infra: InfraContext,
    transition_constraints: list[dict[str, Any]],
    event_latencies: dict[str, dict[str, float]],
    node_budget: int = 500_000,
) -> dict[str, dict[str, Any]] | None:
    """Cheapest-first backtracking search for a certified feasible binding.

    AC-3 only guarantees arc consistency, so budgets anchored to per-task
    cheapest eligible candidates can jointly violate the transition bounds
    (or pool capacities) and render the instance UNSAT. The witness returned
    here satisfies security eligibility (already folded into the eligible
    sets), every transition constraint and every pool capacity, so budgets
    anchored to it keep the instance certifiably satisfiable.
    """
    capacity_of = {p["id"]: dict(p.get("capacity") or {}) for p in infra.pools}
    latency = infra.pool_latency

    event_bounds: dict[str, list[tuple[str, float]]] = defaultdict(list)
    binary_bounds: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for tc in transition_constraints:
        bound = float(tc["value"])
        if tc.get("from_event") is not None:
            event_bounds[tc["to_task"]].append((tc["from_event"], bound))
        elif tc.get("from_task") is not None:
            # Index by both endpoints so a task is checked against every
            # already-assigned neighbour as soon as it gets a pool.
            binary_bounds[tc["to_task"]].append((tc["from_task"], bound))
            binary_bounds[tc["from_task"]].append((tc["to_task"], bound))

    order = sorted(
        (t["id"] for t in tasks if eligible_by_task.get(t["id"])),
        key=lambda tid: len(eligible_by_task[tid]),
    )
    if len(order) < len(tasks):
        return None  # some task has no eligible candidate at all

    assignment: dict[str, dict[str, Any]] = {}
    pool_of: dict[str, str] = {}
    usage: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    expansions = 0

    def fits(task_id: str, cand: dict[str, Any]) -> bool:
        pool = candidate_pools[cand["id"]]
        for event_id, bound in event_bounds.get(task_id, ()):
            if event_latencies.get(event_id, {}).get(pool, float("inf")) > bound + 1e-9:
                return False
        for other, bound in binary_bounds.get(task_id, ()):
            other_pool = pool_of.get(other)
            if other_pool is not None and latency[pool][other_pool] > bound + 1e-9:
                return False
        capacity = capacity_of.get(pool) or {}
        demand = demand_of.get(cand["id"]) or {}
        for resource, needed in demand.items():
            cap = capacity.get(resource)
            if cap is not None and usage[pool][resource] + float(needed) > float(cap) + 1e-9:
                return False
        return True

    def search(depth: int) -> bool:
        nonlocal expansions
        if depth == len(order):
            return True
        task_id = order[depth]
        for cand in eligible_by_task[task_id]:
            expansions += 1
            if expansions > node_budget:
                return False
            if not fits(task_id, cand):
                continue
            pool = candidate_pools[cand["id"]]
            assignment[task_id] = cand
            pool_of[task_id] = pool
            for resource, needed in (demand_of.get(cand["id"]) or {}).items():
                usage[pool][resource] += float(needed)
            if search(depth + 1):
                return True
            for resource, needed in (demand_of.get(cand["id"]) or {}).items():
                usage[pool][resource] -= float(needed)
            del assignment[task_id]
            del pool_of[task_id]
        return False

    return dict(assignment) if search(0) else None


def build_pricing_artifacts(
    *,
    app_id: str,
    tasks: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    candidate_bindings: list[dict[str, Any]],
    composition: dict[str, Any],
    security_thresholds: dict[str, float],
    transition_constraints: list[dict[str, Any]],
    config: dict[str, Any],
    infra: InfraContext,
    event_latencies: dict[str, dict[str, float]],
    reports: GenerationReports,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, float]]]:
    """Pricing (budget) constraints and canonical normalization bounds.

    - Eligibility is latency-aware: candidate pools are filtered by AC-3 over
      the transition constraints, then by the task's security threshold.
    - Per-task budget: quantile of the eligible candidates' costs, raised if
      needed to the cost of a certified feasible witness binding (cheapest
      backtracking assignment satisfying transitions + capacities), so the
      emitted instance stays satisfiable.
    - Global budget: factor x cost of the witness binding, aggregated over
      the composition tree.
    - Normalization bounds: per-feature [min, max] of the aggregated value
      over any binding (folds of per-task extremes; scheduler bounds for the
      end-to-end latency), shared by every engine through the instance.
    """
    cfg = config.get("pricing_constraints", {}) or {}
    factor = float(cfg.get("global_budget_factor", 1.5))
    quantile = float(cfg.get("local_budget_quantile", 0.75))
    slack = float(cfg.get("global_budget_slack", 0.25))

    by_task: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for candidate in candidates:
        by_task[candidate["task_id"]].append(candidate)
    candidate_pools = {cb["candidate_id"]: cb["pool_id"] for cb in candidate_bindings}

    ac_domains = _latency_arc_consistent_pools(
        tasks, by_task, candidate_pools, transition_constraints, infra, event_latencies
    )

    demand_of = {cb["candidate_id"]: dict(cb.get("demand") or {}) for cb in candidate_bindings}
    eligible_by_task: dict[str, list[dict[str, Any]]] = {}
    for task in tasks:
        task_id = task["id"]
        threshold = float(security_thresholds.get(task_id, 0.0))
        pool_domain = ac_domains.get(task_id, set())
        eligible_by_task[task_id] = sorted(
            (
                c for c in by_task.get(task_id, [])
                if float(c["features"]["security"]) >= threshold - 1e-9
                and candidate_pools.get(c["id"]) in pool_domain
            ),
            key=lambda c: float(c["features"]["cost"]),
        )
    witness = _cheapest_feasible_witness(
        tasks, eligible_by_task, candidate_pools, demand_of, infra,
        transition_constraints, event_latencies,
    )

    constraints: list[dict[str, Any]] = []
    min_cost_eligible: dict[str, float] = {}
    local_budget_by_task: dict[str, float] = {}
    min_cost_all: dict[str, float] = {}
    max_cost_all: dict[str, float] = {}
    min_sec_all: dict[str, float] = {}
    max_sec_all: dict[str, float] = {}

    for task in tasks:
        task_id = task["id"]
        cands = by_task.get(task_id, [])
        if not cands:
            continue
        costs_all = [float(c["features"]["cost"]) for c in cands]
        secs_all = [float(c["features"]["security"]) for c in cands]
        threshold = float(security_thresholds.get(task_id, 0.0))
        pool_domain = ac_domains.get(task_id, set())
        latency_feasible = bool(pool_domain)
        eligible_costs = [float(c["features"]["cost"]) for c in eligible_by_task[task_id]]
        security_feasible = bool(eligible_costs)
        if not eligible_costs:
            # Degenerate fallback (latency/security-infeasible task): derive
            # budgets from the security-only filter, then from all candidates.
            eligible_costs = [
                float(c["features"]["cost"])
                for c in cands
                if float(c["features"]["security"]) >= threshold - 1e-9
            ] or costs_all

        local_budget = round(_quantile(sorted(eligible_costs), quantile), 8)
        # Anchor to the certified feasible witness: its candidate must stay
        # within the local budget, otherwise the joint transition/capacity
        # structure can make the emitted instance UNSAT.
        witness_cost = (
            float(witness[task_id]["features"]["cost"]) if witness and task_id in witness else None
        )
        if witness_cost is not None and witness_cost > local_budget:
            local_budget = round(witness_cost, 8)
        local_budget_by_task[task_id] = local_budget
        constraints.append(
            {
                "id": safe_id(f"budget_local_{task_id}"),
                "kind": "ATTRIBUTE_BOUND",
                "scope": "LOCAL",
                "tasks": [task_id],
                "attribute_id": "cost",
                "op": "<=",
                "value": local_budget,
                "hard": True,
            }
        )
        # The global budget builds on the witness binding (feasible w.r.t.
        # transitions and capacities); without a witness it falls back to the
        # cheapest candidate within all local requirements.
        if witness_cost is not None:
            min_cost_eligible[task_id] = witness_cost
        else:
            within_local = [c for c in eligible_costs if c <= local_budget + 1e-9]
            min_cost_eligible[task_id] = min(within_local) if within_local else min(eligible_costs)
        min_cost_all[task_id] = min(costs_all)
        max_cost_all[task_id] = max(costs_all)
        min_sec_all[task_id] = min(secs_all)
        max_sec_all[task_id] = max(secs_all)

        reports.budget_rows.append(
            {
                "application": app_id,
                "dataset_seed": infra.seed,
                "infrastructure": infra.path.stem,
                "task": task_id,
                "security_threshold": threshold,
                "eligible_candidates": len(eligible_costs),
                "latency_feasible": latency_feasible,
                "security_feasible": security_feasible,
                "witness_found": witness is not None,
                "witness_cost": round(witness_cost, 8) if witness_cost is not None else None,
                "ac_pool_domain_size": len(pool_domain),
                "local_budget_quantile": quantile,
                "local_budget": local_budget,
                "min_eligible_cost": round(min_cost_eligible[task_id], 8),
            }
        )

    root = composition["root"]
    cheapest_eligible = fold_over_composition(root, min_cost_eligible, _COST_FNS)
    if witness is not None:
        # Certified-feasible budget with controlled difficulty: the budget
        # always covers the witness binding (so the instance is satisfiable)
        # plus a configurable share of the headroom up to the loosest sensible
        # budget (every task at its local budget). A pure factor on the
        # cheapest witness collapses the feasible region when ultra-cheap
        # cloud candidates anchor it (random search then never finds a
        # feasible binding), so slack interpolates instead of multiplying.
        local_fold = fold_over_composition(root, local_budget_by_task, _COST_FNS)
        global_budget = round(
            cheapest_eligible + slack * max(0.0, local_fold - cheapest_eligible), 8
        )
    else:
        global_budget = round(factor * cheapest_eligible, 8)
    constraints.insert(
        0,
        {
            "id": safe_id(f"budget_global_{app_id}"),
            "kind": "ATTRIBUTE_BOUND",
            "scope": "GLOBAL",
            "attribute_id": "cost",
            "op": "<=",
            "value": global_budget,
            "hard": True,
        },
    )

    min_exec_lat: dict[str, float] = {}
    max_exec_lat: dict[str, float] = {}
    for task in tasks:
        exec_lats = [
            float((c.get("features") or {}).get("latency", 0.0))
            for c in by_task.get(task["id"], [])
        ]
        if exec_lats:
            min_exec_lat[task["id"]] = min(exec_lats)
            max_exec_lat[task["id"]] = max(exec_lats)
    lat_min, lat_max = _latency_norm_bounds(
        composition, tasks, infra, event_latencies, min_exec_lat, max_exec_lat
    )
    normalize_bounds = {
        "cost": {
            "min": round(fold_over_composition(root, min_cost_all, _COST_FNS), 8),
            "max": round(fold_over_composition(root, max_cost_all, _COST_FNS), 8),
        },
        "latency": {"min": round(lat_min, 6), "max": round(lat_max, 6)},
        "security": {
            "min": round(fold_over_composition(root, min_sec_all, _SECURITY_FNS), 6),
            "max": round(fold_over_composition(root, max_sec_all, _SECURITY_FNS), 6),
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
) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, dict[str, float]]]:
    event = trigger_event(app.get("trigger", ""))
    event_pools: dict[str, str] = {}
    event_latencies: dict[str, dict[str, float]] = {}
    constraints: list[dict[str, Any]] = []
    pool_ids = [pool["id"] for pool in infra.pools]
    for generator in infra.event_generators:
        events = {trigger_event(e) for e in generator.get("events", [])}
        if event not in events:
            continue
        event_id = safe_id(f"{generator['name']}_{event}")
        source_pool = infra.pool_by_original_node[generator["node"]]
        event_pools[event_id] = source_pool
        event_latencies[event_id] = {pool_id: infra.pool_latency[source_pool][pool_id] for pool_id in pool_ids}
        for first_task in sorted(flow.first):
            constraints.append(
                {
                    "id": safe_id(f"latency_{event_id}_to_{first_task}"),
                    "from_event": event_id,
                    "to_task": first_task,
                    "op": "<=",
                    "value": float(first_task_bounds[first_task]),
                    "hard": True,
                }
            )
    return constraints, event_pools, event_latencies


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
