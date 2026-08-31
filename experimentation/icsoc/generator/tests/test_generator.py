from __future__ import annotations

from pathlib import Path

from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import load_package

from experimentation.icsoc.generator.config import load_config
from experimentation.icsoc.generator.generator import generate_dataset
from experimentation.icsoc.generator.orchestration import (
    derive_transitions,
    parse_orchestration,
)
from experimentation.icsoc.generator.pricing import FaaSPricing
from experimentation.icsoc.generator.security import infer_task_security
from experimentation.icsoc.generator.utils import load_json
from experimentation.icsoc.generator.validation import validate_instance

ROOT = Path(__file__).resolve().parents[4]
DATASET = ROOT / "experimentation/icsoc/original_dataset"
PRICINGS = ROOT / "pricings"
SCHEMA = ROOT / "schemas/bim/v1/instance.schema.json"
CONFIG = ROOT / "experimentation/icsoc/generator/configs/default.yml"


def test_orchestration_parser_derives_expected_transitions() -> None:
    app = load_json(DATASET / "applications.json")[0]
    orchestration = parse_orchestration(app["orchestration_structure"])

    flow = derive_transitions(orchestration)

    assert flow.first == ({"resource": "application", "id": "fLogin"},)
    assert {
        "from": {"resource": "application", "id": "fLogin"},
        "to": {"resource": "application", "id": "fDCC"},
        "maximum": 15.0,
    } in flow.transitions
    assert {
        "from": {"resource": "application", "id": "fCrop"},
        "to": {"resource": "application", "id": "fGeo"},
        "maximum": 12.0,
    } in flow.transitions
    assert {"resource": "application", "id": "fAR"} in flow.last
    assert "sequence" in orchestration.workflow
    assert orchestration.calls["fLogin"].task == {
        "resource": "application",
        "id": "fLogin",
    }


def test_security_is_translated_to_numeric_thresholds() -> None:
    app = load_json(DATASET / "applications.json")[0]
    orchestration = parse_orchestration(app["orchestration_structure"])
    result = infer_task_security(app, orchestration, load_config(CONFIG))

    assert result.task_thresholds["fLogin"] == 1.0
    assert all(0.33 <= value <= 1.0 for value in result.task_thresholds.values())
    # Per-variable dataflow: homonymous outputs keep their variable's label, so
    # tasks touching only low/medium data stay below 'top' and the security
    # objective actually discriminates between feasible solutions.
    assert result.task_thresholds["fCrop"] == 0.66
    assert len(set(result.task_thresholds.values())) > 1


def test_pricing_adapters_return_positive_costs() -> None:
    pricing = FaaSPricing(PRICINGS)

    assert (
        pricing.estimate(
            "aws",
            "eu-west-1",
            invocations_per_month=1000,
            avg_duration_ms=100,
            memory_mb=512,
        )
        > 0
    )
    assert (
        pricing.estimate(
            "azure",
            "westeurope",
            invocations_per_month=1000,
            avg_duration_ms=100,
            memory_mb=512,
        )
        > 0
    )
    assert (
        pricing.estimate(
            "gcp",
            "europe-west1",
            invocations_per_month=1000,
            avg_duration_ms=100,
            memory_mb=512,
        )
        > 0
    )


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
    expected = invocations * float(rates["lambdaRequest"]) + gb_seconds * float(
        rates["x86"]["firstGbSeconds"]
    )

    cost = pricing.estimate(
        "aws",
        "eu-west-1",
        invocations_per_month=invocations,
        avg_duration_ms=duration_ms,
        memory_mb=memory_mb,
    )
    assert cost == expected
    assert gb_seconds == 120_000.0  # well below the 6B GB-s tier-1 limit
    assert 0.5 < cost < 20.0


