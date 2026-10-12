"""bim_core.conformance: the pure conformance kit (OpenAPI semantics and the deterministic probe)."""

import copy

import pytest

from bim_core import BindingProblem, ProtocolError, openapi_diagnostics, protocol_digest, protocol_document
from bim_core import conformance
from bim_core.compat import resolve_optimization
from core_support import engine_manifest_fixtures

BEARER = {"bearerAuth": {"type": "http", "scheme": "bearer"}, "basicAuth": {"type": "http", "scheme": "Basic"}}


def deployment(*, health=True, security=None, schemes=None):
    """What a conforming engine publishes: the canonical contract, its markers and a health operation."""
    document = protocol_document()
    document["x-bim-protocol"] = "bim-engine/v1"
    document["x-bim-protocol-digest"] = protocol_digest()
    if health:
        document["paths"]["/health"] = {"get": {"responses": {"200": {"description": "ok"}}}}
    if security is not None:
        document["security"] = security
    if schemes is not None:
        document["components"]["securitySchemes"] = schemes
    return document


def refusal(call, *arguments, **options):
    with pytest.raises(ProtocolError) as caught:
        call(*arguments, **options)
    assert isinstance(caught.value, ValueError)
    return caught.value


def findings(document, **options):
    return [(item["check"], item["code"]) for item in openapi_diagnostics(document, **options)]


# -- semantics of OpenAPI schemas --------------------------------------------------------------------


def test_references_are_resolved_and_annotations_dropped() -> None:
    document = {"components": {"schemas": {"Ref": {"type": "object", "description": "d", "properties": {"id": {"type": "string", "title": "t"}}}}}}
    schema = {"$ref": "#/components/schemas/Ref", "description": "also dropped", "examples": [1]}

    assert conformance.schema_semantics(document, schema) == {"type": "object", "properties": {"id": {"type": "string"}}}
    assert conformance.schema_semantics(document, [{"$ref": "#/components/schemas/Ref"}, 3, "x", None]) == [
        {"type": "object", "properties": {"id": {"type": "string"}}}, 3, "x", None,
    ]


def test_the_binding_problem_schema_is_a_symbol() -> None:
    assert conformance.schema_semantics({}, {"$ref": "./bim/v1/binding-problem.schema.json"}) == {"$ref": "bim-binding-problem/v1"}
    assert conformance.schema_semantics({}, {"$ref": "./bim/v1/binding-problem.schema.json", "description": "x"}) == {
        "$ref": "bim-binding-problem/v1"
    }


@pytest.mark.parametrize(
    ("schema", "code"),
    [
        ({"$ref": "#/components/schemas/Ref", "type": "object"}, "openapi_ref_siblings"),
        ({"$ref": "https://example.test/schema.json"}, "openapi_ref_unapproved"),
        ({"$ref": "./other.schema.json"}, "openapi_ref_unapproved"),
        ({"$ref": "#/components/schemas/Missing"}, "openapi_ref_unresolved"),
        ({"$ref": "#/components/schemas/Ref/properties/ghost"}, "openapi_ref_unresolved"),
        ({"$ref": "#/components/schemas/Loop"}, "openapi_ref_recursive"),
    ],
)
def test_references_that_cannot_be_compared_are_refused(schema, code) -> None:
    document = {"components": {"schemas": {"Ref": {"type": "object"}, "Loop": {"items": {"$ref": "#/components/schemas/Loop"}}}}}

    assert refusal(conformance.schema_semantics, document, schema).code == code


def test_a_pointer_unescapes_slash_and_tilde() -> None:
    document = {"a/b": {"c~d": {"value": 1}}}

    assert conformance.resolve_pointer(document, "#/a~1b/c~0d") == {"value": 1}
    assert refusal(conformance.resolve_pointer, document, "other").code == "openapi_ref_not_local"
    assert refusal(conformance.resolve_pointer, document, "#/a~1b/nope").code == "openapi_ref_unresolved"
    assert refusal(conformance.resolve_pointer, {"a": 1}, "#/a/b").code == "openapi_ref_unresolved"


