import json
import os
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Set, Tuple

import httpx

from ...core.settings import get_settings
from ...models.api import ValidationViolation
from ...models.manifest import EngineManifest


def manifests_dir_for(schemas_dir: str) -> str:
    """Where manifests live under a given schemas directory.

    Takes the directory rather than reading it, so that a ``Settings`` instance
    can answer for itself. Reading the global settings here meant an object
    constructed with its own ``schemas_dir`` still consulted somebody else's.
    """
    if not os.path.exists(schemas_dir):
        # SCHEMAS_DIR is what the Docker image sets; this is what a checkout has.
        schemas_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "../../../../../schemas")
        )
    return os.path.join(schemas_dir, "manifests")


def manifests_dir() -> str:
    """Where the manifests of the engines shipping with the gateway are."""
    return manifests_dir_for(get_settings().schemas_dir)


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


#: How a constraint's ``kind`` in an instance maps onto the capability family
#: an engine declares. The two vocabularies differ because one describes a
#: document and the other describes an engine; this is the one place that
#: knows both.
CONSTRAINT_FAMILY_BY_KIND = {
    "ATTRIBUTE_BOUND": "attribute_bound",
    "DEPENDENCY": "dependency",
    "RESOURCE_CAPACITY": "resource_capacity",
    "LATENCY_TRANSITION": "latency_transition",
}


def composition_node_kinds(node: Dict[str, Any]) -> Set[str]:
    """Every node kind the composition uses, across every branch."""
    if not isinstance(node, dict):
        return set()

    found = {node["kind"]} if isinstance(node.get("kind"), str) else set()
    for child in node.get("children", []) or []:
        found |= composition_node_kinds(child)
    for branch in node.get("branches", []) or []:
        found |= composition_node_kinds((branch or {}).get("child", {}))
    if node.get("body"):
        found |= composition_node_kinds(node["body"])
    return found


def capability_violations(
    instance: Dict[str, Any], capabilities: Dict[str, Any]
) -> List[ValidationViolation]:
    """What an engine's declared capabilities alone say about this instance.

    Three checks - node kinds, objective type, constraint families - derived
    from the declaration rather than written per engine. That is most of what
    the four built-in plugins hand-roll, and it is all a registered engine can
    have, since its author cannot ship code here.

    Silence is not consent: an engine that declares no constraint families is
    read as placing no restriction, rather than as refusing every constrained
    instance. The alternative would turn an omitted optional field into a
    blanket rejection.
    """
    violations: List[ValidationViolation] = []

    composition = instance.get("composition") or {}
    supported_nodes = set(capabilities.get("composition_nodes_supported") or [])
    if supported_nodes:
        used = composition_node_kinds(composition.get("root") or {})
        for node in composition.get("nodes", []) or []:
            if isinstance(node, dict) and isinstance(node.get("kind"), str):
                used.add(node["kind"])
        for kind in sorted(used - supported_nodes):
            violations.append(
                ValidationViolation(
                    code="engine_unsupported_feature",
                    path="composition",
                    message=f"Engine does not support node kind '{kind}'",
                )
            )

    supported_objectives = set(capabilities.get("objective_types_supported") or [])
    objective_type = (instance.get("objective") or {}).get("type")
    if supported_objectives and objective_type and objective_type not in supported_objectives:
        violations.append(
            ValidationViolation(
                code="unsupported_objective_type",
                path="objective.type",
                message=(
                    f"Engine does not support '{objective_type}' objectives; it declares "
                    f"{', '.join(sorted(supported_objectives))}"
                ),
            )
        )

    supported_families = set(capabilities.get("constraints_supported") or [])
    if supported_families:
        for index, constraint in enumerate(instance.get("constraints", []) or []):
            if not isinstance(constraint, dict):
                continue
            kind = str(constraint.get("kind") or "").upper()
            family = CONSTRAINT_FAMILY_BY_KIND.get(kind)
            # An unrecognised kind is the general schema's problem, caught in
            # stage 1, so it is not second-guessed here.
            if family and family not in supported_families:
                violations.append(
                    ValidationViolation(
                        code="unsupported_constraint",
                        path=f"constraints[{index}].kind",
                        message=f"Engine does not support '{family}' constraints",
                    )
                )

    return violations


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

    # -- Reading an engine's answer at the envelope level -------------------
    #
    # These three used to live in the router as literal field lookups, which
    # was fine while every engine implemented the same contract. A federated
    # engine does not, so the questions move to the thing that knows the
    # answer. The defaults are what the router did.

    def is_synchronous_response(self, data: Dict[str, Any]) -> bool:
        """Whether this answer is a finished result rather than a job receipt.

        Engines answer either with a job envelope (``{"job_id": ...}``) or with
        a finished result: a selection at the top level, a selection wrapped
        under ``result.solution``, or an already-general ``solutions`` list.
        """
        if not isinstance(data, dict):
            return False
        if "job_id" in data:
            return False
        if data.get("selection") is not None:
            return True
        if ((data.get("result") or {}).get("solution") or {}).get("selection") is not None:
            return True
        return isinstance(data.get("solutions"), list)

    def job_id(self, data: Dict[str, Any]) -> Any:
        """This engine's identifier for a job it has accepted."""
        return data.get("job_id") if isinstance(data, dict) else None

    def job_status(self, data: Dict[str, Any]) -> Any:
        """This engine's word for how a job is going."""
        return data.get("status") if isinstance(data, dict) else None

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
