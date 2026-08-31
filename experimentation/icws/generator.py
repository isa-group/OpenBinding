"""Scale a modular BIM v1 literature package deterministically."""

from __future__ import annotations

import argparse
import copy
import json
import shutil
from pathlib import Path
from typing import Any


def _read_json(path: Path) -> dict[str, Any]:
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise TypeError(f"{path} must contain a JSON object")
    return document


def _write_json(path: Path, document: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _root_path(source: Path) -> Path:
    root = source / "instance.json" if source.is_dir() else source
    if root.name != "instance.json" or not root.is_file():
        raise ValueError("source must be a BIM package directory or its instance.json")
    return root


def scale_package(source: Path, output: Path, copies: int) -> None:
    """Copy *source* to *output* and duplicate every catalog candidate.

    The operation consumes and emits only the modular BIM v1 package shape.
    Candidate ids receive stable numeric suffixes; providers remain shared by
    every copy. No inline resources or alternate representation is accepted.
    """

    if copies < 1:
        raise ValueError("copies must be positive")
    root_path = _root_path(source)
    source_dir = root_path.parent.resolve()
    output = output.resolve()
    if output == source_dir or source_dir in output.parents:
        raise ValueError("output must be outside the source package")
    if output.exists():
        raise FileExistsError(f"output already exists: {output}")

    root = _read_json(root_path)
    if root.get("apiVersion") != "bim/v1" or root.get("kind") != "Instance":
        raise ValueError("source root must be a bim/v1 Instance")
    if root.get("spec", {}).get("profile") != "qos-binding/v1":
        raise ValueError("source root must select the qos-binding/v1 profile")
    resources = root.get("spec", {}).get("resources")
    if not isinstance(resources, dict):
        raise TypeError("Instance.spec.resources must be a grouped object")
    catalogs = resources.get("candidateCatalog")
    if not isinstance(catalogs, dict):
        raise TypeError("Instance.spec.resources.candidateCatalog must be an object")
    if not catalogs:
        raise ValueError("Instance.spec.resources.candidateCatalog must be non-empty")

    shutil.copytree(source_dir, output)
    for resource_id, relative in catalogs.items():
        if not isinstance(relative, str):
            raise TypeError(
                f"CandidateCatalog resource {resource_id!r} must use a local path"
            )
        catalog_path = output / relative
        catalog = _read_json(catalog_path)
        if (
            catalog.get("apiVersion") != "qos-binding/v1"
            or catalog.get("kind") != "CandidateCatalog"
        ):
            raise ValueError(f"{relative} is not a qos-binding/v1 CandidateCatalog")
        spec = catalog.get("spec")
        candidates = spec.get("candidates") if isinstance(spec, dict) else None
        if not isinstance(candidates, dict):
            raise TypeError(f"{relative}: spec.candidates must be an object")

        expanded: dict[str, Any] = {}
        for candidate_id, candidate in candidates.items():
            expanded[candidate_id] = candidate
            for index in range(2, copies + 1):
                expanded[f"{candidate_id}-{index}"] = copy.deepcopy(candidate)
        spec["candidates"] = expanded
        _write_json(catalog_path, catalog)


def main() -> None:
    parser = argparse.ArgumentParser(description="Scale a modular BIM v1 Instance package")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--copies", type=int, default=1)
    args = parser.parse_args()
    scale_package(args.source, args.output, args.copies)


if __name__ == "__main__":
    main()
