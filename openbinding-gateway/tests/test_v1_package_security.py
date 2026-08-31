import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest

from openbinding_gateway.v1 import package as package_module
from openbinding_gateway.routes.v1 import _multipart_zip
from openbinding_gateway.v1.compiler import CompileError, compile_instance
from openbinding_gateway.v1.package import InstancePackage, PackageError, load_package, strict_json_loads


ROOT = {
    "apiVersion": "bim/v1",
    "kind": "Instance",
    "metadata": {"name": "test"},
    "spec": {"profile": "qos-binding/v1", "resources": {}},
}

BPMN = b'''<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             targetNamespace="https://example.test/bpmn">
  <process id="p1" isExecutable="true">
    <startEvent id="start"><outgoing>f1</outgoing></startEvent>
    <serviceTask id="task"><incoming>f1</incoming><outgoing>f2</outgoing></serviceTask>
    <endEvent id="end"><incoming>f2</incoming></endEvent>
    <sequenceFlow id="f1" sourceRef="start" targetRef="task"/>
    <sequenceFlow id="f2" sourceRef="task" targetRef="end"/>
  </process>
</definitions>'''


def _zip(files: dict[str, bytes], *, compression: int = zipfile.ZIP_STORED) -> bytes:
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=compression) as archive:
        for name, value in files.items():
            archive.writestr(name, value)
    return result.getvalue()


def _package_with_bpmn(xml: bytes) -> InstancePackage:
    application = {
        "apiVersion": "qos-binding/v1",
        "kind": "Application",
        "metadata": {"name": "application"},
        "spec": {
            "tasks": {"task": "service/test"},
            "metrics": {},
            "workflow": {"bpmn": {"resource": "workflow", "id": "p1"}},
        },
    }
    candidates = {
        "apiVersion": "qos-binding/v1",
        "kind": "CandidateCatalog",
        "metadata": {"name": "catalog"},
        "spec": {
            "metricBindings": {},
            "candidates": {
                "candidate": {"provides": "service/test", "metrics": {}}
            }
        },
    }
    optimization = {
        "apiVersion": "qos-binding/v1",
        "kind": "Optimization",
        "metadata": {"name": "optimization"},
        "spec": {"mode": "satisfy"},
    }
    root = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": "bpmn-conformance"},
        "spec": {
            "profile": "qos-binding/v1",
            "resources": {
                "application": {
                    "application": "application.json",
                    "workflow": "workflow.bpmn",
                },
                "candidateCatalog": {"catalog": "candidates.json"},
                "optimization": {"optimization": "optimization.json"},
            }
        },
    }
    return InstancePackage(
        {
            "instance.json": json.dumps(root).encode(),
            "application.json": json.dumps(application).encode(),
            "candidates.json": json.dumps(candidates).encode(),
            "optimization.json": json.dumps(optimization).encode(),
            "workflow.bpmn": xml,
        }
    )


def test_all_input_forms_reject_duplicate_json_names() -> None:
    duplicate = b'{"apiVersion":"bim/v1","kind":"Instance","kind":"Application"}'
    with pytest.raises(PackageError, match="duplicate JSON object member"):
        strict_json_loads(duplicate)
    package = load_package(_zip({"instance.json": duplicate}))
    with pytest.raises(PackageError):
        package.to_zip()


