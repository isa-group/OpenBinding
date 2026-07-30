"""Finding the engines that ship with the gateway, by looking.

Adding an in-tree engine used to mean five edits: a manifest, a plugin class, a
settings field, an entry in the ``engine_urls`` dictionary, and a
``register()`` line. Four of those said nothing the manifest had not already
said, and each was a place to forget.

Now a manifest on disk *is* the registration. A file in ``schemas/manifests/``
becomes an engine; its URL comes from ``ENGINE_<ID>_URL`` by convention; and a
Python plugin is needed only by an engine whose request or response shape
differs from the contract, or which enforces something a schema cannot express.

An engine that implements ``schemas/engine-contract.openapi.yaml`` therefore
costs a manifest and an environment variable, and no code at all.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from ..models.manifest import EngineManifest
from ..validation.engine_plugins.base import EngineValidationPlugin, manifests_dir

logger = logging.getLogger(__name__)

MANIFEST_SUFFIX = ".manifest.json"


def url_env_var(engine_id: str) -> str:
    """The environment variable naming where an engine listens.

    ``random-search`` reads ``ENGINE_RANDOM_SEARCH_URL``. A convention rather
    than a registry entry, so that adding an engine does not mean editing a
    dictionary that only exists to repeat the engine's own name.
    """
    return f"ENGINE_{engine_id.upper().replace('-', '_')}_URL"


class ManifestEnginePlugin(EngineValidationPlugin):
    """An in-tree engine that needs no Python.

    Everything a plugin used to declare now comes from the manifest, and the
    request and response transformations default to the identity - which is
    correct for any engine implementing the contract in
    ``schemas/engine-contract.openapi.yaml``. What is left for a real subclass
    is the two things a manifest cannot express: a request shape that differs
    from the contract, and semantic checks beyond a JSON Schema.
    """

    def __init__(self, engine_id: str, manifest: Optional[EngineManifest] = None) -> None:
        self.engine_id = engine_id
        self._preloaded = manifest

    def load_manifest(self) -> EngineManifest:
        if self._preloaded is not None:
            return self._preloaded
        return super().load_manifest()

    def validate_semantics(self, instance: Dict[str, Any]) -> List[Any]:
        """Stage 4, from the declaration alone.

        The same capability-driven checks a federated engine gets: node kinds,
        objective type, constraint families. An engine needing more than that
        writes a subclass and overrides this.
        """
        from ..validation.engine_plugins.base import capability_violations

        return capability_violations(instance, self.get_capabilities())

    def transform_request(self, instance, options={}):
        """The contract's request shape, plus a word about ignored options.

        The base class sends the same body; what this adds is the warning, so
        that an engine whose options are declared in a manifest tells a caller
        about a typo instead of silently dropping it.
        """
        return {"instance": instance, "options": options}, self.unsupported_option_warnings(
            options
        )


def manifest_ids(directory: Optional[str] = None) -> List[str]:
    """The engine ids with a manifest on disk, in a stable order."""
    directory = directory or manifests_dir()
    if not os.path.isdir(directory):
        return []
    return sorted(
        name[: -len(MANIFEST_SUFFIX)]
        for name in os.listdir(directory)
        if name.endswith(MANIFEST_SUFFIX)
    )


def load_manifests(
    directory: Optional[str] = None,
) -> Tuple[Dict[str, EngineManifest], List[str]]:
    """Every in-tree manifest, plus a note for each that would not parse.

    One broken manifest does not take the others with it: a deployment with a
    typo in a new engine's file should lose that engine, not all of them.
    """
    directory = directory or manifests_dir()
    manifests: Dict[str, EngineManifest] = {}
    problems: List[str] = []

    for engine_id in manifest_ids(directory):
        path = os.path.join(directory, f"{engine_id}{MANIFEST_SUFFIX}")
        try:
            with open(path, "r", encoding="utf-8") as handle:
                manifest = EngineManifest.model_validate(json.load(handle))
        except Exception as error:  # noqa: BLE001 - one bad file must not hide the rest
            problems.append(f"{engine_id}: {error}")
            logger.warning("Ignoring unreadable manifest %s: %s", path, error)
            continue

        if manifest.engine_id != engine_id:
            problems.append(
                f"{engine_id}: the manifest calls itself {manifest.engine_id!r}; "
                f"the filename and engine_id have to agree."
            )
            continue

        if manifest.is_federated:
            problems.append(
                f"{engine_id}: this manifest declares a transport, so it describes a "
                f"federated engine and does not belong in the in-tree directory."
            )
            continue

        manifests[engine_id] = manifest

    return manifests, problems


def discover(registry, directory: Optional[str] = None) -> List[str]:
    """Register an engine for every manifest that has no plugin already.

    Called once at import, after the handwritten plugins have registered
    themselves, so a manifest never displaces a plugin that exists for a
    reason. Returns the ids it added, which is what the scaffolding tool prints
    and what a test asserts on.
    """
    manifests, _ = load_manifests(directory)

    added: List[str] = []
    for engine_id, manifest in manifests.items():
        if engine_id in registry._plugins:
            continue
        registry.register(engine_id, ManifestEnginePlugin(engine_id, manifest))
        added.append(engine_id)

    return added
