"""Equivalence battery: the same cases through ``InProcessBim`` and ``HttpBim`` (the service mounted in ASGI).

The answers must be *equal*: the same IR, the same digests, the same diagnostics, and when a call fails the same
error class with the same ``code``, message, ``diagnostics`` and ``http_status``.  The cases are the consumer
fixtures of OpenBinding, ten small packages of the corpus (when ``BIM_CORPUS_ROOT`` has it), the re-evaluation and
result-validation vectors of ``golden/`` and a set of failing calls.  Where a golden exists the answers are also
compared with it.
"""

from __future__ import annotations

import base64
import copy
import functools
import json
from typing import Any

import pytest
from client_support import BASE_URL, GOLDEN_DIR, MANIFEST_DIR, outcome, require_corpus_path, stable
from starlette.testclient import TestClient

import consumer_fixtures as fx
from bim_client import BimServiceError, HttpBim, InProcessBim
from bim_core import ContractError, digest, load_package
from bim_core.protocol import contains_non_finite

NON_SEMANTIC = fx.NON_SEMANTIC
NON_FINITE = {"NaN": float("nan"), "Infinity": float("inf"), "-Infinity": float("-inf")}


def manifest(name: str) -> dict[str, Any]:
    return json.loads((MANIFEST_DIR / f"{name}.json").read_text(encoding="utf-8"))


def golden(name: str) -> dict[str, Any]:
    return json.loads((GOLDEN_DIR / name).read_text(encoding="utf-8"))


def decode_floats(value: Any) -> Any:
    """The inverse of ``baseline_core.encode_floats``: ``{"$float": "NaN"}`` is a float again."""
    if isinstance(value, dict):
        if set(value) == {"$float"} and value["$float"] in NON_FINITE:
            return NON_FINITE[value["$float"]]
        return {key: decode_floats(child) for key, child in value.items()}
    if isinstance(value, list):
        return [decode_floats(child) for child in value]
    return value


def calling(name: str, *args: Any, **kwargs: Any):
    """A call of the port method ``name`` with these arguments, to be made on either implementation."""

    def call(port):
        return getattr(port, name)(*args, **kwargs)

    return call


def both(inprocess: InProcessBim, http: HttpBim, call) -> tuple:
    """``call(port)`` through both implementations; the outcomes must be equal. Returns the shared outcome."""
    local, remote = outcome(functools.partial(call, inprocess)), outcome(functools.partial(call, http))
    assert local == remote
    return local


# --- the wire requests of the fixtures, as calls of the port ------------------------------------------------


def registered_specs(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "namespace": item["namespace"],
            "name": item["name"],
            "version": item["version"],
            "digest": item["digest"],
            "mediaType": item["mediaType"],
            "content": base64.b64decode(item["contentBase64"]),
            **({"versionManifest": item["versionManifest"]} if item.get("versionManifest") else {}),
        }
        for item in items
    ]


def call_port(port, request: dict[str, Any], body: dict[str, Any]):
    """What a fixture request means for the port."""
    path = request["path"].removeprefix("/bim/v1")
    if path in {"/compile", "/validate"}:
        method = port.compile if path == "/compile" else port.validate
        return method(base64.b64decode(body["package"]), registered_specs(body.get("registeredResources", [])))
    if path == "/compatibility":
        return port.compatibility(body["ir"], body["manifest"], mode=body.get("mode"), options=body.get("options"))
    if path == "/optimization/resolve":
        return port.resolve_optimization(body["ir"], body["manifest"], body["optimization"], mode=body.get("mode"))
    if path == "/evaluate":
        return port.evaluate_many(body["ir"], body["bindings"], body.get("execution"), on_error=body.get("onError", "raise"))
    if path == "/reevaluate":
        return port.reevaluate(body["ir"], body["result"], body.get("execution"), body.get("allowedTerminations"))
    if path == "/validate-result":
        return port.validate_result(body["result"])
    if path == "/neighborhood":
        return port.neighborhood(
            body["ir"], body["binding"], task=body.get("task"), limit=body.get("limit", 64),
            seconds=body.get("seconds", 2.0), execution=body.get("execution"),
        )  # fmt: skip
    raise AssertionError(f"no call for {path}")


