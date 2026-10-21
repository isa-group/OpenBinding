"""``tools/toolchain_json.py`` writes one deterministic document that agrees with the installed code."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

import bim_core
import toolchain_json
from bim_core.assets import schema_root
from packaging_support import PACKAGES, ROOT, source_version


@pytest.fixture(scope="module")
def document() -> dict:
    return toolchain_json.build()


def test_the_document_is_deterministic() -> None:
    assert toolchain_json.render(toolchain_json.build()) == toolchain_json.render(toolchain_json.build())


def test_versions_and_digests_are_the_installed_ones(document: dict) -> None:
    assert document["schema"] == "bim-toolchain/toolchain/1"
    assert document["packages"] == {name: source_version(name) for name in PACKAGES}
    assert document["compilerDigest"] == bim_core.compiler_bundle_digest()
    assert document["protocolDigest"] == bim_core.protocol_digest()
    assert document["apiVersion"] == bim_core.toolchain_identity()["apiVersion"]
    assert document["profiles"] == bim_core.toolchain_identity()["profiles"]
    assert document["dialects"] == bim_core.toolchain_identity()["dialects"]


def test_every_schema_and_vendored_file_has_its_digest(document: dict) -> None:
    on_disk = {
        child.name: bim_core.digest_bytes(child.read_bytes())
        for child in schema_root().iterdir()
        if child.name.endswith(".schema.json")
    }
    assert len(on_disk) == 12
    assert document["schemas"] == dict(sorted(on_disk.items()))
    vendor = document["vendor"]["omg/bpmn/2.0.2"]
    assert sorted(vendor) == ["BPMN20.xsd", "BPMNDI.xsd", "DC.xsd", "DI.xsd", "README.md", "Semantic.xsd"]
    assert all(re.fullmatch(r"sha256-[0-9a-f]{64}", value) for value in vendor.values())


def test_the_runtime_versions_are_recorded(document: dict) -> None:
    runtime = document["runtime"]
    assert set(runtime) == {"python", "implementation", "lxml", "libxml2", "jsonschema", "pyyaml"}
    assert re.fullmatch(r"3\.\d+\.\d+.*", runtime["python"])
    assert re.fullmatch(r"\d+(\.\d+)+", runtime["lxml"])
    assert all(isinstance(value, str) and value for value in runtime.values())


def test_the_document_has_no_path_host_or_time(document: dict) -> None:
    text = toolchain_json.render(document).decode("utf-8")
    assert str(ROOT) not in text and "/workspace" not in text and "/home/" not in text
    assert not re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:", text)
    assert json.loads(text) == document


def test_the_digests_have_the_sha256_form(document: dict) -> None:
    for value in (document["compilerDigest"], document["protocolDigest"], document["engineContractDigest"]):
        assert re.fullmatch(r"sha256-[0-9a-f]{64}", value)


def test_output_then_check_round_trip(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    target = tmp_path / "out" / "toolchain.json"
    assert toolchain_json.main(["--output", str(target)]) == 0
    assert target.read_bytes() == toolchain_json.render(toolchain_json.build())
    assert target.read_bytes().endswith(b"\n")
    assert toolchain_json.main(["--check", str(target)]) == 0
    target.write_bytes(target.read_bytes().replace(b"bim-core", b"bim-corf", 1))
    assert toolchain_json.main(["--check", str(target)]) == 1
    assert "is not what this installation produces" in capsys.readouterr().out
    assert toolchain_json.main(["--check", str(tmp_path / "missing.json")]) == 1


def test_standard_output_is_the_default(capsys: pytest.CaptureFixture[str]) -> None:
    assert toolchain_json.main([]) == 0
    assert capsys.readouterr().out.encode("utf-8") == toolchain_json.render(toolchain_json.build())