def test_the_schema_of_an_operation_is_found_by_media_type() -> None:
    operation = {
        "requestBody": {"content": {"application/json": {"schema": {"type": "object"}}}},
        "responses": {"200": {"content": {"application/json": {"schema": {"type": "string"}}}}},
    }

    assert conformance.operation_schema(operation, request=True) == {"type": "object"}
    assert conformance.operation_schema(operation, response="200") == {"type": "string"}
    assert refusal(conformance.operation_schema, operation, response="404").code == "openapi_schema_missing"
    assert refusal(conformance.operation_schema, {}, request=True).code == "openapi_schema_missing"
    assert refusal(conformance.operation_schema, None, request=True).code == "openapi_schema_missing"
    bad = {"responses": {"200": {"content": {"application/json": {"schema": True}}}}}
    assert refusal(conformance.operation_schema, bad, response="200").code == "openapi_schema_not_object"


def test_deployed_and_canonical_schemas_are_compared_by_meaning() -> None:
    canonical = {"components": {"schemas": {"A": {"type": "object", "description": "x"}}}}
    inlined = {"components": {}}

    conformance.assert_protocol_schema("t", inlined, {"type": "object", "title": "other"}, canonical, {"$ref": "#/components/schemas/A"})
    error = refusal(conformance.assert_protocol_schema, "t", inlined, {"type": "array"}, canonical, {"$ref": "#/components/schemas/A"})
    assert error.code == "openapi_schema_not_equivalent"
    assert str(error) == "deployment OpenAPI t schema is not equivalent to bim-engine/v1"


# -- operation authentication ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("document", "operation", "expected"),
    [
        ({}, {}, "none"),
        ({"security": []}, {}, "none"),
        ({"security": [{"bearerAuth": []}]}, {"security": []}, "none"),
        ({}, {"security": [{"bearerAuth": []}, {}]}, "none"),
        ({"components": {"securitySchemes": BEARER}, "security": [{"bearerAuth": []}]}, {}, "bearer"),
        ({"components": {"securitySchemes": BEARER}}, {"security": [{"basicAuth": []}]}, "basic"),
        ({"components": {"securitySchemes": BEARER}}, {"security": [{"basicAuth": []}, {"bearerAuth": []}]}, "bearer"),
    ],
)
def test_authentication_that_matches_the_registration_is_accepted(document, operation, expected) -> None:
    conformance.assert_operation_auth(document, operation, expected, "solve operation")


@pytest.mark.parametrize(
    ("document", "operation", "expected", "code"),
    [
        ({"security": [{"bearerAuth": []}]}, {}, "none", "openapi_auth_mismatch"),
        ({}, {}, "bearer", "openapi_auth_mismatch"),
        ({}, {"security": [{}]}, "bearer", "openapi_auth_mismatch"),
        ({}, {"security": [{"bearerAuth": []}, {}]}, "basic", "openapi_auth_mismatch"),
        ({"components": {"securitySchemes": BEARER}}, {"security": [{"basicAuth": []}]}, "bearer", "openapi_auth_mismatch"),
        ({"components": {"securitySchemes": BEARER}}, {"security": [{"bearerAuth": [], "basicAuth": []}]}, "bearer", "openapi_auth_mismatch"),
        ({"components": {"securitySchemes": {"k": {"type": "apiKey", "scheme": "bearer"}}}}, {"security": [{"k": []}]}, "bearer", "openapi_auth_mismatch"),
        ({}, {"security": [{"bearerAuth": []}]}, "bearer", "openapi_auth_mismatch"),
        ({"components": {"securitySchemes": []}}, {"security": [{"bearerAuth": []}]}, "bearer", "openapi_security_invalid"),
        ({}, {"security": {"bearerAuth": []}}, "none", "openapi_security_invalid"),
        ({}, {"security": ["bearerAuth"]}, "none", "openapi_security_invalid"),
    ],
)
def test_authentication_that_does_not_match_the_registration_is_refused(document, operation, expected, code) -> None:
    error = refusal(conformance.assert_operation_auth, document, operation, expected, "health operation")

    assert error.code == code
    if code == "openapi_auth_mismatch":
        assert "health operation" in str(error)


