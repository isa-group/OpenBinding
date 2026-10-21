"""Fixtures of the interactions OpenBinding has with BIM, and the demo package they are built on.

``contracts/consumers/openbinding/*.json`` record, for each interaction the platform needs (compile a small
package, check Engine compatibility, resolve execution options, re-evaluate an engine answer with and without a
discrepancy, validate an engine result), the HTTP request to send to a ``bim-service`` and the response to expect.
They are the consumer side of the contract: a change that breaks one of them breaks OpenBinding.

A fixture is a short script of *steps*.  A step may refer to what an earlier step answered with
``{"$ref": "<step id>#/json/pointer"}`` (the IR, typically), so no fixture embeds an IR: an IR pins the
toolchain that produced it, and the fixtures must survive a change of ``compilerDigest``.  For the same reason
the *expected* body of a step is normalized (:func:`normalize`): ``irDigest``, ``compilationDigest`` and
``toolchain`` are dropped and ``ir`` is reduced to its semantic digest, i.e. the digest of ``spec`` without
``profile``, ``dialects``, ``instance`` and ``sourceMap`` (see ``docs/DIGESTS.md``).  Everything under a
``toolchain`` key is informative and ignored when comparing, as in the baseline goldens.  A step that compiled
records the ``compilerDigest`` and ``irDigest`` it saw under such a key.

Library use (the tests): :func:`build_fixtures` runs the scripts against any ``execute(method, path, body)``
callable and returns the fixtures with their expected answers; :func:`replay` checks a fixture against one.
Command line, to look at what a running service answers::

    PYTHONPATH=... python tools/consumer_fixtures.py --check
"""

from __future__ import annotations

import base64
import copy
import functools
import json
import sys
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
for _source in ("bim-core", "bim-service"):
    _path = ROOT / "packages" / _source / "src"
    if _path.is_dir() and str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from bim_core import (  # noqa: E402
    BindingProblem,
    InstancePackage,
    compile_instance,
    digest,
    reevaluate_result,
)
from bim_core.package import resource_digest  # noqa: E402

FIXTURE_DIR = ROOT / "contracts" / "consumers" / "openbinding"
MANIFEST_DIR = ROOT / "packages" / "bim-core" / "tests" / "fixtures" / "manifests"
SCHEMA = "bim-toolchain/consumer-fixture/1"
NON_SEMANTIC = frozenset({"profile", "dialects", "instance", "sourceMap"})

Execute = Callable[[str, str, Any], "tuple[int, Any]"]

BINDING = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-b", "id": "c1"}}


# --- the demo package ------------------------------------------------------------------------------


def _envelope(kind: str, name: str, spec: dict[str, Any]) -> dict[str, Any]:
    api_version = "qos-binding-placement/v1" if kind == "Placement" else "qos-binding/v1"
    return {"apiVersion": api_version, "kind": kind, "metadata": {"name": name}, "spec": spec}


def _catalog(name: str, provider: str, latency: int, cost: int) -> dict[str, Any]:
    return _envelope(
        "CandidateCatalog",
        name,
        {
            "providers": {provider: {"name": provider.upper()}},
            "featureBindings": {
                "latency": {"resource": "app", "id": "latency"},
                "cost": {"resource": "app", "id": "cost"},
            },
            "candidates": {
                "c1": {
                    "provider": {"resource": name.replace("catalog", "cat"), "id": provider},
                    "provides": "svc/v1",
                    "features": {"latency": latency, "cost": cost},
                }
            },
        },
    )


