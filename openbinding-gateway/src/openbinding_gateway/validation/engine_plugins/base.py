import json
import os
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Set, Tuple

import httpx

from ...core.settings import get_settings
from ...models.api import ValidationViolation
from ...models.manifest import EngineManifest


def manifests_dir() -> str:
    """Where the manifests of the engines shipping with the gateway are.

    SCHEMAS_DIR is what the Docker image sets; the repository-relative fallback
    is what local development uses. Resolving it here keeps the walk up five
    directories in one place instead of one copy per plugin.
    """
    base_path = get_settings().schemas_dir
    if not os.path.exists(base_path):
        base_path = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "../../../../../schemas")
        )
    return os.path.join(base_path, "manifests")


def manifest_path(engine_id: str) -> str:
    """Where one in-tree engine's manifest lives."""
    return os.path.join(manifests_dir(), f"{engine_id}.manifest.json")


def composition_task_ids(node: Dict[str, Any]) -> Set[str]:
    """Task ids the composition references, across every branch."""
    found: Set[str] = set()
    kind = node.get("kind")
    if kind == "TASK":
        found.add(node["task_id"])
    for child in node.get("children", []) or []:
        found |= composition_task_ids(child)
    for branch in node.get("branches", []) or []:
        found |= composition_task_ids(branch["child"])
    if node.get("body"):
        found |= composition_task_ids(node["body"])
    return found


def missing_candidate_violations(instance: Dict[str, Any]) -> List[ValidationViolation]:
    """Every task the composition reaches needs at least one candidate.

    Shared because it is a property of the instance, not of any engine: an
    unbindable task is unbindable whoever is asked to solve it.
    """
    task_ids = composition_task_ids(instance["composition"]["root"])
    covered = {
        task
        for candidate in instance.get("candidates", [])
        for task in candidate.get("task_ids") or []
    }
    missing = task_ids - covered
    if not missing:
        return []
    return [
        ValidationViolation(
            code="missing_candidates",
            path="candidates",
            message=f"Missing candidates for tasks: {', '.join(sorted(missing))}",
        )
    ]


class EngineValidationPlugin(ABC):
    """What the gateway needs from an engine.

    A plugin no longer *declares* what its engine can do - its manifest does.
    What is left here is the behaviour a declaration cannot express: the
    semantic checks that are more than a schema, and the translation of the
    request and the response.

    A plugin still does not compute metrics. Every engine's answer goes through
    the reference evaluator in ``semantics.canonicalization``, so features,
    violations and feasibility come from one implementation rather than from
    each engine's arithmetic.
    """

    #: Engine id, used to locate the manifest. Subclasses set it.
    engine_id: str = ""

    #: Parsed once per plugin instance. Manifests do not change under a running
    #: process: an in-tree one ships in the image, and a federated one is
    #: rebuilt by the registry when its row is written.
    _manifest: Optional[EngineManifest] = None

    @abstractmethod
    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        """Perform Stage 4 engine-specific semantic validation."""

    # -- The manifest, and everything derived from it -----------------------

    def get_manifest_path(self) -> str:
        """Where this engine's manifest is on disk.

        Only meaningful for an engine that ships with the gateway. A registered
        engine keeps its manifest in the database, which is why callers ask for
        the manifest rather than for its path.
        """
        return manifest_path(self.engine_id)

    def load_manifest(self) -> EngineManifest:
        """Read and validate this engine's manifest.

        Overridden by the federated plugin, which is handed a manifest instead
        of finding one. Validation is not skipped for an in-tree engine on the
        grounds that it is ours: a manifest that does not parse is a broken
        engine either way, and it is better to learn that at startup than to
        serve a capability dictionary nobody checked.
        """
        with open(self.get_manifest_path(), "r", encoding="utf-8") as handle:
            return EngineManifest.model_validate(json.load(handle))

    def get_manifest(self) -> EngineManifest:
        if self._manifest is None:
            self._manifest = self.load_manifest()
        return self._manifest

    def get_capabilities(self) -> Dict[str, Any]:
        """What this engine can do, as the engines endpoint publishes it.

        Derived rather than written out. When this was a literal dictionary in
        each plugin, an engine described itself in two places - the dictionary
        and its schema - with nothing keeping the two honest.
        """
        return self.get_manifest().as_capabilities_dict()

    def get_instance_schema(self) -> Dict[str, Any]:
        """The schema an instance must satisfy for this engine, from the manifest."""
        return self.get_manifest().instance_schema

    def get_options_schema(self) -> Dict[str, Any]:
        """A JSON Schema for the options this engine accepts, from the manifest.

        Served at ``GET /v1/engines/{engine_id}/options/schema``, so a client can
        find out what it may send rather than reading a plugin.
        """
        return self.get_manifest().options_schema

    def get_default_options(self) -> Dict[str, Any]:
        """Gateway-level default options, used when the client sends none.

        Read off the manifest's options schema, so the defaults a client is told
        about and the defaults it gets are the same values.
        """
        return self.get_manifest().default_options()

    def accepted_option_names(self) -> Set[str]:
        """Which options this engine has a use for, from the manifest.

        Every plugin used to keep its own set of these beside the schema that
        also lists them, which is one more copy of the same fact than an engine
        needs.
        """
        properties = self.get_options_schema().get("properties")
        return set(properties) if isinstance(properties, dict) else set()

    def unsupported_option_warnings(self, options: Dict[str, Any]) -> List[str]:
        """A warning per option the engine will ignore.

        A warning rather than a violation on purpose: an unknown option is a
        client asking for something this engine has no notion of, which is worth
        saying, but it is not a reason to refuse an otherwise valid instance.
        """
        accepted = self.accepted_option_names()
        return [
            f"Option '{name}' is not supported by {self.engine_id}"
            for name in (options or {})
            if name not in accepted
        ]

    async def check_engine_health(self, base_url: str, client: httpx.AsyncClient) -> bool:
        """Whether the engine answers its health endpoint.

        Every engine in the repository exposes the same ``/health``, so this
        is the default; override it for an engine that does something else.
        """
        try:
            response = await client.get(f"{base_url.rstrip('/')}/health")
            return response.status_code == 200
        except Exception:
            return False

    def transform_request(
        self, instance: Dict[str, Any], options: Dict[str, Any] = {}
    ) -> Tuple[Dict[str, Any], List[str]]:
        """Turn a general instance into this engine's request. Returns (payload, warnings).

        The default sends the instance untouched: engines read the composition,
        the constraints and the optional placement blocks themselves.
        """
        return {"instance": instance, "options": options}, []

    def transform_response(
        self, engine_response: Dict[str, Any], original_request: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Turn this engine's response into the general shape. Default: identity."""
        return engine_response
