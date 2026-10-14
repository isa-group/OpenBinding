"""Inventory of the vendored OMG BPMN 2.0.2 XSDs, read from their bytes, and the verified download that replaces them.

    python tools/xsd_inventory.py --check        # exit 1 if the tree, licenses.json and docs/OMG_XSD_RIGHTS.md disagree
    python tools/xsd_inventory.py --write        # refresh the generated table of docs/OMG_XSD_RIGHTS.md
    python tools/xsd_inventory.py --json         # the inventory as JSON
    python tools/xsd_inventory.py --fetch DIR    # download the five files from the official source into DIR, verified

For every file the inventory records its path, the origin and SHA-256 the vendored README declares, the SHA-256 and
size of the bytes actually present, and whether those bytes *contain* a copyright or license notice (the inventory
reads the files, not the README, which claims that the notices are preserved).  Nothing but the standard library is
needed, so the verified download also runs in a build that has no dependency installed.

``licenses.json`` is the versioned switch: the files may be exported only when ``omg_bpmn_xsd.cleared`` is ``true`` and
the record is complete (who, when, evidence).  ``--fetch`` does not need the clearance: it is the build step of a tree
that does not carry the files, and it refuses any download whose SHA-256 is not the declared one.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
LICENSES_NAME = "licenses.json"
DOC_RELATIVE = Path("docs") / "OMG_XSD_RIGHTS.md"
BEGIN = "<!-- xsd-inventory:begin -->"
END = "<!-- xsd-inventory:end -->"
SCHEMA = "bim-toolchain/xsd-inventory/1"

COPYRIGHT = re.compile(rb"copyright|\xc2\xa9|\(c\)|all rights reserved", re.IGNORECASE)
LICENSE_TEXT = re.compile(rb"licen[sc]e|permission is hereby|redistribut|terms and conditions", re.IGNORECASE)
XML_COMMENT = re.compile(rb"<!--")
README_ROW = re.compile(r"^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|\s*$", re.MULTILINE)
README_BASE = re.compile(r"Source base:\s*<([^>]+)>")


class FetchError(RuntimeError):
    """A download that could not be made or whose bytes are not the declared ones."""


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
    return hashlib.sha256(data).hexdigest()


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
    """Disagreements between the inventory and what ``licenses.json`` says the tree holds."""
    section = licenses["omg_bpmn_xsd"]
    expected_present = bool(section.get("present_in_tree", True))
    result = [f"licenses.json: {item}" for item in clearance_problems(section)]
    if set(section["files"]) != set(section["sha256"]):
        result.append("licenses.json: files and sha256 do not list the same names")
    all_present = all(entry["present"] for entry in found["files"])
    any_present = any(entry["present"] for entry in found["files"])
    for entry in found["files"]:
        name = entry["path"].rsplit("/", 1)[-1]
        if expected_present and not entry["present"]:
            result.append(f"{name}: present=False but present_in_tree=True")
        elif not expected_present and any_present and not all_present and not entry["present"]:
            # present_in_tree=false is an export without the files: none of them, or all five after the verified download
            result.append(f"{name}: missing while the other files of the set are present (fetch all five or none)")
        if not entry["present"]:
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
    """Refresh the table in the document; True when the document changed."""
    path = root / DOC_RELATIVE
    text = path.read_text(encoding="utf-8")
    updated = _replace_block(text, render_block(inventory(root)))
    if updated == text:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def check(root: Path = ROOT) -> list[str]:
    """Every disagreement between the bytes, ``licenses.json`` and the document; empty when all agree."""
    licenses = load_licenses(root)
    found = inventory(root)
    result = problems(found, licenses)
    if licenses["omg_bpmn_xsd"].get("present_in_tree", True):
        document = root / DOC_RELATIVE
        if not document.is_file():
            result.append(f"{DOC_RELATIVE.as_posix()} does not exist")
        elif current_block(document.read_text(encoding="utf-8")) != render_block(found):
            result.append(f"{DOC_RELATIVE.as_posix()}: the generated table is not the inventory of the bytes (run --write)")
    return result


def _urlopen(url: str) -> bytes:
    if not url.startswith("https://"):
        raise FetchError(f"{url}: only https downloads are made")
    try:
        with urllib.request.urlopen(url, timeout=60) as response:  # noqa: S310 (https only, checked above)
            return response.read()
    except OSError as exc:
        raise FetchError(f"{url}: {exc}") from exc


def fetch(destination: Path, root: Path = ROOT, opener: Callable[[str], bytes] | None = None) -> list[str]:
    """Download the files from ``source_base`` into ``destination``; nothing is written unless all five are the declared bytes."""
    section = load_licenses(root)["omg_bpmn_xsd"]
    read = opener or _urlopen
    downloaded: dict[str, bytes] = {}
    for name in sorted(section["files"]):
        url = f"{section['source_base']}{name}"
        data = read(url)
        found, declared = sha256_hex(data), section["sha256"][name]
        if found != declared:
            raise FetchError(f"{url}: SHA-256 {found} is not the declared {declared}; nothing was written")
        downloaded[name] = data
    destination.mkdir(parents=True, exist_ok=True)
    for name, data in downloaded.items():
        (destination / name).write_bytes(data)
    return sorted(downloaded)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", type=Path, default=ROOT, help="the repository root (default: this one)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="exit 1 if the bytes, licenses.json and the document disagree")
    group.add_argument("--write", action="store_true", help="refresh the generated table of the document")
    group.add_argument("--json", action="store_true", help="print the inventory as JSON")
    group.add_argument("--fetch", type=Path, metavar="DIR", help="download the files from the official source, verifying SHA-256")
    arguments = parser.parse_args(argv)
    if arguments.fetch is not None:
        try:
            names = fetch(arguments.fetch, arguments.root)
        except FetchError as exc:
            print(f"fetch failed: {exc}", file=sys.stderr)
            return 1
        print(f"fetched and verified {len(names)} files into {arguments.fetch}")
        return 0
    if arguments.write:
        print("updated" if write(arguments.root) else "already current")
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
