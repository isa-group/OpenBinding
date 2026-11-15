"""One compilation, as the platform keeps it, and the facts read from it.

The compiling itself is the toolchain's (``integrations.bim``). What the platform keeps is a
``Compilation``: the package bytes, the IR as the plain document the toolchain returned, and the
identities and analysis that came with it. No language object crosses this module.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from functools import cached_property
from typing import Any, Mapping

from bim_core.canonical import digest

#: The members of an IR's ``spec`` that record where and how the problem was written, not what it means.
NON_SEMANTIC = frozenset({"profile", "dialects", "instance", "sourceMap"})


def semantic_digest(ir: Mapping[str, Any]) -> str:
    """The digest of what a compiled problem means, the same across toolchain releases that read it alike.

    The canonical digest of the IR's ``spec`` without its ``NON_SEMANTIC`` members: the toolchain's own
    formula (bim-toolchain v0.2.0 ``tools/baseline_core.py:239-241``, ``semantic_digest``), which its corpus
    golden records as ``semanticDigest``. ``tests/test_bim_consumer_contract.py`` and
    ``tests/test_bim_zip_dir_equivalence.py`` pin this function against those goldens.
    """
    spec = ir.get("spec", {}) if isinstance(ir, Mapping) else {}
    return digest({key: value for key, value in spec.items() if key not in NON_SEMANTIC})


def decimal_digits(value: int) -> str:
    """``str(value)`` for a non-negative integer of any size (``str`` refuses past the digit limit)."""
    if value < 0:
        raise ValueError("a cardinality is not negative")
    try:
        return str(value)
    except ValueError:
        chunks: list[str] = []
        while value:
            value, chunk = divmod(value, 10**18)
            chunks.append(f"{chunk:018d}")
        return "".join(reversed(chunks)).lstrip("0") or "0"


def cardinality_text(analysis: Mapping[str, Any] | None) -> str:
    """``bindingSpaceCardinality`` as the decimal string it is on the wire (``"0"`` when unreadable)."""
    value = analysis.get("bindingSpaceCardinality") if isinstance(analysis, Mapping) else None
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return decimal_digits(value)
    if isinstance(value, str) and value.isascii() and value.isdigit():
        return value.lstrip("0") or "0"
    return "0"


def ir_analysis(ir: Mapping[str, Any]) -> dict[str, Any]:
    """The size of the binding space of a stored IR, in the shape of ``CompileResult.analysis``.

    A fresh compilation brings its own analysis; this is for an IR read back without one. It reads
    the eligibility matrix of the IR (a published interchange format) and nothing else;
    ``tests/test_bim_port_integration.py`` checks it against the toolchain's.
    """
    spec = ir.get("spec", {}) if isinstance(ir, Mapping) else {}
    tasks = spec.get("application", {}).get("tasks", {})
    eligibility = spec.get("eligibility", {})
    breakdown = (
        {
            task_id: len(eligibility.get(task_id, []))
            for task_id, task in sorted(tasks.items())
            if isinstance(task, dict) and task.get("kind") == "service"
        }
        if isinstance(tasks, dict) and isinstance(eligibility, dict)
        else {}
    )
    cardinality = 1
    for count in breakdown.values():
        cardinality *= count
    log10 = 0.0 if not breakdown or 0 in breakdown.values() else float(sum(math.log10(c) for c in breakdown.values()))
    catalogs = spec.get("candidates", {})
    candidates = sum(
        len(catalog.get("candidates", {}))
        for catalog in catalogs.values()
        if isinstance(catalog, dict) and isinstance(catalog.get("candidates"), dict)
    ) if isinstance(catalogs, dict) else 0
    return {
        "bindingSpaceLog10": log10,
        "bindingSpaceCardinality": decimal_digits(cardinality),
        "bindingSpaceBreakdown": breakdown,
        "serviceTasks": len(breakdown),
        "candidates": candidates,
    }


def package_file_digests(instance: Mapping[str, Any] | None, ir: Mapping[str, Any]) -> dict[str, str]:
    """Digest of every file of a package: ``instance.json`` and each resource stored at a path.

    The toolchain refuses an entry the Instance does not declare, so these are all the files.
    """
    resources = ir.get("spec", {}).get("instance", {}).get("resources", {})
    digests = {
        item["path"]: item["digest"]
        for item in (resources.values() if isinstance(resources, dict) else ())
        if isinstance(item, dict) and isinstance(item.get("path"), str) and isinstance(item.get("digest"), str)
    }
    if instance is not None:
        digests["instance.json"] = digest(instance)
    return dict(sorted(digests.items()))


def source_resource_digests(ir: Mapping[str, Any]) -> dict[str, str]:
    """``resource id -> digest`` of every resource of the package, as the IR records them."""
    resources = ir.get("spec", {}).get("instance", {}).get("resources", {})
    return {
        resource_id: descriptor["digest"]
        for resource_id, descriptor in sorted(resources.items())
        if isinstance(descriptor, dict) and isinstance(descriptor.get("digest"), str)
    }


def media_type_of(path: str) -> str:
    lowered = path.lower()
    if lowered.endswith(".json"):
        return "application/json"
    if lowered.endswith(".bpmn"):
        return "application/vnd.omg.bpmn+xml"
    if lowered.endswith(".xml"):
        return "application/xml"
    return "application/octet-stream"


def package_files(instance: Mapping[str, Any], ir: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The files of a package as package facts: ``path``, ``role``, ``resource_id``, ``digest``, ``media_type``.

    Only what the package itself says. What the installed toolchain makes of a resource (its
    ``apiVersion``, ``kind`` and dialect) is read from a compilation's IR instead, because it can change
    with the toolchain while the package does not.
    """
    digests = package_file_digests(instance, ir)
    files = [{
        "path": "instance.json",
        "role": "instance",
        "resource_id": None,
        "digest": digests["instance.json"],
        "media_type": "application/json",
    }]
    groups = instance.get("spec", {}).get("resources", {}) if isinstance(instance.get("spec"), Mapping) else {}
    for role, group in sorted(groups.items()) if isinstance(groups, Mapping) else ():
        if not isinstance(group, Mapping):
            continue
        for resource_id, path in sorted(group.items()):
            if not isinstance(path, str) or path not in digests:
                continue
            files.append({
                "path": path,
                "role": role,
                "resource_id": resource_id,
                "digest": digests[path],
                "media_type": media_type_of(path),
            })
    return files