def test_azure_and_gcp_on_demand_formulas_match_ipricing_rates() -> None:
    pricing = FaaSPricing(PRICINGS)
    invocations, duration_ms, memory_mb = 1_000_000, 120.0, 1024.0
    gb_seconds = invocations * (duration_ms / 1000.0) * (memory_mb / 1024.0)

    azure_rates = pricing.azure["consumptionPricesPerRegion"]["westeurope"]
    azure_expected = invocations * float(azure_rates["execution"]) + gb_seconds * float(
        azure_rates["gbSecond"]
    )
    assert (
        pricing.estimate(
            "azure",
            "westeurope",
            invocations_per_month=invocations,
            avg_duration_ms=duration_ms,
            memory_mb=memory_mb,
        )
        == azure_expected
    )

    gcp_rates = pricing.gcp["requestBasedPricesPerRegion"]["europe-west1"]
    vcpu_seconds = invocations * (duration_ms / 1000.0) * 2.0
    gcp_expected = (
        invocations * float(gcp_rates["request"])
        + vcpu_seconds * float(gcp_rates["vcpuSecond"])
        + gb_seconds * float(gcp_rates["gibSecond"])
    )
    assert (
        pricing.estimate(
            "gcp",
            "europe-west1",
            invocations_per_month=invocations,
            avg_duration_ms=duration_ms,
            memory_mb=memory_mb,
            vcpu=2.0,
        )
        == gcp_expected
    )


def test_pricing_is_monotone_in_decision_variables() -> None:
    pricing = FaaSPricing(PRICINGS)
    base = {
        "invocations_per_month": 1_000_000,
        "avg_duration_ms": 120,
        "memory_mb": 512,
    }
    for provider, region in (
        ("aws", "eu-west-1"),
        ("azure", "westeurope"),
        ("gcp", "europe-west1"),
    ):
        cost = pricing.estimate(provider, region, **base)
        assert pricing.estimate(provider, region, **{**base, "memory_mb": 2048}) > cost
        assert (
            pricing.estimate(
                provider, region, **{**base, "invocations_per_month": 5_000_000}
            )
            > cost
        )
        assert (
            pricing.estimate(provider, region, **{**base, "avg_duration_ms": 480})
            > cost
        )


