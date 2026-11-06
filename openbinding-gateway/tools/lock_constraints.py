#!/usr/bin/env python3
"""Turn ``uv.lock`` into a pip constraints file, so the image installs what CI installs.

The gateway's image cannot install from the lock the way CI does. CI runs
``uv sync --locked``; the image runs ``uv pip install`` with ``--no-sources``, because
``bim-core`` and ``bim-client`` are declared in ``[tool.uv.sources]`` as editable paths
relative to the gateway and the image deliberately carries only those two package
directories, not the ``bim-toolchain`` workspace root they belong to. Without that root
``uv export`` cannot build their metadata and refuses to emit anything at all, so the
lock could not be honoured even if it were copied in.

Reading the lock as data sidesteps all of it. A constraints file needs nothing but
``name==version`` pairs: it pins whatever the resolver happens to need without adding a
single requirement of its own, which is exactly the shape the image's one install command
can take. No network, no metadata build, no resolver, and the result is a pure function of
the lock.

What is deliberately left unpinned:

* The three editable entries -- the two BIM packages and the gateway itself. They are
  installed from paths inside the image and have no registry version to constrain.
* Any name the lock records twice. ``numpy`` and ``scipy`` are locked at two versions
  each, selected by environment marker, and a constraints file cannot say "either of
  these": one pin would be wrong on one of the two platforms. Those are reported on
  stderr rather than guessed at, so the build log states what it did not pin.

Usage::

    python tools/lock_constraints.py uv.lock > constraints.txt
    python tools/lock_constraints.py uv.lock -o constraints.txt
"""

from __future__ import annotations

import argparse
import collections
import sys
import tomllib
from pathlib import Path


def constraints(lock: dict) -> tuple[list[str], list[str], list[str]]:
    """The pins, the names skipped for having no single version, and the editable ones."""
    packages = lock.get("package") or []
    seen = collections.Counter(entry["name"] for entry in packages)
    pins: list[str] = []
    ambiguous: list[str] = []
    editable: list[str] = []
    for entry in sorted(packages, key=lambda item: (item["name"], item.get("version", ""))):
        name = entry["name"]
        source = entry.get("source") or {}
        if "registry" not in source:
            editable.append(name)
            continue
        if seen[name] > 1:
            if name not in ambiguous:
                ambiguous.append(name)
            continue
        version = entry.get("version")
        if not version:
            ambiguous.append(name)
            continue
        pins.append(f"{name}=={version}")
    return pins, ambiguous, editable


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("lock", type=Path, help="path to uv.lock")
    parser.add_argument("-o", "--output-file", type=Path, default=None)
    args = parser.parse_args(argv)

    lock = tomllib.loads(args.lock.read_text(encoding="utf-8"))
    pins, ambiguous, editable = constraints(lock)
    if not pins:
        print(f"lock_constraints: {args.lock} pinned nothing; refusing to write", file=sys.stderr)
        return 1

    header = [
        "# Generated from uv.lock by tools/lock_constraints.py. Do not edit.",
        f"# {len(pins)} pinned."
        + (f" Not pinned, locked at more than one version: {', '.join(ambiguous)}." if ambiguous else "")
        + (f" Installed from a path in the image: {', '.join(editable)}." if editable else ""),
    ]
    text = "\n".join([*header, *pins]) + "\n"
    if args.output_file is None:
        sys.stdout.write(text)
    else:
        args.output_file.write_text(text, encoding="utf-8")
    print(
        f"lock_constraints: pinned {len(pins)}"
        + (f", left {len(ambiguous)} unpinned ({', '.join(ambiguous)})" if ambiguous else "")
        + (f", {len(editable)} installed from paths" if editable else ""),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
