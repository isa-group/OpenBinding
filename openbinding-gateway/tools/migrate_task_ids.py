"""Rewrite candidates from one task to a list of them.

A candidate used to name the single task it implemented; it now lists every
task it can implement, so that one candidate can serve several of them instead
of being written out once per task.

The rewrite is mechanical and behaviour-preserving: ``"task_id": "t"`` becomes
``"task_ids": ["t"]``, a list of one. It is done line by line rather than by
reserializing, because these files are hand-formatted and a reserialization
would rewrite every line of a corpus for the sake of one key.

Only the candidates array is touched. Composition TASK nodes spell their task
the same way and must be left alone, which is why this tracks where in the
document it is instead of matching the key anywhere it appears.

    python openbinding-gateway/tools/migrate_task_ids.py examples experimentation
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import List, Tuple

_CANDIDATES_OPEN = re.compile(r'"candidates"\s*:\s*\[')
_TASK_ID = re.compile(r'"task_id"(\s*):(\s*)"([^"]+)"')


def migrate_text(text: str) -> Tuple[str, int]:
    """Return the migrated document and how many candidates were rewritten."""
    out: List[str] = []
    depth = 0
    inside = False
    rewritten = 0

    for line in text.splitlines(keepends=True):
        if not inside and _CANDIDATES_OPEN.search(line):
            inside = True
            depth = 0

        if inside:
            line, count = _TASK_ID.subn(r'"task_ids"\1:\2["\3"]', line)
            rewritten += count
            # Counted after the rewrite; the inserted pair is balanced.
            depth += line.count("[") - line.count("]")
            if depth <= 0:
                inside = False

        out.append(line)

    return "".join(out), rewritten


def migrate_structurally(document: dict) -> int:
    """The fallback for documents written without line breaks to follow."""
    rewritten = 0
    for candidate in document.get("candidates") or []:
        if "task_id" in candidate:
            rebuilt = {}
            for key, value in candidate.items():
                if key == "task_id":
                    rebuilt["task_ids"] = [value]
                else:
                    rebuilt[key] = value
            candidate.clear()
            candidate.update(rebuilt)
            rewritten += 1
    return rewritten


def check(document: dict, path: Path) -> List[str]:
    """Complain about anything the rewrite should have removed, or moved."""
    problems: List[str] = []
    for index, candidate in enumerate(document.get("candidates") or []):
        if "task_id" in candidate:
            problems.append(f"{path}: candidates[{index}] still declares task_id")
        if not candidate.get("task_ids"):
            problems.append(f"{path}: candidates[{index}] has no task_ids")

    # The composition names its tasks the same way and must be untouched.
    def visit(node: object) -> None:
        if not isinstance(node, dict):
            return
        if node.get("kind") == "TASK" and "task_id" not in node:
            problems.append(f"{path}: a composition TASK node lost its task_id")
        for child in node.get("children") or []:
            visit(child)
        for branch in node.get("branches") or []:
            if isinstance(branch, dict):
                visit(branch.get("child"))
        if node.get("body"):
            visit(node.get("body"))

    visit((document.get("composition") or {}).get("root"))
    return problems


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("paths", nargs="+", type=Path, help="files or directories to migrate")
    parser.add_argument("--dry-run", action="store_true", help="report without writing")
    args = parser.parse_args(argv)

    files: List[Path] = []
    for path in args.paths:
        if path.is_dir():
            files.extend(sorted(path.rglob("*.json")))
        elif path.suffix == ".json":
            files.append(path)

    touched = 0
    problems: List[str] = []
    for path in files:
        text = path.read_text()
        try:
            document = json.loads(text)
        except json.JSONDecodeError:
            continue
        if not isinstance(document, dict):
            continue

        expected = sum(
            1 for c in document.get("candidates") or [] if isinstance(c, dict) and "task_id" in c
        )
        if not expected:
            continue

        migrated, rewritten = migrate_text(text)
        if rewritten == expected:
            result = json.loads(migrated)
        else:
            # The line-based rewrite could not follow this document's layout,
            # so reserialize instead of guessing.
            migrate_structurally(document)
            result = document
            migrated = json.dumps(document, indent=2) + "\n"

        touched += 1
        if args.dry_run:
            print(f"would migrate {path} ({expected} candidates)")
            continue
        path.write_text(migrated)
        problems.extend(check(result, path))
        print(f"migrated {path} ({expected} candidates)")

    for problem in problems:
        print(problem, file=sys.stderr)
    print(f"{touched} file(s) migrated, {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
