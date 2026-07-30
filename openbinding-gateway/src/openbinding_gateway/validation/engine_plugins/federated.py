"""An engine the gateway does not host, behaving like one it does.

One class serves every registered engine, because there is nothing per-engine
left to write in Python: the manifest says what it can do, what instances it
takes, what options it accepts and where its fields live, and this reads all of
that.

``transform_response`` is where the design earns itself. It extracts one thing
from a third party's answer - which candidate serves which task - and returns a
solution carrying that and nothing else. Everything a caller sees afterwards,
the aggregated features, the violations, the feasibility, the objective, is
computed by the same reference evaluator that scores the four engines in this
repository. So a federated result is comparable with a built-in one by
construction rather than by trust, and an engine cannot flatter itself.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

from ...models.api import ValidationViolation
from ...models.manifest import EngineManifest, resolve_pointer
from .base import EngineValidationPlugin, capability_violations


class FederatedEnginePlugin(EngineValidationPlugin):
    """The plugin for a registered engine, built from its manifest row."""

    def __init__(self, manifest: EngineManifest, *, owner: str = "", verified_at: Any = None):
        self.engine_id = manifest.engine_id
        self._manifest = manifest
        self.owner = owner
        self.verified_at = verified_at

    def load_manifest(self) -> EngineManifest:
        # Handed one rather than finding one; the base class caches it.
        return self._manifest

    # -- Validation -----------------------------------------------------

    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        """Stage 4, driven entirely by the declared capabilities.

        A third party cannot ship code here, so what would otherwise be
        hand-written per-engine checks has to come from the declaration. That
        is a smaller net than a built-in engine's - it catches the node kinds,
        the objective type and the constraint families - and it is the same net
        those engines could have been using all along.
        """
        return capability_violations(instance, self.get_capabilities())

    # -- Translation ----------------------------------------------------

    def transform_request(
        self, instance: Dict[str, Any], options: Dict[str, Any] = {}
    ) -> Tuple[Dict[str, Any], List[str]]:
        """The general payload, plus a warning per option this engine ignores.

        The manifest's ``request_mapping`` decides where these two halves end up
        in the third party's body, but that is the transport's job: a plugin
        produces the general shape and the transport rearranges it. Keeping the
        split means the plugin is testable without a URL.
        """
        warnings = self.unsupported_option_warnings(options)
        accepted = self.accepted_option_names()
        filtered = {
            name: value for name, value in (options or {}).items() if name in accepted
        }
        return {"instance": instance, "options": filtered}, warnings

    def transform_response(
        self, engine_response: Dict[str, Any], original_request: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Their answer, reduced to bindings.

        Only the binding is read, and optionally their objective value. Nothing
        else they report is believed, because nothing else is needed: the
        reference evaluator derives it.
        """
        transport = self.get_manifest().transport
        if transport is None:
            return engine_response

        mapping = transport.response_mapping
        raw_solutions = resolve_pointer(engine_response, mapping.solutions)

        if isinstance(raw_solutions, dict):
            # An engine that returns its single best answer as an object rather
            # than a list of one. Common enough to accommodate silently.
            raw_solutions = [raw_solutions]
        if not isinstance(raw_solutions, list):
            raw_solutions = []

        solutions: List[Dict[str, Any]] = []
        for entry in raw_solutions:
            binding = resolve_pointer(entry, mapping.binding)
            if not isinstance(binding, dict) or not binding:
                # No binding is no solution. Reporting an empty one would make
                # the response look feasible-but-empty rather than absent.
                continue

            solution: Dict[str, Any] = {"binding": binding}
            if mapping.objective is not None:
                objective = resolve_pointer(entry, mapping.objective)
                if isinstance(objective, (int, float)):
                    # Kept as the engine's own claim. Canonicalization moves it
                    # aside under engine_objective_value and computes its own,
                    # which is what makes the divergence report possible.
                    solution["objective_value"] = float(objective)
            solutions.append(solution)

        return {
            "solutions": solutions,
            "provenance": {
                "engine_id": self.engine_id,
                "metadata": {
                    # Stated on every federated result so that one can never be
                    # mistaken for an in-tree one in a benchmark.
                    "federated": True,
                    "owner": self.owner,
                    "manifest_version": self.get_manifest().manifest_version,
                    "verified_at": (
                        self.verified_at.isoformat()
                        if hasattr(self.verified_at, "isoformat")
                        else self.verified_at
                    ),
                },
            },
        }

    def is_synchronous_response(self, data: Dict[str, Any]) -> bool:
        """Whether this engine has finished, or merely accepted the work.

        An engine that declares no polling operation has nowhere to say "later",
        so its answer is always the answer. One that does is asynchronous
        exactly when it handed back an identifier.
        """
        transport = self.get_manifest().transport
        if transport is None or not transport.is_asynchronous:
            return True
        return self.job_id(data) is None

    def job_status(self, engine_response: Dict[str, Any]) -> str:
        """Their job state, in the gateway's vocabulary.

        Anything unrecognised is ``running``: an engine reporting a state we
        have no mapping for has not said it failed, and treating silence as
        failure would abandon jobs that are merely still going.
        """
        transport = self.get_manifest().transport
        status_mapping = transport.response_mapping.job_status if transport else None
        if status_mapping is None:
            return "running"

        reported = resolve_pointer(engine_response, status_mapping.pointer)
        if reported is None:
            return "running"
        return status_mapping.map.get(str(reported), "running")

    def job_id(self, engine_response: Dict[str, Any]) -> Any:
        """Their identifier for a job they have accepted."""
        transport = self.get_manifest().transport
        if transport is None or transport.response_mapping.job_id is None:
            return None
        return resolve_pointer(engine_response, transport.response_mapping.job_id)
