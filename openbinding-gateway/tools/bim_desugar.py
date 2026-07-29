"""Expand the authoring shorthands of a BIM instance into its canonical form.

The gateway does this on the way in, so an instance written the short way
solves exactly like the long one. This is the same expansion, offline: useful
to see what a shorthand stands for, and to produce the canonical fixtures the
engines' own test suites read.

    python openbinding-gateway/tools/bim_desugar.py examples/placement/01_small_placement.json
    python openbinding-gateway/tools/bim_desugar.py instance.json -o canonical.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from openbinding_gateway.semantics.desugar import desugar_instance  # noqa: E402
from openbinding_gateway.semantics.errors import DesugarError  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("instance", type=Path, help="instance JSON to expand")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="where to write the canonical instance (default: stdout)",
    )
    args = parser.parse_args(argv)

    with open(args.instance) as handle:
        instance = json.load(handle)

    try:
        canonical = desugar_instance(instance)
    except DesugarError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    text = json.dumps(canonical, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
        print(f"wrote {args.output}")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
