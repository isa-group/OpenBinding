"""The inventory of the OMG XSDs is read from their bytes, agrees with ``licenses.json``, the document and Git, and the verified
download (shared with the build hook of ``bim-core``) refuses any byte it was not told to expect.

Nothing here uses the network: the download takes an injected opener, or the function that reads a URL is replaced."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import types
from pathlib import Path

import pytest

import xsd_inventory
from packaging_support import ROOT

hatch_build = xsd_inventory.hatch_build
FILES = ["BPMN20.xsd", "BPMNDI.xsd", "DC.xsd", "DI.xsd", "Semantic.xsd"]
VENDOR = "packages/bim-core/src/bim_core/resources/vendor/omg/bpmn/2.0.2"
IGNORE_RULE = f"/{VENDOR}/*.xsd\n"


@pytest.fixture(autouse=True)
def tmp_trees_are_not_inside_a_checkout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The trees below are made in a temporary directory; Git must not find a repository above it."""
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path.parent))


def make_tree(tmp_path: Path) -> Path:
    """A copy of what the inventory reads: licenses.json, the document and the directory with the five files."""
    root = tmp_path / "repo"
    (root / "docs").mkdir(parents=True)
    shutil.copy2(ROOT / "licenses.json", root / "licenses.json")
    shutil.copy2(ROOT / "docs" / "OMG_XSD_RIGHTS.md", root / "docs" / "OMG_XSD_RIGHTS.md")
    shutil.copytree(ROOT / VENDOR, root / VENDOR)
    return root


def set_licenses(root: Path, **changes: object) -> None:
    document = json.loads((root / "licenses.json").read_text(encoding="utf-8"))
    document["omg_bpmn_xsd"].update(changes)
    (root / "licenses.json").write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def remove_files(root: Path) -> None:
    for name in FILES:
        (root / VENDOR / name).unlink(missing_ok=True)


def git(root: Path, *arguments: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *arguments], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    return result.stdout


def fake_source(root: Path) -> dict[str, bytes]:
    return {f"https://www.omg.org/spec/BPMN/20100501/{name}": (root / VENDOR / name).read_bytes() for name in FILES}


def no_network(url: str) -> bytes:
    raise AssertionError(f"the network was used: {url}")


def unreachable(url: str) -> bytes:
    raise hatch_build.NetworkError(f"{url}: no network")


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