def demo_documents() -> dict[str, dict[str, Any]]:
    """Two service tasks, two catalogs, two criteria, a hard and a soft constraint, a loop and a local task."""
    return {
        "application.json": _envelope(
            "Application",
            "app",
            {
                "tasks": {"t1": "svc/v1", "t2": "svc/v1", "local": {"kind": "local"}},
                "features": {
                    "latency": {"unit": "ms", "direction": "minimize", "aggregation": "sum"},
                    "cost": {"unit": "eur", "direction": "minimize", "scope": "selectedCandidate", "aggregation": "sum"},
                },
                "workflow": {
                    "sequence": [
                        {"task": {"resource": "app", "id": "t1"}},
                        {"repeat": {"body": {"task": {"resource": "app", "id": "t2"}}, "expectedCount": 2.0}},
                        {"task": {"resource": "app", "id": "local"}},
                    ]
                },
            },
        ),
        "catalog-a.json": _catalog("catalog-a", "pa", 10, 5),
        "catalog-b.json": _catalog("catalog-b", "pb", 20, 7),
        "hard.json": _envelope(
            "ConstraintSet", "hard", {"constraints": {"limit": {"assert": "features.latency <= 100", "enforcement": "hard"}}}
        ),
        "soft.json": _envelope(
            "ConstraintSet",
            "soft",
            {"constraints": {"limit": {"assert": "has(tasks.t1.provider)", "enforcement": "soft", "penalty": 2}}},
        ),
        "optimization.json": _envelope(
            "Optimization",
            "opt",
            {
                "criteria": [
                    {"id": "latency", "feature": {"resource": "app", "id": "latency"}, "normalize": {"min": 0, "max": 100, "clamp": False}},
                    {"id": "cost", "feature": {"resource": "app", "id": "cost"}, "normalize": {"min": 0, "max": 20, "clamp": False}},
                ],
                "penalties": [{"constraint": {"resource": "soft", "id": "limit"}, "weight": 1}],
            },
        ),
    }


def demo_instance() -> dict[str, Any]:
    return {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": "consumer-demo"},
        "spec": {
            "profile": "qos-binding/v1",
            "resources": {
                "application": {"app": "application.json"},
                "candidateCatalog": {"cat-a": "catalog-a.json", "cat-b": "catalog-b.json"},
                "constraintSet": {"hard": "hard.json", "soft": "soft.json"},
                "optimization": {"opt": "optimization.json"},
            },
        },
    }


def demo_files(*, broken: bool = False) -> dict[str, bytes]:
    """The files of the demo package; ``broken`` declares a resource that is not in the package."""
    instance = demo_instance()
    if broken:
        instance["spec"]["resources"]["candidateCatalog"]["cat-c"] = "missing.json"
    files = {"instance.json": json.dumps(instance).encode()}
    files.update({path: json.dumps(document).encode() for path, document in demo_documents().items()})
    return files


def demo_zip(*, broken: bool = False) -> bytes:
    """The demo package as the deterministic ``.bim.zip`` OpenBinding stores."""
    return InstancePackage(demo_files(broken=broken)).to_zip()


def registered_demo() -> tuple[bytes, list[dict[str, Any]]]:
    """The demo with its second catalog pinned as a registered resource: ``(zip, registeredResources)``.

    The list is in wire format (``contentBase64``); the package alone does not compile.
    """
    files = demo_files()
    catalog = json.loads(files.pop("catalog-b.json"))
    catalog["metadata"]["version"] = "1.0.0"
    content = json.dumps(catalog).encode()
    pin = resource_digest("registered.json", content)
    instance = json.loads(files["instance.json"])
    instance["spec"]["resources"]["candidateCatalog"]["cat-b"] = {
        "namespace": "acme",
        "name": "catalog-b",
        "version": "1.0.0",
        "digest": pin,
    }
    files["instance.json"] = json.dumps(instance).encode()
    registered = [
        {
            "namespace": "acme",
            "name": "catalog-b",
            "version": "1.0.0",
            "digest": pin,
            "mediaType": "application/json",
            "contentBase64": _b64(content),
        }
    ]
    return InstancePackage(files).to_zip(), registered


@functools.lru_cache(maxsize=1)
def demo_problem() -> BindingProblem:
    problem = compile_instance(InstancePackage(demo_files()))
    assert isinstance(problem, BindingProblem)
    return problem


# --- normalization and references --------------------------------------------------------------------


def comparable(value: Any) -> Any:
    """Drop every ``toolchain`` member: informative, expected to change with the toolchain."""
    if isinstance(value, dict):
        return {key: comparable(child) for key, child in value.items() if key != "toolchain"}
    if isinstance(value, list):
        return [comparable(child) for child in value]
    return value


def semantic_digest(ir: dict[str, Any]) -> str:
    return digest({key: value for key, value in ir["spec"].items() if key not in NON_SEMANTIC})