def run_script(port, steps: list[dict[str, Any]]) -> list[tuple]:
    bodies: dict[str, Any] = {}
    results = []
    for step in steps:
        body = fx.resolve(step["request"]["body"], bodies)
        result = outcome(functools.partial(call_port, port, step["request"], body))
        bodies[step["id"]] = result[1] if result[0] == "ok" else None
        results.append(result)
    return results


@pytest.mark.parametrize("name", sorted(fx.scripts()))
def test_every_consumer_interaction_is_answered_identically(inprocess_bim, http_bim, name: str) -> None:
    steps = fx.scripts()[name]["steps"]
    local, remote = run_script(inprocess_bim, steps), run_script(http_bim, steps)
    assert local == remote
    # ... and the answers are the ones the fixture recorded: an error where it recorded a problem, with its code.
    recorded = fx.load_fixtures().get(name)
    if recorded is None:
        pytest.skip("the fixture has not been created yet")
    for step, result in zip(recorded["steps"], local, strict=True):
        expected = step["expect"]
        if expected["status"] == 200:
            assert result[0] == "ok", step["id"]
        else:
            assert result[0] == "error" and result[2] == expected["body"]["code"], step["id"]


# --- ten small packages of the corpus ------------------------------------------------------------------------

CORPUS = [
    "01_simple_seq", "02_parallel", "03_xor_choice", "04_conflict", "05_multi_obj", "05_single_obj_various",
    "06_loops", "07_soft_constraints", "08_dependencies", "09_mixed",
]  # fmt: skip


@pytest.mark.parametrize("name", CORPUS)
def test_a_corpus_package_is_answered_identically_and_as_recorded(inprocess_bim, http_bim, name: str) -> None:
    directory = require_corpus_path(f"examples/demo/{name}")
    data = load_package(directory).to_zip()
    compiled = both(inprocess_bim, http_bim, calling("compile", data))
    assert compiled[0] == "ok"
    both(inprocess_bim, http_bim, calling("validate", data))
    result = compiled[1]
    ir = result["ir"]

    # What the baseline recorded in OpenBinding for this package (it compiles the directory, see the next test).
    entry = golden("bim_baseline/corpus.json")["packages"][f"examples/demo/{name}"]
    assert result["analysis"]["bindingSpaceCardinality"] == entry["bindingSpace"]["cardinality"]
    assert round(result["analysis"]["bindingSpaceLog10"], 9) == entry["bindingSpace"]["log10"]
    assert result["analysis"]["candidates"] == entry["candidates"]

    binding = {task: references[0] for task, references in ir["spec"]["eligibility"].items()}
    both(inprocess_bim, http_bim, calling("evaluate", ir, binding))
    both(inprocess_bim, http_bim, calling("evaluate_many", ir, [binding, {}], on_error="collect"))
    both(inprocess_bim, http_bim, calling("neighborhood", ir, binding, limit=4))
    for engine, mode in (("random-search", "seeded"), ("minizinc-csp", "exact-weighted")):
        both(inprocess_bim, http_bim, calling("compatibility", ir, manifest(engine), mode=mode))


def semantic_digest(spec: dict[str, Any], *, sort_eligibility: bool) -> str:
    spec = {key: value for key, value in spec.items() if key not in NON_SEMANTIC}
    if sort_eligibility:
        spec["eligibility"] = {
            task: sorted(references, key=lambda ref: (ref["resource"], ref["id"]))
            for task, references in spec["eligibility"].items()
        }
    return digest(spec)


