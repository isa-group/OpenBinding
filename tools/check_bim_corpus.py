"""Compile every checked-in BIM package and report its canonical IR digest."""

from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "openbinding-gateway" / "src"))
DERIVED_ROOTS = {ROOT / "experimentation" / "icsoc" / "out" / "bim-v1"}


def package_directories() -> list[Path]:
    skipped = {".git", ".pnpm-store", "node_modules", "target", "dist", ".venv", "__pycache__"}
    roots: list[Path] = []
    for directory, subdirectories, filenames in os.walk(ROOT):
        current = Path(directory)
        subdirectories[:] = [
            name
            for name in subdirectories
            if name not in skipped and current / name not in DERIVED_ROOTS
        ]
        if "instance.json" in filenames:
            roots.append(Path(directory))
            subdirectories[:] = []
    return sorted(roots)


def compile_one(directory: Path) -> tuple[str, str | None, str | None]:
    from openbinding_gateway.v1.compiler import compile_instance
    from openbinding_gateway.v1.package import load_package

    try:
        problem = compile_instance(load_package(directory))
        return str(directory.relative_to(ROOT)), problem.digest, None
    except Exception as exc:  # noqa: BLE001  # pragma: no cover - report every package failure
        return str(directory.relative_to(ROOT)), None, f"{type(exc).__name__}: {exc}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile the complete BIM v1 corpus")
    parser.add_argument("--expected", type=int, default=79)
    parser.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    args = parser.parse_args()

    directories = package_directories()
    errors: list[tuple[str, str]] = []
    digests: dict[str, str] = {}
    if args.jobs <= 1:
        results = (compile_one(directory) for directory in directories)
        for name, package_digest, error in results:
            if error:
                errors.append((name, error))
            elif package_digest:
                digests[name] = package_digest
    else:
        with ProcessPoolExecutor(max_workers=args.jobs) as executor:
            futures = {executor.submit(compile_one, directory): directory for directory in directories}
            for future in as_completed(futures):
                name, package_digest, error = future.result()
                if error:
                    errors.append((name, error))
                elif package_digest:
                    digests[name] = package_digest

    if len(directories) != args.expected:
        errors.append(("corpus", f"expected {args.expected} packages, found {len(directories)}"))
    print(f"BIM corpus: {len(directories)} packages, {len(digests)} compiled, {len(errors)} errors")
    for name, error in sorted(errors)[:100]:
        print(f"{name}: {error}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
