from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import load_config
from .generator import generate_dataset
from .validation import validate_paths


def csv_set(value: str | None) -> set[str] | None:
    if not value:
        return None
    return {part.strip() for part in value.split(",") if part.strip()}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate and validate BIM v1 instances for the ICSOC placement dataset")
    sub = parser.add_subparsers(dest="command", required=True)

    generate = sub.add_parser("generate", help="Generate v1 instances and trace reports")
    generate.add_argument("--dataset", required=True, help="Path to experimentation/icsoc/original_dataset")
    generate.add_argument("--pricing-dir", required=True, help="Path to the pricings directory")
    generate.add_argument("--config", default=None, help="YAML config file")
    generate.add_argument("--seed", type=int, default=12345, help="Deterministic generator seed")
    generate.add_argument("--out", required=True, help="Output directory")
    generate.add_argument("--applications", default=None, help="Optional comma-separated application ids")
    generate.add_argument("--dataset-seeds", default=None, help="Optional comma-separated dataset seeds")
    generate.add_argument("--sizes", default=None, help="Optional comma-separated infrastructure sizes")

    validate = sub.add_parser("validate", help="Validate generated v1 instances")
    validate.add_argument("--instances", required=True, help="Directory containing generated instances")
    validate.add_argument("--schema", required=True, help="BIM v1 JSON Schema path")
    validate.add_argument("--report", required=True, help="Validation report JSON path")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "generate":
        config = load_config(args.config)
        reports = generate_dataset(
            dataset=Path(args.dataset),
            pricing_dir=Path(args.pricing_dir),
            config=config,
            seed=args.seed,
            out=Path(args.out),
            applications=csv_set(args.applications),
            dataset_seeds=csv_set(args.dataset_seeds),
            sizes=csv_set(args.sizes),
        )
        print(
            "Generated BIM v1 traces: "
            f"{len(reports.candidate_rows)} task summaries, "
            f"{len(reports.pricing_rows)} priced candidates"
        )
        return 0
    if args.command == "validate":
        summary = validate_paths(args.instances, args.schema, args.report)
        print(f"Validated {summary['total']} instance(s): {summary['valid']} valid, {summary['invalid']} invalid")
        return 0 if summary["invalid"] == 0 else 1
    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