@pytest.mark.parametrize("name", CORPUS)
def test_a_package_and_its_directory_differ_only_in_the_order_of_the_eligibility_lists(inprocess_bim, name: str) -> None:
    """The ``.bim.zip`` stores JSON in canonical form (keys sorted) and the eligible candidates of a task are listed in
    the order of the catalog's keys, so the IR of a package can list them in another order than the IR of the
    directory it came from (which is what ``golden/bim_baseline`` records). Nothing else may differ."""
    from bim_core import compile_instance

    directory = require_corpus_path(f"examples/demo/{name}")
    from_directory = compile_instance(load_package(directory)).document
    from_package = inprocess_bim.compile(load_package(directory).to_zip())["ir"]
    entry = golden("bim_baseline/corpus.json")["packages"][f"examples/demo/{name}"]
    assert semantic_digest(from_directory["spec"], sort_eligibility=False) == entry["semanticDigest"]
    assert semantic_digest(from_directory["spec"], sort_eligibility=True) == semantic_digest(
        from_package["spec"], sort_eligibility=True
    )


# --- the vectors of golden/ ----------------------------------------------------------------------------------------


def demo_ir(inprocess_bim) -> dict[str, Any]:
    directory = require_corpus_path("examples/demo/01_simple_seq")
    return inprocess_bim.compile(load_package(directory).to_zip())["ir"]


def test_the_baseline_vectors_are_answered_identically_and_as_recorded(inprocess_bim, http_bim) -> None:
    document = golden("bim_baseline/vectors.json")
    ir = demo_ir(inprocess_bim)
    assert len(document["vectors"]) == 10
    for vector in document["vectors"]:
        result, allowed = vector["input"]["result"], vector["input"]["allowedTerminations"]
        reevaluated = both(inprocess_bim, http_bim, calling("reevaluate", ir, result, None, allowed))
        assert reevaluated[0] == "ok"
        assert stable(reevaluated[1]) == vector["reevaluate"], vector["id"]
        validated = both(inprocess_bim, http_bim, calling("validate_result", result))[1]
        assert validated["valid"] == vector["validate"]["valid"], vector["id"]
        if not validated["valid"]:
            assert validated["error"]["message"] == vector["validate"]["error"], vector["id"]


def test_the_adversarial_vectors_are_answered_identically_and_as_recorded(inprocess_bim, http_bim) -> None:
    document = json.loads((GOLDEN_DIR / "vectors_extra.json").read_text(encoding="utf-8"))
    ir = demo_ir(inprocess_bim)
    checked = refused = 0
    for vector in document["vectors"]:
        result, allowed = decode_floats(vector["input"]["result"]), vector["input"]["allowedTerminations"]
        validated = both(inprocess_bim, http_bim, calling("validate_result", result))
        if contains_non_finite(result):
            # JSON has no NaN or infinity: the port refuses them, identically, before BIM sees them.
            assert validated[0] == "error" and validated[2] == "request_invalid", vector["id"]
            reevaluated = both(inprocess_bim, http_bim, calling("reevaluate", ir, result, None, allowed))
            assert reevaluated[0] == "error" and reevaluated[2] == "request_invalid", vector["id"]
            refused += 1
            continue
        assert validated[0] == "ok"
        assert validated[1]["valid"] == vector["validateFinite"]["valid"], vector["id"]
        if not validated[1]["valid"]:
            assert validated[1]["error"]["message"] == vector["validateFinite"]["error"], vector["id"]
        if "reevaluate" in vector:
            reevaluated = both(inprocess_bim, http_bim, calling("reevaluate", ir, result, None, allowed))
            assert reevaluated[0] == "ok"
            assert stable(reevaluated[1]) == decode_floats(vector["reevaluate"]), vector["id"]
        checked += 1
    assert checked > 30 and refused >= 5


# --- failing calls ---------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def ir() -> dict[str, Any]:
    with InProcessBim() as bim:
        return bim.compile(fx.demo_zip())["ir"]


def tampered_profile(ir: dict[str, Any]) -> dict[str, Any]:
    changed = copy.deepcopy(ir)
    changed["spec"]["profile"]["digest"] = "sha256-" + "0" * 64
    return changed


