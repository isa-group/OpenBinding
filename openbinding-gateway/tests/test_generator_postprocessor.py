"""Tests for BIM v1 postprocessor and synthesis validation."""

from __future__ import annotations

from decimal import Decimal

from openbinding_gateway.generator.compatibility import resolve_engine_capabilities
from openbinding_gateway.generator.legacy_parser import (
    CandidateService,
    LegacyConstraint,
    LegacyProblem,
    QoSPropertySpec,
    StructureNode,
)
from openbinding_gateway.generator.postprocessor import (
    BIMPostprocessor,
    normalize_probabilities,
)
from openbinding_gateway.v1.compiler import compile_instance


def test_normalize_probabilities_sum_to_exact_one():
    test_cases = [
        [0.3333333333, 0.3333333333, 0.3333333333],
        [0.1, 0.2, 0.7],
        [0.5, 0.5],
        [1.0, 2.0, 3.0, 4.0],
        [0.0, 0.0, 0.0],
    ]
    for probs in test_cases:
        normalized = normalize_probabilities(probs, precision=4)
        dec_sum = sum((Decimal(str(p)) for p in normalized), Decimal(0))
        assert dec_sum == Decimal(1), f"Probabilities {normalized} sum to {dec_sum}, not 1"


def test_postprocessor_produces_valid_bim_v1():
    # Build a synthetic LegacyProblem
    workflow = StructureNode(
        kind="sequence",
        children=[
            StructureNode(kind="task", id="task_1"),
            StructureNode(
                kind="branch",
                probabilities=[0.6, 0.4],
                children=[
                    StructureNode(kind="task", id="task_2"),
                    StructureNode(kind="task", id="task_3"),
                ],
            ),
            StructureNode(
                kind="loop",
                iterations=3,
                children=[StructureNode(kind="task", id="task_4")],
            ),
        ],
    )

    candidates = {
        "task_1": [
            CandidateService(name="t1_c1", metrics={"latency": 10.0, "cost": 50.0}),
            CandidateService(name="t1_c2", metrics={"latency": 20.0, "cost": 30.0}),
        ],
        "task_2": [
            CandidateService(name="t2_c1", metrics={"latency": 15.0, "cost": 40.0}),
        ],
        "task_3": [
            CandidateService(name="t3_c1", metrics={"latency": 25.0, "cost": 20.0}),
        ],
        "task_4": [
            CandidateService(name="t4_c1", metrics={"latency": 5.0, "cost": 10.0}),
        ],
    }

    qos_properties = {
        "latency": QoSPropertySpec(
            name="latency",
            direction="minimize",
            domain_min=0.0,
            domain_max=100.0,
            aggregations={"sequence": "sum", "parallel": "max", "branch": "sum", "loop": "sum"},
        ),
        "cost": QoSPropertySpec(
            name="cost",
            direction="minimize",
            domain_min=0.0,
            domain_max=200.0,
            aggregations={"sequence": "sum", "parallel": "sum", "branch": "sum", "loop": "sum"},
        ),
    }

    constraints = [
        LegacyConstraint(property_name="latency", operator="<=", value=100.0),
    ]

    prob = LegacyProblem(
        abstract_services=["task_1", "task_2", "task_3", "task_4"],
        structure=workflow,
        qos_properties=qos_properties,
        candidates=candidates,
        constraints=constraints,
    )

    postprocessor = BIMPostprocessor(
        name="test_package",
        guarantee_feasibility=True,
        tension=0.5,
    )

    package = postprocessor.process(prob)
    assert package is not None
    assert package.instance()["metadata"]["name"] == "test_package"

    # Verify all 6 resources are present
    assert "instance.json" in package.files
    assert "application.json" in package.files
    assert "candidates.json" in package.files
    assert "constraints.json" in package.files
    assert "optimization.json" in package.files
    assert "routing.json" in package.files

    # Verify that it compiles through BIM compiler with 0 errors
    compiled = compile_instance(package)
    assert compiled is not None
    assert compiled.digest is not None
    assert len(compiled.binding_space_breakdown) == 4


