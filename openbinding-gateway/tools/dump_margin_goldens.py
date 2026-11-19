#!/usr/bin/env python3
"""Write the margin goldens: ``margins.compute()`` over the cases of ``tests/golden/margins/cases.json``.

Every input is offline: a recorded SPHERE version (``tests/fixtures/sphere``), optionally changed by the case
(``set``: dotted paths into the YAML document), or a generated offering, and a synthetic evaluation (global values,
values status, outcome, offering status). Each case gives ``<case>.json`` beside ``cases.json``.

    python tools/dump_margin_goldens.py              # rewrite tests/golden/margins/<case>.json
    python tools/dump_margin_goldens.py --out DIR    # write to DIR instead (and nowhere else)
    python tools/dump_margin_goldens.py --check      # fail if the checked-in goldens differ
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from openbinding_gateway.modules.compositions.application.margins import compute  # noqa: E402
from openbinding_gateway.modules.plans.domain.pricing2yaml import normalise, normalise_text  # noqa: E402

SFX = ROOT / "tests" / "fixtures" / "sphere"
GOLDEN = ROOT / "tests" / "golden" / "margins"
CASES = GOLDEN / "cases.json"
#: The generated 300 x 300 offering must answer within this (the margins never loop over plans x add-ons).
MANY_VARIANTS_SECONDS = 1.0


def _wide(plans: int, add_ons: int):
    return normalise({
        "syntaxVersion": "3.0", "saasName": "Wide", "version": "1", "createdAt": "2026-01-01", "currency": "USD",
        "features": {"f": {"valueType": "BOOLEAN", "defaultValue": True, "type": "DOMAIN"}},
        "plans": {f"p{i:03d}": {"price": i, "unit": "user/month", "features": None} for i in range(plans)},
        "addOns": {
            f"a{j:03d}": {"price": 1, "unit": "/month", "availableFor": [f"p{i:03d}" for i in range(plans)]}
            for j in range(add_ons)
        },
    })


def _set(document: dict[str, Any], dotted: str, value: Any) -> None:
    *path, last = dotted.split(".")
    node = document
    for key in path:
        node = node[key]
    node[last] = value


def offering(spec: dict[str, Any] | None):
    if spec is None:
        return None
    if spec.get("generated") == "wide":
        return _wide(spec["plans"], spec["addOns"])
    raw = (SFX / spec["sfx"]).read_bytes()
    if not spec.get("set"):
        return normalise_text(raw)
    document = yaml.safe_load(raw)
    for dotted, value in spec["set"].items():
        _set(document, dotted, value)
    return normalise(document)


def _values(values: dict[str, Any]) -> dict[str, Any]:
    return {
        name: {**item, "value": float(item["value"]) if item["value"] == "inf" else item["value"]}
        for name, item in values.items()
    }


def golden(name: str, case: dict[str, Any]) -> dict[str, Any]:
    pricing = offering(case["offering"])
    status = case.get("offeringStatus", "read" if case["offering"] is not None else None)
    started = time.perf_counter()
    answer = compute(
        _values(case["values"]), case.get("valuesStatus", "verified"), case.get("outcome", "verified"), pricing,
        status, case.get("users"), case.get("billing"), case.get("cost"),
    )
    elapsed = time.perf_counter() - started
    if name == "many-variants" and elapsed > MANY_VARIANTS_SECONDS:
        raise SystemExit(f"many-variants took {elapsed:.2f} s (more than {MANY_VARIANTS_SECONDS} s)")
    return answer


def render(name: str, case: dict[str, Any]) -> str:
    return json.dumps(golden(name, case), indent=2, ensure_ascii=False) + "\n"


def cases() -> dict[str, dict[str, Any]]:
    return json.loads(CASES.read_text(encoding="utf-8"))["cases"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--out", type=Path, help="write the goldens to this directory")
    group.add_argument("--check", action="store_true", help="fail if the checked-in goldens differ")
    args = parser.parse_args(argv)
    wanted = {f"{name}.json": render(name, case) for name, case in cases().items()}
    if args.check:
        present = {path.name for path in GOLDEN.glob("*.json")} - {CASES.name}
        drift = sorted(name for name, text in wanted.items()
                       if not (GOLDEN / name).exists() or (GOLDEN / name).read_text(encoding="utf-8") != text)
        extra = sorted(present - set(wanted))
        if drift or extra:
            print(f"margin goldens differ: {drift}; not a case: {extra}", file=sys.stderr)
            return 1
        print(f"{len(wanted)} margin goldens match.")
        return 0
    out = args.out or GOLDEN
    out.mkdir(parents=True, exist_ok=True)
    for name, text in wanted.items():
        (out / name).write_text(text, encoding="utf-8")
    print(f"wrote {len(wanted)} margin goldens to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
