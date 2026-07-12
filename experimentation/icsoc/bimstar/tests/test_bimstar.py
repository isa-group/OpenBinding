from __future__ import annotations

from pathlib import Path

from experimentation.icsoc.bimstar.config import load_config
from experimentation.icsoc.bimstar.generator import generate_dataset
from experimentation.icsoc.bimstar.orchestration import derive_transitions, parse_orchestration
from experimentation.icsoc.bimstar.pricing import FaaSPricing
from experimentation.icsoc.bimstar.security import infer_task_security
from experimentation.icsoc.bimstar.utils import load_json, safe_id
from experimentation.icsoc.bimstar.validation import validate_instance


ROOT = Path(__file__).resolve().parents[4]
DATASET = ROOT / "experimentation/icsoc/original_dataset"
PRICINGS = ROOT / "pricings"
SCHEMA = ROOT / "schemas/general/bimstar.schema.json"
CONFIG = ROOT / "experimentation/icsoc/bimstar/configs/default.yml"


def test_orchestration_parser_derives_expected_transitions() -> None:
    app = load_json(DATASET / "applications.json")[0]
    root = parse_orchestration(app["orchestration_structure"])
    calls = {safe_id(tid): call for tid, call in root_calls(root).items()}
    task_latency = {tid: float(call.latency_bound_ms or 0) for tid, call in calls.items()}

    flow = derive_transitions(root, task_latency)

    assert flow.first == {"fLogin"}
    assert ("fLogin", "fDCC", 15.0) in flow.transitions
    assert ("fCrop", "fGeo", 12.0) in flow.transitions
    assert "fAR" in flow.last


def test_security_is_translated_to_numeric_thresholds() -> None:
    app = load_json(DATASET / "applications.json")[0]
    root = parse_orchestration(app["orchestration_structure"])
    result = infer_task_security(app, root, load_config(CONFIG))

    assert result.task_thresholds["fLogin"] == 1.0
    assert all(0.33 <= value <= 1.0 for value in result.task_thresholds.values())
    # Per-variable dataflow: homonymous outputs keep their variable's label, so
    # tasks touching only low/medium data stay below 'top' and the security
    # objective actually discriminates between feasible solutions.
    assert result.task_thresholds["fCrop"] == 0.66
    assert len(set(result.task_thresholds.values())) > 1


def test_pricing_adapters_return_positive_costs() -> None:
    pricing = FaaSPricing(PRICINGS)

    assert pricing.estimate("aws", "eu-west-1", invocations_per_month=1000, avg_duration_ms=100, memory_mb=512) > 0
    assert pricing.estimate("azure", "westeurope", invocations_per_month=1000, avg_duration_ms=100, memory_mb=512) > 0
    assert pricing.estimate("gcp", "europe-west1", invocations_per_month=1000, avg_duration_ms=100, memory_mb=512) > 0


def test_aws_lambda_on_demand_formula_matches_ipricing_rates() -> None:
    """AWS on-demand: invocations x request rate + GB-seconds x tier-1 x86 rate.

    The expected value is reconstructed from the iPricing variables file so the
    test survives daily pricing refreshes; the plausibility bounds pin the
    order of magnitude (about $2/month for 1M x 120ms x 1GB as of 2026).
    """
    pricing = FaaSPricing(PRICINGS)
    invocations, duration_ms, memory_mb = 1_000_000, 120.0, 1024.0

    rates = pricing.aws["pricesPerRegionAndArchitecture"]["eu-west-1"]
    gb_seconds = invocations * (duration_ms / 1000.0) * (memory_mb / 1024.0)
    expected = (
        invocations * float(rates["lambdaRequest"])
        + gb_seconds * float(rates["x86"]["firstGbSeconds"])
    )

    cost = pricing.estimate(
        "aws", "eu-west-1",
        invocations_per_month=invocations, avg_duration_ms=duration_ms, memory_mb=memory_mb,
    )
    assert cost == expected
    assert gb_seconds == 120_000.0  # well below the 6B GB-s tier-1 limit
    assert 0.5 < cost < 20.0