# -- a whole deployment document ---------------------------------------------------------------------


def test_the_canonical_contract_with_its_markers_and_a_health_operation_conforms() -> None:
    assert openapi_diagnostics(deployment()) == []


def test_a_registration_with_authentication_conforms_if_every_operation_offers_it() -> None:
    document = deployment(security=[{"bearerAuth": []}], schemes=BEARER)

    assert openapi_diagnostics(document, auth_scheme="bearer") == []
    assert findings(document) == [("solve", "openapi_auth_mismatch"), ("async", "openapi_auth_mismatch"), ("health", "openapi_auth_mismatch")]
    assert findings(deployment(), auth_scheme="bearer") == [
        ("solve", "openapi_auth_mismatch"), ("async", "openapi_auth_mismatch"), ("health", "openapi_auth_mismatch"),
    ]


def test_the_mappings_of_the_registration_are_followed() -> None:
    document = deployment()
    document["paths"]["/v2/solve"] = document["paths"].pop("/internal/v1/binding-problems")
    document["paths"]["/v2/jobs/{id}"] = document["paths"].pop("/internal/v1/jobs/{id}")
    document["paths"]["/ready"] = document["paths"].pop("/health")
    mappings = {"request": "/v2/solve", "job": "/v2/jobs/{id}", "health": "/ready"}

    assert openapi_diagnostics(document, mappings=mappings) == []
    assert findings(document) == [
        ("solve", "openapi_operation_missing"), ("health", "openapi_health_missing"),
    ]


@pytest.mark.parametrize("document", [None, [], "openapi", 3])
def test_a_document_that_is_not_an_object_is_one_finding(document) -> None:
    assert openapi_diagnostics(document) == [
        {"code": "openapi_not_object", "check": "openapi", "message": "deployment OpenAPI must be an object"}
    ]


def test_the_version_the_protocol_marker_and_the_pinned_digest_are_checked() -> None:
    document = deployment()
    document["openapi"] = "3.0.3"
    document["x-bim-protocol"] = "other/v1"
    document["x-bim-protocol-digest"] = "sha256-" + "0" * 64

    assert findings(document) == [
        ("openapi", "openapi_version"), ("openapi", "openapi_protocol"), ("openapi", "openapi_digest_unpinned"),
    ]


def test_a_registration_must_pin_the_installed_contract() -> None:
    stale = "sha256-" + "1" * 64
    document = deployment()
    document["x-bim-protocol-digest"] = stale

    assert findings(document, expected_digest=stale) == [("openapi", "protocol_not_installed")]
    assert findings(document) == [("openapi", "openapi_digest_unpinned")]


def test_a_changed_request_schema_is_not_equivalent() -> None:
    document = deployment()
    document["components"]["schemas"]["BindingProblemRequest"]["required"] = ["apiVersion"]

    assert findings(document) == [("solve", "openapi_schema_not_equivalent")]


def test_a_changed_result_receipt_or_job_schema_is_not_equivalent() -> None:
    result = deployment()
    result["components"]["schemas"]["BindingResult"]["properties"]["extra"] = {"type": "string"}
    receipt = deployment()
    receipt["components"]["schemas"]["EngineJobAccepted"]["required"] = []
    job = deployment()
    job["components"]["schemas"]["EngineJob"]["required"] = []

    # EngineJob embeds BindingResult, so a changed result changes the job schema too.
    assert findings(result) == [("solve", "openapi_schema_not_equivalent"), ("async", "openapi_schema_not_equivalent")]
    assert findings(receipt) == [("async", "openapi_schema_not_equivalent")]
    assert findings(job) == [("async", "openapi_schema_not_equivalent")]