def normalize(body: Any) -> Any:
    """What a fixture records of a response body (see the module docstring)."""
    if not isinstance(body, dict):
        return body
    result = {key: value for key, value in body.items() if key not in {"ir", "irDigest", "compilationDigest", "toolchain"}}
    if "ir" in body:
        result["ir"] = {
            "apiVersion": body["ir"]["apiVersion"],
            "kind": body["ir"]["kind"],
            "semanticDigest": semantic_digest(body["ir"]),
        }
    return result


def _pointer(document: Any, pointer: str) -> Any:
    for part in [item.replace("~1", "/").replace("~0", "~") for item in pointer.split("/")[1:]]:
        document = document[int(part)] if isinstance(document, list) else document[part]
    return document


def resolve(value: Any, bodies: dict[str, Any]) -> Any:
    """Replace every ``{"$ref": "step#/pointer"}`` by the member of that step's (actual) response."""
    if isinstance(value, dict):
        if set(value) == {"$ref"}:
            step, _, pointer = value["$ref"].partition("#")
            return copy.deepcopy(_pointer(bodies[step], pointer))
        return {key: resolve(child, bodies) for key, child in value.items()}
    if isinstance(value, list):
        return [resolve(child, bodies) for child in value]
    return value


# --- the scripts -------------------------------------------------------------------------------------


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _step(step_id: str, description: str, path: str, body: Any, method: str = "POST") -> dict[str, Any]:
    return {"id": step_id, "description": description, "request": {"method": method, "path": f"/bim/v1{path}", "body": body}}


def _package_body(data: bytes) -> dict[str, Any]:
    return {"package": _b64(data), "registeredResources": []}


def _compile_step() -> dict[str, Any]:
    return _step("compile", "Compile the demo package to its IR.", "/compile", _package_body(demo_zip()))


def _manifest(name: str) -> dict[str, Any]:
    return json.loads((MANIFEST_DIR / f"{name}.json").read_text(encoding="utf-8"))


def _honest_answer() -> dict[str, Any]:
    """An engine answer whose numbers are the right ones: the authoritative result of a bare binding."""
    bare = {"termination": "FEASIBLE", "solutions": [{"decision": {"kind": "binding", "binding": BINDING}}]}
    honest = reevaluate_result(demo_problem(), bare)
    return {"termination": "FEASIBLE", "solutions": honest["solutions"], "provenance": {"engine": "consumer-fixture"}}


def _lying_answer() -> dict[str, Any]:
    """The same decision with invented numbers, hidden violations and a termination nobody can back."""
    answer = copy.deepcopy(_honest_answer())
    solution = answer["solutions"][0]
    solution["features"] = {name: 0.0 for name in solution["features"]}
    solution["objectives"]["score"] = 0.0
    solution["objectives"]["penalty"] = 0.0
    for component in solution["objectives"]["components"]:
        component["value"] = 0.0
        component["loss"] = 0.0
    solution["penalties"] = [0.0 for _ in solution["penalties"]]
    answer["termination"] = "OPTIMAL"
    return answer


