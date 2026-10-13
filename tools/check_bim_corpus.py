"""Compile every checked-in BIM package and report its canonical IR digest."""

from __future__ import annotations

import argparse
import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DERIVED_ROOTS = {
    ROOT / "experimentation" / "icsoc" / "out" / "bim-v1",
    ROOT / "datasets",
    # Frontend test fixtures are not part of the checked-in corpus.
    ROOT / "frontend",
}


def package_directories(base: Path = ROOT, excluded: set[Path] | None = None) -> list[Path]:
    skipped = {".git", ".pnpm-store", "node_modules", "target", "dist", ".venv", "__pycache__"}
    excluded = DERIVED_ROOTS if excluded is None else excluded
    roots: list[Path] = []
    for directory, subdirectories, filenames in os.walk(base):
        current = Path(directory)
        subdirectories[:] = [
            name
            for name in subdirectories
            if name not in skipped and current / name not in excluded
        ]
        if "instance.json" in filenames:
            roots.append(Path(directory))
            subdirectories[:] = []
    return sorted(roots)


def compile_one(directory: Path) -> tuple[str, str | None, str | None]:
    from bim_core import compile_instance, load_package

    try:
        problem = compile_instance(load_package(directory))
        return str(directory.relative_to(ROOT)), problem.digest, None
    except Exception as exc:  # noqa: BLE001  # pragma: no cover - report every package failure
        return str(directory.relative_to(ROOT)), None, f"{type(exc).__name__}: {exc}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile the complete BIM v1 corpus")
    parser.add_argument("--expected", type=int, default=82)
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