def test_generated_latency_provider_and_geo_classes() -> None:
    from experimentation.icsoc.generator.generator import generated_latency

    config = load_config(CONFIG)
    lat_cfg = config["latency_generation"]
    pool_kind = {
        "aws.faas.eu-west-1": "CLOUD_FAAS",
        "aws.faas.us-east-1": "CLOUD_FAAS",
        "gcp.faas.europe-west1": "CLOUD_FAAS",
        "gcp.faas.us-central1": "CLOUD_FAAS",
        "edge1": "EDGE",
    }
    pool_meta = {
        "aws.faas.eu-west-1": {"commercial_provider": "aws", "region": "eu-west-1"},
        "aws.faas.us-east-1": {"commercial_provider": "aws", "region": "us-east-1"},
        "gcp.faas.europe-west1": {
            "commercial_provider": "gcp",
            "region": "europe-west1",
        },
        "gcp.faas.us-central1": {"commercial_provider": "gcp", "region": "us-central1"},
        "edge1": {},
    }

    def lat(a: str, b: str) -> float:
        return generated_latency(a, b, pool_kind, pool_meta, config, 12345, "seed")

    def assert_in(value: float, key: str) -> None:
        low, high = lat_cfg[key]
        assert low <= value <= high, f"{value} not in {key} {lat_cfg[key]}"

    # Same provider, cross-continent backbone.
    assert_in(
        lat("aws.faas.eu-west-1", "aws.faas.us-east-1"),
        "cloud_same_provider_inter_geo_ms",
    )
    # Cross provider within the same continent (public peering).
    assert_in(
        lat("aws.faas.eu-west-1", "gcp.faas.europe-west1"),
        "cloud_cross_provider_intra_geo_ms",
    )
    # Cross provider, cross continent: the slowest class.
    assert_in(
        lat("aws.faas.eu-west-1", "gcp.faas.us-central1"),
        "cloud_cross_provider_inter_geo_ms",
    )
    # Original node to EU / US cloud.
    assert_in(lat("edge1", "aws.faas.eu-west-1"), "original_to_cloud_intra_geo_ms")
    assert_in(lat("edge1", "aws.faas.us-east-1"), "original_to_cloud_inter_geo_ms")

    # Class ordering: disjoint ranges make the realism property structural.
    assert (
        lat_cfg["cloud_same_provider_same_region_ms"][1]
        < lat_cfg["cloud_same_provider_intra_geo_ms"][0]
    )
    assert (
        lat_cfg["cloud_same_provider_intra_geo_ms"][1]
        < lat_cfg["cloud_cross_provider_intra_geo_ms"][0]
    )
    assert (
        lat_cfg["cloud_same_provider_inter_geo_ms"][1]
        < lat_cfg["cloud_cross_provider_inter_geo_ms"][0]
    )

    # Determinism.
    assert lat("aws.faas.eu-west-1", "gcp.faas.europe-west1") == lat(
        "aws.faas.eu-west-1", "gcp.faas.europe-west1"
    )


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
    instance_path = tmp_path / "instances/arOrch/338599157/infrastructure_50"
    instance = load_json(instance_path / "instance.json")

    assert instance_path.exists()
    assert instance["apiVersion"] == "bim/v1"
    assert instance["kind"] == "Instance"
    assert instance["spec"]["profile"] == "qos-binding/v1"
    groups = instance["spec"]["resources"]
    assert {"application", "candidateCatalog", "constraintSet", "optimization"} == set(
        groups
    )
    assert groups["application"] == {
        "application": "application.json",
        "placement": "placement.json",
        "routing": "routing.json",
    }
    violations = validate_instance(instance_path, SCHEMA)
    assert violations == []

    package = load_package(instance_path)
    problem = compile_instance(package)
    application = package.json("application.json")
    catalog = package.json("candidates.json")
    constraints = package.json("constraints.json")
    placement = package.json("placement.json")
    optimization = package.json("optimization.json")
    routing = package.json("routing.json")
    assert application["apiVersion"] == "qos-binding/v1"
    assert catalog["apiVersion"] == "qos-binding/v1"
    assert constraints["apiVersion"] == "qos-binding/v1"
    assert optimization["apiVersion"] == "qos-binding/v1"
    assert routing["apiVersion"] == "qos-binding/v1"
    assert placement["apiVersion"] == "qos-binding-placement/v1"
    assert isinstance(application["spec"]["tasks"], dict)
    assert catalog["spec"]["metricBindings"]["cost"] == {
        "resource": "application",
        "id": "cost",
    }
    assert placement["spec"]["networkMode"] == "symmetric"
    pairs = {
        (entry["from"]["id"], entry["to"]["id"])
        for entry in placement["spec"]["network"]
    }
    assert all(source <= target for source, target in pairs)
    assert all(term["normalize"]["clamp"] for term in optimization["spec"]["terms"])
    assert problem.as_dict()["spec"]["profile"]["id"] == "qos-binding/v1"

    assert reports


def test_latency_bounds_schedule_the_scenario_dag() -> None:
    """Normalization bounds schedule the actual precedence DAG."""
    from experimentation.icsoc.generator.generator import (
        InfraContext,
        _latency_norm_bounds,
    )

    # Two tasks in sequence, fed by one event generator.
    workflow = {
        "sequence": [
            {"task": {"resource": "application", "id": "T1"}},
            {"task": {"resource": "application", "id": "T2"}},
        ]
    }
    infra = InfraContext.__new__(InfraContext)
    infra.pool_latency = {"a": {"a": 0.0, "b": 10.0}, "b": {"a": 10.0, "b": 0.0}}
    event_latencies = {"ev": {"a": 1.0, "b": 4.0}}
    exec_of = {"T1": 2.0, "T2": 3.0}

    low, high = _latency_norm_bounds(
        workflow, infra, event_latencies, min_exec=exec_of, max_exec=exec_of
    )

    # Critical path with the worst transfer: event(4) + T1(2) + hop(10) + T2(3).
    assert high == 19.0
    # The coarse fallback would have been 4 + (2 + 1) * 10 + 5 = 39.
    assert high < 39.0
    assert low == 1.0 + 2.0 + 0.0 + 3.0
