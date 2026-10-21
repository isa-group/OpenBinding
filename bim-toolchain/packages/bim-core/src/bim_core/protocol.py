"""The engine protocol ``bim-engine/v1``: the contract document, its digest and result validation.

This is the pure part of an engine client: the HTTP transport, endpoint policy and DNS pinning stay
in the host, and this module only decides whether a decoded JSON message is a valid ``bim-engine/v1``
message (the origin of each function is listed in ``docs/EXTRACTION_LOG.md``).

Every violation is a :class:`ProtocolError` with a stable ``code``; the messages are those the
platform's transport has always reported.

=============================  ==================================================================
code                           raised when
=============================  ==================================================================
``result_not_object``          the response is not a JSON object
``invalid_termination``        ``termination`` is not OPTIMAL/FEASIBLE/INFEASIBLE/UNKNOWN
``solutions_missing``          ``solutions`` is not an array
``solution_decision_invalid``  a solution lacks exactly the five fields or a canonical binding
``solution_features_invalid``  ``features`` is not an object of numbers
``solution_objectives_invalid``  ``objectives`` is not a canonical objective evaluation
``objective_component_invalid``  an objective component is not canonical
``penalties_invalid``          ``penalties`` is not an array of non-negative numbers
``violations_not_array``       ``violations`` is not an array
``violation_invalid``          a violation does not satisfy bim-engine/v1
``unknown_fields``             the response has fields outside bim-engine/v1
``provenance_invalid``         ``provenance`` is not an object
``non_finite_number``          (``finite=True`` only) a NaN or an infinity anywhere in the message
``job_receipt_invalid``        an acceptance receipt is not ``EngineJobAccepted``
``job_invalid``                a polling response is not ``EngineJob``
``job_not_object``             a polling response is not an object
``engine_job_failed``          the engine reported that the job failed (message: the engine's)
``protocol_document_invalid``  the installed contract is not an object
=============================  ==================================================================

Numbers: a JSON number is an ``int`` or a ``float`` that is not a ``bool``.  Like the original,
:func:`validate_result` accepts a ``float`` NaN or infinity unless ``finite=True``, because the
transport already rejects them while parsing (``strict_json_loads``).  A host that validates
messages that did not come through a strict parser should pass ``finite=True``.
"""

from __future__ import annotations

import math
from typing import Any

import yaml

from .assets import engine_contract_bytes, read_schema
from .canonical import digest, digest_bytes
from .errors import ProtocolError

PROTOCOL_ID = "bim-engine/v1"
TERMINATIONS = frozenset({"OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"})
OBJECTIVE_TYPES = frozenset({"SINGLE", "MULTI", "MANY"})
JOB_STATES = frozenset({"queued", "running", "completed", "failed"})

_SOLUTION_FIELDS = {"decision", "features", "objectives", "penalties", "violations"}
_OBJECTIVE_FIELDS = {"type", "scalarization", "components", "penalty", "score"}
_COMPONENT_FIELDS = {"criteria", "feature", "value", "loss", "weight"}
_RESULT_FIELDS = {"termination", "solutions", "provenance"}


def protocol_document() -> dict[str, Any]:
    """The installed OpenAPI contract of ``bim-engine/v1``, parsed."""
    document = yaml.safe_load(engine_contract_bytes().decode("utf-8"))
    if not isinstance(document, dict):
        raise ProtocolError("protocol_document_invalid", "BIM engine OpenAPI contract must be an object")
    return document


def protocol_digest() -> str:
    """Digest that identifies the protocol: the OpenAPI document plus the BindingProblem schema it references.

    The OpenAPI refers to the BindingProblem schema by a relative path.  Pinning that external
    contract in the identity means a change of the IR schema cannot leave a deceptively unchanged
    protocol revision.
    """
    return digest({
        "openapi": protocol_document(),
        "externalSchemas": {
            "bim/v1/BindingProblem": digest_bytes(read_schema("binding-problem.schema.json")),
        },
    })


def _member(value: object, allowed: frozenset[str] | set[str]) -> bool:
    """``value in allowed`` that is simply false for an unhashable value (a list, an object)."""
    try:
        return value in allowed
    except TypeError:
        return False


def is_termination(value: object) -> bool:
    """Whether ``value`` is one of the four terminations of ``bim-engine/v1``."""
    return _member(value, TERMINATIONS)


def _number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _valid_ref(value: object) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("resource"), str)
        and bool(value.get("resource"))
        and isinstance(value.get("id"), str)
        and bool(value.get("id"))
        and set(value) == {"resource", "id"}
    )


def contains_non_finite(value: object) -> bool:
    """Whether a NaN or an infinity occurs anywhere in a JSON-like value (iterative, so depth is no limit)."""
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, float):
            if not math.isfinite(item):
                return True
        elif isinstance(item, dict):
            pending.extend(item.values())
        elif isinstance(item, (list, tuple)):
            pending.extend(item)
    return False


