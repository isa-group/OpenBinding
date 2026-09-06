#!/usr/bin/env python3
"""Generate the public three-track changelog from Conventional Commits."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "frontend/src/content/changelog.generated.json"
BASELINE = ROOT / "tools/changelog-baseline"
CONVENTIONAL = re.compile(r"^(?P<kind>[a-z]+)(?:\((?P<scope>[^)]+)\))?!?:\s+(?P<title>.+)$")
VERSION = re.compile(r"^version:\s*['\"]?([^'\"\s]+)", re.MULTILINE)

BIM_SCOPES = {"bim", "core", "engines", "engine", "federation", "experiments"}
DOC_SCOPES = {"docs", "documentation"}
PLATFORM_SCOPES = {"account", "admin", "auth", "frontend", "gateway", "platform", "space", "pricing"}


def git_log() -> list[tuple[str, str, str, list[str]]]:
    baseline = BASELINE.read_text(encoding="utf-8").strip()
    raw = subprocess.run(
        [
            "git",
            "log",
            "--no-merges",
            "--format=%x1e%H%x1f%cs%x1f%s",
            "--name-only",
            f"{baseline}..HEAD",
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    commits = []
    for record in raw.split("\x1e"):
        lines = record.strip().splitlines()
        if not lines:
            continue
        digest, date, subject = lines[0].split("\x1f", 2)
        commits.append((digest, date, subject, [line for line in lines[1:] if line]))
    return commits


def tracks(scope: str, paths: list[str]) -> set[str]:
    selected: set[str] = set()
    if scope in DOC_SCOPES or any(path.startswith("docs/") or path in {"README.md", "THIRD_PARTY_NOTICES.md"} for path in paths):
        selected.add("documentation")
    if scope in BIM_SCOPES or any(path.startswith(("schemas/", "engines/", "examples/", "experimentation/")) for path in paths):
        selected.add("bim")
    if scope in PLATFORM_SCOPES or any(path.startswith(("frontend/", "openbinding-gateway/", "space/", "deploy/", "nginx/")) for path in paths):
        selected.add("platform")
    return selected or {"platform"}


def current_version() -> str:
    source = (ROOT / "space/pricing/openbinding.yml").read_text(encoding="utf-8")
    match = VERSION.search(source)
    if not match:
        raise SystemExit("space/pricing/openbinding.yml has no version")
    return match.group(1)


def generate() -> dict[str, list[dict[str, object]]]:
    changes: dict[str, list[str]] = {"platform": [], "bim": [], "documentation": []}
    dates: dict[str, str] = {}
    for _, date, subject, paths in git_log():
        match = CONVENTIONAL.fullmatch(subject)
        if not match:
            continue
        title = match.group("title").rstrip(".")
        sentence = title[:1].upper() + title[1:]
        for track in tracks(match.group("scope") or "", paths):
            dates.setdefault(track, date)
            if sentence not in changes[track]:
                changes[track].append(sentence)

    version = current_version()
    labels = {
        "platform": (version, "OpenBinding platform"),
        "bim": ("BIM v1", "Binding language and engines"),
        "documentation": (version, "OpenBinding documentation"),
    }
    return {
        track: [
            {
                "version": labels[track][0],
                "date": dates.get(track, "Unreleased"),
                "title": labels[track][1],
                "changes": entries,
            }
        ]
        for track, entries in changes.items()
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    rendered = json.dumps(generate(), indent=2, ensure_ascii=False) + "\n"
    if args.check:
        if not args.output.exists() or args.output.read_text(encoding="utf-8") != rendered:
            raise SystemExit(f"{args.output.relative_to(ROOT)} is stale; run tools/generate_changelog.py")
        return
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8")


if __name__ == "__main__":
    main()
