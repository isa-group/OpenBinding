"""Inventory of the OMG BPMN 2.0.2 XSDs, read from their bytes, and the verified download that puts them in place.

    python tools/xsd_inventory.py --ensure       # download the five files unless they are there and verify (needs network if not)
    python tools/xsd_inventory.py --check        # exit 1 if the bytes, licenses.json, Git and docs/OMG_XSD_RIGHTS.md disagree
    python tools/xsd_inventory.py --write        # refresh the generated table of docs/OMG_XSD_RIGHTS.md (the five files must be there)
    python tools/xsd_inventory.py --json         # the inventory as JSON
    python tools/xsd_inventory.py --fetch DIR    # download the five files from the official source into DIR, verified

The repository never carries the five files: ``.gitignore`` ignores them, ``licenses.json`` says ``present_in_tree`` is
false, and ``--check`` fails if ``git ls-files`` lists one or Git does not ignore it (it says nothing outside a checkout).
Wheels, sdists, the SDK and the images do carry them: every build downloads them over https first and compares each with
the SHA-256 declared in ``licenses.json`` (``packages/bim-core/hatch_build.py``, shared with this tool), all five or none.

For every file the inventory records its path, the origin and SHA-256 the vendored README declares, the SHA-256 and
size of the bytes actually present, and whether those bytes *contain* a copyright or license notice (the inventory
reads the files, not the README, which claims that the notices are preserved).  Nothing but the standard library is
needed, so the verified download also runs in a build that has no dependency installed.

``licenses.json`` also holds the clearance record (``omg_bpmn_xsd.cleared``): whether the rights to redistribute the
files are demonstrated.  They are not, and shipping the files inside artifacts is a decision of the holder
(``docs/OMG_XSD_RIGHTS.md``); the download does not need the clearance.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
LICENSES_NAME = "licenses.json"
DOC_RELATIVE = Path("docs") / "OMG_XSD_RIGHTS.md"
HATCH_BUILD = ROOT / "packages" / "bim-core" / "hatch_build.py"
ENSURE_COMMAND = "python3 tools/xsd_inventory.py --ensure"
BEGIN = "<!-- xsd-inventory:begin -->"
END = "<!-- xsd-inventory:end -->"
SCHEMA = "bim-toolchain/xsd-inventory/1"

COPYRIGHT = re.compile(rb"copyright|\xc2\xa9|\(c\)|all rights reserved", re.IGNORECASE)
LICENSE_TEXT = re.compile(rb"licen[sc]e|permission is hereby|redistribut|terms and conditions", re.IGNORECASE)
XML_COMMENT = re.compile(rb"<!--")
README_ROW = re.compile(r"^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|\s*$", re.MULTILINE)
README_BASE = re.compile(r"Source base:\s*<([^>]+)>")


def _load_hatch_build() -> ModuleType:
    """``packages/bim-core/hatch_build.py`` of this checkout: the one implementation of the verified download."""
    name = "bim_core_hatch_build"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, HATCH_BUILD)
    if spec is None or spec.loader is None:
        raise ImportError(f"{HATCH_BUILD} cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


hatch_build = _load_hatch_build()
#: A download that could not be made or whose bytes are not the declared ones.
FetchError = hatch_build.FetchError


def load_licenses(root: Path = ROOT) -> dict[str, Any]:
    return json.loads((root / LICENSES_NAME).read_text(encoding="utf-8"))


def clearance_problems(section: dict[str, Any]) -> list[str]:
    """What is wrong with the clearance record of ``omg_bpmn_xsd`` (an empty list when it is coherent)."""
    cleared = section.get("cleared")
    if cleared is not True and cleared is not False:
        return ['"cleared" must be true or false']
    if not cleared:
        if section.get("status") != "not-demonstrated":
            return ['while "cleared" is false the "status" is "not-demonstrated"']
        return []
    problems = []
    if section.get("status") != "cleared":
        problems.append('"cleared" is true but "status" is not "cleared"')
    for key in ("cleared_by", "cleared_on", "evidence"):
        value = section.get(key)
        if not isinstance(value, str) or not value.strip():
            problems.append(f'"cleared" is true but "{key}" is empty')
    return problems


def is_cleared(licenses: dict[str, Any]) -> bool:
    """True only when the holder marked the files as cleared and the record is complete."""
    section = licenses["omg_bpmn_xsd"]
    return section.get("cleared") is True and not clearance_problems(section)


def scan(data: bytes) -> dict[str, Any]:
    """What the bytes of one file say about rights."""
    return {
        "contains_copyright_notice": bool(COPYRIGHT.search(data)),
        "contains_license_text": bool(LICENSE_TEXT.search(data)),
        "xml_comments": len(XML_COMMENT.findall(data)),
        "lines": data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0),
    }


def sha256_hex(data: bytes) -> str:
    return hatch_build.sha256_hex(data)


def inventory(root: Path = ROOT) -> dict[str, Any]:
    """The inventory of the files listed in ``licenses.json``, from the bytes present below ``root``."""
    section = load_licenses(root)["omg_bpmn_xsd"]
    directory = root / section["directory"]
    readme = directory / "README.md"
    readme_digests: dict[str, str] = {}
    base = None
    if readme.is_file():
        text = readme.read_text(encoding="utf-8")
        readme_digests = dict(README_ROW.findall(text))
        found = README_BASE.search(text)
        base = found.group(1) if found else None
    files = []
    for name in sorted(section["files"]):
        entry: dict[str, Any] = {
            "path": f"{section['directory']}/{name}",
            "declared_origin": f"{base}{name}" if base else None,
            "declared_sha256": section["sha256"].get(name),
            "readme_sha256": readme_digests.get(name),
        }
        path = directory / name
        if path.is_file():
            data = path.read_bytes()
            entry.update({"present": True, "sha256": sha256_hex(data), "size": len(data), **scan(data)})
        else:
            entry["present"] = False
        files.append(entry)
    return {"schema": SCHEMA, "directory": section["directory"], "files": files}


def problems(found: dict[str, Any], licenses: dict[str, Any]) -> list[str]:
    """Disagreements between the inventory and what ``licenses.json`` says about the files."""
    section = licenses["omg_bpmn_xsd"]
    result = [f"licenses.json: {item}" for item in clearance_problems(section)]
    if section.get("present_in_tree") is not False:
        result.append(
            "licenses.json: present_in_tree must be false: the repository never carries the files "
            "(they are downloaded and verified at build time)"
        )
    if set(section["files"]) != set(section["sha256"]):
        result.append("licenses.json: files and sha256 do not list the same names")
    all_present = all(entry["present"] for entry in found["files"])
    for entry in found["files"]:
        name = entry["path"].rsplit("/", 1)[-1]
        if not entry["present"]:
            if not all_present and any(other["present"] for other in found["files"]):
                # none of them, or all five after the verified download
                result.append(f"{name}: missing while the other files of the set are present (download all five or none)")
            continue
        if entry["sha256"] != entry["declared_sha256"]:
            result.append(f"{name}: sha256 {entry['sha256']} is not the one in licenses.json")
        if entry["readme_sha256"] is not None and entry["sha256"] != entry["readme_sha256"]:
            result.append(f"{name}: sha256 is not the one in the vendored README")
    return result


def render_block(found: dict[str, Any]) -> str:
    """The generated table of ``docs/OMG_XSD_RIGHTS.md`` (between the two markers, markers included)."""
    lines = [
        BEGIN,
        "",
        "| File | Declared origin | SHA-256 (bytes present) | Bytes | Lines | Copyright notice in the bytes | License text in the bytes | XML comments |",
        "| --- | --- | --- | ---: | ---: | --- | --- | ---: |",
    ]
    for entry in found["files"]:
        if entry["present"]:
            lines.append(
                f"| `{entry['path']}` | {entry['declared_origin']} | `{entry['sha256']}` | {entry['size']} | {entry['lines']} "
                f"| {'yes' if entry['contains_copyright_notice'] else 'no'} "
                f"| {'yes' if entry['contains_license_text'] else 'no'} | {entry['xml_comments']} |"
            )
        else:
            lines.append(f"| `{entry['path']}` | {entry['declared_origin']} | (not in this tree) | | | | | |")
    present = [entry for entry in found["files"] if entry["present"]]
    with_notice = [entry["path"].rsplit("/", 1)[-1] for entry in present if entry["contains_copyright_notice"]]
    lines += [
        "",
        f"Files read: {len(present)} of {len(found['files'])}. "
        f"Files whose bytes contain a copyright notice: {', '.join(with_notice) if with_notice else 'none'}.",
        "",
        END,
    ]
    return "\n".join(lines)


def _replace_block(text: str, block: str) -> str:
    start, end = text.find(BEGIN), text.find(END)
    if start < 0 or end < start:
        raise ValueError(f"the document has no {BEGIN} ... {END} block")
    return text[:start] + block + text[end + len(END):]


def current_block(text: str) -> str | None:
    start, end = text.find(BEGIN), text.find(END)
    if start < 0 or end < start:
        return None
    return text[start:end + len(END)]


def write(root: Path = ROOT) -> bool:
    """Refresh the table in the document, from the five files; True when the document changed.

    The table records what the bytes say, so it is only written with all five present (``--ensure`` puts them there).
    """
    found = inventory(root)
    missing = [entry["path"].rsplit("/", 1)[-1] for entry in found["files"] if not entry["present"]]
    if missing:
        raise FetchError(f"the table is generated from the bytes and {', '.join(missing)} is not present: run {ENSURE_COMMAND}")
    path = root / DOC_RELATIVE
    text = path.read_text(encoding="utf-8")
    updated = _replace_block(text, render_block(found))
    if updated == text:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def _git(root: Path, *arguments: str) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(["git", "-C", str(root), *arguments], capture_output=True, text=True, check=False)
    except OSError:
        return None


def git_problems(root: Path, section: dict[str, Any]) -> list[str]:
    """Git tracks one of the files, or does not ignore it.  Nothing is said outside a Git checkout (an export, an archive)."""
    inside = _git(root, "rev-parse", "--is-inside-work-tree")
    if inside is None or inside.returncode != 0 or inside.stdout.strip() != "true":
        return []
    paths = [f"{section['directory']}/{name}" for name in sorted(section["files"])]
    result = []
    listed = _git(root, "ls-files", "-z", "--", *paths)
    if listed is not None and listed.returncode == 0:
        for item in (entry for entry in listed.stdout.split("\0") if entry):
            result.append(f"{item}: listed by `git ls-files`; the repository never versions the files (git rm --cached)")
    for path in paths:
        ignored = _git(root, "check-ignore", "--no-index", "-q", "--", path)
        if ignored is not None and ignored.returncode == 1:
            result.append(f"{path}: not ignored by Git; .gitignore must ignore the five files")
    return result


def check(root: Path = ROOT) -> list[str]:
    """Every disagreement between the bytes, ``licenses.json``, Git and the document; empty when all agree."""
    licenses = load_licenses(root)
    section = licenses["omg_bpmn_xsd"]
    found = inventory(root)
    result = problems(found, licenses) + git_problems(root, section)
    document = root / DOC_RELATIVE
    if not document.is_file():
        result.append(f"{DOC_RELATIVE.as_posix()} does not exist")
        return result
    block = current_block(document.read_text(encoding="utf-8"))
    present = [entry["present"] for entry in found["files"]]
    if all(present):
        if block != render_block(found):
            result.append(f"{DOC_RELATIVE.as_posix()}: the generated table is not the inventory of the bytes (run --write)")
    elif not any(present):
        # Without the bytes the table must still list the digests that licenses.json declares.
        for name, digest in sorted(section["sha256"].items()):
            if block is None or f"`{digest}`" not in block:
                result.append(f"{DOC_RELATIVE.as_posix()}: the generated table does not list the SHA-256 of {name} declared in licenses.json")
    return result


def fetch(destination: Path, root: Path = ROOT, opener: Callable[[str], bytes] | None = None) -> list[str]:
    """Download the files from ``source_base`` into ``destination``; nothing is written unless all five are the declared bytes."""
    section = load_licenses(root)["omg_bpmn_xsd"]
    return hatch_build.download(destination, opener=opener, source_base=section["source_base"], digests=section["sha256"])


def ensure(root: Path = ROOT, opener: Callable[[str], bytes] | None = None) -> bool:
    """Put the five files in place below ``root`` unless they are there with the declared bytes; True if downloaded."""
    section = load_licenses(root)["omg_bpmn_xsd"]
    return hatch_build.ensure(
        root / section["directory"],
        opener=opener,
        source_base=section["source_base"],
        digests=section["sha256"],
        command=ENSURE_COMMAND,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", type=Path, default=ROOT, help="the repository root (default: this one)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--ensure", action="store_true", help="download the files unless they are present and verify")
    group.add_argument("--check", action="store_true", help="exit 1 if the bytes, licenses.json, Git and the document disagree")
    group.add_argument("--write", action="store_true", help="refresh the generated table of the document")
    group.add_argument("--json", action="store_true", help="print the inventory as JSON")
    group.add_argument("--fetch", type=Path, metavar="DIR", help="download the files from the official source, verifying SHA-256")
    arguments = parser.parse_args(argv)
    if arguments.ensure:
        try:
            downloaded = ensure(arguments.root)
        except FetchError as exc:
            print(f"ensure failed: {exc}", file=sys.stderr)
            return 1
        print("xsd files: " + ("downloaded and verified" if downloaded else "already present and verified"))
        return 0
    if arguments.fetch is not None:
        try:
            names = fetch(arguments.fetch, arguments.root)
        except FetchError as exc:
            print(f"fetch failed: {exc}", file=sys.stderr)
            return 1
        print(f"fetched and verified {len(names)} files into {arguments.fetch}")
        return 0
    if arguments.write:
        try:
            print("updated" if write(arguments.root) else "already current")
        except FetchError as exc:
            print(f"write failed: {exc}", file=sys.stderr)
            return 1
        return 0
    if arguments.json:
        print(json.dumps(inventory(arguments.root), indent=2, sort_keys=True))
        return 0
    found = check(arguments.root)
    for item in found:
        print(f"differs: {item}", file=sys.stderr)
    section = load_licenses(arguments.root)["omg_bpmn_xsd"]
    print(f"xsd inventory: {len(found)} problems; cleared={section.get('cleared')}")
    return 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main())