def scripts() -> dict[str, dict[str, Any]]:
    """The fixtures, without expected answers: name -> {description, steps}."""
    ir = {"$ref": "compile#/ir"}
    random_search, minizinc = _manifest("random-search"), _manifest("minizinc-csp")
    return {
        "compile": {
            "description": "Compile and validate a small package, a package with a diagnostic and bytes that are not a package.",
            "steps": [
                _compile_step(),
                _step("validate", "The same package, validated (no IR in the answer).", "/validate", _package_body(demo_zip())),
                _step("validate-broken", "A package that declares a resource it does not contain: findings as data.", "/validate", _package_body(demo_zip(broken=True))),
                _step("compile-broken", "The same package compiled: 422 with the diagnostics.", "/compile", _package_body(demo_zip(broken=True))),
                _step("compile-not-a-package", "Bytes that are not a ZIP: 422 package_error.", "/compile", _package_body(b"not a zip")),
            ],
        },
        "compatibility": {
            "description": "Which Engine modes can run the demo IR, and why not.",
            "steps": [
                _compile_step(),
                _step("random-search", "A mode that declares every capability the IR uses.", "/compatibility", {"ir": ir, "manifest": random_search, "mode": "seeded"}),
                _step("random-search-options", "The same with execution options.", "/compatibility", {"ir": ir, "manifest": random_search, "mode": "seeded", "options": {"iterations": 50, "seed": 7}}),
                _step("minizinc", "A mode that does not support everything the IR uses.", "/compatibility", {"ir": ir, "manifest": minizinc, "mode": "exact-weighted"}),
                _step("unknown-mode", "A mode the manifest does not have: 422 engine_mode_incompatible.", "/compatibility", {"ir": ir, "manifest": random_search, "mode": "nope"}),
                _step("unknown-option", "An option the mode does not declare: 422 unknown_option.", "/compatibility", {"ir": ir, "manifest": random_search, "mode": "seeded", "options": {"bogus": 1}}),
            ],
        },
        "optimization": {
            "description": "Resolve the execution-time optimization selection against an Engine mode.",
            "steps": [
                _compile_step(),
                _step("weighted", "SINGLE weighted-sum without weights: equal weights.", "/optimization/resolve", {"ir": ir, "manifest": random_search, "mode": "seeded", "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"}}),
                _step("weighted-explicit", "SINGLE weighted-sum with weights that are normalized.", "/optimization/resolve", {"ir": ir, "manifest": random_search, "mode": "seeded", "optimization": {"type": "SINGLE", "scalarization": "weighted-sum", "weights": [{"criteria": "latency", "value": 3}, {"criteria": "cost", "value": 1}]}}),
                _step("pareto", "MULTI pareto-front.", "/optimization/resolve", {"ir": ir, "manifest": random_search, "mode": "seeded", "optimization": {"type": "MULTI", "scalarization": "pareto-front"}}),
                _step("incompatible", "SINGLE with a scalarization that is for MULTI: 422 optimization_type_incompatible.", "/optimization/resolve", {"ir": ir, "manifest": random_search, "mode": "seeded", "optimization": {"type": "SINGLE", "scalarization": "pareto-front"}}),
            ],
        },
        "evaluate": {
            "description": "Evaluate bindings with the canonical evaluator.",
            "steps": [
                _compile_step(),
                _step("one", "One valid binding.", "/evaluate", {"ir": ir, "bindings": [BINDING]}),
                _step("collect", "A valid and an invalid binding with onError=collect.", "/evaluate", {"ir": ir, "bindings": [BINDING, {"t1": BINDING["t1"]}], "onError": "collect"}),
                _step("raise", "The same with onError=raise: 422 binding_invalid.", "/evaluate", {"ir": ir, "bindings": [BINDING, {"t1": BINDING["t1"]}]}),
                _step("neighborhood", "The one-task alternatives of the binding.", "/neighborhood", {"ir": ir, "binding": BINDING, "limit": 8}),
            ],
        },
        "reevaluate-agreement": {
            "description": "An engine answer whose numbers are right: the authoritative result repeats them.",
            "steps": [
                _compile_step(),
                _step("reevaluate", "Re-evaluate an honest FEASIBLE answer.", "/reevaluate", {"ir": ir, "result": _honest_answer()}),
            ],
        },
        "reevaluate-discrepancy": {
            "description": "An engine answer with invented numbers and an OPTIMAL it cannot back: only the binding survives.",
            "steps": [
                _compile_step(),
                _step("reevaluate", "Re-evaluate a lying OPTIMAL answer: numbers are replaced, termination lowered to UNKNOWN.", "/reevaluate", {"ir": ir, "result": _lying_answer()}),
                _step("reevaluate-allowed", "The same when the mode is trusted with OPTIMAL.", "/reevaluate", {"ir": ir, "result": _lying_answer(), "allowedTerminations": ["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"]}),
            ],
        },
        "validate-result": {
            "description": "Shape validation of bim-engine/v1 results (not a check that the numbers are right).",
            "steps": [
                _step("valid", "A well-formed answer.", "/validate-result", {"result": _honest_answer()}),
                _step("missing-field", "A solution without `penalties`.", "/validate-result", {"result": _without(_honest_answer(), "penalties")}),
                _step("extra-field", "A field that bim-engine/v1 does not define.", "/validate-result", {"result": {**_honest_answer(), "elapsed": 1.0}}),
                _step("bad-termination", "A termination that does not exist.", "/validate-result", {"result": {**_honest_answer(), "termination": "optimal"}}),
                _step("not-an-object", "A JSON array.", "/validate-result", {"result": [1, 2, 3]}),
            ],
        },
    }


