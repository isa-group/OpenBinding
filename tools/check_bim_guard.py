"""Dependency-free repository guard for the complete BIM v1 cutover."""

from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_PACKAGES = 79
THIRD_PARTY_DIRECTORY_NAMES = {
    ".git",
    ".pnpm-store",
    "dist",
    "node_modules",
    ".venv",
}
THIRD_PARTY_ROOTS = {
    ROOT / "upstream",
    ROOT / "space" / "space-src",
    ROOT / "openbinding-gateway" / "src" / "openbinding_gateway" / "v1" / "vendor",
    # A local 479 MB campaign build is reproducible output, not checked-in
    # language corpus.  ICSOC's official regression generates one case in tmp.
    ROOT / "experimentation" / "icsoc" / "out" / "bim-v1",
}
CACHE_DIRECTORY_NAMES = {"__pycache__", ".pytest_cache", ".ruff_cache"}

# Assemble retired spellings so a plain repository search can itself have zero
# matches. This file is skipped by the textual scan below.
def _retired(*parts: str) -> str:
    return "".join(parts)


_OLD_BRAND = _retired("bim", "star")
_OLD_API_VERSION = _retired("openbinding", "/v1")
_OLD_PRODUCT_VERSION = _retired("openbinding", " v1")
_OLD_SCHEMA_ROOT = _retired("schemas/", "openbinding", "/v1")
FORBIDDEN_PATH_FRAGMENTS = {
    _OLD_BRAND,
    _retired("instance_", "parts"),
    _retired("openbinding_", "v1_resources"),
    _retired("materialize_", "v1_instances"),
    _retired("check_", "v1_corpus"),
    _retired("split_", "schema"),
    _retired("bim_", "desugar"),
    _retired("bim_", "parts"),
    _retired("migrate_", "task_ids"),
}
FORBIDDEN_RELATIVE_PATHS = {
    Path(_retired("schemas/", "general")),
    Path(_retired("examples/placement/", "parts")),
    Path("experimentation/icsoc/report"),
    Path(_retired("openbinding-gateway/src/openbinding_gateway/", "semantics")),
    Path(_retired("openbinding-gateway/src/openbinding_gateway/validation/", "engine_plugins")),
    Path(_retired("docs/ENGINE_", "MANIFEST.md")),
    Path(_retired("docs/ENGINE_", "INTEGRATION_GUIDE.md")),
}
FORBIDDEN_TEXT = {
    _OLD_API_VERSION,
    _OLD_PRODUCT_VERSION,
    _OLD_SCHEMA_ROOT,
    _OLD_BRAND,
    "." + _OLD_BRAND + ".json",
    _retired("project", ".json"),
    _retired("whole", "json"),
    _retired("parts", "json"),
    "/api/" + "instances",
    "/api/" + "jobs",
    "/api/" + "engines",
    "/api/" + "schemas",
    "/api/" + "examples",
    '"task_' + 'ids"',
    '"candidate_' + 'bindings"',
    '"aggregation_' + 'policies"',
    '"resource_' + 'model"',
    '"latency_' + 'model"',
    '"expected_' + 'iterations"',
    '"weights_' + 'sum_to_one"',
    '"qos_' + 'features_supported"',
    '"composition_' + 'nodes_supported"',
    '"objective_' + 'types_supported"',
    '"constraints_' + 'supported"',
    '"instance_' + 'schema"',
    '"manifest_' + 'version"',
    _retired('"iterations_', 'count"'),
    _retired('"time_', 'limit_ms"'),
    _retired('"intermediate_', 'solutions"'),
    _retired('"reference_', 'divisions"'),
    _retired('"distribution_', 'index"'),
    _retired('"div', 'ide"'),
    _retired('"repli', 'cate"'),
    '"same_' + 'candidate"',
    '"different_' + 'candidate"',
    '"scaled_' + 'sum"',
    '"scaled_' + 'product"',
}
TEXT_SUFFIXES = {
    ".conf",
    ".css",
    ".csv",
    ".gradle",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".jsx",
    ".json",
    ".md",
    ".mzn",
    ".py",
    ".rst",
    ".sh",
    ".sql",
    ".svg",
    ".tex",
    ".txt",
    ".toml",
    ".ts",
    ".tsx",
    ".xml",
    ".yaml",
    ".yml",
    ".ipynb",
}
TEXT_FILENAMES = {
    ".dockerignore",
    ".gitignore",
    "Dockerfile",
    "LICENSE",
    "Makefile",
}


