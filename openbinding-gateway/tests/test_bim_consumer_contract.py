"""The interactions OpenBinding has with BIM, replayed through the gateway's own port.

``bim-toolchain/contracts/consumers/openbinding/*.json`` are scripts of the requests the platform makes to
BIM and the answers it relies on (compile and validate, compatibility, optimization, evaluation, re-evaluation,
result validation). They are written and checked by the toolchain against its service; this runs the same scripts
through ``integrations.bim.get_bim()``, the port the gateway really uses (in process unless ``BIM_MODE=http``), so
that a change on either side that breaks what the platform depends on is caught on the platform's side too.

Answers are compared as the fixtures record them: ``irDigest``, ``compilationDigest`` and ``toolchain`` are dropped
and the IR is reduced to its semantic digest, because they change with the bytes of the toolchain. A failure is
compared by its class, code, message and diagnostics, and its HTTP status must be the one the platform answers with.
"""

from __future__ import annotations

import base64
import json
from typing import Any

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.integrations import bim
from bim_core import BimError
from bim_core.canonical import digest

FIXTURES = REPO_ROOT / "bim-toolchain" / "contracts" / "consumers" / "openbinding"
NON_SEMANTIC = frozenset({"profile", "dialects", "instance", "sourceMap"})
EXPECTED_FIXTURES = {
    "compile",
    "compatibility",
    "optimization",
    "evaluate",
    "reevaluate-agreement",
    "reevaluate-discrepancy",
    "validate-result",
}


def fixture_names() -> list[str]:
    return sorted(path.stem for path in FIXTURES.glob("*.json"))


def load(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def without_toolchain(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: without_toolchain(child) for key, child in value.items() if key != "toolchain"}
    if isinstance(value, list):
        return [without_toolchain(child) for child in value]
    return value


def normalize(body: Any) -> Any:
    """What a fixture records of an answer."""
    if not isinstance(body, dict):
        return body
    result = {key: value for key, value in body.items() if key not in {"ir", "irDigest", "compilationDigest", "toolchain"}}
    if "ir" in body:
        result["ir"] = {
            "apiVersion": body["ir"]["apiVersion"],
            "kind": body["ir"]["kind"],
            "semanticDigest": digest({key: value for key, value in body["ir"]["spec"].items() if key not in NON_SEMANTIC}),
        }
    return result


def pointer(document: Any, reference: str) -> Any:
    for part in [item.replace("~1", "/").replace("~0", "~") for item in reference.split("/")[1:]]:
        document = document[int(part)] if isinstance(document, list) else document[part]
    return document


def resolve(value: Any, bodies: dict[str, Any]) -> Any:
    """Replace every ``{"$ref": "step#/pointer"}`` by that member of the step's actual answer."""
    if isinstance(value, dict):
        if set(value) == {"$ref"}:
            step, _, member = value["$ref"].partition("#")
            return json.loads(json.dumps(pointer(bodies[step], member)))
        return {key: resolve(child, bodies) for key, child in value.items()}
    if isinstance(value, list):
        return [resolve(child, bodies) for child in value]
    return value


def registered(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "namespace": item["namespace"],
            "name": item["name"],
            "version": item["version"],
            "digest": item["digest"],
            "mediaType": item["mediaType"],
            "content": base64.b64decode(item["contentBase64"]),
            **({"versionManifest": item["versionManifest"]} if item.get("versionManifest") else {}),
        }
        for item in items
    ]


def call(port, request: dict[str, Any], body: dict[str, Any]) -> Any:
    """What a recorded request means for the port, with the answer shaped like the service's body."""
    path = request["path"].removeprefix("/bim/v1")
    if path in {"/compile", "/validate"}:
        method = port.compile if path == "/compile" else port.validate
        return method(base64.b64decode(body["package"]), registered(body.get("registeredResources", [])))
    if path == "/compatibility":
        return port.compatibility(body["ir"], body["manifest"], mode=body.get("mode"), options=body.get("options"))
    if path == "/optimization/resolve":
        return port.resolve_optimization(body["ir"], body["manifest"], body["optimization"], mode=body.get("mode"))
    if path == "/evaluate":
        results = port.evaluate_many(body["ir"], body["bindings"], body.get("execution"), on_error=body.get("onError", "raise"))
        return {"results": results}
    if path == "/reevaluate":
        return port.reevaluate(body["ir"], body["result"], body.get("execution"), body.get("allowedTerminations"))
    if path == "/validate-result":
        return port.validate_result(body["result"])
    if path == "/neighborhood":
        return port.neighborhood(
            body["ir"], body["binding"], task=body.get("task"), limit=body.get("limit", 64),
            seconds=body.get("seconds", 2.0), execution=body.get("execution"),
        )  # fmt: skip
    raise AssertionError(f"no call of the port for {path}")


def failure(exc: BimError) -> dict[str, Any]:
    return {
        "code": exc.code,
        "detail": exc.message,
        "errorType": type(exc).__name__,
        "diagnostics": [item.as_dict() if hasattr(item, "as_dict") else item for item in exc.diagnostics],
    }


def recorded_failure(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": body["code"],
        "detail": body["detail"],
        "errorType": body["errorType"],
        "diagnostics": body.get("diagnostics", []),
    }


def test_the_toolchain_fixtures_are_there_for_every_interaction() -> None:
    if not FIXTURES.is_dir():
        pytest.skip("bim-toolchain/contracts is not mounted in this environment")

    assert set(fixture_names()) == EXPECTED_FIXTURES


@pytest.mark.parametrize("name", sorted(EXPECTED_FIXTURES))
def test_the_gateways_port_answers_each_recorded_interaction(name: str) -> None:
    if not (FIXTURES / f"{name}.json").is_file():
        pytest.skip(f"{name}.json is not mounted in this environment")
    fixture = load(name)
    port = bim.get_bim()
    bodies: dict[str, Any] = {}
    mismatches: list[str] = []

    for step in fixture["steps"]:
        request, expected = step["request"], step["expect"]
        body = resolve(request["body"], bodies)
        try:
            answer = call(port, request, body)
        except BimError as exc:
            status = bim.problem_for(exc)[0]
            bodies[step["id"]] = None
            if expected["status"] == 200:
                mismatches.append(f"{step['id']}: failed with {failure(exc)['code']} where an answer was recorded")
            elif status != expected["status"] or failure(exc) != recorded_failure(expected["body"]):
                mismatches.append(f"{step['id']}: {status} {failure(exc)['code']}")
            continue
        bodies[step["id"]] = answer
        if expected["status"] != 200 or without_toolchain(normalize(answer)) != without_toolchain(expected["body"]):
            mismatches.append(f"{step['id']}: answered where {expected['status']} was recorded, or differently")

    assert mismatches == []