def test_a_synchronous_only_engine_needs_no_job_operation() -> None:
    document = deployment()
    del document["paths"]["/internal/v1/binding-problems"]["post"]["responses"]["202"]
    del document["paths"]["/internal/v1/jobs/{id}"]

    assert openapi_diagnostics(document, mappings={}) == []


def test_an_asynchronous_engine_needs_a_job_path_with_an_id_and_its_operation() -> None:
    document = deployment()
    del document["paths"]["/internal/v1/binding-problems"]["post"]["responses"]["200"]

    assert findings(document, mappings={}) == [("async", "openapi_job_path")]
    assert findings(document, mappings={"job": "/jobs"}) == [("async", "openapi_job_path")]
    assert findings(document, mappings={"job": "/jobs/{id}"}) == [("async", "openapi_operation_missing")]
    assert findings(document, mappings={"job": 3}) == [("async", "openapi_job_path")]
    assert openapi_diagnostics(document, mappings={"job": "/internal/v1/jobs/{id}"}) == []


def test_an_operation_with_no_result_response_is_a_finding() -> None:
    document = deployment()
    document["paths"]["/internal/v1/binding-problems"]["post"]["responses"] = {"500": {"description": "x"}}

    assert findings(document) == [("solve", "openapi_responses_missing")]
    document["paths"]["/internal/v1/binding-problems"]["post"]["responses"] = []
    assert findings(document) == [("solve", "openapi_responses_missing")]


def test_the_health_operation_must_exist_and_answer_200() -> None:
    assert findings(deployment(health=False)) == [("health", "openapi_health_missing")]
    document = deployment()
    document["paths"]["/health"]["get"]["responses"] = {"503": {"description": "x"}}
    assert findings(document) == [("health", "openapi_health_missing")]
    document["paths"]["/health"] = {"post": {}}
    assert findings(document) == [("health", "openapi_health_missing")]


def test_independent_findings_are_all_reported() -> None:
    document = deployment(health=False)
    document["openapi"] = "3.0.0"
    document["paths"]["/internal/v1/binding-problems"]["post"]["responses"].pop("200")
    document["components"]["schemas"]["EngineJob"]["required"] = []

    assert findings(document, mappings={"job": "/internal/v1/jobs/{id}"}) == [
        ("openapi", "openapi_version"), ("async", "openapi_schema_not_equivalent"), ("health", "openapi_health_missing"),
    ]


@pytest.mark.parametrize("paths", [[], "x", None, {"/internal/v1/binding-problems": []}, {"/internal/v1/binding-problems": {"post": 3}}])
def test_a_malformed_paths_object_is_a_finding_not_a_crash(paths) -> None:
    document = deployment()
    document["paths"] = paths

    assert ("solve", "openapi_operation_missing") in findings(document)


def test_a_malformed_component_section_is_reported_as_malformed() -> None:
    document = deployment()
    document["components"] = []

    found = findings(document)

    assert ("solve", "openapi_ref_unresolved") in found
    assert ("solve", "openapi_schema_not_equivalent") not in found


def test_findings_have_a_check_a_code_and_a_message() -> None:
    document = deployment(health=False)

    (item,) = openapi_diagnostics(document)

    assert set(item) == {"code", "check", "message"}
    assert item["message"] == "deployment OpenAPI must describe the mapped GET health operation and its 200 response"


# -- the probe -----------------------------------------------------------------------------------------


def mode(scalarizations, **limits):
    return {"capabilities": {"scalarizations": {"selector": "only", "values": scalarizations}}, "limits": limits}