def _without(answer: dict[str, Any], member: str) -> dict[str, Any]:
    answer = copy.deepcopy(answer)
    del answer["solutions"][0][member]
    return answer


# --- running and recording ---------------------------------------------------------------------------


def run_steps(steps: list[dict[str, Any]], execute: Execute) -> list[dict[str, Any]]:
    """Execute ``steps`` in order; return, for each, the status and the actual (raw) body."""
    bodies: dict[str, Any] = {}
    outcomes: list[dict[str, Any]] = []
    for step in steps:
        request = step["request"]
        body = resolve(request["body"], bodies)
        status, answer = execute(request["method"], request["path"], body)
        bodies[step["id"]] = answer
        outcomes.append({"id": step["id"], "status": status, "body": answer})
    return outcomes


def build_fixtures(execute: Execute) -> dict[str, dict[str, Any]]:
    """The complete fixtures: every script with the answers ``execute`` gives (normalized)."""
    fixtures: dict[str, dict[str, Any]] = {}
    for name, script in scripts().items():
        outcomes = run_steps(script["steps"], execute)
        steps = []
        for step, outcome in zip(script["steps"], outcomes, strict=True):
            recorded = {**step, "expect": {"status": outcome["status"], "body": normalize(outcome["body"])}}
            if isinstance(outcome["body"], dict) and "toolchain" in outcome["body"]:
                recorded["toolchain"] = {"compilerDigest": outcome["body"]["toolchain"]["compilerDigest"], "irDigest": outcome["body"].get("irDigest")}
            steps.append(recorded)
        fixtures[name] = {"schema": SCHEMA, "consumer": "openbinding", "name": name, "description": script["description"], "steps": steps}
    return fixtures


def replay(fixture: dict[str, Any], execute: Execute) -> list[str]:
    """Run a recorded fixture; the list of the steps whose status or normalized body differ from the record."""
    outcomes = run_steps(fixture["steps"], execute)
    differing = []
    for step, outcome in zip(fixture["steps"], outcomes, strict=True):
        expected = step["expect"]
        if outcome["status"] != expected["status"] or comparable(normalize(outcome["body"])) != comparable(expected["body"]):
            differing.append(step["id"])
    return differing


def dump(document: Any) -> bytes:
    """The one byte representation of a fixture: sorted keys, one-space indent, LF."""
    return (json.dumps(document, sort_keys=True, indent=1, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")


def load_fixtures(directory: Path = FIXTURE_DIR) -> dict[str, dict[str, Any]]:
    return {path.stem: json.loads(path.read_text(encoding="utf-8")) for path in sorted(directory.glob("*.json"))}


def local_execute() -> Execute:
    """An ``execute`` that mounts the service in this process (anonymous, for development)."""
    from starlette.testclient import TestClient

    from bim_service.app import build_app
    from bim_service.auth import Authenticator
    from bim_service.settings import BimServiceSettings

    client = TestClient(build_app(BimServiceSettings(), Authenticator(anonymous=True)), base_url="http://bim.test")

    def execute(method: str, path: str, body: Any) -> tuple[int, Any]:
        response = client.request(method, path, json=body)
        return response.status_code, response.json()

    return execute


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="compare the committed fixtures with a fresh run")
    arguments = parser.parse_args(argv)
    execute = local_execute()
    if arguments.check:
        committed = load_fixtures()
        problems = [f"{name}: {step}" for name, fixture in committed.items() for step in replay(fixture, execute)]
        missing = sorted(set(scripts()) - set(committed))
        for line in [*problems, *(f"{name}: fixture is missing" for name in missing)]:
            print(line)
        return 1 if problems or missing else 0
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for name, fixture in build_fixtures(execute).items():
        (FIXTURE_DIR / f"{name}.json").write_bytes(dump(fixture))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
