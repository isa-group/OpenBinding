"""Public API, public replacements of former private names, and IR integrity checks."""

import copy
import json

import pytest

import bim_core
from bim_core import (
    BindingProblem,
    ContractError,
    compilation_digest,
    compile_instance,
    digest,
    ir_digest,
    toolchain_identity,
)
from bim_core import compiler

from _minimal import package_with_bpmn

REQUIRED_NAMES = {
    "load_package", "InstancePackage", "compile_instance", "BindingProblem", "canonical_json", "digest",
    "BimError", "PackageError", "CompileError", "EvaluationError", "ProtocolError", "ContractError",
    "Limits", "configure", "toolchain_identity",
    "schema_root", "dialect_type_matches", "dialect_xml_type_matches", "resource_schema_diagnostics",
    "dialect_descriptor", "profile_descriptor",
}
FORMER_PRIVATE_NAMES = (
    "_schema_root", "_dialect_type_matches", "_dialect_xml_type_matches",
    "_resource_schema_diagnostics", "_dialect_descriptor", "_profile_descriptor",
)


@pytest.fixture(scope="module")
def problem() -> BindingProblem:
    return compile_instance(package_with_bpmn())


def test_all_lists_the_required_names_and_each_resolves() -> None:
    assert REQUIRED_NAMES <= set(bim_core.__all__)
    assert len(bim_core.__all__) == len(set(bim_core.__all__))
    for name in bim_core.__all__:
        assert hasattr(bim_core, name), name


def test_former_private_names_are_public_without_underscore() -> None:
    for name in FORMER_PRIVATE_NAMES:
        assert not hasattr(compiler, name), name
        assert callable(getattr(compiler, name.lstrip("_"))), name
        assert getattr(bim_core, name.lstrip("_")) is getattr(compiler, name.lstrip("_")), name


def test_schema_root_lists_every_bim_schema_through_importlib_resources() -> None:
    names = {item.name for item in bim_core.schema_root().iterdir()}
    assert {
        "application.schema.json", "binding-problem.schema.json", "candidate-catalog.schema.json",
        "constraint-set.schema.json", "dialect.schema.json", "engine-registration.schema.json",
        "engine.schema.json", "instance.schema.json", "optimization.schema.json",
        "placement.schema.json", "profile.schema.json", "routing-overlay.schema.json",
    } <= names
    schema = json.loads(bim_core.schema_root().joinpath("binding-problem.schema.json").read_text("utf-8"))
    assert schema["type"] == "object"


def test_type_matching_helpers_resolve_the_installed_dialects() -> None:
    dialects = compiler.installed_dialect_manifests()
    matches = bim_core.dialect_type_matches(dialects, "qos-binding/v1", "Application", "application/json")
    assert [compiler.manifest_id(dialect) for dialect, _ in matches] == ["qos-binding/v1"]
    xml = bim_core.dialect_xml_type_matches(
        dialects, "http://www.omg.org/spec/BPMN/20100524/MODEL", "definitions"
    )
    assert [compiler.manifest_id(dialect) for dialect, _ in xml] == ["bpmn-workflow/v1"]
    assert bim_core.dialect_type_matches(dialects, "qos-binding/v1", "Nope", "application/json") == []


def test_resource_schema_diagnostics_reports_schema_violations() -> None:
    findings = bim_core.resource_schema_diagnostics(
        {"apiVersion": "qos-binding/v1"}, "qos-binding/v1", "Application", "application/json", "app.json"
    )
    assert findings and {item.code for item in findings} == {"schema"}
    unknown = bim_core.resource_schema_diagnostics({}, "x/v1", "Nope", "application/json", "x.json")
    assert [item.code for item in unknown] == ["schema_unavailable"]


def test_descriptors_pin_the_installed_manifests() -> None:
    profile = compiler.installed_profile_manifests()[0]
    descriptor = bim_core.profile_descriptor(profile)
    assert descriptor["id"] == "qos-binding/v1"
    assert descriptor["digest"] == digest(profile)
    assert descriptor["adapter"]["digest"] == bim_core.compiler_bundle_digest()
    for dialect in compiler.installed_dialect_manifests():
        pinned = bim_core.dialect_descriptor(dialect)
        assert pinned["digest"] == digest(dialect)
        assert pinned["adapter"]["digest"] == bim_core.compiler_bundle_digest()


def test_toolchain_identity_is_json_and_pins_the_bundle_digest() -> None:
    identity = toolchain_identity()
    assert json.loads(json.dumps(identity)) == identity
    assert identity["name"] == "bim-core"
    assert identity["version"] == bim_core.__version__
    assert identity["compilerDigest"] == bim_core.compiler_bundle_digest()
    assert [item["name"] for item in identity["profiles"]] == ["qos-binding"]
    assert {item["name"] for item in identity["dialects"]} == {
        "qos-binding", "bpmn-workflow", "qos-binding-placement",
    }
    assert all(item["digest"].startswith("sha256-") for item in identity["profiles"] + identity["dialects"])


