"""Tests for /v1/generator API routes."""

from __future__ import annotations

import io
import base64
import json
import uuid
import zipfile
import pytest

from openbinding_gateway import space_client
from bim_core.compiler import compile_instance
from bim_core.package import InstancePackage
from _pricing import fake_pricing_gate, largest_plan
from _repo import REPO_ROOT

# The legacy generator shells out to a Maven-built jar that is not part of a
# plain checkout (see generator/synthesizer.py); without it the legacy cases
# cannot run, which is an environment gap rather than a regression.
LEGACY_GENERATOR_JAR = REPO_ROOT / "engines/bim-generator/target/bim-generator-0.1.0-SNAPSHOT.jar"
LEGACY_ENGINE = pytest.param(
    True,
    marks=pytest.mark.skipif(
        not LEGACY_GENERATOR_JAR.is_file(),
        reason=f"legacy BIM generator jar not built: {LEGACY_GENERATOR_JAR} (run mvn package in engines/bim-generator)",
    ),
)

# A legacy QACO document the parser's own grammar accepts: five `%#= SECTION =#`
# markers, four abstract services, a BRANCH and a LOOP, five candidate services
# and two constraints. Text without those markers parses to nothing, so a
# conversion test fed on such text asserts only that the endpoint answers at all.
LEGACY_QACO_SPEC = """%#============================= HEADER ======================================#
% Problem Statistics:
% Number of activities: 4
% Number of Candidate Services: 6
% Number of Constraints: 2
%#======================= COMPOSITION STRUCTURE =============================#
% Abstract Services:
4
t1
t2
t3
t4
% CompositionStructure:
SEC[
    t1,
    BRANCH(0.6;0.4;)[
        t2,
        t3,
    ],
    LOOP(5)[
        t4,
    ],
]
%#======================= QOS MODEL =============================#
QoSModel{
    Properties{
         ExecTime:NEGATIVE€Double[0.0,1.0]
         Cost:NEGATIVE€Double[0.0,1.0]
         Availability:POSITIVE€Double[0.0,1.0]
    }
    AggregationFunctions(
         ExecTime{
             Loop:SUM
             Branch:SUM
             Flow:MAX
             Sequence:SUM
         }
         Cost{
             Loop:SUM
             Branch:SUM
             Flow:SUM
             Sequence:SUM
         }
    )
    Weights(
         ExecTime:0.5
         Cost:0.5
    )
}
%#======================= CANDIDATE SERVICES =============================#
------------------------
t1
------------------------
s11(ExecTime:0.1,Cost:0.2,Availability:0.9,)
s12(ExecTime:0.3,Cost:0.4,Availability:0.8,)
------------------------
t2
------------------------
s21(ExecTime:0.2,Cost:0.1,Availability:0.95,)
------------------------
t3
------------------------
s31(ExecTime:0.4,Cost:0.3,Availability:0.85,)
------------------------
t4
------------------------
s41(ExecTime:0.05,Cost:0.05,Availability:0.99,)
------------------------
%#======================= CONSTRAINTS =============================#
2
LOWEREQUAL(ExecTime, 50.0)
GREATEREQUAL(Availability, 0.8)
"""

LARGER_PLAN = largest_plan()
FEATURES = [
    {"id": "cost", "unit": "EUR", "direction": "minimize", "scope": "selectedCandidate",
     "distribution": {"kind": "uniform", "minimum": 1, "maximum": 10},
     "aggregation": {"selection": "sum"}},
    {"id": "latency", "unit": "ms", "direction": "minimize", "scope": "invocation",
     "distribution": {"kind": "normal", "minimum": 2, "maximum": 20, "mean": 10, "stddev": 3},
     "aggregation": {"sequence": "sum", "parallel": "max", "exclusive": "weightedSum", "repeat": "scale"}},
]


