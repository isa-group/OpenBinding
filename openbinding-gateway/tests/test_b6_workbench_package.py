"""The package the Workbench writes is a package the real compiler accepts.

The frontend keeps the reference files in ``frontend/src/test/fixtures/bim-package``. A Vitest test
(``frontend/src/pages/Workbench/bimPackageContract.test.tsx``) generates the same files from the
Workbench's defaults and forms and compares them one by one, so these files always say what the
Workbench writes. Here they are compiled with the real compiler and through ``POST /v1/validate``:
the schemas have ``additionalProperties: false`` almost everywhere, so a key the Workbench invents
(``metrics`` for ``features``, ``metricBindings`` for ``featureBindings``, ``terms`` for ``criteria``)
is refused, and this is where that shows.
"""

from __future__ import annotations

import json

import pytest
from _repo import REPO_ROOT

from bim_core.compiler import (
    CompileError,
    compile_instance,
    installed_dialect_manifests,
    installed_profile_manifests,
    manifest_reference,
)
from bim_core.package import InstancePackage

FIXTURES = REPO_ROOT / "frontend" / "src" / "test" / "fixtures" / "bim-package"

# One file per resource, named as the Workbench names them (DEFAULT_FILES in bimDocuments.ts).
DEFAULT_PATHS = ("instance.json", "application.json", "candidates.json", "optimization.json", "workflow.bpmn")


def reference_files(variant: str | None = None) -> dict[str, bytes]:
    """The default package, with the files of a variant (a folder of the fixtures) laid over it."""
    assert FIXTURES.is_dir(), f"the Workbench reference package is missing: {FIXTURES}"
    files = {path: (FIXTURES / path).read_bytes() for path in DEFAULT_PATHS}
    if variant is not None:
        folder = FIXTURES / variant
        assert folder.is_dir(), f"the Workbench reference variant is missing: {folder}"
        files.update({item.name: item.read_bytes() for item in sorted(folder.iterdir()) if item.is_file()})
    return files


def with_document(files: dict[str, bytes], path: str, change) -> dict[str, bytes]:
    document = json.loads(files[path])
    change(document)
    return {**files, path: json.dumps(document).encode()}


def pinned(files: dict[str, bytes]) -> dict[str, bytes]:
    """The same package with the exact installed contracts pinned in its Instance."""
    profile = next(item for item in installed_profile_manifests() if item["metadata"]["name"] == "qos-binding")
    # The profile's roles name BPMN and Placement resource types, so every dialect it needs is pinned too.
    dialects = [item for item in installed_dialect_manifests() if item["metadata"]["namespace"] == "bim.builtin"]
    assert {item["metadata"]["name"] for item in dialects} == {"qos-binding", "bpmn-workflow", "qos-binding-placement"}

    def pin(root):
        root["spec"]["contracts"] = {
            "profile": manifest_reference(profile),
            "dialects": [manifest_reference(item) for item in dialects],
        }

    return with_document(files, "instance.json", pin)


def zip_of(files: dict[str, bytes]) -> bytes:
    return InstancePackage(files).to_zip()


VARIANTS = [None, "open-range", "with-rules"]


@pytest.mark.parametrize("variant", VARIANTS, ids=lambda value: value or "default")
def test_the_package_the_workbench_writes_compiles(variant):
    compiled = compile_instance(InstancePackage(reference_files(variant)))
    assert compiled.document["kind"] == "BindingProblem"
    assert compiled.digest


def test_the_default_package_has_the_five_files_of_the_workbench():
    assert sorted(path.name for path in FIXTURES.iterdir() if path.is_file()) == sorted(DEFAULT_PATHS)
    root = json.loads(reference_files()["instance.json"])
    assert root["spec"]["profile"] == "qos-binding/v1"
    assert root["spec"]["resources"] == {
        "application": {"application": "application.json", "workflow": "workflow.bpmn"},
        "candidateCatalog": {"catalog": "candidates.json"},
        "optimization": {"optimization": "optimization.json"},
    }


def test_the_open_range_variant_is_valid_language_and_keeps_the_open_end():
    # An engine that only takes single values refuses it later (`unsupported_capability_value`); this is the language.
    files = reference_files("open-range")
    candidates = json.loads(files["candidates.json"])["spec"]["candidates"]
    assert candidates["candidate2"]["features"]["latency"] == {"min": 100, "max": None}
    compiled = compile_instance(InstancePackage(files))
    assert '"max": null' in json.dumps(compiled.document, sort_keys=True)


