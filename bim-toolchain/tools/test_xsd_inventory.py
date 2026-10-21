"""The inventory of the vendored OMG XSDs is read from their bytes, agrees with ``licenses.json`` and the document, and the
verified download refuses any byte it was not told to expect."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest

import xsd_inventory
from packaging_support import ROOT

FILES = ["BPMN20.xsd", "BPMNDI.xsd", "DC.xsd", "DI.xsd", "Semantic.xsd"]
VENDOR = "packages/bim-core/src/bim_core/resources/vendor/omg/bpmn/2.0.2"


def make_tree(tmp_path: Path) -> Path:
    """A copy of what the inventory reads: licenses.json, the document and the vendored directory."""
    root = tmp_path / "repo"
    (root / "docs").mkdir(parents=True)
    shutil.copy2(ROOT / "licenses.json", root / "licenses.json")
    shutil.copy2(ROOT / "docs" / "OMG_XSD_RIGHTS.md", root / "docs" / "OMG_XSD_RIGHTS.md")
    shutil.copytree(ROOT / VENDOR, root / VENDOR)
    # The tests below describe a tree that carries the files, whatever the state of the repository they run in (an export
    # without them has present_in_tree false until the files are fetched).
    set_licenses(root, present_in_tree=True)
    return root


def set_licenses(root: Path, **changes: object) -> None:
    document = json.loads((root / "licenses.json").read_text(encoding="utf-8"))
    document["omg_bpmn_xsd"].update(changes)
    (root / "licenses.json").write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def test_the_inventory_lists_the_five_files_with_what_their_bytes_say() -> None:
    inventory = xsd_inventory.inventory(ROOT)
    assert [entry["path"].rsplit("/", 1)[-1] for entry in inventory["files"]] == FILES
    for entry in inventory["files"]:
        data = (ROOT / entry["path"]).read_bytes()
        assert entry["present"] is True and entry["size"] == len(data)
        assert entry["sha256"] == entry["declared_sha256"] == entry["readme_sha256"]
        assert entry["declared_origin"] == f"https://www.omg.org/spec/BPMN/20100501/{entry['path'].rsplit('/', 1)[-1]}"


def test_none_of_the_five_files_contains_a_copyright_or_license_notice() -> None:
    """Read from the bytes, not from the README (which claims the notices are preserved): there is nothing to preserve."""
    for entry in xsd_inventory.inventory(ROOT)["files"]:
        name = entry["path"].rsplit("/", 1)[-1]
        assert entry["contains_copyright_notice"] is False, name
        assert entry["contains_license_text"] is False, name
        assert entry["xml_comments"] == 0, name


def test_the_scan_finds_a_notice_when_there_is_one() -> None:
    assert xsd_inventory.scan(b"<!-- Copyright (c) 2010 Object Management Group -->\n<x/>")["contains_copyright_notice"] is True
    assert xsd_inventory.scan("<!-- © OMG -->".encode())["contains_copyright_notice"] is True
    assert xsd_inventory.scan(b"<!-- All Rights Reserved -->")["contains_copyright_notice"] is True
    assert xsd_inventory.scan(b"<!-- Licensed under the Apache License -->")["contains_license_text"] is True
    plain = xsd_inventory.scan(b'<xsd:schema targetNamespace="http://www.omg.org/spec/BPMN/20100524/MODEL"/>\n')
    assert plain == {"contains_copyright_notice": False, "contains_license_text": False, "xml_comments": 0, "lines": 1}


def test_the_repository_agrees_with_itself() -> None:
    assert xsd_inventory.check(ROOT) == []
    assert xsd_inventory.main(["--check"]) == 0


def test_the_generated_table_is_the_inventory_and_write_is_idempotent(tmp_path: Path) -> None:
    root = make_tree(tmp_path)
    assert xsd_inventory.write(root) is False
    document = root / "docs" / "OMG_XSD_RIGHTS.md"
    text = document.read_text(encoding="utf-8")
    document.write_text(text.replace("| no | no | 0 |", "| yes | no | 0 |", 1), encoding="utf-8")
    assert any("generated table" in item for item in xsd_inventory.check(root))
    assert xsd_inventory.write(root) is True
    assert xsd_inventory.check(root) == []
    assert document.read_text(encoding="utf-8") == text


def test_a_changed_byte_is_reported_against_licenses_json_and_the_readme(tmp_path: Path) -> None:
    root = make_tree(tmp_path)
    target = root / VENDOR / "DC.xsd"
    target.write_bytes(target.read_bytes() + b"\n")
    found = xsd_inventory.check(root)
    assert any("DC.xsd: sha256" in item and "licenses.json" in item for item in found)
    assert any("DC.xsd" in item and "README" in item for item in found)


def test_a_missing_file_is_reported_unless_the_tree_declares_it_absent(tmp_path: Path) -> None:
    root = make_tree(tmp_path)
    (root / VENDOR / "DI.xsd").unlink()
    assert any("DI.xsd" in item and "present_in_tree" in item for item in xsd_inventory.check(root))
    for name in FILES:
        (root / VENDOR / name).unlink(missing_ok=True)
    set_licenses(root, present_in_tree=False)
    assert xsd_inventory.check(root) == []


def test_an_export_without_the_files_may_have_all_five_after_the_verified_download_but_not_some(tmp_path: Path) -> None:
    root = make_tree(tmp_path)
    set_licenses(root, present_in_tree=False)
    assert xsd_inventory.check(root) == []  # fetched: all five, with the declared bytes
    (root / VENDOR / "DC.xsd").unlink()
    assert any("DC.xsd: missing while the other files of the set are present" in item for item in xsd_inventory.check(root))
    for name in FILES:
        (root / VENDOR / name).unlink(missing_ok=True)
    assert xsd_inventory.check(root) == []  # none: the export as it is written
    (root / VENDOR / "DC.xsd").write_bytes(b"<tampered/>")
    assert any("DC.xsd: sha256" in item for item in xsd_inventory.check(root))


def test_the_state_of_the_clearance_in_the_repository_is_coherent() -> None:
    section = json.loads((ROOT / "licenses.json").read_text(encoding="utf-8"))["omg_bpmn_xsd"]
    assert xsd_inventory.clearance_problems(section) == []
    assert (section["cleared"] is False) == (section["status"] == "not-demonstrated")
    assert isinstance(section["present_in_tree"], bool)


def test_the_clearance_is_a_boolean_with_a_complete_record() -> None:
    section = {
        **json.loads((ROOT / "licenses.json").read_text(encoding="utf-8"))["omg_bpmn_xsd"],
        "cleared": False, "status": "not-demonstrated", "cleared_by": None, "cleared_on": None, "evidence": None,
    }
    assert xsd_inventory.clearance_problems(section) == []
    assert xsd_inventory.is_cleared({"omg_bpmn_xsd": section}) is False

    claimed = {**section, "cleared": True, "status": "cleared"}
    assert len(xsd_inventory.clearance_problems(claimed)) == 3
    assert xsd_inventory.is_cleared({"omg_bpmn_xsd": claimed}) is False
    complete = {**claimed, "cleared_by": "the holder", "cleared_on": "2026-10-14", "evidence": "letter of OMG, kept by the holder"}
    assert xsd_inventory.clearance_problems(complete) == []
    assert xsd_inventory.is_cleared({"omg_bpmn_xsd": complete}) is True
    assert xsd_inventory.clearance_problems({**complete, "status": "not-demonstrated"})
    assert xsd_inventory.clearance_problems({**section, "cleared": "yes"})
    assert xsd_inventory.clearance_problems({**section, "status": "cleared"})


def test_licenses_json_lists_the_declared_digests_of_the_vendored_readme() -> None:
    section = json.loads((ROOT / "licenses.json").read_text(encoding="utf-8"))["omg_bpmn_xsd"]
    assert sorted(section["files"]) == sorted(section["sha256"]) == FILES
    assert section["directory"] == VENDOR and isinstance(section["present_in_tree"], bool)
    assert section["source_base"] == "https://www.omg.org/spec/BPMN/20100501/"


# --- the verified download ------------------------------------------------------------------------------


def fake_source(root: Path) -> dict[str, bytes]:
    return {f"https://www.omg.org/spec/BPMN/20100501/{name}": (root / VENDOR / name).read_bytes() for name in FILES}


def test_fetch_writes_the_files_when_every_digest_is_the_declared_one(tmp_path: Path) -> None:
    served = fake_source(ROOT)
    destination = tmp_path / "out"
    names = xsd_inventory.fetch(destination, ROOT, opener=lambda url: served[url])
    assert names == FILES
    for name in FILES:
        assert (destination / name).read_bytes() == (ROOT / VENDOR / name).read_bytes()


def test_fetch_writes_nothing_when_one_digest_is_not_the_declared_one(tmp_path: Path) -> None:
    served = fake_source(ROOT)
    served["https://www.omg.org/spec/BPMN/20100501/Semantic.xsd"] += b" "
    destination = tmp_path / "out"
    with pytest.raises(xsd_inventory.FetchError, match="Semantic.xsd: SHA-256"):
        xsd_inventory.fetch(destination, ROOT, opener=lambda url: served[url])
    assert not destination.exists()


def test_fetch_refuses_anything_but_https() -> None:
    with pytest.raises(xsd_inventory.FetchError, match="only https"):
        xsd_inventory._urlopen("http://www.omg.org/spec/BPMN/20100501/DC.xsd")
    with pytest.raises(xsd_inventory.FetchError, match="only https"):
        xsd_inventory._urlopen("file:///etc/passwd")


def test_a_failed_download_is_an_error_exit_without_files(tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(url: str) -> bytes:
        raise xsd_inventory.FetchError(f"{url}: no network")

    monkeypatch.setattr(xsd_inventory, "_urlopen", refuse)
    assert xsd_inventory.main(["--fetch", str(tmp_path / "out")]) == 1
    assert "fetch failed" in capsys.readouterr().err
    assert not (tmp_path / "out").exists()


# --- the document -----------------------------------------------------------------------------------------


def test_the_rights_document_states_the_findings_as_received() -> None:
    raw = (ROOT / "docs" / "OMG_XSD_RIGHTS.md").read_text(encoding="utf-8")
    text = re.sub(r"\s*\n>\s*", " ", raw)  # the quotation wraps its lines
    assert "NOT DEMONSTRATED" in text and "NO DEMOSTRADO" in text
    assert "IPR Mode: RF-RAND" in text
    for sentence in (
        "La página oficial BPMN 2.0.2 lista los 5 XSD sin enunciar licencia de redistribución",
        "`BPMN20.xsd` y `Semantic.xsd` tal como los sirve omg.org no traen comentario de copyright",
        "los términos del PDF de la especificación (copia/distribución) no han sido leídos por el controlador",
    ):
        assert sentence in text, sentence
    for option in ("Written confirmation from OMG", "Do not vendor", "Own validation", "Keep the repository private"):
        assert option in text, option
    assert xsd_inventory.BEGIN in text and xsd_inventory.END in text