def test_direct_and_directory_inputs_enforce_the_entry_limit(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(package_module, "MAX_ENTRIES", 1)
    with pytest.raises(PackageError, match="more than 1 entries"):
        InstancePackage({"instance.json": json.dumps(ROOT).encode(), "extra.json": b"{}"})
    (tmp_path / "instance.json").write_text(json.dumps(ROOT), encoding="utf-8")
    (tmp_path / "extra.json").write_text("{}", encoding="utf-8")
    with pytest.raises(PackageError, match="more than 1 entries"):
        load_package(tmp_path)


def test_directory_input_rejects_symlinks(tmp_path) -> None:
    (tmp_path / "instance.json").write_text(json.dumps(ROOT), encoding="utf-8")
    (tmp_path / "target.json").write_text("{}", encoding="utf-8")
    (tmp_path / "alias.json").symlink_to(tmp_path / "target.json")
    with pytest.raises(PackageError, match="symlink"):
        load_package(tmp_path)


def test_standalone_json_is_not_a_v1_package(tmp_path) -> None:
    path = tmp_path / "instance.json"
    path.write_text(json.dumps(ROOT), encoding="utf-8")
    with pytest.raises(PackageError, match="standalone JSON"):
        load_package(path)


def test_xml_security_scan_covers_the_entire_document() -> None:
    xml = b"<root>" + b" " * 20_000 + b'<!DOCTYPE bad [<!ENTITY xxe SYSTEM "file:///etc/passwd">]></root>'
    package = InstancePackage({"instance.json": json.dumps(ROOT).encode(), "workflow.bpmn": xml})
    with pytest.raises(PackageError, match="forbidden external construct"):
        package.xml("workflow.bpmn")


def test_bpmn_is_validated_against_the_official_offline_omg_schema() -> None:
    package = InstancePackage({"instance.json": json.dumps(ROOT).encode(), "workflow.bpmn": BPMN})
    assert package.xml("workflow.bpmn").tag == "{http://www.omg.org/spec/BPMN/20100524/MODEL}definitions"

    invalid = BPMN.replace(b'targetNamespace="https://example.test/bpmn"', b"")
    package = InstancePackage({"instance.json": json.dumps(ROOT).encode(), "workflow.bpmn": invalid})
    with pytest.raises(PackageError, match=r"OMG BPMN 2\.0\.2 at line \d+, column \d+"):
        package.xml("workflow.bpmn")


def test_compiler_only_receives_xsd_conformant_bpmn() -> None:
    problem = compile_instance(_package_with_bpmn(BPMN))
    assert problem.document["spec"]["application"]["workflow"]["kind"] == "task"

    invalid = BPMN.replace(b'targetNamespace="https://example.test/bpmn"', b"")
    with pytest.raises(CompileError, match=r"OMG BPMN 2\.0\.2 at line"):
        compile_instance(_package_with_bpmn(invalid))


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("BPMN20.xsd", "a07c159cb0594573dd7c97b1370dd116112378f377e43c89a8bf512ac5030705"),
        ("Semantic.xsd", "c4318842f7d2bbc262d7954c9452c501db16f0868eac0b8732ec5d7fb384d9a7"),
        ("BPMNDI.xsd", "f0dff1cd559d1514d8ebfc8c646f58402bcaced27ec22e2aa6456c2dcc80b038"),
        ("DC.xsd", "a2f90e5ad9bb48c6915e4e034b4e27ac838264a1d4f27bfc70dbdfc69351312d"),
        ("DI.xsd", "8220b179c175572df74e08a51bffabe957867962035cee7b5fee0b6acb4c4498"),
    ],
)
def test_vendored_omg_bpmn_schema_matches_the_normative_download(filename: str, expected: str) -> None:
    bundle = Path(package_module.__file__).parent / "vendor/omg/bpmn/2.0.2"
    assert hashlib.sha256((bundle / filename).read_bytes()).hexdigest() == expected


def test_export_is_canonical_across_split_json_whitespace_and_key_order() -> None:
    first = InstancePackage(
        {
            "instance.json": json.dumps(ROOT, indent=2).encode(),
            "resource.json": b'{"z":1,"a":{"b":2,"a":1}}',
        }
    )
    second = InstancePackage(
        {
            "resource.json": b'{ "a" : { "a" : 1, "b" : 2 }, "z" : 1 }',
            "instance.json": json.dumps(ROOT, separators=(",", ":")).encode(),
        }
    )
    assert first.to_zip() == second.to_zip()
    assert first.package_digest == second.package_digest
    assert load_package(first.to_zip()).resource_digests == load_package(second.to_zip()).resource_digests


def test_export_orders_non_ascii_posix_paths_by_utf8_bytes() -> None:
    package = InstancePackage(
        {
            "instance.json": json.dumps(ROOT).encode(),
            "zeta.json": b"{}",
            "árbol.json": b"{}",
            "Ωmega.json": b"{}",
        }
    )
    with zipfile.ZipFile(io.BytesIO(package.to_zip())) as archive:
        names = archive.namelist()
    assert names == sorted(names, key=lambda value: value.encode("utf-8"))


def test_resource_digests_use_the_same_json_and_xml_normalization_as_export() -> None:
    package = InstancePackage(
        {
            "instance.json": json.dumps(ROOT, indent=2).encode(),
            "resource.json": b'{ "z": 1, "a": 2 }\n',
            "workflow.bpmn": b"<definitions>\r\n  <process/>\r\n</definitions>\r\n",
        }
    )
    portable = load_package(package.to_zip())
    assert package.resource_digests == portable.resource_digests


