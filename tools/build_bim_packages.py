"""Build deterministic ``.bim.zip`` artifacts from checked-in directories."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "openbinding-gateway" / "src"))

from check_bim_corpus import package_directories
from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import load_package


def _source_directory(value: str) -> Path:
    candidate = Path(value)
    source = candidate.resolve() if candidate.is_absolute() else (ROOT / candidate).resolve()
    try:
        source.relative_to(ROOT)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("source must be inside the repository") from exc
    if not source.is_dir() or not (source / "instance.json").is_file():
        raise argparse.ArgumentTypeError(f"not a BIM package directory: {value}")
    return source


def build(sources: list[Path], output: Path) -> list[tuple[Path, str]]:
    """Validate, compile and export sources without modifying their Git form."""

    destination = output.resolve()
    for source in sources:
        if destination == source or destination.is_relative_to(source):
            raise ValueError(f"output directory cannot be inside BIM source {source}")

    built: list[tuple[Path, str]] = []
    for source in sources:
        package = load_package(source)
        problem = compile_instance(package)
        first = package.to_zip()
        if first != package.to_zip():
            raise RuntimeError(f"non-deterministic export: {source}")
        relative = source.relative_to(ROOT)
        artifact = destination / Path(f"{relative.as_posix()}.bim.zip")
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_bytes(first)
        built.append((artifact, problem.digest))
    return built


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build deterministic .bim.zip files from BIM v1 directories",
    )
    parser.add_argument(
        "sources",
        nargs="*",
        type=_source_directory,
        help="package directories relative to the repository (default: complete corpus)",
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    sources = sorted(set(args.sources or package_directories()))
    if not sources:
        parser.error("no BIM package directories found")
    for artifact, ir_digest in build(sources, args.output):
        print(f"{artifact}: {ir_digest}")
    print(f"Built {len(sources)} deterministic BIM package(s) in {args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