async def _get_auth_headers(api_client, registration, platform_gate, username: str = "gen-user") -> dict[str, str]:
    details = registration(username=username, email=f"{username}@example.com")
    resp = await api_client.post("/v1/auth/register", json=details)
    assert resp.status_code == 201, resp.text
    user_id = resp.json()["id"]
    platform_gate.plans[uuid.UUID(user_id)] = LARGER_PLAN
    login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest.fixture
def platform_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


@pytest.mark.asyncio
async def test_generate_instance_endpoint_success(api_client):
    payload = {
        "tasks": 5,
        "candidates": 3,
        "control_flow": 30,
        "constraints": 1,
        "name": "api_test_inst",
        "target_engines": ["minizinc-csp"],
        "seed": 42,
        "features": FEATURES,
    }
    resp = await api_client.post("/v1/generator/instances", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["name"] == "api_test_inst"
    assert "package_digest" in data
    assert "compilation_digest" in data
    assert "workload_features" not in data

    # Check 6 BIM v1 files
    files = data["files"]
    for expected_file in [
        "instance.json",
        "application.json",
        "candidates.json",
        "constraints.json",
        "optimization.json",
        "routing.json",
    ]:
        assert expected_file in files


@pytest.mark.asyncio
@pytest.mark.parametrize("structure", [
    {"control_flow": 0},
    {"control_flow": 40, "loops": 100, "branches": 0, "parallel": 0},
    {"control_flow": 40, "loops": 34, "branches": 33, "parallel": 33},
])
async def test_generated_bpmn_matches_native_workflow(api_client, structure):
    base = {"tasks": 12, "candidates": 3, "constraints": 1, "features": FEATURES,
            "target_engines": ["minizinc-csp", "random-search", "evolutionary-heuristics"],
            "optimization_mode": "weighted-sum", "name": "paired_workflow", "seed": 42,
            "include_file_bytes": True, **structure}
    native = await api_client.post("/v1/generator/instances", json={**base, "dialects": ["qos-binding/v1"]})
    bpmn = await api_client.post("/v1/generator/instances", json={**base, "dialects": ["bpmn-workflow/v1"]})
    assert native.status_code == bpmn.status_code == 200, (native.text, bpmn.text)
    assert native.json()["compilation_digest"] == bpmn.json()["compilation_digest"]
    native_compiled = compile_instance(InstancePackage({
        name: base64.b64decode(content) for name, content in native.json()["file_bytes_base64"].items()
    }))
    bpmn_compiled = compile_instance(InstancePackage({
        name: base64.b64decode(content) for name, content in bpmn.json()["file_bytes_base64"].items()
    }))
    eligibility = native_compiled.document["spec"]["eligibility"]
    binding = {task: refs[0] for task, refs in eligibility.items()}
    assert native_compiled.evaluate(binding) == bpmn_compiled.evaluate(binding)
    assert "<bpmn:definitions" in bpmn.json()["files"]["workflow.bpmn"]
    assert base64.b64decode(bpmn.json()["file_bytes_base64"]["workflow.bpmn"]).startswith(b"<?xml")
    if structure.get("loops"):
        assert "subProcess" in bpmn.json()["files"]["workflow.bpmn"]


@pytest.mark.asyncio
async def test_generate_instance_incompatible_engines(api_client):
    payload = {
        "tasks": 6,
        "candidates": 3,
        "target_engines": ["minizinc-csp", "many-heuristic"],
        "features": FEATURES,
    }
    resp = await api_client.post("/v1/generator/instances", json=payload)
    assert resp.status_code == 422, resp.text
    problem = resp.json()
    assert problem["code"] == "incompatible_target_engines"
    # The route's own fields travel beside the canonical ones.
    assert "conflicts" in problem


@pytest.mark.asyncio
async def test_generate_instance_persist(api_client, registration, platform_gate):
    headers = await _get_auth_headers(api_client, registration, platform_gate, username="persister")

    # Create Org & Project
    org_slug = f"org-{uuid.uuid4().hex[:6]}"
    proj_slug = "test-proj"
    r = await api_client.post("/v1/organizations", headers=headers, json={"slug": org_slug, "name": "Test Org"})
    assert r.status_code == 201
    r = await api_client.post(f"/v1/organizations/{org_slug}/projects", headers=headers, json={"slug": proj_slug, "name": "Test Proj", "visibility": "private"})
    assert r.status_code == 201
    proj_id = r.json()["id"]

    payload = {
        "tasks": 4,
        "candidates": 2,
        "name": "persisted_inst",
        "persist": True,
        "project_id": proj_id,
        "case_name": "My Case",
        "features": FEATURES,
    }
    resp = await api_client.post("/v1/generator/instances", headers=headers, json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["snapshot_id"] is not None
    assert data["case_id"] is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("use_legacy_engine", [False, LEGACY_ENGINE])
async def test_generate_corpus_endpoint(api_client, use_legacy_engine):
    payload = {
        "count": 3,
        "name": "bench_corpus",
        "base_config": {
            "tasks": 4,
            "candidates": 2,
            "constraints": 1,
            "features": FEATURES,
            "seed": 21,
            "use_legacy_engine": use_legacy_engine,
        },
    }
    resp = await api_client.post("/v1/generator/corpus", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["name"] == "bench_corpus"
    assert data["count"] == 3
    assert len(data["instances"]) == 3
    for inst in data["instances"]:
        assert "package_digest" in inst
        assert "workload_features" not in inst
        assert inst["actual_constraint_count"] == 1


@pytest.mark.asyncio
async def test_generate_corpus_as_zip_archive(api_client):
    payload = {
        "count": 2,
        "name": "zip_corpus",
        "as_archive": True,
        "base_config": {
            "tasks": 3,
            "candidates": 2,
            "features": FEATURES,
        },
    }
    resp = await api_client.post("/v1/generator/corpus", json=payload)
    assert resp.status_code == 200, resp.text
    assert resp.headers.get("content-type") == "application/zip"

    # Verify zip content
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        namelist = zf.namelist()
        assert len(namelist) == 2
        for item in namelist:
            assert item.endswith(".bim.zip")
            inner_zip = zf.read(item)
            with zipfile.ZipFile(io.BytesIO(inner_zip)) as izf:
                assert "instance.json" in izf.namelist()
                assert "application.json" in izf.namelist()


@pytest.mark.asyncio
@pytest.mark.parametrize("use_legacy_engine", [False, LEGACY_ENGINE])
async def test_explicit_features_and_distributions_are_seeded(api_client, use_legacy_engine):
    payload = {
        "tasks": 7, "control_flow": 50, "loops": 0, "branches": 100, "parallel": 0,
        "features": [
            {**FEATURES[0], "id": "ExecTime", "count": 2},
            {**FEATURES[1], "id": "latency", "objective": False},
        ],
        "distributions": {
            "candidate_count": {"kind": "uniform", "minimum": 3, "maximum": 3},
            "branches_per_decision": {"kind": "uniform", "minimum": 3, "maximum": 3},
            "constraint_optimality_percent": {"kind": "uniform", "minimum": 0, "maximum": 0},
        },
        "constraints": 2, "constraint_count_mode": "expected",
        "guarantee_feasibility": False, "seed": 81,
        "use_legacy_engine": use_legacy_engine,
    }
    first = await api_client.post("/v1/generator/instances", json=payload)
    second = await api_client.post("/v1/generator/instances", json=payload)
    assert first.status_code == second.status_code == 200, first.text
    data = first.json()
    assert data["package_digest"] == second.json()["package_digest"]
    files = data["files"]
    assert set(files["application.json"]["spec"]["features"]) == {"ExecTime_1", "ExecTime_2", "latency"}
    assert len(files["optimization.json"]["spec"]["criteria"]) == 2
    assert data["actual_constraint_count"] == len(files["constraints.json"]["spec"]["constraints"])
    candidates = files["candidates.json"]["spec"]["candidates"]
    assert len(candidates) == 3 * len(files["application.json"]["spec"]["tasks"])

    def branches(node):
        return ([node["exclusive"]] if "exclusive" in node else []) + [
            branch for value in node.values() if isinstance(value, (list, dict))
            for child in (value if isinstance(value, list) else [value])
            if isinstance(child, dict) for branch in branches(child)
        ]

    generated_branches = branches(files["application.json"]["spec"]["workflow"])
    assert generated_branches and all(len(branch) == 3 for branch in generated_branches)


@pytest.mark.asyncio
async def test_percentage_bound_uses_aggregated_extreme(api_client):
    payload = {"tasks": 3, "control_flow": 0, "features": [FEATURES[0]], "constraints": 1,
               "guarantee_feasibility": False, "seed": 13,
               "distributions": {"constraint_optimality_percent": {"kind": "uniform", "minimum": 0, "maximum": 0}}}
    response = await api_client.post("/v1/generator/instances", json=payload)
    assert response.status_code == 200, response.text
    files = response.json()["files"]
    low = files["optimization.json"]["spec"]["criteria"][0]["normalize"]["min"]
    bound = float(next(iter(files["constraints.json"]["spec"]["constraints"].values()))["assert"].split("<= ")[1])
    assert bound == pytest.approx(low)


@pytest.mark.asyncio
async def test_anonymous_feature_count_assigns_stable_ids_without_weights(api_client):
    feature = {key: value for key, value in FEATURES[0].items() if key != "id"}
    response = await api_client.post("/v1/generator/instances", json={
        "features": [{**feature, "count": 2}], "constraints": 0, "seed": 9,
    })
    assert response.status_code == 200, response.text
    files = response.json()["files"]
    assert list(files["application.json"]["spec"]["features"]) == ["qos_1", "qos_2"]
    assert [criterion["id"] for criterion in files["optimization.json"]["spec"]["criteria"]] == ["qos_1", "qos_2"]
    assert "weights" not in files["optimization.json"]["spec"]


@pytest.mark.asyncio
@pytest.mark.parametrize("use_legacy_engine", [False, LEGACY_ENGINE])
@pytest.mark.parametrize("kind", ["loop", "parallel"])
async def test_structural_distributions_apply_in_both_synthesizers(api_client, use_legacy_engine, kind):
    payload = {"tasks": 7, "control_flow": 50, "loops": 100 if kind == "loop" else 0,
               "branches": 0, "parallel": 100 if kind == "parallel" else 0,
               "features": [FEATURES[0]], "constraints": 0, "seed": 2,
               "use_legacy_engine": use_legacy_engine}
    if kind == "loop":
        payload["distributions"] = {"loop_iterations": {"kind": "normal", "minimum": 4,
                                                       "maximum": 4, "mean": 4, "stddev": 1}}
    response = await api_client.post("/v1/generator/instances", json=payload)
    assert response.status_code == 200, response.text
    workflow = json.dumps(response.json()["files"]["application.json"]["spec"]["workflow"])
    assert ('"repeat"' if kind == "loop" else '"parallel"') in workflow
    if kind == "loop":
        assert '"count": 4' in workflow


@pytest.mark.asyncio
@pytest.mark.parametrize(("change", "field"), [
    ({"qos_properties": 5}, "qos_properties"),
    ({"templates": ["cost"]}, "templates"),
    ({"weights": [1]}, "weights"),
    ({"features": [FEATURES[0], FEATURES[0]]}, "duplicate"),
    ({"features": [{**FEATURES[0], "aggregation": {"selection": "sum", "sequence": "sum"}}]}, "aggregation"),
    ({"features": [{**FEATURES[0], "objective": False}]}, "objective"),
    ({"constraints": 3}, "constraints"),
    ({"guarantee_feasibility": False, "tension": 0.4}, "tension"),
    ({"distributions": {"constraint_optimality_percent": {"kind": "uniform", "minimum": 20, "maximum": 80}}}, "guarantee_feasibility"),
    ({"candidates": 3, "distributions": {"candidate_count": {"kind": "uniform", "minimum": 2, "maximum": 4}}}, "candidates"),
    ({"features": [{**FEATURES[0], "distribution": {"kind": "normal", "minimum": 0, "maximum": 1, "mean": 0.5, "stddev": 0}}]}, "stddev"),
    ({"features": [{**FEATURES[0], "distribution": {"kind": "uniform", "minimum": 2, "maximum": 1}}]}, "maximum"),
    ({"control_flow": 0, "branches": 50}, "control_flow"),
    ({"loops": 0, "iterations_per_loop": 4}, "iterations_per_loop"),
])
async def test_invalid_generator_configuration_reports_field(api_client, change, field):
    response = await api_client.post("/v1/generator/instances", json={"features": [FEATURES[0]], "constraints": 1, **change})
    assert response.status_code == 422, response.text
    assert field in response.text


@pytest.mark.asyncio
async def test_target_engine_rejects_unsupported_objective_and_aggregation(api_client):
    one_objective = await api_client.post("/v1/generator/instances", json={
        "features": [FEATURES[0]], "target_engines": ["many-heuristic"], "constraints": 0,
    })
    assert one_objective.status_code == 422
    assert "minObjectives" in one_objective.text

    # minizinc-csp 1.1.1 declares the multiplicative aggregations, so a product is no longer rejected for it.
    product = await api_client.post("/v1/generator/instances", json={
        "features": [{**FEATURES[0], "aggregation": {"selection": "product"}}],
        "target_engines": ["minizinc-csp"], "constraints": 0,
    })
    assert product.status_code == 200, product.text

    unknown = await api_client.post("/v1/generator/instances", json={
        "features": [FEATURES[0]], "target_engines": ["auto"], "constraints": 0,
    })
    assert unknown.status_code == 422
    assert "manifest_not_found" in unknown.text


@pytest.mark.asyncio
async def test_corpus_rejects_ignored_base_configuration(api_client):
    response = await api_client.post("/v1/generator/corpus", json={
        "count": 2,
        "base_config": {"features": [FEATURES[0]], "name": "ignored"},
    })
    assert response.status_code == 422
    assert "base_config.name" in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("use_legacy_engine", [False, LEGACY_ENGINE])
async def test_guaranteed_constraints_share_a_feasible_witness(api_client, use_legacy_engine):
    response = await api_client.post("/v1/generator/instances", json={
        "tasks": 5, "features": [FEATURES[0], {**FEATURES[0], "id": "quality", "direction": "maximize"}],
        "constraints": 2, "tension": 1, "seed": 4, "use_legacy_engine": use_legacy_engine,
    })
    assert response.status_code == 200, response.text
    package = InstancePackage({name: json.dumps(doc).encode() for name, doc in response.json()["files"].items()})
    compiled = compile_instance(package)
    binding = {task: options[0] for task, options in compiled.document["spec"]["eligibility"].items()}
    assert compiled.evaluate_constraints(binding) == []


@pytest.mark.asyncio
async def test_convert_legacy_endpoint(api_client):
    """The conversion carries the document's own tasks, features and candidates."""
    payload = {
        "raw_text": LEGACY_QACO_SPEC,
        "name": "converted_from_api",
        "guarantee_feasibility": True,
        "tension": 0.6,
    }
    resp = await api_client.post("/v1/generator/convert-legacy", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["name"] == "converted_from_api"
    assert "package_digest" in data
    assert "workload_features" not in data

    application = data["files"]["application.json"]["spec"]
    # The four abstract services of the document, and only those.
    assert sorted(application["tasks"]) == ["t1", "t2", "t3", "t4"]
    # Its three QoS properties, with the directions it declares.
    assert sorted(application["features"]) == ["availability", "cost", "latency"]
    assert application["features"]["availability"]["direction"] == "maximize"
    assert application["features"]["cost"]["direction"] == "minimize"
    assert application["features"]["latency"]["direction"] == "minimize"
    # SEC[ t1, BRANCH[ t2, t3 ], LOOP[ t4 ] ]: a sequence of three steps.
    workflow = application["workflow"]["sequence"]
    assert len(workflow) == 3
    assert workflow[0]["task"]["id"] == "t1"
    assert [branch["flow"]["task"]["id"] for branch in workflow[1]["exclusive"]] == ["t2", "t3"]

    # Every candidate the document defines, named after the task it provides for,
    # carrying the metrics declared for it.
    candidates = data["files"]["candidates.json"]["spec"]["candidates"]
    assert sorted(candidates) == ["t1_s11", "t1_s12", "t2_s21", "t3_s31", "t4_s41"]
    assert candidates["t1_s11"]["provides"] == "service/t1"
    assert candidates["t1_s11"]["features"] == {"latency": 0.1, "cost": 0.2, "availability": 0.9}

    # Both of the document's constraints, one per declared direction.
    constraints = data["files"]["constraints.json"]["spec"]["constraints"]
    assert len(constraints) == 2
    assert [entry["assert"].split()[1] for entry in constraints.values()] == ["<=", ">="]


@pytest.mark.asyncio
async def test_convert_legacy_never_reads_files_from_the_server(api_client, tmp_path):
    """raw_text is content. A path in it is parsed as text, never opened.

    The parser used to call os.path.isfile on the string it was given, so a body on
    this route - which needs no account - returned any file the service user could
    read, and told existing paths from missing ones by the status code.
    """
    planted = tmp_path / "legacy.txt"
    planted.write_text(LEGACY_QACO_SPEC.replace("s11", "leakedcanary"), encoding="utf-8")

    existing = await api_client.post("/v1/generator/convert-legacy", json={
        "raw_text": str(planted), "name": "reader",
    })
    # Nothing of the file: not its canary, not the tasks it would have produced.
    assert "leakedcanary" not in existing.text
    assert "t1_s12" not in existing.text
    assert existing.status_code == 422, existing.text

    # And a path that does not exist is answered exactly the same way, so the
    # endpoint cannot be asked whether a file is there.
    missing = await api_client.post("/v1/generator/convert-legacy", json={
        "raw_text": str(tmp_path / "absent.txt"), "name": "reader",
    })
    assert missing.status_code == 422, missing.text
    assert missing.json()["detail"] == existing.json()["detail"]


@pytest.mark.asyncio
async def test_convert_legacy_rejects_text_the_grammar_does_not_accept(api_client):
    """A document the parser cannot read is 422, not 500 and not a fabricated package.

    Without the section markers the parser read nothing and the postprocessor filled
    the gap with its own defaults, so a failed parse reached the caller as a 200 and
    a two-task package it never asked for.
    """
    resp = await api_client.post("/v1/generator/convert-legacy", json={
        "raw_text": "SEC\n  T1\n  T2\nEND\n", "name": "malformed",
    })
    assert resp.status_code == 422, resp.text
    assert "files" not in resp.json()


def test_generator_endpoints_stay_open_to_any_caller():
    """Generation is a pure function of the request: no route requires an account or a role.

    The exact set of paths also pins that the generator offers nothing beyond generation and conversion.
    """
    from openbinding_gateway.access.dependencies import get_current_user, get_optional_user, require_platform_admin
    from openbinding_gateway.main import app

    def calls(dependant):
        found = {dependant.call}
        for dependency in dependant.dependencies:
            found |= calls(dependency)
        return found

    guards = {}
    for included in app.routes:
        original_router = getattr(included, "original_router", None)
        for route in original_router.routes if original_router is not None else [included]:
            path = getattr(route, "path", "")
            if path.startswith("/v1/generator/"):
                guards[path] = calls(route.dependant)
    assert set(guards) == {
        "/v1/generator/instances",
        "/v1/generator/corpus",
        "/v1/generator/convert-legacy",
    }
    for found in guards.values():
        assert get_optional_user in found
        assert require_platform_admin not in found and get_current_user not in found