def test_inline_resource_documents_are_preserved_but_never_materialized() -> None:
    inline = {
        **ROOT,
        "spec": {
            "resources": {
                "application": {
                    "application": {
                        "document": {"apiVersion": "qos-binding/v1", "kind": "Application", "metadata": {"name": "app"}, "spec": {}}
                    }
                },
                "candidateCatalog": {"catalog": "catalog.json"},
                "optimization": {"optimization": "optimization.json"},
            }
        },
    }
    package = InstancePackage({"instance.json": json.dumps(inline).encode()})
    assert package.instance()["spec"]["resources"]["application"]["application"]["document"]["kind"] == "Application"
    assert "application.json" not in package.files
    portable = load_package(package.to_zip())
    assert portable.instance() == inline
    assert "application.json" not in portable.files
    with pytest.raises(CompileError):
        compile_instance(package)


def test_zip_rejects_casefold_collisions() -> None:
    data = _zip({"instance.json": json.dumps(ROOT).encode(), "A.json": b"{}", "a.json": b"{}"})
    with pytest.raises(PackageError, match="duplicate package path"):
        load_package(data)


@pytest.mark.parametrize(
    "name",
    [
        "/instance.json",
        "C:/instance.json",
        r"C:\instance.json",
        "../instance.json",
        "folder/../instance.json",
        "folder//instance.json",
        "~/instance.json",
        "instance\x00.json",
    ],
)
def test_zip_rejects_every_non_portable_path_shape(name: str) -> None:
    # Python's ZIP writer truncates a NUL-bearing name before serializing it;
    # that still fails closed because the required root is then absent.
    with pytest.raises(PackageError, match="path|component|NUL|contain instance"):
        load_package(_zip({name: b"{}"}))


def test_virtual_filesystem_rejects_nul_without_zip_writer_normalization() -> None:
    with pytest.raises(PackageError, match="NUL"):
        InstancePackage({"instance.json": json.dumps(ROOT).encode(), "bad\x00.json": b"{}"})


def test_zip_rejects_unicode_normalization_collisions() -> None:
    data = _zip(
        {
            "instance.json": json.dumps(ROOT).encode(),
            "caf\u00e9.json": b"{}",
            "cafe\u0301.json": b"{}",
        }
    )
    with pytest.raises(PackageError, match="duplicate package path"):
        load_package(data)


def test_zip_rejects_a_compression_bomb_before_parsing_resources() -> None:
    data = _zip({"instance.json": b"0" * 100_000}, compression=zipfile.ZIP_DEFLATED)
    with pytest.raises(PackageError, match="compression ratio"):
        load_package(data)


def test_zip_rejects_a_bad_crc() -> None:
    data = bytearray(_zip({"instance.json": b'{"marker":"crc-payload"}'}))
    offset = data.index(b"crc-payload")
    data[offset] ^= 0x01
    with pytest.raises(PackageError, match="could not read"):
        load_package(bytes(data))


def test_xml_rejects_xinclude_and_remote_schema_hints() -> None:
    for marker in (
        b'<xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="file:///etc/passwd"/>',
        b'<definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:x https://example.test/x.xsd"/>',
    ):
        package = InstancePackage({"instance.json": json.dumps(ROOT).encode(), "workflow.bpmn": marker})
        with pytest.raises(PackageError, match="forbidden external construct"):
            package.xml("workflow.bpmn")


def test_multipart_parser_preserves_zip_bytes_and_requires_one_file() -> None:
    archive = _zip({"instance.json": json.dumps(ROOT).encode()})
    boundary = "bim-boundary"

    def part(name: str) -> bytes:
        return (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"package\"; filename=\"{name}\"\r\n"
            "Content-Type: application/vnd.bim+zip\r\n\r\n"
        ).encode() + archive + b"\r\n"

    body = part("instance.bim.zip") + f"--{boundary}--\r\n".encode()
    assert _multipart_zip(body, f"multipart/form-data; boundary={boundary}") == archive
    duplicate = part("one.bim.zip") + part("two.bim.zip") + f"--{boundary}--\r\n".encode()
    with pytest.raises(PackageError, match="exactly one"):
        _multipart_zip(duplicate, f"multipart/form-data; boundary={boundary}")