def test_postprocessor_tension_bounds():
    prob = LegacyProblem(
        abstract_services=["t1"],
        structure=StructureNode(kind="task", id="t1"),
        candidates={
            "t1": [
                CandidateService(name="c1", metrics={"latency": 10.0}),
                CandidateService(name="c2", metrics={"latency": 50.0}),
            ]
        },
        qos_properties={
            "latency": QoSPropertySpec(
                name="latency",
                direction="minimize",
                domain_min=0.0,
                domain_max=100.0,
                aggregations={"sequence": "sum"},
            )
        },
        constraints=[LegacyConstraint(property_name="latency", operator="<=", value=100.0)],
    )

    # Tightest tension (tau = 1.0)
    pp_tight = BIMPostprocessor(name="tight", guarantee_feasibility=True, tension=1.0)
    pkg_tight = pp_tight.process(prob)
    constr_tight = pkg_tight.json("constraints.json")
    assert "c_1_latency" in constr_tight["spec"]["constraints"]
    assert "features.latency <=" in constr_tight["spec"]["constraints"]["c_1_latency"]["assert"]

    # Loosest tension (tau = 0.0)
    pp_loose = BIMPostprocessor(name="loose", guarantee_feasibility=True, tension=0.0)
    pkg_loose = pp_loose.process(prob)
    constr_loose = pkg_loose.json("constraints.json")

    # Extract bounds
    val_tight = float(constr_tight["spec"]["constraints"]["c_1_latency"]["assert"].split("<=")[1])
    val_loose = float(constr_loose["spec"]["constraints"]["c_1_latency"]["assert"].split("<=")[1])
    assert val_tight < val_loose, f"Tight bound {val_tight} should be less than loose bound {val_loose}"


def test_postprocessor_empty_branch_repair():
    # Construct a branch with an empty side
    workflow = StructureNode(
        kind="branch",
        probabilities=[0.5, 0.5],
        children=[
            StructureNode(kind="task", id="task_active"),
            StructureNode(kind="sequence", children=[]),  # Empty branch!
        ],
    )

    prob = LegacyProblem(
        abstract_services=["task_active"],
        structure=workflow,
        candidates={
            "task_active": [
                CandidateService(name="c1", metrics={"latency": 10.0}),
            ]
        },
        qos_properties={
            "latency": QoSPropertySpec(
                name="latency",
                direction="minimize",
                domain_min=0.0,
                domain_max=50.0,
                aggregations={"sequence": "sum", "branch": "sum"},
            )
        },
        constraints=[],
    )

    pp = BIMPostprocessor(name="repaired", repair_empty_branches=True)
    pkg = pp.process(prob)
    app_doc = pkg.json("application.json")
    root = app_doc["spec"]["workflow"]
    assert "exclusive" in root
    # Check that empty branch was repaired to {"empty": True}
    branches = root["exclusive"]
    assert any(b.get("flow") == {"empty": True} for b in branches)

    # Must compile cleanly
    compiled = compile_instance(pkg)
    assert compiled is not None


def test_postprocessor_pareto_optimization_for_many_heuristic():
    caps = resolve_engine_capabilities(["many-heuristic"])
    prob = LegacyProblem(
        abstract_services=["t1"],
        structure=StructureNode(kind="task", id="t1"),
        candidates={
            "t1": [
                CandidateService(name="c1", metrics={"latency": 10.0, "cost": 20.0, "reliability": 0.99}),
            ]
        },
        qos_properties={
            "latency": QoSPropertySpec(
                name="latency",
                direction="minimize",
                domain_min=0.0,
                domain_max=100.0,
                aggregations={"sequence": "sum"},
            ),
            "cost": QoSPropertySpec(
                name="cost",
                direction="minimize",
                domain_min=0.0,
                domain_max=100.0,
                aggregations={"sequence": "sum"},
            ),
            "reliability": QoSPropertySpec(
                name="reliability",
                direction="maximize",
                domain_min=0.0,
                domain_max=1.0,
                aggregations={"sequence": "product"},
            ),
        },
        constraints=[],
    )

    pp = BIMPostprocessor(name="pareto_pkg", capabilities=caps)
    pkg = pp.process(prob)
    opt_doc = pkg.json("optimization.json")
    assert opt_doc["spec"]["mode"] == "pareto"
    assert len(opt_doc["spec"]["terms"]) >= 3

    compiled = compile_instance(pkg)
    assert compiled is not None
