"""Migrated from openbinding-gateway/tests/test_v1_language.py: package digests, expressions, routing.

The two tests that exercised ``POST /v1/jobs`` through the platform's ``TestClient`` are not part of
the language and stay in OpenBinding (see docs/EXTRACTION_LOG.md).  The demo package comes from the
OpenBinding corpus (``BIM_CORPUS_ROOT``); the tests skip with a warning when it is absent.
"""

import io
import json
import zipfile

import pytest

from bim_core import (
    CompileError,
    ExpressionError,
    InstancePackage,
    PackageError,
    compile_instance,
    load_package,
)
from bim_core.compiler import instance_digest
from bim_core.expressions import compile_expression
from core_support import require_corpus_path


@pytest.fixture(scope="module")
def example():
    return require_corpus_path("examples/demo/01_simple_seq")


def _copy_package(example) -> InstancePackage:
    return InstancePackage(dict(load_package(example).files))


def _json_file(package: InstancePackage, path: str) -> dict:
    return json.loads(package.files[path])


def _put_json(package: InstancePackage, path: str, value: dict) -> None:
    package.files[path] = json.dumps(value, allow_nan=False).encode()


def test_directory_and_portable_package_have_identical_digests(example) -> None:
    directory = load_package(example)
    portable = load_package(directory.to_zip())
    assert directory.package_digest == portable.package_digest
    assert directory.resource_digests == portable.resource_digests
    assert instance_digest(directory.instance(), directory.resource_digests) == instance_digest(
        portable.instance(), portable.resource_digests
    )
    assert compile_instance(directory).digest == compile_instance(portable).digest
    assert directory.to_zip() == directory.to_zip()


def test_restricted_expression_rejects_calls_and_io() -> None:
    assert compile_expression(
        "metrics.latency <= 50",
        allowed_roots={"metrics": "closed-object"},
        path_types={"metrics.latency": "number"},
        expected_type="bool",
    ).evaluate({"metrics": {"latency": 20}})
    with pytest.raises(ExpressionError):
        compile_expression("__import__('os').system('id')")


def test_restricted_expression_is_bounded_and_has_no_macros_or_reflection() -> None:
    with pytest.raises(ExpressionError, match="maximum length"):
        compile_expression("true || " + "false || " * 1000 + "true", expected_type="bool")
    with pytest.raises(ExpressionError, match="unsupported construct"):
        compile_expression("[x for x in values]")
    with pytest.raises(ExpressionError, match="path is not declared"):
        compile_expression("metrics.__class__", allowed_roots={"metrics": "closed-object"})
    deeply_nested = {"op": "not", "value": True}
    for _ in range(40):
        deeply_nested = {"op": "not", "value": deeply_nested}
    with pytest.raises(ExpressionError, match="maximum nesting depth"):
        compile_expression(deeply_nested, expected_type="bool")


def test_cel_syntax_errors_map_back_to_exact_authored_ranges() -> None:
    source = "  true && && false  "
    with pytest.raises(ExpressionError, match="invalid CEL expression") as captured:
        compile_expression(source, expected_type="bool")
    operator_start = source.rindex("&&")
    assert captured.value.span == {"start": operator_start, "end": operator_start + 2}
    assert source[captured.value.span["start"] : captured.value.span["end"]] == "&&"

    unterminated = "metrics.latency == 'oops"
    with pytest.raises(ExpressionError, match="unterminated string") as captured:
        compile_expression(unterminated)
    quote_start = unterminated.index("'")
    assert captured.value.span == {"start": quote_start, "end": len(unterminated)}


def test_cel_semantic_errors_point_to_the_offending_node() -> None:
    roots = {"metrics": "object"}
    paths = {"metrics.latency": "number"}
    source = "  metrics.latency + 'slow' <= 50  "
    with pytest.raises(ExpressionError, match="must be number") as captured:
        compile_expression(source, allowed_roots=roots, path_types=paths, expected_type="bool")
    literal_start = source.index("'slow'")
    assert captured.value.span == {"start": literal_start, "end": literal_start + len("'slow'")}

    unknown_path = "metrics.latency <= secrets.limit"
    with pytest.raises(ExpressionError, match="root is not allowed") as captured:
        compile_expression(unknown_path, allowed_roots=roots, path_types=paths, expected_type="bool")
    path_start = unknown_path.index("secrets.limit")
    assert captured.value.span == {"start": path_start, "end": len(unknown_path)}