# --- IR integrity ----------------------------------------------------------------------------


def test_ir_digest_is_the_digest_of_the_compiled_problem(problem) -> None:
    assert ir_digest(problem.document) == problem.digest


def test_from_document_rehydrates_the_problem(problem) -> None:
    rebuilt = BindingProblem.from_document(problem.document, expected_digest=problem.digest)
    assert rebuilt.digest == problem.digest
    assert rebuilt.document == problem.document
    assert rebuilt.source_map == problem.source_map
    assert rebuilt.document is not problem.document
    assert rebuilt.binding_space_cardinality == problem.binding_space_cardinality


def test_from_document_detects_a_changed_semantic_digest(problem) -> None:
    tampered = copy.deepcopy(problem.document)
    tampered["spec"]["application"]["requiredFeatures"] = ["not-in-the-original"]
    with pytest.raises(ContractError) as caught:
        BindingProblem.from_document(tampered, expected_digest=problem.digest)
    assert caught.value.code == "ir_digest_mismatch"
    assert str(caught.value) == "Stored IR does not match its semantic digest"
    # Without an expected digest the new document defines its own digest.
    assert BindingProblem.from_document(tampered, verify=False).digest != problem.digest


def test_from_document_ignores_provenance_for_the_digest(problem) -> None:
    other = copy.deepcopy(problem.document)
    other["metadata"]["name"] = "renamed"
    assert BindingProblem.from_document(other, expected_digest=problem.digest).digest == problem.digest


def test_from_document_rejects_unsupported_malformed_and_invalid_documents(problem) -> None:
    other_kind = copy.deepcopy(problem.document)
    other_kind["kind"] = "SomethingElse"
    with pytest.raises(ContractError) as caught:
        BindingProblem.from_document(other_kind)
    assert caught.value.code == "ir_not_supported"

    for bad in ({}, [], {"spec": []}):
        with pytest.raises(ContractError) as caught:
            BindingProblem.from_document(bad, verify=False)
        assert caught.value.code == "ir_malformed"

    invalid = copy.deepcopy(problem.document)
    del invalid["metadata"]
    with pytest.raises(ContractError) as caught:
        BindingProblem.from_document(invalid)
    assert caught.value.code == "ir_schema"
    assert caught.value.diagnostics
    assert BindingProblem.from_document(invalid, verify=False).digest == problem.digest


def test_from_document_requires_the_exact_installed_contracts(problem) -> None:
    other_profile = copy.deepcopy(problem.document)
    other_profile["spec"]["profile"]["digest"] = "sha256-" + "0" * 64
    with pytest.raises(ContractError, match="Profile is not installed") as caught:
        BindingProblem.from_document(other_profile)
    assert caught.value.code == "contract_not_installed"
    # spec.profile pins the toolchain and therefore belongs to the semantic digest.
    assert BindingProblem.from_document(other_profile, verify=False).digest != problem.digest

    other_dialect = copy.deepcopy(problem.document)
    other_dialect["spec"]["dialects"][0]["digest"] = "sha256-" + "0" * 64
    with pytest.raises(ContractError, match="Dialect is not installed") as caught:
        BindingProblem.from_document(other_dialect)
    assert caught.value.code == "contract_not_installed"


def test_ir_digest_matches_the_platform_snapshot_recomputation(problem) -> None:
    # Verbatim recomputation of services/snapshots.py snapshot_problem(): the digest stored by
    # the platform for a real compilation must equal what from_document verifies.
    semantic = json.loads(json.dumps(problem.document))
    semantic.pop("metadata", None)
    for key in ("instance", "dialects", "sourceMap"):
        semantic.get("spec", {}).pop(key, None)
    assert digest(semantic) == problem.digest
    assert BindingProblem.from_document(problem.document, expected_digest=digest(semantic)).digest == digest(semantic)


def test_compilation_digest_follows_the_platform_formula(problem) -> None:
    package = package_with_bpmn()
    expected = digest({
        "packageDigest": package.package_digest,
        "profile": problem.document["spec"]["profile"],
        "dialects": problem.document["spec"]["dialects"],
        "compilerDigest": bim_core.compiler_bundle_digest(),
    })
    assert compilation_digest(package.package_digest, problem) == expected
    assert compilation_digest(package.package_digest, problem.document) == expected
    assert compilation_digest("sha256-" + "1" * 64, problem) != expected
    assert compilation_digest(package.package_digest, problem, compiler_digest="sha256-" + "2" * 64) != expected