def _is_third_party(path: Path) -> bool:
    if path.name in THIRD_PARTY_DIRECTORY_NAMES:
        return True
    return any(path == root or root in path.parents for root in THIRD_PARTY_ROOTS)


def repository_tree() -> tuple[list[Path], list[Path]]:
    directories: list[Path] = []
    files: list[Path] = []
    for directory, subdirectories, filenames in os.walk(ROOT):
        current = Path(directory)
        if _is_third_party(current):
            subdirectories[:] = []
            continue
        directories.append(current)
        subdirectories[:] = [
            name for name in subdirectories if not _is_third_party(current / name)
        ]
        files.extend(current / name for name in filenames)
    return directories, files


def _path_marker(path: Path) -> str | None:
    folded = path.as_posix().casefold()
    for marker in FORBIDDEN_PATH_FRAGMENTS:
        if marker.casefold() in folded:
            return marker
    return None


def _under_forbidden_path(path: Path) -> Path | None:
    for forbidden in FORBIDDEN_RELATIVE_PATHS:
        if path == forbidden or forbidden in path.parents:
            return forbidden
    return None


def _is_text_file(path: Path) -> bool:
    return (
        path.suffix.lower() in TEXT_SUFFIXES
        or path.name in TEXT_FILENAMES
        or path.name == ".env"
        or path.name.startswith(".env.")
    )


def _cache_marker(path: Path) -> str | None:
    if not any(part in CACHE_DIRECTORY_NAMES for part in path.parts):
        return None
    # This guard necessarily carries the retired signatures it detects. Its
    # optional bytecode cache is the binary equivalent of skipping this source
    # file in the text pass below.
    if path.parent.name == "__pycache__" and path.name.startswith("check_bim_guard."):
        return None
    markers = sorted(
        {
            *(marker.encode("utf-8").lower() for marker in FORBIDDEN_TEXT),
            *(marker.encode("utf-8").lower() for marker in FORBIDDEN_PATH_FRAGMENTS),
        },
        key=len,
        reverse=True,
    )
    overlap = max(map(len, markers), default=1) - 1
    try:
        with path.open("rb") as handle:
            previous = b""
            while chunk := handle.read(1024 * 1024):
                haystack = previous + chunk.lower()
                for marker in markers:
                    if marker in haystack:
                        return marker.decode("utf-8")
                previous = haystack[-overlap:] if overlap else b""
    except OSError:
        return None
    return None