def test_workflow_catalog_and_optimization_references_are_explicit(example) -> None:
    problem = compile_instance(load_package(example)).as_dict()
    first = problem["spec"]["application"]["workflow"]["steps"][0]["task"]
    criterion = problem["spec"]["optimization"]["criteria"][0]
    binding = problem["spec"]["candidates"]["catalog"]["featureBindings"]["latency"]
    assert first == {"resource": "application", "id": "t1"}
    assert criterion["feature"] == {"resource": "application", "id": "latency"}
    assert binding == {"resource": "application", "id": "latency"}


def test_unknown_workflow_properties_are_rejected(example) -> None:
    package = _copy_package(example)
    application = _json_file(package, "application.json")
    application["spec"]["workflow"]["unexpected"] = True
    _put_json(package, "application.json", application)
    with pytest.raises(CompileError, match="Additional properties"):
        compile_instance(package)


def _xor_package(example, *, uniform: bool) -> InstancePackage:
    package = _copy_package(example)
    instance = _json_file(package, "instance.json")
    instance["spec"]["resources"]["candidateCatalog"]["routing"] = "routing.json"
    application = _json_file(package, "application.json")
    application["spec"]["workflow"] = {
        "exclusive": [
            {"id": "left", "flow": {"task": {"resource": "application", "id": "t1"}}},
            {
                "id": "right",
                "flow": {
                    "sequence": [
                        {"task": {"resource": "application", "id": "t2"}},
                        {"task": {"resource": "application", "id": "t3"}},
                    ]
                },
            },
        ]
    }
    routing = {
        "apiVersion": "qos-binding/v1",
        "kind": "RoutingOverlay",
        "metadata": {"name": "routing"},
        "spec": {"uniform": True} if uniform else {"entries": []},
    }
    _put_json(package, "instance.json", instance)
    _put_json(package, "application.json", application)
    _put_json(package, "routing.json", routing)
    return package


def test_uniform_routing_is_materialized_only_by_explicit_opt_in(example) -> None:
    problem = compile_instance(_xor_package(example, uniform=True))
    assert problem.as_dict()["spec"]["routing"] == [
        {"target": {"resource": "application", "id": "left"}, "probability": 0.5},
        {"target": {"resource": "application", "id": "right"}, "probability": 0.5},
    ]


def test_empty_or_absent_xor_routing_never_implies_uniform(example) -> None:
    with pytest.raises(CompileError):
        compile_instance(_xor_package(example, uniform=False))

    package = _xor_package(example, uniform=True)
    instance = _json_file(package, "instance.json")
    instance["spec"]["resources"]["candidateCatalog"].pop("routing")
    package.files.pop("routing.json")
    _put_json(package, "instance.json", instance)
    with pytest.raises(CompileError, match="fully probabilistic"):
        compile_instance(package)


@pytest.mark.parametrize(
    ("entries", "code"),
    [
        (
            [{"target": {"resource": "application", "id": "left"}, "probability": 1}],
            "routing_partial",
        ),
        (
            [
                {"target": {"resource": "application", "id": "left"}, "probability": 0.4},
                {"target": {"resource": "application", "id": "right"}, "probability": 0.5},
            ],
            "routing_sum",
        ),
    ],
)
def test_xor_routing_rejects_partial_or_non_unit_probabilities(example, entries, code) -> None:
    package = _xor_package(example, uniform=True)
    routing = _json_file(package, "routing.json")
    routing["spec"] = {"entries": entries}
    _put_json(package, "routing.json", routing)

    with pytest.raises(CompileError) as captured:
        compile_instance(package)

    assert code in {item.code for item in captured.value.diagnostics}


def test_zip_rejects_traversal() -> None:
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr("../instance.json", "{}")
    with pytest.raises(PackageError):
        load_package(data.getvalue())