def test_the_package_compiles_with_the_installed_contracts_pinned():
    for variant in VARIANTS:
        compiled = compile_instance(InstancePackage(pinned(reference_files(variant))))
        assert compiled.document["kind"] == "BindingProblem"



# -- The contract in the other direction: the vocabulary the Workbench used to write is refused -----------------


def old_application(document):
    document["spec"]["metrics"] = document["spec"].pop("features")


def old_catalog(document):
    document["spec"]["metricBindings"] = document["spec"].pop("featureBindings")
    for candidate in document["spec"]["candidates"].values():
        candidate["metrics"] = candidate.pop("features")


def old_optimization(document):
    spec = document["spec"]
    spec["type"] = "MONO"
    spec["mode"] = "weighted"
    spec["terms"] = [{"metric": criterion["feature"], "weight": 1} for criterion in spec.pop("criteria")]


OLD_VOCABULARY = [
    ("application.json", old_application, "metrics"),
    ("candidates.json", old_catalog, "metricBindings"),
    ("optimization.json", old_optimization, "terms"),
]


@pytest.mark.parametrize(("path", "change", "refused_key"), OLD_VOCABULARY, ids=[item[0] for item in OLD_VOCABULARY])
def test_the_older_vocabulary_is_not_a_valid_package(path, change, refused_key):
    files = with_document(reference_files(), path, change)
    with pytest.raises(CompileError) as refused:
        compile_instance(InstancePackage(files))
    assert refused.value.diagnostics
    assert refused_key in str(refused.value)


def test_a_package_made_only_of_the_older_vocabulary_is_not_valid():
    files = reference_files()
    for path, change, _key in OLD_VOCABULARY:
        files = with_document(files, path, change)
    with pytest.raises(CompileError):
        compile_instance(InstancePackage(files))


def test_the_placement_keys_of_the_older_vocabulary_are_not_valid():
    placement = {
        "apiVersion": "qos-binding-placement/v1",
        "kind": "Placement",
        "metadata": {"name": "hello-placement"},
        "spec": {
            "pools": {"edge": {"capacity": {"cpu": 4}}},
            "globalLatency": {
                "metric": {"resource": "application", "id": "latency"},
                "includeExecution": True,
                "exclusive": "routing",
                "parallel": "max",
            },
        },
    }
    files = reference_files()
    files["placement.json"] = json.dumps(placement).encode()
    files = with_document(files, "instance.json", lambda root: root["spec"]["resources"]["candidateCatalog"].update({"placement": "placement.json"}))
    with pytest.raises(CompileError) as refused:
        compile_instance(InstancePackage(files))
    assert "metric" in str(refused.value)


def test_the_reference_files_are_not_the_older_vocabulary():
    for variant in VARIANTS:
        text = b"".join(reference_files(variant).values()).decode()
        for key in ('"metricBindings"', '"metrics"', '"terms"', '"metric"'):
            assert key not in text, f"{key} in the reference package {variant or 'default'}"


# -- Through the endpoint --------------------------------------------------------------------------------------


async def account_headers(client, details):
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['access_token']}", "Content-Type": "application/vnd.bim+zip"}


@pytest.mark.parametrize(("variant", "candidates"), [(None, 1), ("open-range", 2), ("with-rules", 1)], ids=["default", "open-range", "with-rules"])
async def test_validate_accepts_the_package_the_workbench_writes(api_client, registration, variant, candidates):
    headers = await account_headers(api_client, registration())
    response = await api_client.post("/v1/validate", content=zip_of(reference_files(variant)), headers=headers)
    assert response.status_code == 200, response.text
    analysis = response.json()["analysis"]
    assert analysis["tasks"] == 1
    assert analysis["candidates"] == candidates
    assert analysis["constraints"] == (2 if variant == "with-rules" else 0)


async def test_validate_refuses_the_older_vocabulary_with_diagnostics(api_client, registration):
    headers = await account_headers(api_client, registration())
    files = with_document(reference_files(), "application.json", old_application)
    response = await api_client.post("/v1/validate", content=zip_of(files), headers=headers)
    assert response.status_code == 422, response.text
    body = response.json()
    assert body["diagnostics"]
    assert "metrics" in json.dumps(body["diagnostics"])