def _package_errors(path: Path) -> list[str]:
    prefix = str(path.relative_to(ROOT))
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return [f"{prefix}: invalid JSON ({exc})"]
    if not isinstance(document, dict):
        return [f"{prefix}: root is not an object"]
    errors: list[str] = []
    if document.get("apiVersion") != "bim/v1" or document.get("kind") != "Instance":
        errors.append(f"{prefix}: root is not a bim/v1 Instance")
    spec = document.get("spec", {})
    if spec.get("profile") != "qos-binding/v1":
        errors.append(f"{prefix}: Instance does not select qos-binding/v1")
    resources = spec.get("resources")
    if not isinstance(resources, dict):
        return [*errors, f"{prefix}: spec.resources is not an object"]
    if not resources:
        errors.append(f"{prefix}: spec.resources must be non-empty")

    declared: set[str] = set()
    ids: set[str] = set()
    identities: list[tuple[str, str, str]] = []
    qos_roles = {
        ("qos-binding/v1", "Application"): "application",
        ("qos-binding/v1", "RoutingOverlay"): "application",
        ("omg/bpmn/2.0.2", "BPMN"): "application",
        ("qos-binding-placement/v1", "Placement"): "application",
        ("qos-binding/v1", "CandidateCatalog"): "candidateCatalog",
        ("qos-binding/v1", "ConstraintSet"): "constraintSet",
        ("qos-binding/v1", "Optimization"): "optimization",
    }
    for group_name, group in resources.items():
        if not isinstance(group, dict):
            errors.append(f"{prefix}: resource role {group_name!r} is not an object")
            continue
        if not group:
            errors.append(f"{prefix}: resource group {group_name!r} is empty")
        for resource_id, target in group.items():
            if resource_id in ids:
                errors.append(f"{prefix}: duplicate resource id {resource_id!r}")
            ids.add(resource_id)
            if isinstance(target, dict):
                if set(target) != {"namespace", "name", "version", "digest"}:
                    errors.append(f"{prefix}: registered resource {resource_id!r} is not exactly namespace/name/version/digest")
                continue
            if not isinstance(target, str) or not target:
                errors.append(f"{prefix}: resource {resource_id!r} has no path or registered reference")
                continue
            relative = target
            if relative in declared:
                errors.append(f"{prefix}: duplicate resource path {relative}")
                continue
            declared.add(relative)
            resource_path = path.parent / relative
            if not resource_path.is_file():
                errors.append(f"{prefix}: missing declared resource {relative}")
                continue
            if resource_path.suffix.lower() in {".bpmn", ".xml"}:
                api_version = "omg/bpmn/2.0.2"
                kind = "BPMN"
            elif resource_path.suffix == ".json":
                try:
                    resource = json.loads(resource_path.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                    errors.append(f"{prefix}: invalid resource {relative} ({exc})")
                    continue
                api_version = resource.get("apiVersion")
                kind = resource.get("kind")
            else:
                errors.append(f"{prefix}: unsupported resource media type {relative}")
                continue
            identity = (str(api_version), str(kind))
            identities.append((group_name, *identity))
            expected_role = qos_roles.get(identity)
            if expected_role is None:
                errors.append(f"{prefix}: no installed QoS Dialect claims {identity!r}")
            elif group_name != expected_role:
                errors.append(
                    f"{prefix}: {identity!r} belongs to role {expected_role!r}, not {group_name!r}"
                )

    kinds = [kind for _role, _api_version, kind in identities]
    if kinds.count("Application") != 1:
        errors.append(f"{prefix}: expected exactly one Application")
    if kinds.count("CandidateCatalog") < 1:
        errors.append(f"{prefix}: expected at least one CandidateCatalog")
    if kinds.count("Optimization") != 1:
        errors.append(f"{prefix}: expected exactly one Optimization")
    if kinds.count("RoutingOverlay") > 1:
        errors.append(f"{prefix}: expected at most one RoutingOverlay")

    for resource_path in path.parent.iterdir():
        if resource_path.is_file() and resource_path.name != "instance.json" and resource_path.name not in declared:
            errors.append(f"{prefix}: undeclared package file {resource_path.name}")
    return errors


def main() -> int:
    directories, files = repository_tree()
    roots = sorted(path for path in files if path.name == "instance.json")
    errors: list[str] = []
    if len(roots) != EXPECTED_PACKAGES:
        errors.append(f"expected {EXPECTED_PACKAGES} BIM packages, found {len(roots)}")
    for root in roots:
        errors.extend(_package_errors(root))

    own_path = Path(__file__).resolve()
    retired_directories: set[Path] = set()
    for path in directories:
        relative = path.relative_to(ROOT)
        forbidden = _under_forbidden_path(relative)
        marker = _path_marker(relative)
        if forbidden is not None:
            errors.append(f"retired artifact path: {forbidden}")
            retired_directories.add(forbidden)
        elif marker is not None:
            errors.append(f"retired artifact path: {relative} ({marker!r})")
            retired_directories.add(relative)

    for path in files:
        if path.resolve() == own_path:
            continue
        relative = path.relative_to(ROOT)
        if any(directory == relative or directory in relative.parents for directory in retired_directories):
            continue
        forbidden = _under_forbidden_path(relative)
        marker = _path_marker(relative)
        if forbidden is not None:
            errors.append(f"retired artifact path: {relative} (under {forbidden})")
            continue
        if marker is not None:
            errors.append(f"retired artifact path: {relative} ({marker!r})")
            continue
        cache_marker = _cache_marker(path)
        if cache_marker is not None:
            errors.append(f"{relative}: retired language marker {cache_marker!r} in cache")
            continue
        if not _is_text_file(path):
            continue
        try:
            text = path.read_text(encoding="utf-8").casefold()
        except (OSError, UnicodeDecodeError):
            continue
        for marker in FORBIDDEN_TEXT:
            if marker.casefold() in text:
                errors.append(f"{relative}: retired language marker {marker!r}")

    print(f"BIM guard: {len(roots)} packages, {len(errors)} errors")
    for error in errors[:200]:
        print(error)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