WEIGHTED = {"id": "weighted-sum", "objectiveTypes": ["SINGLE"], "weightPolicy": "required"}
PARETO = {"id": "pareto-front", "objectiveTypes": ["MULTI", "MANY"], "weightPolicy": "forbidden"}
FEASIBILITY = {"id": "feasibility", "objectiveTypes": ["SINGLE"], "weightPolicy": "forbidden"}


@pytest.mark.parametrize(
    ("candidate", "expected"),
    [
        (mode([WEIGHTED]), ("weighted-sum", "SINGLE", 1)),
        (mode([FEASIBILITY, WEIGHTED]), ("feasibility", "SINGLE", 0)),
        (mode([FEASIBILITY, WEIGHTED], minObjectives=1), ("feasibility", "SINGLE", 1)),
        (mode([PARETO]), ("pareto-front", "MULTI", 2)),
        (mode([PARETO], minObjectives=3), ("pareto-front", "MULTI", 3)),
        (mode([PARETO], minObjectives=4), ("pareto-front", "MANY", 4)),
        (mode([PARETO], maxObjectives=2), ("pareto-front", "MULTI", 2)),
        (mode([PARETO, WEIGHTED], maxObjectives=1), ("weighted-sum", "SINGLE", 1)),
        (mode([{"id": "x", "objectiveTypes": ["NONE", "SINGLE", 3, None]}]), ("x", "SINGLE", 1)),
        (mode([1, None, {"objectiveTypes": ["SINGLE"]}, WEIGHTED]), ("weighted-sum", "SINGLE", 1)),
        (mode([WEIGHTED], minObjectives="2", maxObjectives="1"), ("weighted-sum", "SINGLE", 1)),
    ],
)
def test_the_shape_of_the_probe_is_the_cheapest_the_mode_supports(candidate, expected) -> None:
    assert conformance.conformance_shape(candidate) == expected


@pytest.mark.parametrize(
    "candidate",
    [
        {},
        mode([]),
        mode([PARETO], maxObjectives=1),
        mode([WEIGHTED], minObjectives=2, maxObjectives=1),
        mode([{"id": "x", "objectiveTypes": ["NONE"]}]),
        {"capabilities": {"scalarizations": "all"}},
        {"capabilities": {"scalarizations": {"selector": "all"}}},
    ],
)
def test_a_mode_without_a_usable_shape_is_refused(candidate) -> None:
    assert refusal(conformance.conformance_shape, candidate).code == "conformance_no_shape"


def test_the_first_usable_mode_of_an_engine_is_chosen() -> None:
    engine = {"spec": {"modes": [mode([]), 3, {"id": "second", **mode([WEIGHTED])}, {"id": "third", **mode([PARETO])}]}}

    assert conformance.conformance_mode(engine)["id"] == "second"
    assert refusal(conformance.conformance_mode, {"spec": {"modes": [mode([])]}}).code == "conformance_no_mode"
    assert refusal(conformance.conformance_mode, {"spec": {"modes": "x"}}).code == "conformance_no_mode"
    assert refusal(conformance.conformance_mode, {}).code == "conformance_no_mode"


def test_the_probe_runs_with_the_default_options_of_the_mode() -> None:
    options = {"iterations": {"default": [1, 2]}, "seed": {"type": "integer"}, 3: {"default": 1}, "mode": 7}
    candidate = {"optionsSchema": {"properties": options}}

    found = conformance.conformance_options(candidate)

    assert found == {"iterations": [1, 2]}
    found["iterations"].append(3)
    assert options["iterations"]["default"] == [1, 2]
    assert conformance.conformance_options({}) == {}
    assert conformance.conformance_options({"optionsSchema": {"properties": []}}) == {}


@pytest.fixture(scope="module")
def catalog_modes():
    return [
        (f"{name}/{item['id']}", item)
        for name, manifest in engine_manifest_fixtures().items()
        for item in manifest["spec"]["modes"]
    ]


