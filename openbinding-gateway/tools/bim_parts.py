"""Compose and split BIM instances by element of the tuple.

    # one instance out of a directory of parts
    python openbinding-gateway/tools/bim_parts.py compose examples/placement/parts/edge -o /tmp/edge.json

    # the inverse, for an instance that already exists
    python openbinding-gateway/tools/bim_parts.py split examples/placement/01_small_placement.json -o /tmp/parts

    # a whole corpus, sharing the parts that are identical across it
    python openbinding-gateway/tools/bim_parts.py regroup experimentation/icsoc/out/bimstar-priced/instances -o /tmp/parts
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from openbinding_gateway.semantics.instance_parts import (  # noqa: E402
    NORMALIZATION_PART,
    PART_KEYS,
    compose,
    split,
)


def _read(path: Path) -> Dict[str, Any]:
    with open(path) as handle:
        return json.load(handle)


def _write(path: Path, document: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as handle:
        json.dump(document, handle, indent=2, sort_keys=True)
        handle.write("\n")


def _digest(document: Any) -> str:
    return hashlib.sha1(json.dumps(document, sort_keys=True).encode()).hexdigest()[:12]


def do_compose(args: argparse.Namespace) -> int:
    """Read every part file across the given directories and merge them.

    Several directories are the normal case: the parts an application shares
    across deployments in one, what a particular deployment adds in another.
    """
    parts: Dict[str, Any] = {}
    for directory in (Path(d) for d in args.parts):
        for name in list(PART_KEYS) + [NORMALIZATION_PART]:
            path = directory / f"{name}.json"
            if not path.exists():
                continue
            if name in parts:
                print(f"'{name}' is given by more than one directory", file=sys.stderr)
                return 1
            parts[name] = _read(path)
    if not parts:
        print(f"No part files found in {', '.join(args.parts)}", file=sys.stderr)
        return 1

    instance = compose(parts)
    _write(Path(args.output), instance)
    print(f"composed {len(parts)} parts into {args.output}")
    return 0


def do_split(args: argparse.Namespace) -> int:
    parts = split(_read(Path(args.instance)))
    out = Path(args.output)
    for name, content in parts.items():
        _write(out / f"{name}.json", content)
    print(f"split into {len(parts)} parts under {out}")
    return 0


def do_regroup(args: argparse.Namespace) -> int:
    """Split a corpus, writing each distinct part once and referencing it.

    A part identical across many instances - the application model over a
    family of infrastructures, say - is written to shared/ and named in each
    instance's index instead of being repeated.
    """
    corpus = Path(args.corpus)
    out = Path(args.output)
    instances = sorted(corpus.glob("**/*.json"))
    if not instances:
        print(f"No instances found under {corpus}", file=sys.stderr)
        return 1

    shared: Dict[str, str] = {}
    written = 0
    for path in instances:
        parts = split(_read(path))
        index: Dict[str, str] = {}
        for name, content in parts.items():
            digest = _digest(content)
            key = f"{name}/{digest}"
            if key not in shared:
                _write(out / "shared" / name / f"{digest}.json", content)
                shared[key] = f"shared/{name}/{digest}.json"
                written += 1
            index[name] = shared[key]
        _write(out / "instances" / f"{path.relative_to(corpus).with_suffix('')}.parts.json", index)

    print(f"{len(instances)} instances -> {written} distinct part files")
    for name in list(PART_KEYS) + [NORMALIZATION_PART]:
        count = sum(1 for key in shared if key.startswith(f"{name}/"))
        if count:
            print(f"  {name:<20} {count} distinct")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("compose", help="build one instance from directories of parts")
    p.add_argument("parts", nargs="+", help="directories holding part files; merged in order")
    p.add_argument("-o", "--output", required=True)
    p.set_defaults(func=do_compose)

    p = sub.add_parser("split", help="take one instance apart into its parts")
    p.add_argument("instance")
    p.add_argument("-o", "--output", required=True)
    p.set_defaults(func=do_split)

    p = sub.add_parser("regroup", help="split a corpus, writing each distinct part once")
    p.add_argument("corpus")
    p.add_argument("-o", "--output", required=True)
    p.set_defaults(func=do_regroup)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
