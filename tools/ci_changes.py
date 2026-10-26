#!/usr/bin/env python3
"""Decide which CI areas a pull request touches, from the file list of `git diff` (no network).

Every doubt runs the area: an event other than pull_request, an unreadable or empty diff, a path no rule knows, or a
change to the CI definition itself sets all areas to true. [impl->req~ci-speed-change-detection~1]
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import re
import subprocess
import sys

AREAS = ("e2e", "bim", "engines", "gateway")
NONE: frozenset[str] = frozenset()
GATEWAY = frozenset({"gateway"})
CHANGELOG = "frontend/src/content/changelog.generated.json"
CI_WORKFLOW = ".github/workflows/ci.yml"
# The gateway tests read these directories (grep of `REPO_ROOT / "..."`), so a change there runs the gateway area.
GATEWAY_DIRS = ("lab/", "docs/", ".github/", ".agentic/", "deploy/", "space/", "pricings/", "acceptance/")
GATEWAY_ROOT_FILES = ("compose*.json", "docker-compose*.yml", "*.dockerignore", ".gitignore", ".env.example", "LICENSE")
# Root Markdown files no test reads; any other root *.md (README.md, INTENT.md, NOTICE.md ...) is read.
UNREAD_ROOT_MARKDOWN = {"AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "REVIEW.md", "ROADMAP.md", "SECURITY.md", "TESTING.md"}
BIM_ROOT_FILES = ("LICENSE", "THIRD_PARTY_NOTICES.md")
GATEWAY_VENDOR_BPMN = "openbinding-gateway/src/openbinding_gateway/v1/vendor/omg/bpmn/"
# A gateway test reads this one file of openspec/, so only it counts there.
OPENSPEC_READ ="openspec/changes/m09-compose-only/"
REVISION = re.compile(r"[0-9a-fA-F]{7,64}")


def classify(path: str) -> frozenset[str] | None:
    """The areas a changed path runs; an empty set when it never needs a job, None when no rule knows it."""
    # The bim-core boundary test compares these two root files with their bim-toolchain copies (corpus root = repository).
    if path in BIM_ROOT_FILES:
        return frozenset({"bim", "gateway"})
    if path == CHANGELOG or path.startswith(("docs/agent-work/", "acceptance/ui/")):
        return NONE
    if path.startswith("openspec/"):
        return GATEWAY if path.startswith(OPENSPEC_READ) else NONE
    if path.startswith("frontend/"):
        if path.endswith(".md"):
            return NONE
        # The gateway tests read frontend/src (routes, package fixtures); only the browser specs are e2e alone.
        return frozenset({"e2e"}) if path.startswith("frontend/e2e/") else frozenset({"e2e", "gateway"})
    if path.startswith("engines/") or path.startswith("schemas/bim/") or path == "tools/check_bim_guard.py":
        return frozenset({"engines", "bim", "gateway"})
    if path.startswith(("bim-toolchain/", "schemas/", "examples/", "datasets/", "experimentation/")):
        return frozenset({"bim", "gateway"})
    # The bim-core tests read openbinding-gateway/tests/golden/bim_baseline/*, so those goldens also run the bim area.
    if path in ("openbinding-gateway/pyproject.toml", "openbinding-gateway/uv.lock") or path.startswith("openbinding-gateway/tests/golden/"):
        return frozenset({"bim", "gateway"})
    # test_boundary.py (bim-core) compares the vendored OMG BPMN XSD files with the gateway originals.
    if path.startswith(GATEWAY_VENDOR_BPMN):
        return frozenset({"bim", "gateway"})
    if path.startswith("tools/"):
        return frozenset({"bim", "gateway"}) if "bim" in path.rsplit("/", 1)[-1] else GATEWAY
    if path.startswith(("openbinding-gateway/", *GATEWAY_DIRS)):
        return GATEWAY
    if "/" not in path:
        if path.endswith(".md"):
            return NONE if path in UNREAD_ROOT_MARKDOWN else GATEWAY
        if any(fnmatch.fnmatchcase(path, pattern) for pattern in GATEWAY_ROOT_FILES):
            return GATEWAY
    return None


def changed_paths(paths: list[str]) -> dict[str, bool]:
    """Map the changed paths to one boolean per area; every doubt sets all of them."""
    everything = dict.fromkeys(AREAS, True)
    if not paths:
        # A pull request that changes no file (base == head) is a doubt, not a docs-only change.
        return everything
    areas: set[str] = set()
    for path in paths:
        if path == CI_WORKFLOW or fnmatch.fnmatchcase(path, "tools/ci_*.py"):
            return everything
        found = classify(path)
        if found is None:
            return everything
        areas |= found
        # test_no_kubernetes walks the whole repository for kustomizations and manifests, even in ignored paths.
        # A new repo-wide walk in the gateway tests must be justified here and in test_ci_changes.py (WALKING_TESTS).
        name = path.rsplit("/", 1)[-1]
        # The corpus tests discover every package (a directory with an instance.json) in the whole repository.
        if name == "instance.json":
            areas |= {"bim", "gateway"}
        if name.startswith("kustomization.") or (name.endswith((".yml", ".yaml")) and path.startswith(("acceptance/ui/", "frontend/e2e/"))):
            areas.add("gateway")
    return {area: area in areas for area in AREAS}


def _diff(base: str, head: str) -> list[str] | None:
    """Changed paths between two revisions, or None (reason on stderr) when git cannot tell."""
    if not REVISION.fullmatch(base) or not (head == "HEAD" or REVISION.fullmatch(head)):
        print(f"ci_changes: invalid revision (base={base!r}, head={head!r}); running every area", file=sys.stderr)
        return None
    try:
        done = subprocess.run(["git", "diff", "--name-only", "--no-renames", "-z", base, head], capture_output=True, text=True, check=False)
    except OSError as error:
        print(f"ci_changes: cannot run git ({error}); running every area", file=sys.stderr)
        return None
    if done.returncode != 0:
        print(f"ci_changes: git diff failed ({done.stderr.strip()}); running every area", file=sys.stderr)
        return None
    return [path for path in done.stdout.split("\0") if path]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--event", default="")
    args = parser.parse_args(argv)
    paths = _diff(args.base, args.head) if args.event == "pull_request" else None
    result = changed_paths(paths) if paths is not None else dict.fromkeys(AREAS, True)
    lines = "".join(f"{area}={'true' if result[area] else 'false'}\n" for area in AREAS)
    print(lines, end="")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(lines)
    return 0


if __name__ == "__main__":
    sys.exit(main())
