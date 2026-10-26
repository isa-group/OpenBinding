#!/usr/bin/env python3
"""Print the test files of shard i/n, balanced greedily longest-first.

[impl->req~ci-speed-gateway-unit-shards~1]
"""

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def collect(root):
    """Return (printed path, weight in bytes) for every test_*.py under root."""
    base = root if root.is_absolute() else REPO / root
    return {
        f"{root.as_posix()}/{p.relative_to(base).as_posix()}": p.stat().st_size
        for p in base.rglob("test_*.py")
        if p.is_file() and "__pycache__" not in p.parts
    }


def assign(weights, n):
    shards = [[] for _ in range(n)]
    loads = [0.0] * n
    for path in sorted(weights, key=lambda p: (-weights[p], p)):
        k = min(range(n), key=lambda j: (loads[j], j))
        shards[k].append(path)
        loads[k] += weights[path]
    return shards


def parse_shard(text):
    try:
        i, n = (int(x) for x in text.split("/"))
    except ValueError:
        raise ValueError(f"--shard must look like i/n, got {text!r}") from None
    if n < 1 or not 1 <= i <= n:
        raise ValueError(f"--shard i/n needs n >= 1 and 1 <= i <= n, got {text!r}")
    return i, n


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--shard", required=True)
    ap.add_argument("--root", default="openbinding-gateway/tests")
    ap.add_argument("--weights", help="JSON file mapping printed path -> seconds")
    args = ap.parse_args(argv)
    try:
        i, n = parse_shard(args.shard)
    except ValueError as err:
        print(f"ci_shard: {err}", file=sys.stderr)
        return 2
    weights = collect(Path(args.root))
    if args.weights:
        measured = json.loads(Path(args.weights).read_text())
        weights = {p: float(measured.get(p, w)) for p, w in weights.items()}
    for path in sorted(assign(weights, n)[i - 1]):
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
