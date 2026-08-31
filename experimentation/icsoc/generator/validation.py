"""Validation helpers for generated BIM v1 packages."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from openbinding_gateway.v1.compiler import CompileError, compile_instance
from openbinding_gateway.v1.package import InstancePackage, load_package


@dataclass
class Violation:
    code: str
    path: str
    message: str
    stage: str = "semantic"

    def as_dict(self) -> dict[str, str]:
        return {"stage": self.stage, "code": self.code, "path": self.path, "message": self.message}


def validate_instance(
    package: InstancePackage | str | Path,
    schema_path: str | Path | None = None,
) -> list[Violation]:
    """Compile a complete generated package and translate its diagnostics."""
    if not isinstance(package, InstancePackage):
        package = load_package(package)
    instance = package.instance()
    if instance.get("apiVersion") != "bim/v1" or instance.get("kind") != "Instance":
        return [Violation("instance_kind", "/kind", "generated document must be a bim/v1 Instance", "schema")]
    if instance.get("spec", {}).get("profile") != "qos-binding/v1":
        return [
            Violation(
                "instance_profile",
                "/spec/profile",
                "generated document must select the qos-binding/v1 profile",
                "schema",
            )
        ]
    try:
        compile_instance(package)
    except CompileError as exc:
        return [Violation(item.code, item.pointer or "/", item.message) for item in exc.diagnostics]
    return []


def validate_paths(instances: str | Path, schema: str | Path | None, report: str | Path) -> dict[str, Any]:
    root = Path(instances)
    results = []
    valid = 0
    for path in sorted(root.rglob("instance.json")):
        violations = validate_instance(path.parent, schema)
        if not violations:
            valid += 1
        results.append({"path": str(path), "valid": not violations, "violations": [v.as_dict() for v in violations]})
    summary = {"total": len(results), "valid": valid, "invalid": len(results) - valid, "results": results}
    Path(report).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary
