"""Transform and validate the 48 literature ICWS benchmark instances into BIM v1 packages.

Reconstructs 6 real-world service composition scenarios across 8 objective/constraint
variants (mono_one, mono_utility, multi, many x hard, soft) using the canonical
BIM v1 features and featureBindings schema.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "openbinding-gateway" / "src"))

from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import load_package

DEFAULT_SOURCE = ROOT / "experimentation" / "icws" / "instances"
DEFAULT_TARGET = ROOT / "datasets" / "01_icws"

SCENARIOS = [
    "benatallah2002-selfserv-travel-solution-cts-itas",
    "bultan2003-warehouse-example",
    "cremaschi2018-textbook-access",
    "netedu2020-transport-agency",
    "pautasso2009-restful-ecommerce",
    "zhang2014-entertainment-planner-running-example",
]

VARIANTS = [
    "mono_one_hard",
    "mono_one_soft",
    "mono_utility_hard",
    "mono_utility_soft",
    "multi_hard",
    "multi_soft",
    "many_hard",
    "many_soft",
]


def transform_icws_instances(
    source_dir: Path = DEFAULT_SOURCE,
    target_dir: Path = DEFAULT_TARGET,
    verify: bool = True,
) -> int:
    target_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    errors: list[str] = []

    for scenario in SCENARIOS:
        for variant in VARIANTS:
            name = f"{scenario}_{variant}"
            src_pkg = source_dir / name
            if not src_pkg.is_dir():
                errors.append(f"Missing source instance: {name}")
                continue

            dst_pkg = target_dir / name
            dst_pkg.mkdir(parents=True, exist_ok=True)

            # Copy and normalize all json files
            for file_path in sorted(src_pkg.glob("*.json")):
                with open(file_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                with open(dst_pkg / file_path.name, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, sort_keys=True)
                    f.write("\n")

            if verify:
                try:
                    pkg = load_package(dst_pkg)
                    compile_instance(pkg)
                except Exception as exc:
                    errors.append(f"Failed compiling {name}: {exc}")

            count += 1

    print(f"ICWS Transformation: {count}/48 instances written to {target_dir}")
    if errors:
        for err in errors:
            print(f"  ERROR: {err}")
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Transform ICWS benchmark instances into datasets/01_icws")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Source directory")
    parser.add_argument("--target", type=Path, default=DEFAULT_TARGET, help="Target directory")
    parser.add_argument("--no-verify", action="store_true", help="Skip compilation verification")
    args = parser.parse_args()

    return transform_icws_instances(
        source_dir=args.source,
        target_dir=args.target,
        verify=not args.no_verify,
    )


if __name__ == "__main__":
    raise SystemExit(main())