def test_azure_and_gcp_on_demand_formulas_match_ipricing_rates() -> None:
    pricing = FaaSPricing(PRICINGS)
    invocations, duration_ms, memory_mb = 1_000_000, 120.0, 1024.0
    gb_seconds = invocations * (duration_ms / 1000.0) * (memory_mb / 1024.0)

    azure_rates = pricing.azure["consumptionPricesPerRegion"]["westeurope"]
    azure_expected = (
        invocations * float(azure_rates["execution"])
        + gb_seconds * float(azure_rates["gbSecond"])
    )
    assert pricing.estimate(
        "azure", "westeurope",
        invocations_per_month=invocations, avg_duration_ms=duration_ms, memory_mb=memory_mb,
    ) == azure_expected

    gcp_rates = pricing.gcp["requestBasedPricesPerRegion"]["europe-west1"]
    vcpu_seconds = invocations * (duration_ms / 1000.0) * 2.0
    gcp_expected = (
        invocations * float(gcp_rates["request"])
        + vcpu_seconds * float(gcp_rates["vcpuSecond"])
        + gb_seconds * float(gcp_rates["gibSecond"])
    )
    assert pricing.estimate(
        "gcp", "europe-west1",
        invocations_per_month=invocations, avg_duration_ms=duration_ms,
        memory_mb=memory_mb, vcpu=2.0,
    ) == gcp_expected


def test_pricing_is_monotone_in_decision_variables() -> None:
    pricing = FaaSPricing(PRICINGS)
    base = dict(invocations_per_month=1_000_000, avg_duration_ms=120, memory_mb=512)
    for provider, region in (("aws", "eu-west-1"), ("azure", "westeurope"), ("gcp", "europe-west1")):
        cost = pricing.estimate(provider, region, **base)
        assert pricing.estimate(provider, region, **{**base, "memory_mb": 2048}) > cost
        assert pricing.estimate(provider, region, **{**base, "invocations_per_month": 5_000_000}) > cost
        assert pricing.estimate(provider, region, **{**base, "avg_duration_ms": 480}) > cost


def test_generated_latency_provider_and_geo_classes() -> None:
    from experimentation.icsoc.bimstar.generator import generated_latency

    config = load_config(CONFIG)
    lat_cfg = config["latency_generation"]
    pool_kind = {
        "aws.faas.eu-west-1": "CLOUD_FAAS", "aws.faas.us-east-1": "CLOUD_FAAS",
        "gcp.faas.europe-west1": "CLOUD_FAAS", "gcp.faas.us-central1": "CLOUD_FAAS",
        "edge1": "EDGE",
    }
    pool_meta = {
        "aws.faas.eu-west-1": {"commercial_provider": "aws", "region": "eu-west-1"},
        "aws.faas.us-east-1": {"commercial_provider": "aws", "region": "us-east-1"},
        "gcp.faas.europe-west1": {"commercial_provider": "gcp", "region": "europe-west1"},
        "gcp.faas.us-central1": {"commercial_provider": "gcp", "region": "us-central1"},
        "edge1": {},
    }

    def lat(a: str, b: str) -> float:
        return generated_latency(a, b, pool_kind, pool_meta, config, 12345, "seed")

    def assert_in(value: float, key: str) -> None:
        low, high = lat_cfg[key]
        assert low <= value <= high, f"{value} not in {key} {lat_cfg[key]}"

    # Same provider, cross-continent backbone.
    assert_in(lat("aws.faas.eu-west-1", "aws.faas.us-east-1"), "cloud_same_provider_inter_geo_ms")
    # Cross provider within the same continent (public peering).
    assert_in(lat("aws.faas.eu-west-1", "gcp.faas.europe-west1"), "cloud_cross_provider_intra_geo_ms")
    # Cross provider, cross continent: the slowest class.
    assert_in(lat("aws.faas.eu-west-1", "gcp.faas.us-central1"), "cloud_cross_provider_inter_geo_ms")
    # Original node to EU / US cloud.
    assert_in(lat("edge1", "aws.faas.eu-west-1"), "original_to_cloud_intra_geo_ms")
    assert_in(lat("edge1", "aws.faas.us-east-1"), "original_to_cloud_inter_geo_ms")

    # Class ordering: disjoint ranges make the realism property structural.
    assert lat_cfg["cloud_same_provider_same_region_ms"][1] < lat_cfg["cloud_same_provider_intra_geo_ms"][0]
    assert lat_cfg["cloud_same_provider_intra_geo_ms"][1] < lat_cfg["cloud_cross_provider_intra_geo_ms"][0]
    assert lat_cfg["cloud_same_provider_inter_geo_ms"][1] < lat_cfg["cloud_cross_provider_inter_geo_ms"][0]

    # Determinism.
    assert lat("aws.faas.eu-west-1", "gcp.faas.europe-west1") == lat("aws.faas.eu-west-1", "gcp.faas.europe-west1")