def test_the_table_is_only_written_with_the_five_files_present(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = make_tree(tmp_path)
    document = root / "docs" / "OMG_XSD_RIGHTS.md"
    before = document.read_text(encoding="utf-8")
    (root / VENDOR / "DC.xsd").unlink()
    with pytest.raises(xsd_inventory.FetchError, match="DC.xsd is not present: run python3 tools/xsd_inventory.py --ensure"):
        xsd_inventory.write(root)
    assert xsd_inventory.main(["--root", str(root), "--write"]) == 1
    assert "write failed" in capsys.readouterr().err
    remove_files(root)
    with pytest.raises(xsd_inventory.FetchError):
        xsd_inventory.write(root)
    assert document.read_text(encoding="utf-8") == before


def test_a_changed_byte_is_reported_against_licenses_json_and_the_readme(tmp_path: Path) -> None:
    root = make_tree(tmp_path)
    target = root / VENDOR / "DC.xsd"
    target.write_bytes(target.read_bytes() + b"\n")
    found = xsd_inventory.check(root)
    assert any("DC.xsd: sha256" in item and "licenses.json" in item for item in found)
    assert any("DC.xsd" in item and "README" in item for item in found)


def test_the_files_are_all_there_or_none_of_them_and_the_table_lists_the_declared_digests_without_them(tmp_path: Path) -> None:
    root = make_tree(tmp_path)
    assert xsd_inventory.check(root) == []  # downloaded: all five, with the declared bytes
    (root / VENDOR / "DC.xsd").unlink()
    assert any("DC.xsd: missing while the other files of the set are present" in item for item in xsd_inventory.check(root))
    remove_files(root)
    assert xsd_inventory.check(root) == []  # none: the tree as it is versioned, the table still lists every digest
    document = root / "docs" / "OMG_XSD_RIGHTS.md"
    text = document.read_text(encoding="utf-8")
    digest = json.loads((root / "licenses.json").read_text(encoding="utf-8"))["omg_bpmn_xsd"]["sha256"]["Semantic.xsd"]
    document.write_text(text.replace(digest, "0" * 64), encoding="utf-8")
    assert any("does not list the SHA-256 of Semantic.xsd" in item for item in xsd_inventory.check(root))
    document.unlink()
    assert any("OMG_XSD_RIGHTS.md does not exist" in item for item in xsd_inventory.check(root))
    document.write_text(text, encoding="utf-8")
    (root / VENDOR).mkdir(parents=True, exist_ok=True)
    (root / VENDOR / "DC.xsd").write_bytes(b"<tampered/>")
    assert any("DC.xsd: sha256" in item for item in xsd_inventory.check(root))


def test_the_repository_never_carries_the_files_so_present_in_tree_must_be_false(tmp_path: Path) -> None:
    root = make_tree(tmp_path)
    set_licenses(root, present_in_tree=True)
    assert any("present_in_tree must be false" in item for item in xsd_inventory.check(root))
    set_licenses(root, present_in_tree=False)
    assert xsd_inventory.check(root) == []


def test_the_state_of_the_clearance_in_the_repository_is_coherent() -> None:
    section = json.loads((ROOT / "licenses.json").read_text(encoding="utf-8"))["omg_bpmn_xsd"]
    assert xsd_inventory.clearance_problems(section) == []
    assert (section["cleared"] is False) == (section["status"] == "not-demonstrated")
    assert section["present_in_tree"] is False
    assert section["cleared"] is False, "the rights are not demonstrated: only the owner can change that"


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
    assert section["directory"] == VENDOR and section["present_in_tree"] is False
    assert section["source_base"] == "https://www.omg.org/spec/BPMN/20100501/"


def test_the_build_hook_declares_the_origin_and_the_digests_of_licenses_json() -> None:
    """``hatch_build.py`` cannot read ``licenses.json`` (it ships in the sdist, which does not carry the repository root)."""
    section = json.loads((ROOT / "licenses.json").read_text(encoding="utf-8"))["omg_bpmn_xsd"]
    assert hatch_build.SOURCE_BASE == section["source_base"]
    assert dict(hatch_build.SHA256) == section["sha256"]
    assert f"packages/bim-core/{hatch_build.RELATIVE_DIRECTORY}" == section["directory"]
    assert hatch_build.DIRECTORY == ROOT / section["directory"]


# --- Git: the repository never versions the files --------------------------------------------------------------


def test_outside_a_git_checkout_git_says_nothing(tmp_path: Path) -> None:
    root = make_tree(tmp_path)
    assert not (root / ".gitignore").exists()
    assert xsd_inventory.git_problems(root, json.loads((root / "licenses.json").read_text(encoding="utf-8"))["omg_bpmn_xsd"]) == []
    assert xsd_inventory.check(root) == []


def test_in_a_checkout_git_must_ignore_the_files_and_must_not_list_them(tmp_path: Path) -> None:
    root = make_tree(tmp_path)
    git(root, "init", "-q")
    found = xsd_inventory.check(root)
    assert sorted(item.split(":")[0].rsplit("/", 1)[-1] for item in found if "not ignored by Git" in item) == FILES
    (root / ".gitignore").write_text(IGNORE_RULE, encoding="utf-8")
    assert xsd_inventory.check(root) == []
    assert xsd_inventory.main(["--root", str(root), "--check"]) == 0
    git(root, "add", "-A")
    assert FILES[0] not in git(root, "ls-files")  # ignored: `git add -A` leaves them out
    git(root, "add", "--force", "--", f"{VENDOR}/DC.xsd", f"{VENDOR}/Semantic.xsd")
    found = xsd_inventory.check(root)
    assert sum("listed by `git ls-files`" in item for item in found) == 2
    assert any("DC.xsd: listed by `git ls-files`" in item for item in found)
    assert xsd_inventory.main(["--root", str(root), "--check"]) == 1
    git(root, "rm", "-q", "--cached", "--", f"{VENDOR}/DC.xsd", f"{VENDOR}/Semantic.xsd")
    assert xsd_inventory.check(root) == []


def test_git_is_checked_with_the_files_absent_too(tmp_path: Path) -> None:
    root = make_tree(tmp_path)
    remove_files(root)
    git(root, "init", "-q")
    assert any("not ignored by Git" in item for item in xsd_inventory.check(root))
    (root / ".gitignore").write_text(IGNORE_RULE, encoding="utf-8")
    assert xsd_inventory.check(root) == []


def test_this_repository_ignores_the_files_in_both_gitignore_files() -> None:
    rule = f"/{VENDOR}/*.xsd"
    assert rule in (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    root_ignore = (ROOT.parent / ".gitignore")
    if root_ignore.is_file():  # in OpenBinding; the exported repository has no parent
        assert f"/bim-toolchain{rule}" in root_ignore.read_text(encoding="utf-8").splitlines()


# --- the verified download ------------------------------------------------------------------------------


def test_fetch_writes_the_files_when_every_digest_is_the_declared_one(tmp_path: Path) -> None:
    served = fake_source(ROOT)
    destination = tmp_path / "out"
    names = xsd_inventory.fetch(destination, ROOT, opener=lambda url: served[url])
    assert names == FILES
    for name in FILES:
        assert (destination / name).read_bytes() == (ROOT / VENDOR / name).read_bytes()
    assert sorted(path.name for path in destination.iterdir()) == FILES, "no temporary file is left behind"


def test_fetch_writes_nothing_when_one_digest_is_not_the_declared_one(tmp_path: Path) -> None:
    served = fake_source(ROOT)
    served["https://www.omg.org/spec/BPMN/20100501/Semantic.xsd"] += b" "
    destination = tmp_path / "out"
    with pytest.raises(xsd_inventory.FetchError, match="Semantic.xsd: SHA-256"):
        xsd_inventory.fetch(destination, ROOT, opener=lambda url: served[url])
    assert not destination.exists()


def test_a_digest_that_is_not_the_declared_one_leaves_an_existing_directory_untouched(tmp_path: Path) -> None:
    destination = tmp_path / "out"
    destination.mkdir()
    (destination / "DC.xsd").write_bytes(b"mine")
    served = fake_source(ROOT)
    served["https://www.omg.org/spec/BPMN/20100501/BPMN20.xsd"] = b"<other/>"
    with pytest.raises(xsd_inventory.FetchError, match="BPMN20.xsd: SHA-256"):
        xsd_inventory.fetch(destination, ROOT, opener=lambda url: served[url])
    assert [path.name for path in destination.iterdir()] == ["DC.xsd"]
    assert (destination / "DC.xsd").read_bytes() == b"mine"


def test_a_failing_write_leaves_no_temporary_file_and_no_target(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    served = fake_source(ROOT)

    def fail(source: object, target: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(hatch_build.os, "replace", fail)
    destination = tmp_path / "out"
    with pytest.raises(OSError, match="disk full"):
        xsd_inventory.fetch(destination, ROOT, opener=lambda url: served[url])
    assert list(destination.iterdir()) == []


def test_the_download_refuses_anything_but_https() -> None:
    with pytest.raises(xsd_inventory.FetchError, match="only https"):
        hatch_build.urlopen("http://www.omg.org/spec/BPMN/20100501/DC.xsd")
    with pytest.raises(xsd_inventory.FetchError, match="only https"):
        hatch_build.urlopen("file:///etc/passwd")


def test_a_failed_download_is_an_error_exit_without_files(tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(hatch_build, "urlopen", unreachable)
    assert xsd_inventory.main(["--fetch", str(tmp_path / "out")]) == 1
    assert "fetch failed" in capsys.readouterr().err
    assert not (tmp_path / "out").exists()


# --- ensure: nothing to do when they are there, a verified download when not, an exact command without network ---


def test_ensure_does_nothing_when_the_five_files_are_there_with_the_declared_bytes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = make_tree(tmp_path)
    assert xsd_inventory.ensure(root, opener=no_network) is False
    assert xsd_inventory.main(["--root", str(root), "--ensure"]) == 0
    assert "already present and verified" in capsys.readouterr().out


def test_ensure_downloads_all_five_when_they_are_missing(tmp_path: Path) -> None:
    root = make_tree(tmp_path)
    remove_files(root)
    served = fake_source(ROOT)
    assert xsd_inventory.ensure(root, opener=lambda url: served[url]) is True
    for name in FILES:
        assert (root / VENDOR / name).read_bytes() == (ROOT / VENDOR / name).read_bytes()
    assert xsd_inventory.check(root) == []
    assert xsd_inventory.ensure(root, opener=no_network) is False


def test_ensure_replaces_a_file_that_is_not_the_declared_bytes_and_one_missing_among_the_others(tmp_path: Path) -> None:
    root = make_tree(tmp_path)
    (root / VENDOR / "DC.xsd").write_bytes(b"<tampered/>")
    (root / VENDOR / "DI.xsd").unlink()
    served = fake_source(ROOT)
    assert xsd_inventory.ensure(root, opener=lambda url: served[url]) is True
    assert xsd_inventory.check(root) == []


def test_ensure_writes_nothing_when_the_source_serves_other_bytes(tmp_path: Path) -> None:
    root = make_tree(tmp_path)
    remove_files(root)
    served = fake_source(ROOT)
    served["https://www.omg.org/spec/BPMN/20100501/DI.xsd"] = b"<other/>"
    with pytest.raises(xsd_inventory.FetchError, match="DI.xsd: SHA-256"):
        xsd_inventory.ensure(root, opener=lambda url: served[url])
    assert not list((root / VENDOR).glob("*.xsd"))


def test_without_network_the_error_names_the_exact_command(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    root = make_tree(tmp_path)
    remove_files(root)
    with pytest.raises(xsd_inventory.FetchError) as raised:
        xsd_inventory.ensure(root, opener=unreachable)
    message = str(raised.value)
    assert "python3 tools/xsd_inventory.py --ensure" in message and "no network" in message and "BPMN20.xsd: missing" in message
    monkeypatch.setattr(hatch_build, "urlopen", unreachable)
    assert xsd_inventory.main(["--root", str(root), "--ensure"]) == 1
    assert "python3 tools/xsd_inventory.py --ensure" in capsys.readouterr().err
    assert not list((root / VENDOR).glob("*.xsd"))


def test_the_build_hook_script_ensures_a_directory_and_names_its_own_command_without_network(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    served = fake_source(ROOT)
    directory = tmp_path / "xsd"
    monkeypatch.setattr(hatch_build, "urlopen", lambda url: served[url])
    assert hatch_build.main(["--ensure", "--directory", str(directory)]) == 0
    assert "downloaded and verified" in capsys.readouterr().out
    assert hatch_build.problems(directory) == []
    assert hatch_build.main(["--ensure", "--directory", str(directory)]) == 0
    assert "already present and verified" in capsys.readouterr().out

    missing = tmp_path / "missing"
    monkeypatch.setattr(hatch_build, "urlopen", unreachable)
    assert hatch_build.main(["--ensure", "--directory", str(missing)]) == 1
    error = capsys.readouterr().err
    command = hatch_build.command_for(missing)
    assert command in error
    assert command.startswith("python3 ") and command.endswith(f"hatch_build.py --ensure --directory {missing}")
    assert not missing.exists()


def test_the_build_hook_ensures_the_files_of_its_project_before_every_build(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    served = fake_source(ROOT)
    monkeypatch.setattr(hatch_build, "urlopen", lambda url: served[url])
    messages: list[str] = []

    class Hook(hatch_build.OmgXsdBuildHook):
        root = str(tmp_path / "project")
        app = types.SimpleNamespace(display_info=messages.append)

    hook = object.__new__(Hook)
    hook.initialize("standard", {})
    assert hatch_build.problems(tmp_path / "project" / hatch_build.RELATIVE_DIRECTORY) == []
    assert len(messages) == 1 and "downloaded and verified" in messages[0]
    hook.initialize("standard", {})
    assert len(messages) == 1, "nothing to say when the files were there"
    assert hatch_build.get_build_hook() is hatch_build.OmgXsdBuildHook


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


def test_the_rights_document_says_how_the_files_arrive_and_that_shipping_them_is_the_owners_decision() -> None:
    text = re.sub(r"\s+", " ", (ROOT / "docs" / "OMG_XSD_RIGHTS.md").read_text(encoding="utf-8"))
    for needle in (
        "not versioned", "xsd_inventory.py --ensure", "hatch_build.py", "SHA-256", "wheels, sdists", "decision of the owner",
        "not demonstrated",
    ):
        assert needle in text, needle
