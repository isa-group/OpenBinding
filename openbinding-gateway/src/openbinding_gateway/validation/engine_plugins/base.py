import os
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Set, Tuple

import httpx

from ...models.api import ValidationViolation


def specialization_schema_path(engine_id: str) -> str:
    """Where an engine's specialization schema lives.

    SCHEMAS_DIR is what the Docker image sets; the repository-relative fallback
    is what local development uses. Resolving it here keeps the walk up five
    directories in one place instead of one copy per plugin.
    """
    base_path = os.getenv("SCHEMAS_DIR", "/app/schemas")
    if not os.path.exists(base_path):
        base_path = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "../../../../../schemas")
        )
    return os.path.join(base_path, "specializations", f"{engine_id}.schema.json")


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

    A plugin declares what its engine can do, validates an instance against
    that, and translates the request and response. It does not compute
    metrics: every engine's answer goes through the reference evaluator in
    ``semantics.canonicalization``, so features, violations and feasibility
    come from one implementation.
    """

    #: Engine id, used to locate the specialization schema. Subclasses set it.
    engine_id: str = ""

    @abstractmethod
    def get_capabilities(self) -> Dict[str, Any]:
        """Return engine capabilities including supported QoS, operators, etc."""

    @abstractmethod
    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        """Perform Stage 4 engine-specific semantic validation."""

    def get_specialization_schema_path(self) -> str:
        return specialization_schema_path(self.engine_id)

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

    def get_default_options(self) -> Dict[str, Any]:
        """Gateway-level default options, used when the client sends none."""
        return {}

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