def test_the_probe_is_a_valid_binding_problem_with_exactly_one_binding(catalog_modes) -> None:
    for name, candidate in catalog_modes:
        scalarization, objective_type, count = conformance.conformance_shape(candidate)
        document = conformance.conformance_problem(candidate)
        problem = BindingProblem.from_document(document)

        assert len(document["spec"]["optimization"]["criteria"]) == count, name
        assert document["spec"]["eligibility"] == {"probe-task": [{"resource": "probe-catalog", "id": "probe-candidate"}]}, name
        evaluation = problem.evaluate(conformance.EXPECTED_PROBE_BINDING)
        assert evaluation["violations"] == [], name
        assert all(value == 0 for value in evaluation["features"].values()), name


def test_the_probe_optimization_names_a_scalarization_the_mode_declares(catalog_modes) -> None:
    for name, candidate in catalog_modes:
        requested = conformance.conformance_optimization(candidate)
        descriptors = candidate["capabilities"]["scalarizations"]["values"]
        declared = next(item for item in descriptors if item["id"] == requested["scalarization"])

        assert requested["type"] in declared["objectiveTypes"], name
        assert sum(item["value"] for item in requested["weights"]) == pytest.approx(1.0 if requested["weights"] else 0.0), name
        # Like the platform's probe, it is sent as it is, not through resolve_optimization: a mode that
        # forbids weights would refuse the weights of the probe there.
        if declared.get("weightPolicy") == "required":
            resolved = resolve_optimization(
                BindingProblem.from_document(conformance.conformance_problem(candidate)), candidate, requested
            )
            assert [item["criteria"] for item in resolved["weights"]] == [item["criteria"] for item in requested["weights"]], name
            assert [item["value"] for item in resolved["weights"]] == pytest.approx(
                [item["value"] for item in requested["weights"]]
            ), name


def test_the_probe_is_deterministic(catalog_modes) -> None:
    _, candidate = catalog_modes[0]

    assert conformance.conformance_problem(candidate) == conformance.conformance_problem(copy.deepcopy(candidate))
    assert conformance.conformance_optimization(candidate) == conformance.conformance_optimization(candidate)


def test_the_probe_optimization_carries_equal_weights() -> None:
    optimization = conformance.conformance_optimization(mode([PARETO], minObjectives=3))

    assert optimization == {
        "type": "MULTI",
        "scalarization": "pareto-front",
        "weights": [{"criteria": f"probe-objective-{index}", "value": 1.0 / 3} for index in (1, 2, 3)],
    }
    assert conformance.conformance_optimization(mode([FEASIBILITY]))["weights"] == []


def answer(termination, *bindings):
    return {
        "termination": termination,
        "solutions": [{"decision": {"kind": "binding", "binding": binding}} for binding in bindings],
    }


def test_the_probe_is_solved_only_by_the_one_possible_binding() -> None:
    expected = conformance.EXPECTED_PROBE_BINDING

    conformance.assert_conformance_result(answer("OPTIMAL", expected))
    conformance.assert_conformance_result(answer("FEASIBLE", {}, expected))


@pytest.mark.parametrize(
    "result",
    [
        answer("UNKNOWN", conformance.EXPECTED_PROBE_BINDING),
        answer("INFEASIBLE", conformance.EXPECTED_PROBE_BINDING),
        answer("OPTIMAL"),
        answer("OPTIMAL", {"probe-task": {"resource": "probe-catalog", "id": "other"}}),
        {"termination": "OPTIMAL", "solutions": [1, None, "x"]},
        {"termination": "OPTIMAL", "solutions": [{"decision": 3}]},
        {"termination": ["OPTIMAL"], "solutions": []},
        {"solutions": []},
        {},
    ],
)
def test_any_other_answer_fails_the_probe(result) -> None:
    error = refusal(conformance.assert_conformance_result, result)

    assert error.code == "conformance_failed"
    assert str(error) == "engine did not solve the deterministic conformance problem"