def test_generate_one_instance_layout_and_validation(tmp_path: Path) -> None:
    reports = generate_dataset(
        dataset=DATASET,
        pricing_dir=PRICINGS,
        config=load_config(CONFIG),
        seed=12345,
        out=tmp_path,
        applications={"arOrch"},
        dataset_seeds={"338599157"},
        sizes={"50"},
    )
    instance_path = tmp_path / "instances/arOrch/338599157/infrastructure_50.bimstar.json"
    instance = load_json(instance_path)

    assert instance_path.exists()
    assert instance["metadata"]["application_id"] == "arOrch"
    assert instance["metadata"]["dataset_seed"] == "338599157"
    assert "resource_model" in instance
    assert "latency_model" in instance
    violations = [v for v in validate_instance(instance, SCHEMA) if v.code != "jsonschema_not_installed"]
    assert violations == []

    _assert_budget_artifacts(instance, reports)
    _assert_latency_matrix_properties(instance)


def _assert_budget_artifacts(instance, reports) -> None:
    """Budget constraints and canonical normalization bounds are well-formed."""
    constraints = instance["constraints"]
    global_budgets = [c for c in constraints if c["id"].startswith("budget_global")]
    local_budgets = {c["tasks"][0]: c for c in constraints if c["id"].startswith("budget_local")}
    task_ids = {t["id"] for t in instance["tasks"]}

    assert len(global_budgets) == 1 and global_budgets[0]["value"] > 0
    assert set(local_budgets) == task_ids

    # Eligibility guarantee: each task keeps at least one candidate within its
    # security threshold and local budget.
    thresholds = {
        c["tasks"][0]: float(c["value"])
        for c in constraints
        if c["id"].startswith("security_min")
    }
    by_task: dict[str, list[dict]] = {}
    for cand in instance["candidates"]:
        by_task.setdefault(cand["task_id"], []).append(cand)
    for task_id in task_ids:
        budget = float(local_budgets[task_id]["value"])
        threshold = thresholds.get(task_id, 0.0)
        eligible = [
            c for c in by_task[task_id]
            if c["features"]["security"] >= threshold - 1e-9
            and c["features"]["cost"] <= budget + 1e-9
        ]
        assert eligible, f"no eligible candidate within budget for {task_id}"

    # Canonical normalization bounds on the three objective features.
    for feature_id in ("cost", "latency", "security"):
        bounds = instance["aggregation_policies"][feature_id]["normalize"]["bounds"]
        assert bounds["min"] < bounds["max"]

    # AC-3 domains were non-empty (latency-feasible) for every task.
    task_rows = [r for r in reports.budget_rows if r.get("task") not in (None, "__global__")]
    assert task_rows and all(r["latency_feasible"] for r in task_rows)


def _assert_latency_matrix_properties(instance) -> None:
    """The emitted pool latency matrix is symmetric with a zero diagonal, and
    cloud pairs respect the provider/geography realism classes."""
    matrix = instance["latency_model"]["pool_latency_matrix_ms"]
    pools = {p["id"]: p for p in instance["resource_model"]["pools"]}
    config = load_config(CONFIG)
    lat_cfg = config["latency_generation"]

    for a, row in matrix.items():
        assert row[a] == 0.0
        for b, value in row.items():
            assert matrix[b][a] == value

    cloud = [p for p in pools.values() if p["kind"] == "CLOUD_FAAS"]
    for pa in cloud:
        for pb in cloud:
            if pa["id"] >= pb["id"]:
                continue
            meta_a, meta_b = pa["metadata"], pb["metadata"]
            same_provider = meta_a["commercial_provider"] == meta_b["commercial_provider"]
            geo = lat_cfg["region_geo"]
            same_geo = geo[meta_a["region"]] == geo[meta_b["region"]]
            if same_provider and same_geo:
                key = "cloud_same_provider_intra_geo_ms"
            elif same_provider:
                key = "cloud_same_provider_inter_geo_ms"
            elif same_geo:
                key = "cloud_cross_provider_intra_geo_ms"
            else:
                key = "cloud_cross_provider_inter_geo_ms"
            low, high = lat_cfg[key]
            value = matrix[pa["id"]][pb["id"]]
            assert low <= value <= high, (pa["id"], pb["id"], value, key)


def root_calls(root):
    from experimentation.icsoc.bimstar.orchestration import collect_task_calls

    return collect_task_calls(root)