@dataclass(frozen=True)
class Compilation:
    """One compilation: the package and what the toolchain said about it."""

    archive: bytes
    #: The root index (``instance.json``) of the package.
    instance: dict[str, Any]
    ir: dict[str, Any]
    ir_digest: str
    instance_digest: str | None
    package_digest: str
    compilation_digest: str
    source_map: dict[str, Any]
    analysis: dict[str, Any]
    toolchain: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_result(cls, archive: bytes, instance: Mapping[str, Any], result: Mapping[str, Any]) -> "Compilation":
        ir = result["ir"]
        return cls(
            archive=archive,
            instance=dict(instance),
            ir=ir,
            ir_digest=result["irDigest"],
            instance_digest=result.get("instanceDigest"),
            package_digest=result["packageDigest"],
            compilation_digest=result["compilationDigest"],
            source_map=result.get("sourceMap") or {},
            analysis=result.get("analysis") or ir_analysis(ir),
            toolchain=dict(result.get("toolchain") or {}),
        )

    @property
    def compiler_digest(self) -> str | None:
        """The ``compilerDigest`` the compile result reports (D6), not the cached capabilities."""
        value = self.toolchain.get("compilerDigest")
        return value if isinstance(value, str) and value else None

    @property
    def spec(self) -> dict[str, Any]:
        return self.ir["spec"]

    @property
    def binding_space_text(self) -> str:
        """``bindingSpaceCardinality`` as the decimal string it is on the wire (``"0"`` when unreadable)."""
        return cardinality_text(self.analysis)

    @cached_property
    def semantic_digest(self) -> str:
        return semantic_digest(self.ir)

    @cached_property
    def file_digests(self) -> dict[str, str]:
        return package_file_digests(self.instance, self.ir)

    @cached_property
    def resource_digests(self) -> dict[str, str]:
        return source_resource_digests(self.ir)

    @cached_property
    def files(self) -> list[dict[str, Any]]:
        return package_files(self.instance, self.ir)


def analysis_summary(ir: Mapping[str, Any], analysis: Mapping[str, Any]) -> dict[str, Any]:
    """The analysis the API reports: tasks, candidates, constraints, placement and the binding space."""
    spec = ir.get("spec", {}) if isinstance(ir, Mapping) else {}
    return {
        "tasks": len(spec.get("application", {}).get("tasks", [])),
        "candidates": int(analysis.get("candidates") or 0),
        "constraints": len(spec.get("constraints", [])),
        "placement": bool(spec.get("placement")),
        "bindingSpace": cardinality_text(analysis),
    }


def resource_contracts(ir: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """``resource id -> {role, path, apiVersion, kind, dialect}`` as this compilation's IR records them."""
    spec = ir.get("spec", {}) if isinstance(ir, Mapping) else {}
    resources = spec.get("instance", {}).get("resources", {})
    out: dict[str, dict[str, Any]] = {}
    for resource_id, descriptor in sorted(resources.items()) if isinstance(resources, Mapping) else ():
        if not isinstance(descriptor, Mapping):
            continue
        out[resource_id] = {
            "role": descriptor.get("role"),
            "path": descriptor.get("path"),
            "apiVersion": descriptor.get("apiVersion"),
            "kind": descriptor.get("kind"),
            "dialect": descriptor.get("dialect"),
        }
    return out