def broken_schema(ir: dict[str, Any]) -> dict[str, Any]:
    changed = copy.deepcopy(ir)
    del changed["spec"]["application"]
    return changed


def failing_calls(ir: dict[str, Any]) -> dict[str, Any]:
    binding, random_search = fx.BINDING, manifest("random-search")
    nobody = copy.deepcopy(random_search)
    nobody["spec"]["modes"][0]["profile"] = "nobody/v1"
    return {
        "not a zip": calling("compile", b"not a zip"),
        "compile diagnostics": calling("compile", fx.demo_zip(broken=True)),
        "validate not a zip": calling("validate", b"not a zip"),
        "validate findings": calling("validate", fx.demo_zip(broken=True)),
        "incomplete binding": calling("evaluate", ir, {"t1": binding["t1"]}),
        "binding is not an object": calling("evaluate", ir, "t1"),
        "collect": calling("evaluate_many", ir, [binding, {}, "x"], on_error="collect"),
        "raise": calling("evaluate_many", ir, [binding, {}]),
        "neighborhood limit": calling("neighborhood", ir, binding, limit=0),
        "neighborhood task": calling("neighborhood", ir, binding, task="nope"),
        "neighborhood binding": calling("neighborhood", ir, {}),
        "unknown mode": calling("compatibility", ir, random_search, mode="nope"),
        "no mode chosen": calling("compatibility", ir, manifest("evolutionary-heuristics")),
        "unknown option": calling("compatibility", ir, random_search, mode="seeded", options={"bogus": 1}),
        "option limit": calling("compatibility", ir, random_search, mode="seeded", options={"iterations": 10**9}),
        "invalid manifest": calling("compatibility", ir, nobody, mode="seeded"),
        "optimization missing": calling("resolve_optimization", ir, random_search, "x", mode="seeded"),
        "optimization incompatible": calling(
            "resolve_optimization", ir, random_search, {"type": "SINGLE", "scalarization": "pareto-front"}, mode="seeded"
        ),
        "tampered profile": calling("evaluate", tampered_profile(ir), binding),
        "broken schema": calling("evaluate", broken_schema(ir), binding),
        "not an ir": calling("evaluate", {}, binding),
        "reevaluate tampered": calling("reevaluate", tampered_profile(ir), {"termination": "UNKNOWN", "solutions": []}),
        "unknown schema": calling("schema", "Nope"),
        "validate-result invalid": calling("validate_result", {"termination": "FEASIBLE"}),
        "wrong shape": calling("reevaluate", ir, []),
    }


def test_failing_calls_fail_identically(ir, inprocess_bim, http_bim) -> None:
    errors = []
    for call in failing_calls(ir).values():
        result = both(inprocess_bim, http_bim, call)
        if result[0] == "error":
            errors.append(result[2])
    assert len(errors) >= 20
    assert {"compile_error", "package_error", "binding_invalid", "ir_schema", "request_invalid"} <= set(errors)
    assert {"contract_not_installed", "ir_malformed", "engine_mode_incompatible", "engine_contract_invalid"} <= set(errors)


def test_the_error_that_is_the_same_in_both_is_the_one_documented(ir, inprocess_bim, http_bim) -> None:
    calls = failing_calls(ir)
    expected = {
        "not a zip": ("PackageError", "package_error", None),
        "compile diagnostics": ("CompileError", "compile_error", None),
        "incomplete binding": ("EvaluationError", "binding_invalid", None),
        "neighborhood limit": ("EvaluationError", "neighborhood_limit", None),
        "unknown mode": ("ContractError", "engine_mode_incompatible", 422),
        "invalid manifest": ("ContractError", "engine_contract_invalid", 422),
        "tampered profile": ("ContractError", "contract_not_installed", None),
        "broken schema": ("ContractError", "ir_schema", None),
        "unknown schema": ("ContractError", "schema_not_found", 404),
        "wrong shape": ("ContractError", "request_invalid", 422),
    }
    for label, (name, code, status) in expected.items():
        result = both(inprocess_bim, http_bim, calls[label])
        assert (result[0], result[1], result[2], result[5]) == ("error", name, code, status), label
    # The findings that ir_schema carries are plain dictionaries in both, not CompileDiagnostic objects.
    for port in (inprocess_bim, http_bim):
        with pytest.raises(ContractError) as raised:
            port.evaluate(broken_schema(ir), fx.BINDING)
        assert raised.value.diagnostics and all(isinstance(item, dict) for item in raised.value.diagnostics)


