"""Loading the general schema, which is split across one file per model.

The schema follows the decomposition of the problem itself,
I' = (M_A, M'_C, Delta, O), one file per element, so that a model can be
referenced and reused on its own. Everything that consumes the schema still
wants one document, so the modules are inlined into a bundle on load.

Bundling rather than resolving lazily keeps a single behaviour for every
consumer: the validator, the OpenAPI description, and the ``/v1/schemas``
endpoint all see exactly the same document a monolithic file would have been.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional


def resolve_schema_path(env_var: str, filename: str) -> Path:
    """Where a schema file lives, across the layouts this runs in."""
    env_path = os.getenv(env_var)
    candidates: List[Path] = []
    if env_path:
        candidate = Path(env_path)
        # The variable names the general schema; siblings live beside it.
        candidates.append(candidate if candidate.name == filename else candidate.parent / filename)

    this_file = Path(__file__).resolve()
    candidates.extend(
        [
            this_file.parents[3] / "schemas" / "general" / filename,
            this_file.parents[4] / "schemas" / "general" / filename,
            Path(f"/app/schemas/general/{filename}"),
        ]
    )

    found: Optional[Path] = next((p for p in candidates if p.exists()), None)
    if found is None:
        raise FileNotFoundError(
            f"Schema '{filename}' not found. Tried: " + ", ".join(str(p) for p in candidates)
        )
    return found


def _localize(node: Any) -> Any:
    """Turn cross-file ``$ref``s into pointers inside the bundle."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ".schema.json#" in ref:
            return {**node, "$ref": "#" + ref.split("#", 1)[1]}
        return {key: _localize(value) for key, value in node.items()}
    if isinstance(node, list):
        return [_localize(item) for item in node]
    return node


def _module_files(directory: Path) -> List[Path]:
    return sorted(p for p in directory.glob("*.schema.json") if p.name != "schema.json")


def load_general_schema() -> Dict[str, Any]:
    """The general schema as one self-contained document.

    Every module's ``$defs`` are merged into the root and the cross-file
    references become local pointers. Merging rather than expanding in place is
    what makes recursive definitions work: a composition node contains nodes,
    so inlining it by value would never terminate.
    """
    root_path = resolve_schema_path("GENERAL_SCHEMA_PATH", "schema.json")
    directory = root_path.parent

    with open(root_path) as handle:
        bundle = json.load(handle)

    defs: Dict[str, Any] = dict(bundle.get("$defs") or {})
    properties: Dict[str, Dict[str, Any]] = {}

    for path in _module_files(directory):
        with open(path) as handle:
            module = json.load(handle)
        for name, definition in (module.get("$defs") or {}).items():
            if name in defs:
                raise ValueError(f"'{name}' is defined by more than one schema module")
            defs[name] = _localize(definition)
        for name, definition in (module.get("properties") or {}).items():
            properties[f"{path.name}#/properties/{name}"] = _localize(definition)

    def resolve_property(node: Any) -> Any:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and "#/properties/" in ref:
                return properties[ref]
            return {key: resolve_property(value) for key, value in node.items()}
        if isinstance(node, list):
            return [resolve_property(item) for item in node]
        return node

    # Properties are resolved before references are localized: localizing
    # first would drop the file name the lookup needs.
    bundle["properties"] = {
        name: _localize(resolve_property(value))
        for name, value in bundle["properties"].items()
    }
    bundle["$defs"] = defs
    return bundle
