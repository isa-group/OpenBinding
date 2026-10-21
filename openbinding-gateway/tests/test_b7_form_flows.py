"""A package built with nothing but the forms compiles, including the rules the compiler checks across documents.

``frontend/src/test/fixtures/bim-package/form-flow`` holds a complete package: an Application with two features in different units, a
catalog with a declared provider and two candidates, a ConstraintSet with a hard and a soft rule, and an Optimization with two normalized
criteria and the penalty of the soft rule. A Vitest test (``frontend/src/pages/Workbench/bimPackageContract.test.tsx``) generates those files by
driving the real Workbench forms and compares them one by one. Here they are compiled with the real compiler and through
``POST /v1/validate``, and the same package without each of the pieces the forms now create is refused with the diagnostic that names it, so
this file documents what each piece is for:

=========================  ==============================================================================================
``candidate_provider``     a candidate's ``provider`` is ``{resource: <the catalog>, id}`` and the catalog declares it in ``spec.providers``
``candidate_feature_ref``  a feature binding names a feature the Application declares
``inert_soft``             a rule that should hold is listed under ``penalties`` of the Optimization
``normalization_required`` criteria in different units each carry a ``normalize``
=========================  ==============================================================================================
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bim_core.compiler import (
    CompileError,
    compile_instance,
    installed_dialect_manifests,
    installed_profile_manifests,
    manifest_reference,
)
from bim_core.package import InstancePackage

FIXTURES = Path(__file__).resolve().parents[2] / "frontend" / "src" / "test" / "fixtures" / "bim-package"
FLOW = "form-flow"

# One file per resource, named as the Workbench names them; the flow adds the rules file.
DEFAULT_PATHS = ("instance.json", "application.json", "candidates.json", "optimization.json", "workflow.bpmn")


def flow_files() -> dict[str, bytes]:
    """The default package of the Workbench with the files of the form flow laid over it."""
    assert FIXTURES.is_dir(), f"the Workbench reference package is missing: {FIXTURES}"
    folder = FIXTURES / FLOW
    assert folder.is_dir(), f"the form flow reference is missing: {folder}"
    files = {path: (FIXTURES / path).read_bytes() for path in DEFAULT_PATHS}
    files.update({item.name: item.read_bytes() for item in sorted(folder.iterdir()) if item.is_file()})
    return files


def edited(path: str, change) -> dict[str, bytes]:
    files = flow_files()
    document = json.loads(files[path])
    change(document)
    return {**files, path: json.dumps(document).encode()}


def refused_codes(files: dict[str, bytes]) -> set[str]:
    with pytest.raises(CompileError) as refused:
        compile_instance(InstancePackage(files))
    return {diagnostic.code for diagnostic in refused.value.diagnostics}


# -- The valid flow -------------------------------------------------------------------------------------------


def test_the_flow_has_the_files_of_the_default_package_and_the_rules():
    assert sorted(path.name for path in (FIXTURES / FLOW).iterdir() if path.is_file()) == [
        "application.json", "candidates.json", "constraints.json", "instance.json", "optimization.json",
    ]
    root = json.loads(flow_files()["instance.json"])
    assert root["spec"]["resources"]["constraintSet"] == {"constraints": "constraints.json"}


def test_the_package_built_with_the_forms_compiles():
    compiled = compile_instance(InstancePackage(flow_files()))
    assert compiled.document["kind"] == "BindingProblem"
    assert compiled.digest
    spec = compiled.document["spec"]
    catalog = spec["candidates"]["catalog"]
    assert list(catalog["providers"]) == ["acme"]
    assert {item["provider"]["id"] for item in catalog["candidates"].values()} == {"acme"}
    assert [criterion["id"] for criterion in spec["optimization"]["criteria"]] == ["latency", "criterion2"]
    assert all("normalize" in criterion for criterion in spec["optimization"]["criteria"])
    assert [penalty["constraint"] for penalty in spec["optimization"]["penalties"]] == [{"resource": "constraints", "id": "constraint2"}]
    assert sorted(spec["eligibility"]["hello"], key=lambda ref: ref["id"]) == [
        {"resource": "catalog", "id": "candidate2"}, {"resource": "catalog", "id": "service-a"},
    ]


def test_the_package_built_with_the_forms_compiles_with_the_installed_contracts_pinned():
    profile = next(item for item in installed_profile_manifests() if item["metadata"]["name"] == "qos-binding")
    dialects = [item for item in installed_dialect_manifests() if item["metadata"]["namespace"] == "bim.builtin"]
    files = flow_files()
    root = json.loads(files["instance.json"])
    root["spec"]["contracts"] = {"profile": manifest_reference(profile), "dialects": [manifest_reference(item) for item in dialects]}
    compiled = compile_instance(InstancePackage({**files, "instance.json": json.dumps(root).encode()}))
    assert compiled.document["kind"] == "BindingProblem"


# -- The same package without each piece the forms create ----------------------------------------------------------


def no_providers(document):
    del document["spec"]["providers"]


def provider_of_another_catalog(document):
    for candidate in document["spec"]["candidates"].values():
        candidate["provider"]["resource"] = "somewhere-else"


def no_penalties(document):
    del document["spec"]["penalties"]


def one_criterion_without_scale(document):
    del document["spec"]["criteria"][1]["normalize"]


def no_scales(document):
    for criterion in document["spec"]["criteria"]:
        del criterion["normalize"]


def binding_to_a_missing_feature(document):
    document["spec"]["featureBindings"]["cost"]["id"] = "not-declared"


def criterion_on_a_missing_feature(document):
    document["spec"]["criteria"][1]["feature"]["id"] = "not-declared"


def penalty_for_a_hard_rule(document):
    document["spec"]["penalties"].append({"constraint": {"resource": "constraints", "id": "constraint1"}, "weight": 1})


def candidate_without_the_cost(document):
    del document["spec"]["candidates"]["candidate2"]["features"]["cost"]


# (file, change, the diagnostic that names it, whether it is the only one the change causes)
WITHOUT_THE_PIECE = [
    ("candidates.json", no_providers, "candidate_provider", True),
    ("candidates.json", provider_of_another_catalog, "candidate_provider", True),
    ("optimization.json", no_penalties, "inert_soft", True),
    ("optimization.json", one_criterion_without_scale, "normalization_required", True),
    ("optimization.json", no_scales, "normalization_required", True),
    ("candidates.json", binding_to_a_missing_feature, "candidate_feature_ref", False),
    ("optimization.json", criterion_on_a_missing_feature, "optimization_feature", False),
    ("optimization.json", penalty_for_a_hard_rule, "optimization_penalty_ref", True),
    ("candidates.json", candidate_without_the_cost, "missing_feature", True),
]
IDS = [f"{case[1].__name__}-{case[2]}" for case in WITHOUT_THE_PIECE]


@pytest.mark.parametrize(("path", "change", "code", "alone"), WITHOUT_THE_PIECE, ids=IDS)
def test_the_package_without_the_piece_is_refused_with_the_diagnostic_that_names_it(path, change, code, alone):
    codes = refused_codes(edited(path, change))
    assert code in codes
    if alone:
        assert codes == {code}


# -- Through the endpoint -------------------------------------------------------------------------------------


async def account_headers(client, details):
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['access_token']}", "Content-Type": "application/vnd.bim+zip"}


async def test_validate_accepts_the_package_built_with_the_forms(api_client, registration):
    headers = await account_headers(api_client, registration())
    response = await api_client.post("/v1/validate", content=InstancePackage(flow_files()).to_zip(), headers=headers)
    assert response.status_code == 200, response.text
    analysis = response.json()["analysis"]
    assert analysis["tasks"] == 1
    assert analysis["candidates"] == 2
    assert analysis["constraints"] == 2


async def test_validate_names_the_missing_piece_of_each_package_without_one(api_client, registration):
    headers = await account_headers(api_client, registration())
    for path, change, code, _alone in WITHOUT_THE_PIECE:
        response = await api_client.post("/v1/validate", content=InstancePackage(edited(path, change)).to_zip(), headers=headers)
        assert response.status_code == 422, f"{change.__name__}: {response.text}"
        assert code in {diagnostic["code"] for diagnostic in response.json()["diagnostics"]}, change.__name__