def validate_result(payload: object, *, finite: bool = False) -> dict[str, Any]:
    """Return ``payload`` if it is a valid ``bim-engine/v1`` result, otherwise raise :class:`ProtocolError`.

    The check is structural: shapes, closed key sets, types and signs.  Whether the numbers are
    *right* is decided by re-evaluating the decisions (``bim_core.reevaluate``), never by trusting
    them.  ``finite=True`` additionally rejects any NaN or infinity in the message.
    """
    if not isinstance(payload, dict):
        raise ProtocolError("result_not_object", "engine response must be an object")
    if finite and contains_non_finite(payload):
        raise ProtocolError("non_finite_number", "engine response contains a non-finite number")
    termination = payload.get("termination")
    if not is_termination(termination):
        raise ProtocolError("invalid_termination", "engine response has an invalid termination")
    solutions = payload.get("solutions")
    if not isinstance(solutions, list):
        raise ProtocolError("solutions_missing", "engine response must contain a solutions array")

    for solution in solutions:
        decision = solution.get("decision") if isinstance(solution, dict) else None
        binding = decision.get("binding") if isinstance(decision, dict) else None
        if (
            not isinstance(solution, dict)
            or set(solution) != _SOLUTION_FIELDS
            or not isinstance(decision, dict)
            or set(decision) != {"kind", "binding"}
            or decision.get("kind") != "binding"
            or not isinstance(binding, dict)
            or any(not isinstance(key, str) or not _valid_ref(value) for key, value in binding.items())
        ):
            raise ProtocolError(
                "solution_decision_invalid", "every engine solution must contain a canonical binding decision"
            )
        features = solution["features"]
        if (
            not isinstance(features, dict)
            or any(not isinstance(key, str) or not _number(value) for key, value in features.items())
        ):
            raise ProtocolError("solution_features_invalid", "every engine solution must contain numeric features")
        objectives = solution["objectives"]
        if (
            not isinstance(objectives, dict)
            or set(objectives) != _OBJECTIVE_FIELDS
            or not _member(objectives.get("type"), OBJECTIVE_TYPES)
            or not isinstance(objectives.get("scalarization"), str)
            or not isinstance(objectives.get("components"), list)
            or not _number(objectives.get("penalty"))
            or objectives["penalty"] < 0
            or not (
                _number(objectives.get("score"))
                or (
                    isinstance(objectives.get("score"), list)
                    and all(_number(value) for value in objectives["score"])
                )
            )
        ):
            raise ProtocolError(
                "solution_objectives_invalid", "every engine solution must contain a canonical objective evaluation"
            )
        for component in objectives["components"]:
            if (
                not isinstance(component, dict)
                or set(component) != _COMPONENT_FIELDS
                or not isinstance(component.get("criteria"), str)
                or not _valid_ref(component.get("feature"))
                or not _number(component.get("value"))
                or not _number(component.get("loss"))
                or not _number(component.get("weight"))
                or component["weight"] < 0
            ):
                raise ProtocolError(
                    "objective_component_invalid", "engine objective components must satisfy bim-engine/v1"
                )
        penalties = solution["penalties"]
        if not isinstance(penalties, list) or any(not _number(value) or value < 0 for value in penalties):
            raise ProtocolError("penalties_invalid", "engine penalties must be non-negative numbers")
        violations = solution["violations"]
        if not isinstance(violations, list):
            raise ProtocolError("violations_not_array", "engine violations must be an array")
        for violation in violations:
            if (
                not isinstance(violation, dict)
                or not {"constraint", "enforcement", "penalty"} <= set(violation)
                or not set(violation) <= {"constraint", "enforcement", "penalty", "message"}
                or not _valid_ref(violation.get("constraint"))
                or not _member(violation.get("enforcement"), {"hard", "soft"})
                or not _number(violation.get("penalty"))
                or violation["penalty"] < 0
                or ("message" in violation and not isinstance(violation["message"], str))
            ):
                raise ProtocolError("violation_invalid", "engine violations must satisfy bim-engine/v1")
    if not set(payload) <= _RESULT_FIELDS:
        raise ProtocolError("unknown_fields", "engine response contains fields outside bim-engine/v1")
    if "provenance" in payload and not isinstance(payload["provenance"], dict):
        raise ProtocolError("provenance_invalid", "engine provenance must be an object")
    return payload


def validate_job_receipt(payload: object) -> str:
    """The job id of an ``EngineJobAccepted`` receipt (``{"id", "status": "queued"}``)."""
    if (
        not isinstance(payload, dict)
        or set(payload) != {"id", "status"}
        or not isinstance(payload.get("id"), str)
        or not payload["id"]
        or payload.get("status") != "queued"
    ):
        raise ProtocolError("job_receipt_invalid", "engine acceptance receipt must satisfy EngineJobAccepted")
    return payload["id"]


def validate_job(payload: object, expected_id: str, *, finite: bool = False) -> dict[str, Any] | None:
    """The validated result of a finished ``EngineJob``, or ``None`` while it is queued or running.

    A job the engine reports as ``failed`` raises ``ProtocolError("engine_job_failed")`` with the
    engine's own message.
    """
    if not isinstance(payload, dict):
        raise ProtocolError("job_not_object", "engine polling returned a non-object response")
    job_id = payload.get("id")
    state = payload.get("status")
    created_at = payload.get("created_at")
    if (
        job_id != expected_id
        or not isinstance(job_id, str)
        or not isinstance(created_at, int)
        or isinstance(created_at, bool)
        or created_at < 0
        or not _member(state, JOB_STATES)
    ):
        raise ProtocolError("job_invalid", "engine polling response must satisfy EngineJob")
    if state in {"queued", "running"}:
        if set(payload) != {"id", "status", "created_at"}:
            raise ProtocolError("job_invalid", "engine polling response must satisfy EngineJob")
        return None
    if state == "failed":
        if set(payload) != {"id", "status", "created_at", "error"} or not isinstance(payload.get("error"), str):
            raise ProtocolError("job_invalid", "engine polling response must satisfy EngineJob")
        raise ProtocolError("engine_job_failed", payload["error"] or "remote engine failed")
    if set(payload) != {"id", "status", "created_at", "result"}:
        raise ProtocolError("job_invalid", "engine polling response must satisfy EngineJob")
    return validate_result(payload["result"], finite=finite)