def test_a_validation_that_finds_something_is_data_not_an_error(inprocess_bim, http_bim) -> None:
    findings = both(inprocess_bim, http_bim, calling("validate", fx.demo_zip(broken=True)))
    assert findings[0] == "ok" and findings[1]["valid"] is False
    assert findings[1]["diagnostics"] and "irDigest" not in findings[1]
    invalid = both(inprocess_bim, http_bim, calling("validate_result", {"termination": "FEASIBLE"}))
    assert invalid[0] == "ok" and invalid[1]["valid"] is False and invalid[1]["error"]["code"] == "solutions_missing"


# --- registered resources, descriptors, tenant ----------------------------------------------------------------------


def test_registered_resources_are_compiled_identically(inprocess_bim, http_bim) -> None:
    data, wire_resources = fx.registered_demo()
    resources = registered_specs(wire_resources)
    compiled = both(inprocess_bim, http_bim, calling("compile", data, resources))
    assert compiled[0] == "ok" and compiled[1]["ir"]["spec"]["instance"]["resources"]["cat-b"]["registered"]
    both(inprocess_bim, http_bim, calling("validate", data, resources))
    missing = both(inprocess_bim, http_bim, calling("compile", data))
    assert missing[0] == "error" and missing[2] == "compile_error"
    altered = [{**resources[0], "content": resources[0]["content"].replace(b"catalog-b", b"catalog-x")}]
    assert both(inprocess_bim, http_bim, calling("compile", data, altered))[0] == "error"


def test_descriptors_are_identical(inprocess_bim, http_bim) -> None:
    for name in ("profiles", "dialects", "protocol"):
        assert both(inprocess_bim, http_bim, calling(name))[0] == "ok"
    kinds = inprocess_bim.capabilities()["schemaKinds"]
    assert len(kinds) == 12
    for kind in kinds:
        assert both(inprocess_bim, http_bim, calling("schema", kind))[0] == "ok"


def test_capabilities_differ_only_in_what_a_service_adds(inprocess_bim, http_bim, service) -> None:
    local, remote = inprocess_bim.capabilities(), http_bim.capabilities()
    assert local["service"] is None and remote["service"]["name"] == "bim-service"
    assert local["limits"]["service"] is None
    assert remote["limits"]["service"] == service.state.settings.public_limits()
    assert local["limits"]["package"] == remote["limits"]["package"]
    assert {key: value for key, value in local.items() if key not in {"service", "limits"}} == {
        key: value for key, value in remote.items() if key not in {"service", "limits"}
    }


def test_the_tenant_changes_no_result(inprocess_bim, service, tokens_file) -> None:
    results = []
    for tenant in (None, "acme", "other"):
        client = TestClient(service, base_url=BASE_URL, raise_server_exceptions=False)
        with HttpBim(client=client, token_file=tokens_file, tenant=tenant) as bim:
            compiled = bim.compile(fx.demo_zip())
            results.append((compiled, bim.evaluate(compiled["ir"], fx.BINDING)))
    assert results[0] == results[1] == results[2]
    assert results[0][0] == inprocess_bim.compile(fx.demo_zip())


def test_a_wrong_token_is_a_service_error_not_a_bim_error(service) -> None:
    client = TestClient(service, base_url=BASE_URL, raise_server_exceptions=False)
    with HttpBim(client=client, token="x" * 40) as bim, pytest.raises(BimServiceError) as raised:
        bim.capabilities()
    assert (raised.value.code, raised.value.status) == ("unauthorized", 401)
