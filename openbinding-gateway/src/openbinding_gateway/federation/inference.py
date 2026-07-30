"""Guessing a manifest from somebody's OpenAPI document.

Writing a transport block by hand means reading a spec, finding the right
``operationId``, and working out JSON Pointers into request and response bodies
you did not design. It is perfectly doable and almost nobody will do it - which
would leave federation as a feature with a wall in front of it.

So the gateway reads the document and proposes: which operation looks like
"solve", which looks like "poll a job", where the instance goes, where the
solutions come back, and which field in a solution is the binding. Every guess
carries a note saying what it was based on, because a proposal a user cannot
check is worse than no proposal.

Nothing here decides anything. The output is a draft for a person to correct,
and the conformance probe is what actually establishes that a mapping works.

The heuristics are names and shapes. That is not principled, and it does not
need to be: a wrong guess costs one correction in a form, and a right one saves
somebody reading a spec.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

#: Words an operation that solves something tends to contain.
SOLVE_WORDS = ("solve", "optimize", "optimise", "run", "submit", "schedule", "plan")
#: ...and one that reports on a running job.
JOB_WORDS = ("job", "run", "task", "status", "result", "poll")
HEALTH_PATHS = ("/health", "/healthz", "/status", "/ping", "/live", "/ready")

#: Property names, most specific first, for each thing we need to locate.
INSTANCE_NAMES = ("instance", "problem", "input", "model", "request", "data", "payload")
SOLUTIONS_NAMES = ("solutions", "results", "answers", "assignments", "bindings", "output")
BINDING_NAMES = ("binding", "assignment", "selection", "mapping", "allocation", "choices")
OBJECTIVE_NAMES = ("objective_value", "objective", "score", "fitness", "cost", "value")
OPTIONS_NAMES = ("options", "params", "parameters", "config", "settings")
JOB_ID_NAMES = ("job_id", "jobId", "run_id", "runId", "task_id", "taskId", "id")
STATUS_NAMES = ("status", "state", "phase")

_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")


@dataclass
class Draft:
    """A proposed transport, and why each part of it was proposed."""

    transport: Dict[str, Any] = field(default_factory=dict)
    notes: List[str] = field(default_factory=list)
    #: Things the document does not answer, which a person has to.
    unresolved: List[str] = field(default_factory=list)

    @property
    def is_complete(self) -> bool:
        """Whether the draft has the one mapping that is not optional."""
        return bool(self.transport.get("response_mapping", {}).get("binding"))


def _deref(document: Dict[str, Any], node: Any, seen: Optional[set] = None) -> Any:
    """Follow local ``$ref``s so a schema can be inspected.

    Only local references: fetching a remote one would be an SSRF primitive
    reached from inside a helper nobody expects to make requests.
    """
    seen = seen or set()
    while isinstance(node, dict) and "$ref" in node:
        ref = node["$ref"]
        if not isinstance(ref, str) or not ref.startswith("#/") or ref in seen:
            return {}
        seen.add(ref)
        current: Any = document
        for token in ref[2:].split("/"):
            token = token.replace("~1", "/").replace("~0", "~")
            if not isinstance(current, dict) or token not in current:
                return {}
            current = current[token]
        node = current
    return node


def operations(document: Dict[str, Any]) -> List[Tuple[str, str, Dict[str, Any]]]:
    """``(method, path, operation)`` for every operation in the document."""
    found = []
    for path, item in (document.get("paths") or {}).items():
        if not isinstance(item, dict):
            continue
        for method in _METHODS:
            operation = item.get(method)
            if isinstance(operation, dict):
                found.append((method.upper(), path, operation))
    return found


def _score(text: str, words: Tuple[str, ...]) -> int:
    lowered = text.lower()
    return sum(1 for word in words if word in lowered)


def _json_schema_of_body(document: Dict[str, Any], operation: Dict[str, Any]) -> Dict[str, Any]:
    body = _deref(document, operation.get("requestBody") or {})
    content = (body.get("content") or {}).get("application/json") or {}
    return _deref(document, content.get("schema") or {})


def _json_schema_of_response(
    document: Dict[str, Any], operation: Dict[str, Any]
) -> Dict[str, Any]:
    responses = operation.get("responses") or {}
    for status in ("200", "201", "202", "default"):
        response = _deref(document, responses.get(status) or {})
        content = (response.get("content") or {}).get("application/json") or {}
        schema = _deref(document, content.get("schema") or {})
        if schema:
            return schema
    return {}


def _properties(schema: Dict[str, Any]) -> Dict[str, Any]:
    properties = schema.get("properties")
    return properties if isinstance(properties, dict) else {}


def _find_property(
    document: Dict[str, Any], schema: Dict[str, Any], names: Tuple[str, ...], *, kind=None
) -> Optional[str]:
    """The first property whose name matches, in the order the names are given.

    Ordered because the names are ranked: an engine with both ``objective`` and
    ``value`` means the first one.
    """
    properties = _properties(schema)
    lowered = {name.lower(): name for name in properties}

    for candidate in names:
        actual = lowered.get(candidate.lower())
        if actual is None:
            continue
        if kind is not None:
            resolved = _deref(document, properties[actual])
            declared = resolved.get("type")
            if declared is not None and declared != kind:
                continue
        return actual
    return None


def _pointer(name: Optional[str]) -> Optional[str]:
    return None if name is None else "/" + name.replace("~", "~0").replace("/", "~1")


def pick_solve(document: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], str]:
    """The operation that most likely submits a problem."""
    posts = [(m, p, o) for m, p, o in operations(document) if m == "POST"]
    if not posts:
        return None, "the document declares no POST operation, so there is nothing to solve with"
    if len(posts) == 1:
        method, path, operation = posts[0]
        return operation, f"the only POST operation is {path}"

    ranked = sorted(
        posts,
        key=lambda item: _score(f"{item[1]} {item[2].get('operationId', '')}", SOLVE_WORDS),
        reverse=True,
    )
    best = ranked[0]
    if _score(f"{best[1]} {best[2].get('operationId', '')}", SOLVE_WORDS) == 0:
        return None, (
            f"{len(posts)} POST operations and none of them mentions solving; "
            f"say which one it is"
        )
    return best[2], f"{best[1]} looks like the one that solves"


def pick_job(document: Dict[str, Any], solve_path: Optional[str]) -> Tuple[Optional[Dict], str]:
    """The operation that reports on a job, if the engine is asynchronous."""
    candidates = [
        (m, p, o) for m, p, o in operations(document) if m == "GET" and re.search(r"\{[^}]+\}", p)
    ]
    if not candidates:
        return None, "no GET operation takes a path parameter, so the engine looks synchronous"

    def rank(item):
        method, path, operation = item
        score = _score(f"{path} {operation.get('operationId', '')}", JOB_WORDS)
        if solve_path and path.startswith(solve_path.rstrip("/")):
            # /v1/optimize and /v1/optimize/{id} are almost certainly a pair.
            score += 2
        return score

    best = max(candidates, key=rank)
    return best[2], f"{best[1]} looks like the one that reports on a job"


def pick_health(document: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], str]:
    for method, path, operation in operations(document):
        if method == "GET" and path.lower().rstrip("/") in HEALTH_PATHS:
            return operation, f"{path} looks like a health check"
    return None, "no health operation found; the engine will simply not be probed"


def infer(document: Dict[str, Any]) -> Draft:
    """Propose a transport block for this document.

    The result is a draft: every field is a guess with a note attached, and the
    caller is expected to look at it. What cannot be guessed is listed in
    ``unresolved`` rather than filled in with something plausible.
    """
    draft = Draft()

    if not isinstance(document, dict) or not document.get("paths"):
        draft.unresolved.append("This does not look like an OpenAPI document: it declares no paths.")
        return draft

    solve, why = pick_solve(document)
    draft.notes.append(why)
    if solve is None:
        draft.unresolved.append("Which operation submits an instance.")
        return draft

    solve_id = solve.get("operationId")
    if not solve_id:
        draft.unresolved.append(
            "The solve operation has no operationId. Mappings refer to operations by id, "
            "so the document has to give it one."
        )
        return draft

    solve_path = next(
        (p for m, p, o in operations(document) if o is solve), None
    )

    transport: Dict[str, Any] = {
        "openapi": {"url": "REPLACE_WITH_YOUR_OPENAPI_URL"},
        "operations": {"solve": {"operationId": solve_id}},
    }

    servers = document.get("servers")
    if isinstance(servers, list) and servers and isinstance(servers[0], dict):
        draft.notes.append(f"base URL taken from servers[0]: {servers[0].get('url')}")
    else:
        draft.unresolved.append(
            "The document declares no servers[], so transport.base_url has to say where "
            "the engine is."
        )

    # -- Request ---------------------------------------------------------
    request_schema = _json_schema_of_body(document, solve)
    instance_name = _find_property(document, request_schema, INSTANCE_NAMES)
    options_name = _find_property(document, request_schema, OPTIONS_NAMES)

    if instance_name:
        draft.notes.append(f"the instance goes in the request's '{instance_name}' property")
        request_mapping: Dict[str, Any] = {"instance": _pointer(instance_name)}
    elif request_schema:
        # A body with properties but none of them named like a problem: the
        # body is most likely the instance itself.
        draft.notes.append("the request body looks like the instance itself")
        request_mapping = {"instance": ""}
    else:
        draft.unresolved.append("Where the instance goes in the request body.")
        request_mapping = {"instance": "/instance"}

    if options_name:
        request_mapping["options"] = _pointer(options_name)
        draft.notes.append(f"options go in the request's '{options_name}' property")
    transport["request_mapping"] = request_mapping

    # -- Response --------------------------------------------------------
    response_schema = _json_schema_of_response(document, solve)
    response_mapping: Dict[str, Any] = {}

    job_id_name = _find_property(document, response_schema, JOB_ID_NAMES, kind="string")
    job, job_why = pick_job(document, solve_path)
    job_id_used = job is not None and job_id_name is not None

    if job_id_used:
        job_operation_id = job.get("operationId")
        if job_operation_id:
            transport["operations"]["job"] = {"operationId": job_operation_id}
            response_mapping["job_id"] = _pointer(job_id_name)
            draft.notes.append(job_why)
            draft.notes.append(f"the job identifier is the response's '{job_id_name}'")
            # An async engine's solutions arrive from the polling operation.
            response_schema = _json_schema_of_response(document, job) or response_schema
            status_name = _find_property(document, response_schema, STATUS_NAMES, kind="string")
            if status_name:
                response_mapping["job_status"] = {"pointer": _pointer(status_name), "map": {}}
                draft.unresolved.append(
                    f"What this engine's '{status_name}' values mean: map each of them onto "
                    f"queued, running, completed or failed."
                )
        else:
            draft.notes.append("the polling operation has no operationId, so it cannot be mapped")
    else:
        draft.notes.append("the engine looks synchronous: it answers with a result, not a receipt")

    health, health_why = pick_health(document)
    if health is not None and health.get("operationId"):
        transport["operations"]["health"] = {"operationId": health["operationId"]}
        draft.notes.append(health_why)

    solutions_name = _find_property(document, response_schema, SOLUTIONS_NAMES)
    if solutions_name:
        response_mapping["solutions"] = _pointer(solutions_name)
        item_schema = _deref(
            document, _deref(document, _properties(response_schema)[solutions_name]).get("items") or {}
        )
        draft.notes.append(f"solutions are the response's '{solutions_name}' array")
    elif response_schema.get("type") == "array":
        response_mapping["solutions"] = ""
        item_schema = _deref(document, response_schema.get("items") or {})
        draft.notes.append("the response body is itself the list of solutions")
    else:
        item_schema = response_schema
        draft.notes.append("no list of solutions found; treating the response as a single answer")
        response_mapping["solutions"] = ""

    binding_name = _find_property(document, item_schema, BINDING_NAMES)
    if binding_name:
        response_mapping["binding"] = _pointer(binding_name)
        draft.notes.append(
            f"'{binding_name}' looks like the task-to-candidate map - the one mapping that "
            f"is required"
        )
    else:
        draft.unresolved.append(
            "Which field of a solution is the task-to-candidate map. This is the only "
            "mapping the gateway cannot do without: everything else it recomputes."
        )

    objective_name = _find_property(document, item_schema, OBJECTIVE_NAMES, kind="number")
    if objective_name:
        response_mapping["objective"] = _pointer(objective_name)
        draft.notes.append(
            f"'{objective_name}' looks like the engine's own objective; it is kept for "
            f"comparison, never used as the answer"
        )

    transport["response_mapping"] = response_mapping
    draft.transport = transport
    return draft


def draft_manifest(
    document: Dict[str, Any],
    *,
    engine_id: str = "my-engine",
    display_name: Optional[str] = None,
    openapi_url: Optional[str] = None,
) -> Tuple[Dict[str, Any], Draft]:
    """A whole manifest, ready to be corrected and submitted.

    The capabilities are deliberately narrow - TASK and SEQ, MONO, no
    constraint families - because an over-generous guess is the dangerous
    direction: it advertises what the engine may not enforce, and the gateway
    would route instances to it accordingly.
    """
    draft = infer(document)

    info = document.get("info") or {}
    title = info.get("title") if isinstance(info, dict) else None

    transport = dict(draft.transport)
    if transport and openapi_url:
        transport["openapi"] = {"url": openapi_url}

    manifest = {
        "manifest_version": "1",
        "engine_id": engine_id,
        "display_name": display_name or title or engine_id,
        "description": (info.get("description") if isinstance(info, dict) else None)
        or "Say what this engine does and when to reach for it.",
        "type": "HEURISTIC",
        "capabilities": {
            "qos_features_supported": ["*"],
            "composition_nodes_supported": ["TASK", "SEQ"],
            "objective_types_supported": ["MONO"],
            "constraints_supported": [],
            "schema_version": "v1",
        },
        "options_schema": {"type": "object", "additionalProperties": True},
        "instance_schema": {"type": "object"},
    }
    if transport:
        manifest["transport"] = transport

    draft.unresolved.append(
        "Capabilities are guessed narrowly on purpose. Widen them to what the engine "
        "really supports - and only to what it really enforces."
    )
    return manifest, draft
