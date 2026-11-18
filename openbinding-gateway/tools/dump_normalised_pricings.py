#!/usr/bin/env python3
"""Write the goldens of the Python Pricing2Yaml normaliser over the recorded SPHERE set.

For every recorded version (``tests/fixtures/sphere/<pricingId>/<versionId>.yml``) and every synthetic one
(``derived/*.yml``) it writes ``<pricingId>@<versionId>.json`` (``derived@<name>.json``): the normalised
pricing (``as_json``) and ``effective()`` of every plan and every single subscription add-on variant
(``single_variants``), or the refusal of a version the normaliser does not read (Pricing2Yaml 2.x).
The frontend's parity test (``frontend/src/test/sphere/normaliserParity.test.ts``) holds pricing-renderer
to these files.

    python tools/dump_normalised_pricings.py              # rewrite tests/fixtures/sphere/normalised/
    python tools/dump_normalised_pricings.py --out DIR    # write to DIR instead (and nowhere else)
    python tools/dump_normalised_pricings.py --check      # fail if the checked-in goldens differ
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from openbinding_gateway.modules.plans.domain.errors import PricingInvalid  # noqa: E402
from openbinding_gateway.modules.plans.domain.pricing2yaml import (  # noqa: E402
    as_json,
    effective,
    effective_json,
    normalise_text,
    single_variants,
)

SFX = ROOT / "tests" / "fixtures" / "sphere"
DEFAULT_OUT = SFX / "normalised"


def sources(root: Path = SFX) -> dict[str, Path]:
    """Golden name -> recorded or derived YAML, in a fixed order."""
    found: dict[str, Path] = {}
    for manifest in sorted(root.glob("*/manifest.json")):
        for path in sorted(manifest.parent.glob("*.yml")):
            found[f"{manifest.parent.name}@{path.stem}.json"] = path
    for path in sorted((root / "derived").glob("*.yml")):
        found[f"derived@{path.stem}.json"] = path
    return found


def golden(path: Path) -> dict[str, Any]:
    try:
        pricing = normalise_text(path.read_bytes())
    except PricingInvalid as exc:
        return {"refused": exc.code, "message": exc.message}
    variants = {}
    for plan, add_on in single_variants(pricing):
        key = plan if add_on is None else f"{plan}+{add_on}"
        variants[key] = effective_json(effective(pricing, plan, {add_on: 1} if add_on else None))
    return {"pricing": as_json(pricing), "effective": variants}


def render(path: Path) -> str:
    return json.dumps(golden(path), indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--out", type=Path, help="write the goldens to this directory")
    group.add_argument("--check", action="store_true", help="fail if the checked-in goldens differ")
    args = parser.parse_args(argv)
    wanted = {name: render(path) for name, path in sources().items()}
    if args.check:
        drift = []
        present = {p.name for p in DEFAULT_OUT.glob("*.json")} if DEFAULT_OUT.is_dir() else set()
        for name, text in wanted.items():
            target = DEFAULT_OUT / name
            if not target.exists() or target.read_text(encoding="utf-8") != text:
                drift.append(name)
        drift.extend(sorted(present - set(wanted)))
        for name in drift:
            print(f"drift {name}")
        return 1 if drift else 0
    out = args.out or DEFAULT_OUT
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.json"):
        if stale.name not in wanted:
            stale.unlink()
    for name, text in wanted.items():
        (out / name).write_text(text, encoding="utf-8")
    print(f"wrote {len(wanted)} goldens to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
