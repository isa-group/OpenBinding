#!/usr/bin/env python3
"""Acceptance probe of ``bim-service`` running with ``BIM_SERVICE_EXECUTOR=process`` in the real lab demo.

It talks only HTTP to ``BIM_SERVICE_URL`` (default ``http://bim-service:8080``) with the bearer token of
``BIM_SERVICE_TOKEN_FILE`` (default ``/run/bim/token``), exactly as the gateway does, and uses nothing but the public
limits, inputs and routes of the service. It touches no gateway, database, SPACE or SPHERE: every payload is
synthetic. Run it through the ``seed`` service of the lab (``DEMO_SEED_TOOL=process_probe.py``), see
``docs/qa/PROCESS_PROBE.md``.

Output: ONE JSON document on stdout, ``{"tool", "ok", "steps": [{name, ok, checks: [{name, ok, expected,
observed}], ...}], "observations": {...}}``. Progress and the phase marks (monotonic and epoch seconds) go to stderr
as ``PHASE <label> monotonic=<s> epoch=<s>`` and are repeated in ``observations.timeline``. The token is never
printed. Exit code: 0 when every step that ran met every expectation, 1 when any did not, 2 on a configuration error.
For runners that keep only the tail of the output, ``--summary`` makes stdout ONE compact line (the failed checks, the key
figures and the timeline) and sends the full report to stderr, after the phase marks.

Steps (``--steps``, default all but the last; each is independent, a failure never aborts the next one):
    capabilities         limits.service is the N2 profile, and does not advertise more than the container holds
    valid_operations     compile/validate/evaluate/reevaluate/compatibility/resources on the synthetic consumer
                         package, twice, with identical bodies and the digests of the consumer contract
    hostile_small        small hostile inputs: status and problem+json code as in thread mode
    large_bodies         Content-Length over the limit, chunked body crossing it, a body at the limit, bodies in flight
                         above the pending-bytes limit
    saturation           more concurrent costly requests than slots: 503 service_busy / 429 with Retry-After, no
                         unexpected 5xx
    healthz_under_load   /healthz latency while costly valid operations keep every slot busy
    timeout_replacement  (only with --timeout-probe, needs BIM_SERVICE_OPERATION_TIMEOUT_SECONDS=3 in the service)
                         a valid request over the time budget: 503 operation_timeout, /healthz stays 200, the next
                         request is served by the replacement worker

The costly valid operation is ``POST /neighborhood`` with ``limit`` 128 on a synthetic IR compiled here with the
bim-core of this image (a chain of N service tasks with two candidates and four features each). The service re-validates
the IR against its schema and evaluates up to 128 one-task alternatives: the time grows with N, so the probe measures a
request alone and grows N until it lasts as long as the step needs (or the body would pass ``--cost-body-fraction``
of the body limit).

Usage:
    python tools/process_probe.py [--timeout-probe] [--hold SECONDS] [--steps a,b,c|all|none] [--repeat 2] ...
"""

from __future__ import annotations

import argparse
import base64
import copy
import functools
import hashlib
import http.client
import json
import math
import os
import sys
import threading
import time
import urllib.parse
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from bim_client import InProcessBim
from bim_core import InstancePackage, compile_instance, compiler_bundle_digest, digest

MIB = 1024 * 1024
EXIT_OK, EXIT_FAILED, EXIT_CONFIG = 0, 1, 2
TOOL = "process_probe"

DEFAULT_URL = "http://bim-service:8080"
DEFAULT_TOKEN_FILE = "/run/bim/token"
API = "/bim/v1"
CAPABILITIES = f"{API}/capabilities"
COMPILE = f"{API}/compile"
VALIDATE = f"{API}/validate"
COMPATIBILITY = f"{API}/compatibility"
OPTIMIZATION = f"{API}/optimization/resolve"
EVALUATE = f"{API}/evaluate"
REEVALUATE = f"{API}/reevaluate"
VALIDATE_RESULT = f"{API}/validate-result"
NEIGHBORHOOD = f"{API}/neighborhood"
RESOURCE_VALIDATE = f"{API}/resources/validate"
ENGINE_VALIDATE = f"{API}/engines/validate"
XML_ROOT = f"{API}/resources/xml/root"
JSON_TYPE = "application/json"
PROBLEM_TYPE = "application/problem+json"
PROBLEM_PREFIX = "urn:bim-toolchain:problem:"

STEP_NAMES = (
    "capabilities",
    "valid_operations",
    "hostile_small",
    "large_bodies",
    "saturation",
    "healthz_under_load",
)
TIMEOUT_STEP = "timeout_replacement"

#: The profile of ``compose.lab-process-n2.json`` (``lab/tests/test_lab_process_profiles.py`` pins the same figures).
N2_DEFAULTS = {
    "executor": "process",
    "max_body_bytes": 2 * MIB,
    "concurrency": 2,
    "tenant_limit": 0,
    "acquire_timeout_ms": 2000,
    "memory_budget_bytes": 16 * MIB,
    "pending_body_bytes": 4 * MIB,
    "container_memory_bytes": 256 * MIB,
}
#: ``BIM_SERVICE_OPERATION_TIMEOUT_SECONDS`` of the default profile and of ``compose.lab-process-n2-probe.json``.
DEFAULT_OPERATION_TIMEOUT = 60.0
PROBE_OPERATION_TIMEOUT = 3.0

# The fit rule of bim_service.workers.memory_fit with the conservative figures of docs/qa/PROCESS_DEPLOYMENT.md.
BODY_MEMORY_FACTOR = 8
FIT_MARGIN = 0.10
PARENT_RSS_CONSERVATIVE = 60 * MIB
CHILD_RSS_CONSERVATIVE = 54 * MIB

#: What the consumer contract (``bim-toolchain/contracts/consumers/openbinding/compile.json``) records of the demo package.
PINNED_COMPILE = {
    "packageDigest": "sha256-011e8f95939fae5b45e41687dfd3ffb0eb21648f6b591f7e2c1080a097dbff74",
    "instanceDigest": "sha256-3c3f7ae7926ecd01dea6535dd8f4170dfe73d30e17565a33eed622e979d7a1bd",
    "inputDigest": "sha256-bab0665c7698af16aae5261f425d8a5110b3b97496e701433249a940ec18a916",
    "irSemanticDigest": "sha256-88faceb9ed5ccd1d0db24093dd43b4845879c221b23a6aeb2790b01b7d08a743",
}
NON_SEMANTIC = frozenset({"profile", "dialects", "instance", "sourceMap"})

#: Answers of the service that mean "refused for load", with ``Retry-After``.
REFUSALS = frozenset({(503, "service_busy"), (429, "memory_budget"), (429, "pending_body_bytes"), (429, "rate_limited")})
NEIGHBORHOOD_LIMIT = 128  # bim_core.neighborhood.MAX_EVALUATIONS
MAX_RUNGS = 8


class ConfigError(Exception):
    """The probe cannot start: a missing token, a bad option."""


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def dumps(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def clip(value: Any, limit: int = 300) -> Any:
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + f"...[{len(value)} chars]"
    return value


def percentile(values: Sequence[float], q: float) -> float:
    """Nearest-rank percentile (``q`` in 0..1); 0.0 for no values."""
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, math.ceil(q * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


def fit_required_bytes(*, body: int, workers: int, budget: int, pending: int, container: int) -> int:
    """``P + Q + N*C + B + N*(L + R) + margin`` with conservative ``P`` and ``C`` (``R`` = 8 L, the allowance)."""
    allowance = BODY_MEMORY_FACTOR * body
    return (
        PARENT_RSS_CONSERVATIVE
        + pending
        + workers * CHILD_RSS_CONSERVATIVE
        + (budget or workers * allowance)
        + workers * (body + allowance)
        + int(FIT_MARGIN * container)
    )


def padded_result_body(total: int) -> bytes:
    """A valid ``/validate-result`` request body of exactly ``total`` bytes (a string of ``a``)."""
    prefix, suffix = b'{"result":"', b'"}'
    if total < len(prefix) + len(suffix):
        raise ValueError("the body is smaller than its own frame")
    return prefix + b"a" * (total - len(prefix) - len(suffix)) + suffix


def json_chunks(total: int, *, close: bool, size: int = 16384) -> Iterator[bytes]:
    """The pieces of a ``/validate-result`` body of ``total`` bytes: a string of ``a``, closed only when ``close``."""
    suffix = b'"}' if close else b""
    yield b'{"result":"'
    sent = 11
    while sent < total - len(suffix):
        piece = min(size, total - len(suffix) - sent)
        yield b"a" * piece
        sent += piece
    if suffix:
        yield suffix


# --------------------------------------------------------------------------
# The synthetic consumer package (the demo of tools/consumer_fixtures.py) and the costly IR
# --------------------------------------------------------------------------


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


def demo_files(*, broken: bool = False) -> dict[str, bytes]:
    """The files of the demo package; ``broken`` declares a resource that is not in the package."""
    instance = {
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
    if broken:
        instance["spec"]["resources"]["candidateCatalog"]["cat-c"] = "missing.json"
    files = {"instance.json": json.dumps(instance).encode()}
    files.update({path: json.dumps(document).encode() for path, document in demo_documents().items()})
    return files


def demo_zip(*, broken: bool = False) -> bytes:
    """The demo package as the deterministic ``.bim.zip`` OpenBinding stores."""
    return InstancePackage(demo_files(broken=broken)).to_zip()


BINDING = {"t1": {"resource": "cat-a", "id": "c1"}, "t2": {"resource": "cat-b", "id": "c1"}}

#: ``bim-core/tests/fixtures/manifests/random-search.json``, the Engine manifest of the consumer contract.
RANDOM_SEARCH_MANIFEST: dict[str, Any] = {
    "apiVersion": "bim/v1",
    "kind": "Engine",
    "metadata": {
        "namespace": "bim.builtin",
        "name": "random-search",
        "version": "1.0.0",
        "description": "Seeded random search over canonical BIM v1 binding decisions",
    },
    "spec": {
        "modes": [
            {
                "id": "seeded",
                "profile": "qos-binding/v1",
                "ir": {"apiVersion": "bim/v1", "kind": "BindingProblem"},
                "algorithm": "seeded-random-search",
                "capabilities": {
                    "workflowNodes": {"selector": "all"},
                    "featureScopes": {"selector": "all"},
                    "featureValues": {"selector": "only", "values": ["scalar"]},
                    "aggregations": {"selector": "all"},
                    "constraints": {"selector": "all"},
                    "scalarizations": {
                        "selector": "only",
                        "values": [
                            {"id": "weighted-sum", "objectiveTypes": ["SINGLE"], "weightPolicy": "required"},
                            {"id": "pareto-front", "objectiveTypes": ["MULTI", "MANY"], "weightPolicy": "forbidden"},
                            {"id": "feasibility", "objectiveTypes": ["SINGLE"], "weightPolicy": "forbidden"},
                        ],
                    },
                    "expressions": {"selector": "all"},
                    "placement": {"selector": "all"},
                    "irExtensions": {"selector": "only", "values": ["qos-binding-placement/v1"]},
                },
                "optionsSchema": {
                    "type": "object",
                    "properties": {
                        "iterations": {"type": "integer", "minimum": 1, "maximum": 1000000, "default": 1000},
                        "seed": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991,
                            "default": 0,
                        },
                        "time_budget_ms": {"type": "integer", "minimum": 1, "maximum": 3600000},
                    },
                    "additionalProperties": False,
                },
                "limits": {"maxIterations": 1000000, "maxTimeBudgetMs": 3600000},
                "guarantees": {
                    "termination": ["FEASIBLE", "UNKNOWN"],
                    "exact": False,
                    "deterministicWithoutTimeBudget": True,
                },
            }
        ]
    },
}

FEATURES = (("latency", "ms"), ("cost", "eur"), ("energy", "j"), ("carbon", "g"))


def synthetic_files(tasks: int) -> dict[str, bytes]:
    """A package of ``tasks`` service tasks in sequence, two candidates per task and four features per candidate."""
    names = [f"t{index}" for index in range(tasks)]
    application = _envelope(
        "Application",
        "app",
        {
            "tasks": {name: f"s{index}/v1" for index, name in enumerate(names)},
            "features": {
                feature: {"unit": unit, "direction": "minimize", "aggregation": "sum"} for feature, unit in FEATURES
            },
            "workflow": {"sequence": [{"task": {"resource": "app", "id": name}} for name in names]},
        },
    )
    candidates: dict[str, Any] = {}
    for index in range(tasks):
        for offset, suffix in enumerate("ab"):
            candidates[f"c{index}{suffix}"] = {
                "provider": {"resource": "cat", "id": "p"},
                "provides": f"s{index}/v1",
                "features": {
                    feature: 1 + (index + offset + position) % 9 for position, (feature, _) in enumerate(FEATURES)
                },
            }
    catalog = _envelope(
        "CandidateCatalog",
        "cat",
        {
            "providers": {"p": {"name": "P"}},
            "featureBindings": {feature: {"resource": "app", "id": feature} for feature, _ in FEATURES},
            "candidates": candidates,
        },
    )
    bound = max(100, tasks * 10)
    optimization = _envelope(
        "Optimization",
        "opt",
        {
            "criteria": [
                {
                    "id": feature,
                    "feature": {"resource": "app", "id": feature},
                    "normalize": {"min": 0, "max": bound, "clamp": False},
                }
                for feature, _ in FEATURES
            ],
            "penalties": [{"constraint": {"resource": "soft", "id": "limit"}, "weight": 1}],
        },
    )
    documents = {
        "application.json": application,
        "catalog.json": catalog,
        "hard.json": _envelope(
            "ConstraintSet", "hard", {"constraints": {"limit": {"assert": "features.latency <= 1000000000", "enforcement": "hard"}}}
        ),
        "soft.json": _envelope(
            "ConstraintSet",
            "soft",
            {"constraints": {"limit": {"assert": "has(tasks.t0.provider)", "enforcement": "soft", "penalty": 2}}},
        ),
        "optimization.json": optimization,
    }
    instance = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": "probe-synthetic"},
        "spec": {
            "profile": "qos-binding/v1",
            "resources": {
                "application": {"app": "application.json"},
                "candidateCatalog": {"cat": "catalog.json"},
                "constraintSet": {"hard": "hard.json", "soft": "soft.json"},
                "optimization": {"opt": "optimization.json"},
            },
        },
    }
    files = {"instance.json": json.dumps(instance).encode()}
    files.update({path: json.dumps(document).encode() for path, document in documents.items()})
    return files


@functools.lru_cache(maxsize=4)
def synthetic_ir(tasks: int) -> tuple[dict[str, Any], dict[str, Any]]:
    """``(IR document, a valid binding)`` of the synthetic package of ``tasks`` tasks, compiled by this image's bim-core."""
    problem = compile_instance(InstancePackage(synthetic_files(tasks)))
    binding = {f"t{index}": {"resource": "cat", "id": f"c{index}a"} for index in range(tasks)}
    return problem.document, binding


def costly_body(tasks: int, seconds: float) -> bytes:
    """A valid ``/neighborhood`` request that evaluates up to 128 alternatives of a binding of ``tasks`` tasks."""
    ir, binding = synthetic_ir(tasks)
    return dumps({"ir": ir, "binding": binding, "limit": NEIGHBORHOOD_LIMIT, "seconds": seconds})


# --------------------------------------------------------------------------
# Comparison with bim-core (the oracle of the consumer contract)
# --------------------------------------------------------------------------


def comparable(value: Any) -> Any:
    """Drop every ``toolchain`` member: informative, expected to change with the toolchain."""
    if isinstance(value, dict):
        return {key: comparable(child) for key, child in value.items() if key != "toolchain"}
    if isinstance(value, list):
        return [comparable(child) for child in value]
    return value


def semantic_digest(ir: Mapping[str, Any]) -> str:
    return digest({key: value for key, value in mapping(ir.get("spec")).items() if key not in NON_SEMANTIC})


def normalize(body: Any) -> Any:
    """What a consumer fixture records of an answer: no ``irDigest``/``compilationDigest``, the IR as its semantic digest."""
    if not isinstance(body, dict):
        return body
    result = {key: value for key, value in body.items() if key not in {"ir", "irDigest", "compilationDigest", "toolchain"}}
    if isinstance(body.get("ir"), dict):
        result["ir"] = {
            "apiVersion": body["ir"].get("apiVersion"),
            "kind": body["ir"].get("kind"),
            "semanticDigest": semantic_digest(body["ir"]),
        }
    return result


# --------------------------------------------------------------------------
# HTTP (stdlib: one connection per request, so threads share nothing)
# --------------------------------------------------------------------------


@dataclass
class Reply:
    status: int  # 0: no answer (see ``error``)
    headers: dict[str, str]
    body: bytes
    seconds: float
    started: float  # time.monotonic() when the request was sent
    epoch: float
    error: str = ""

    @functools.cached_property
    def data(self) -> Any:
        try:
            return json.loads(self.body)
        except ValueError:
            return None

    @property
    def code(self) -> str:
        code = mapping(self.data).get("code")
        return code if isinstance(code, str) else ""

    @property
    def retry_after(self) -> int | None:
        value = self.headers.get("retry-after", "").strip()
        return int(value) if value.isdigit() else None

    @property
    def is_problem(self) -> bool:
        return self.headers.get("content-type", "").startswith(PROBLEM_TYPE)

    def label(self) -> str:
        if self.status == 0:
            return f"no-answer ({clip(self.error, 80)})"
        return f"{self.status} {self.code}".strip()


class Http:
    def __init__(self, url: str, token: str, timeout: float = 30.0) -> None:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            raise ConfigError(f"BIM_SERVICE_URL is not an http(s) URL: {url!r}")
        self.secure = parts.scheme == "https"
        self.host = parts.hostname
        self.port = parts.port or (443 if self.secure else 80)
        self.prefix = parts.path.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _connection(self, timeout: float | None) -> http.client.HTTPConnection:
        factory = http.client.HTTPSConnection if self.secure else http.client.HTTPConnection
        return factory(self.host, self.port, timeout=timeout or self.timeout)

    def _headers(self, content_type: str | None, auth: bool, token: str | None, extra: Mapping[str, str] | None) -> dict[str, str]:
        headers = {"Accept": "application/json, application/problem+json"}
        if content_type:
            headers["Content-Type"] = content_type
        if auth:
            headers["Authorization"] = f"Bearer {self.token if token is None else token}"
        headers.update(extra or {})
        return headers

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | Iterable[bytes] | None = None,
        content_type: str | None = JSON_TYPE,
        auth: bool = True,
        token: str | None = None,
        headers: Mapping[str, str] | None = None,
        chunked: bool = False,
        declared_length: int | None = None,
        timeout: float | None = None,
    ) -> Reply:
        """One request. ``declared_length`` sends the headers only (a ``Content-Length`` that the body never fills);
        ``chunked`` sends ``body`` (an iterable) with ``Transfer-Encoding: chunked``."""
        connection = self._connection(timeout)
        sent = self._headers(content_type if body is not None or declared_length is not None else None, auth, token, headers)
        target = self.prefix + path
        started, epoch = time.monotonic(), time.time()
        status, answer_headers, data, error = 0, {}, b"", ""
        try:
            if declared_length is not None:
                connection.putrequest(method, target)
                for key, value in sent.items():
                    connection.putheader(key, value)
                connection.putheader("Content-Length", str(declared_length))
                connection.endheaders()
            elif chunked:
                try:
                    connection.request(method, target, body=body, headers=sent, encode_chunked=True)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass  # the service answered (and closed) before the whole body was sent
            else:
                connection.request(method, target, body=body, headers=sent)
            response = connection.getresponse()
            data = response.read()
            status = response.status
            answer_headers = {key.lower(): value for key, value in response.getheaders()}
        except (OSError, http.client.HTTPException) as exc:
            error = f"{type(exc).__name__}: {exc}"
        finally:
            connection.close()
        return Reply(status, answer_headers, data, time.monotonic() - started, started, epoch, error)

    def slow_upload(
        self,
        path: str,
        data: bytes,
        *,
        first: int,
        reached: threading.Event,
        release: threading.Event,
        wait: float,
    ) -> Reply:
        """Declare ``len(data)`` bytes, send ``first`` of them, wait for ``release``, send the rest and read the answer."""
        connection = self._connection(max(self.timeout, wait + 30))
        sent = self._headers(JSON_TYPE, True, None, None)
        started, epoch = time.monotonic(), time.time()
        status, answer_headers, answer, error = 0, {}, b"", ""
        try:
            connection.putrequest("POST", self.prefix + path)
            for key, value in sent.items():
                connection.putheader(key, value)
            connection.putheader("Content-Length", str(len(data)))
            connection.endheaders()
            connection.send(data[:first])
            reached.set()
            release.wait(wait)
            connection.send(data[first:])
            response = connection.getresponse()
            answer = response.read()
            status = response.status
            answer_headers = {key.lower(): value for key, value in response.getheaders()}
        except (OSError, http.client.HTTPException) as exc:
            error = f"{type(exc).__name__}: {exc}"
        finally:
            reached.set()
            connection.close()
        return Reply(status, answer_headers, answer, time.monotonic() - started, started, epoch, error)


# --------------------------------------------------------------------------
# Configuration, results
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Expected:
    """``limits.service`` that the service must publish (the profile under test)."""

    executor: str = N2_DEFAULTS["executor"]
    max_body_bytes: int = N2_DEFAULTS["max_body_bytes"]
    concurrency: int = N2_DEFAULTS["concurrency"]
    tenant_limit: int = N2_DEFAULTS["tenant_limit"]
    acquire_timeout_ms: int = N2_DEFAULTS["acquire_timeout_ms"]
    memory_budget_bytes: int = N2_DEFAULTS["memory_budget_bytes"]
    pending_body_bytes: int = N2_DEFAULTS["pending_body_bytes"]
    container_memory_bytes: int = N2_DEFAULTS["container_memory_bytes"]
    operation_timeout_seconds: float = DEFAULT_OPERATION_TIMEOUT


@dataclass(frozen=True)
class ProbeConfig:
    url: str
    token: str
    expected: Expected
    steps: tuple[str, ...] = STEP_NAMES
    timeout_probe: bool = False
    hold: float = 0.0
    repeat: int = 2
    request_timeout: float = 60.0
    cost_seconds: float = 1.0
    load_seconds: float = 6.0
    body_fraction: float = 0.7
    start_tasks: int = 60
    healthz_p95_ms: float = 500.0
    healthz_max_ms: float = 2500.0
    at_limit: bool = True


class Step:
    """The expectations of one scenario, each with what was expected and what was observed."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.checks: list[dict[str, Any]] = []
        self.details: dict[str, Any] = {}
        self.started_monotonic = time.monotonic()
        self.started_epoch = time.time()
        self.ended_monotonic = self.started_monotonic

    def check(self, name: str, ok: bool, expected: Any, observed: Any) -> bool:
        self.checks.append({"name": name, "ok": bool(ok), "expected": clip(expected), "observed": clip(observed)})
        return bool(ok)

    def equal(self, name: str, expected: Any, observed: Any) -> bool:
        return self.check(name, expected == observed, expected, observed)

    @property
    def ok(self) -> bool:
        return bool(self.checks) and all(check["ok"] for check in self.checks)

    def finish(self) -> None:
        self.ended_monotonic = time.monotonic()

    def as_dict(self) -> dict[str, Any]:
        failed = [check["name"] for check in self.checks if not check["ok"]]
        return {
            "name": self.name,
            "ok": self.ok,
            "failed": failed,
            "startedMonotonic": round(self.started_monotonic, 3),
            "startedEpoch": round(self.started_epoch, 3),
            "elapsedMs": round((self.ended_monotonic - self.started_monotonic) * 1000, 1),
            "checks": self.checks,
            "details": self.details,
        }


@dataclass
class CostlyPlan:
    """A valid request that lasts about ``solo_seconds`` alone."""

    tasks: int
    body: bytes
    solo_seconds: float
    status: int
    code: str
    reached_target: bool
    history: list[dict[str, Any]] = field(default_factory=list)
    note: str = ""


# --------------------------------------------------------------------------
# The probe
# --------------------------------------------------------------------------


class Probe:
    def __init__(self, config: ProbeConfig, http_client: Http | None = None) -> None:
        self.config = config
        self.http = http_client or Http(config.url, config.token, config.request_timeout)
        self.timeline: list[dict[str, Any]] = []
        self.observations: dict[str, Any] = {}
        self.published: dict[str, Any] = {}
        self._plans: dict[str, CostlyPlan] = {}

    # -- bookkeeping --------------------------------------------------------

    def mark(self, label: str) -> None:
        entry = {"phase": label, "monotonic": round(time.monotonic(), 3), "epoch": round(time.time(), 3)}
        self.timeline.append(entry)
        print(f"PHASE {label} monotonic={entry['monotonic']} epoch={entry['epoch']}", file=sys.stderr, flush=True)

    def hold(self, label: str) -> None:
        if self.config.hold > 0:
            self.mark(f"hold:{label}:start")
            time.sleep(self.config.hold)
            self.mark(f"hold:{label}:end")

    @property
    def expected(self) -> Expected:
        return self.config.expected

    def post(self, path: str, body: bytes | Mapping[str, Any], **kwargs: Any) -> Reply:
        payload = body if isinstance(body, bytes) else dumps(body)
        return self.http.request("POST", path, body=payload, **kwargs)

    def normal_request(self, **kwargs: Any) -> Reply:
        """A cheap valid operation: it goes through a worker (process mode) like any other."""
        return self.post(VALIDATE_RESULT, {"result": {"termination": "UNKNOWN", "solutions": []}}, **kwargs)

    def health(self, check: Callable[[str, bool, Any, Any], bool], label: str) -> None:
        """Expectations that the service is up: /healthz and /readyz (public) and a normal operation."""
        healthz = self.http.request("GET", "/healthz", auth=False, timeout=10)
        readyz = self.http.request("GET", "/readyz", auth=False, timeout=10)
        normal = self.normal_request()
        check(f"{label}: /healthz", healthz.status == 200, 200, healthz.status)
        check(f"{label}: /readyz", readyz.status == 200, 200, readyz.status)
        check(f"{label}: a normal operation is served", normal.status == 200, 200, normal.label())

    def run_concurrent(self, count: int, function: Callable[[int], Reply]) -> list[Reply]:
        """``function(0..count-1)`` in ``count`` threads that start together."""
        go = threading.Event()

        def worker(index: int) -> Reply:
            go.wait()
            return function(index)

        with ThreadPoolExecutor(max_workers=count) as pool:
            futures = [pool.submit(worker, index) for index in range(count)]
            time.sleep(0.05)
            go.set()
            return [future.result() for future in futures]

    # -- the run --------------------------------------------------------------

    def run(self) -> dict[str, Any]:
        started = time.monotonic()
        self.mark("probe:start")
        results: list[dict[str, Any]] = []
        names = list(self.config.steps)
        if self.config.timeout_probe and TIMEOUT_STEP not in names:
            names.append(TIMEOUT_STEP)
        for index, name in enumerate(names):
            if index:
                self.hold(f"before:{name}")
            step = Step(name)
            self.mark(f"{name}:start")
            try:
                getattr(self, f"step_{name}")(step)
            except Exception as exc:  # noqa: BLE001 - one step's crash must not stop the next ones
                step.check("the step runs to completion", False, "no exception", f"{type(exc).__name__}: {clip(str(exc), 200)}")
            step.finish()
            self.mark(f"{name}:end")
            results.append(step.as_dict())
        self.mark("probe:end")
        skipped = [name for name in (*STEP_NAMES, TIMEOUT_STEP) if name not in names]
        self.observations.update(
            {
                "service": {"url": self.config.url, "published": self.published},
                "expected": asdict(self.expected),
                "skipped": skipped,
                "timeline": self.timeline,
                "elapsedSeconds": round(time.monotonic() - started, 1),
            }
        )
        return {
            "tool": TOOL,
            "ok": bool(results) and all(step["ok"] for step in results),
            "baseUrl": self.config.url,
            "steps": results,
            "observations": self.observations,
        }

    # -- 1. capabilities ------------------------------------------------------

    def step_capabilities(self, step: Step) -> None:
        reply = self.http.request("GET", CAPABILITIES)
        step.equal("GET /bim/v1/capabilities: status", 200, reply.status)
        body = mapping(reply.data)
        limits = mapping(mapping(body.get("limits")).get("service"))
        self.published = dict(limits)
        wanted = {
            "executor": self.expected.executor,
            "maxBodyBytes": self.expected.max_body_bytes,
            "maxConcurrentOperations": self.expected.concurrency,
            "maxConcurrentOperationsPerTenant": self.expected.tenant_limit,
            "acquireTimeoutMs": self.expected.acquire_timeout_ms,
            "memoryBudgetBytes": self.expected.memory_budget_bytes,
            "maxPendingBodyBytes": self.expected.pending_body_bytes,
            "operationTimeoutSeconds": self.expected.operation_timeout_seconds,
        }
        for key, value in wanted.items():
            step.equal(f"limits.service.{key}", value, limits.get(key))
        step.equal("service.name", "bim-service", mapping(body.get("service")).get("name"))

        published_body = limits.get("maxBodyBytes")
        published_budget = limits.get("memoryBudgetBytes")
        if isinstance(published_body, int) and isinstance(published_budget, int):
            step.check(
                "does not advertise a larger body than the profile",
                published_body <= self.expected.max_body_bytes,
                f"<= {self.expected.max_body_bytes}",
                published_body,
            )
            step.check(
                "a request at the advertised limit is admissible (memory budget off, or at least 8 x body)",
                published_budget == 0 or published_budget >= BODY_MEMORY_FACTOR * published_body,
                f"0 or >= {BODY_MEMORY_FACTOR * published_body}",
                published_budget,
            )
        if limits.get("executor") == "process" and all(
            isinstance(limits.get(key), int)
            for key in ("maxBodyBytes", "maxConcurrentOperations", "memoryBudgetBytes", "maxPendingBodyBytes")
        ):
            required = fit_required_bytes(
                body=limits["maxBodyBytes"],
                workers=limits["maxConcurrentOperations"],
                budget=limits["memoryBudgetBytes"],
                pending=limits["maxPendingBodyBytes"],
                container=self.expected.container_memory_bytes,
            )
            step.check(
                "the advertised limits fit the container (fit rule, conservative parent and worker sizes)",
                required <= self.expected.container_memory_bytes,
                f"required <= {self.expected.container_memory_bytes}",
                required,
            )
            step.details["fit"] = {
                "requiredBytes": required,
                "containerBytes": self.expected.container_memory_bytes,
                "headroomBytes": self.expected.container_memory_bytes - required,
            }

        local = compiler_bundle_digest()
        remote = body.get("compilerDigest")
        step.details["toolchain"] = {
            "service": mapping(body.get("toolchain")),
            "serviceCompilerDigest": remote,
            "probeCompilerDigest": local,
            "sameToolchain": remote == local,
        }
        self.observations["toolchainMatchesProbe"] = remote == local
        self.health(step.check, "capabilities")

    # -- 2. valid operations ----------------------------------------------------

    def case(
        self,
        step: Step,
        case_id: str,
        path: str,
        body: bytes | Mapping[str, Any],
        *,
        status: int = 200,
        code: str | None = None,
        oracle: Callable[[], Any] | None = None,
    ) -> Reply:
        payload = body if isinstance(body, bytes) else dumps(body)
        replies = [self.post(path, payload) for _ in range(max(1, self.config.repeat))]
        first = replies[0]
        step.check(f"{case_id}: status", all(reply.status == status for reply in replies), status, [r.status for r in replies])
        if code is not None:
            step.check(f"{case_id}: problem code", all(reply.code == code for reply in replies), code, [r.code for r in replies])
        hashes = {hashlib.sha256(reply.body).hexdigest() for reply in replies}
        step.check(f"{case_id}: identical answer in {len(replies)} runs", len(hashes) == 1, 1, len(hashes))
        if oracle is not None and first.status == 200:
            try:
                expected_body = oracle()
            except Exception as exc:  # noqa: BLE001 - an oracle that fails is a finding, not a crash
                step.check(f"{case_id}: bim-core computes the expected answer", False, "no error", f"{type(exc).__name__}: {clip(str(exc), 200)}")
            else:
                same = comparable(normalize(first.data)) == comparable(normalize(expected_body))
                step.check(f"{case_id}: answer equals the one of bim-core", same, "equal", "equal" if same else "differs")
        step.details.setdefault("operations", {})[case_id] = {
            "status": first.status,
            "sha256": hashlib.sha256(first.body).hexdigest()[:16],
            "ms": round(first.seconds * 1000, 1),
        }
        return first

    def step_valid_operations(self, step: Step) -> None:
        port = InProcessBim()
        good, bad = demo_zip(), demo_zip(broken=True)
        manifest = RANDOM_SEARCH_MANIFEST
        package = {"package": b64(good), "registeredResources": []}
        broken = {"package": b64(bad), "registeredResources": []}

        compiled = self.case(step, "compile", COMPILE, package, oracle=lambda: port.compile(good))
        body = mapping(compiled.data)
        if compiled.status != 200 or not isinstance(body.get("ir"), dict):
            step.check("compile gives an IR to run the other operations on", False, "an IR", compiled.label())
            return
        ir = body["ir"]
        for key in ("packageDigest", "instanceDigest", "inputDigest"):
            step.equal(f"compile: {key} is the one of the consumer contract", PINNED_COMPILE[key], body.get(key))
        step.equal("compile: IR semantic digest is the one of the consumer contract", PINNED_COMPILE["irSemanticDigest"], semantic_digest(ir))

        validated = self.case(step, "validate", VALIDATE, package, oracle=lambda: port.validate(good))
        step.equal("validate: valid", True, mapping(validated.data).get("valid"))
        step.equal("validate: packageDigest equals the one of compile", body.get("packageDigest"), mapping(validated.data).get("packageDigest"))
        found = self.case(step, "validate-broken", VALIDATE, broken, oracle=lambda: port.validate(bad))
        diagnostics = mapping(found.data).get("diagnostics")
        step.equal("validate-broken: valid is false", False, mapping(found.data).get("valid"))
        step.equal(
            "validate-broken: first diagnostic",
            "resource_missing",
            mapping(diagnostics[0]).get("code") if isinstance(diagnostics, list) and diagnostics else None,
        )
        self.case(step, "compile-broken", COMPILE, broken, status=422, code="compile_error")
        self.case(step, "compile-not-a-package", COMPILE, {"package": b64(b"not a zip"), "registeredResources": []}, status=422, code="package_error")

        compatible = self.case(
            step, "compatibility", COMPATIBILITY, {"ir": ir, "manifest": manifest, "mode": "seeded"},
            oracle=lambda: port.compatibility(ir, manifest, mode="seeded"),
        )  # fmt: skip
        step.equal("compatibility: compatible", True, mapping(compatible.data).get("compatible"))
        options = {"iterations": 50, "seed": 7}
        with_options = self.case(
            step, "compatibility-options", COMPATIBILITY, {"ir": ir, "manifest": manifest, "mode": "seeded", "options": options},
            oracle=lambda: port.compatibility(ir, manifest, mode="seeded", options=options),
        )  # fmt: skip
        step.equal("compatibility-options: options with defaults applied", options, mapping(with_options.data).get("options"))
        self.case(step, "compatibility-unknown-mode", COMPATIBILITY, {"ir": ir, "manifest": manifest, "mode": "nope"}, status=422, code="engine_mode_incompatible")
        self.case(step, "compatibility-unknown-option", COMPATIBILITY, {"ir": ir, "manifest": manifest, "mode": "seeded", "options": {"bogus": 1}}, status=422, code="unknown_option")

        weighted = {"type": "SINGLE", "scalarization": "weighted-sum"}
        pareto = {"type": "MULTI", "scalarization": "pareto-front"}
        self.case(
            step, "optimization-weighted", OPTIMIZATION, {"ir": ir, "manifest": manifest, "mode": "seeded", "optimization": weighted},
            oracle=lambda: port.resolve_optimization(ir, manifest, weighted, mode="seeded"),
        )  # fmt: skip
        self.case(
            step, "optimization-pareto", OPTIMIZATION, {"ir": ir, "manifest": manifest, "mode": "seeded", "optimization": pareto},
            oracle=lambda: port.resolve_optimization(ir, manifest, pareto, mode="seeded"),
        )  # fmt: skip
        wrong = {"type": "SINGLE", "scalarization": "pareto-front"}
        self.case(step, "optimization-incompatible", OPTIMIZATION, {"ir": ir, "manifest": manifest, "mode": "seeded", "optimization": wrong}, status=422, code="optimization_type_incompatible")

        mixed = [BINDING, {"t1": BINDING["t1"]}]
        self.case(
            step, "evaluate", EVALUATE, {"ir": ir, "bindings": [BINDING]},
            oracle=lambda: {"results": port.evaluate_many(ir, [BINDING], None, on_error="raise")},
        )  # fmt: skip
        collected = self.case(
            step, "evaluate-collect", EVALUATE, {"ir": ir, "bindings": mixed, "onError": "collect"},
            oracle=lambda: {"results": port.evaluate_many(ir, mixed, None, on_error="collect")},
        )  # fmt: skip
        results = mapping(collected.data).get("results")
        step.equal(
            "evaluate-collect: the invalid binding is reported per binding",
            "binding_invalid",
            mapping(mapping(results[1]).get("error")).get("code") if isinstance(results, list) and len(results) == 2 else None,
        )
        self.case(step, "evaluate-raise", EVALUATE, {"ir": ir, "bindings": mixed}, status=422, code="binding_invalid")
        around = self.case(
            step, "neighborhood", NEIGHBORHOOD, {"ir": ir, "binding": BINDING, "limit": 8},
            oracle=lambda: port.neighborhood(ir, BINDING, limit=8),
        )  # fmt: skip
        step.equal("neighborhood: coverage is complete", True, mapping(mapping(around.data).get("coverage")).get("complete"))

        bare = {"termination": "FEASIBLE", "solutions": [{"decision": {"kind": "binding", "binding": BINDING}}]}
        honest = port.reevaluate(ir, bare)
        engine_answer = {"termination": "FEASIBLE", "solutions": honest["solutions"], "provenance": {"engine": "consumer-fixture"}}
        agreed = self.case(
            step, "reevaluate-agreement", REEVALUATE, {"ir": ir, "result": engine_answer},
            oracle=lambda: port.reevaluate(ir, engine_answer),
        )  # fmt: skip
        step.equal("reevaluate-agreement: the numbers the engine gave come back", engine_answer["solutions"], mapping(agreed.data).get("solutions"))
        lying = copy.deepcopy(engine_answer)
        solution = lying["solutions"][0]
        solution["features"] = {name: 0.0 for name in solution["features"]}
        solution["objectives"]["score"] = 0.0
        solution["objectives"]["penalty"] = 0.0
        for component in solution["objectives"]["components"]:
            component["value"] = 0.0
            component["loss"] = 0.0
        solution["penalties"] = [0.0 for _ in solution["penalties"]]
        lying["termination"] = "OPTIMAL"
        corrected = self.case(
            step, "reevaluate-discrepancy", REEVALUATE, {"ir": ir, "result": lying},
            oracle=lambda: port.reevaluate(ir, lying),
        )  # fmt: skip
        step.equal("reevaluate-discrepancy: termination is lowered", "UNKNOWN", mapping(corrected.data).get("termination"))

        self.case(
            step, "validate-result", VALIDATE_RESULT, {"result": engine_answer},
            oracle=lambda: port.validate_result(engine_answer),
        )  # fmt: skip
        self.case(
            step, "validate-result-invalid", VALIDATE_RESULT, {"result": [1, 2, 3]},
            oracle=lambda: port.validate_result([1, 2, 3]),
        )  # fmt: skip

        application = demo_documents()["application.json"]
        self.case(
            step, "engines-validate", ENGINE_VALIDATE, {"document": manifest},
            oracle=lambda: {"diagnostics": port.validate_engine(manifest)},
        )  # fmt: skip
        self.case(
            step, "resources-validate", RESOURCE_VALIDATE,
            {"document": application, "apiVersion": "qos-binding/v1", "kind": "Application", "mediaType": "application/json", "resource": "application.json"},
            oracle=lambda: {"diagnostics": port.validate_resource(application, "qos-binding/v1", "Application", "application/json", "application.json")},
        )  # fmt: skip
        xml = b'<?xml version="1.0"?><root xmlns="urn:probe"/>'
        root = self.case(step, "xml-root", XML_ROOT, {"contentBase64": b64(xml)}, oracle=lambda: port.xml_resource_root(xml))
        step.equal("xml-root: root element", {"namespace": "urn:probe", "localName": "root"}, root.data)

    # -- 3. hostile small inputs --------------------------------------------------

    def step_hostile_small(self, step: Step) -> None:
        good = demo_zip()
        dtd = b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "b">]><r>&a;</r>'
        laughs = (
            b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">'
            b'<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;">]><lolz>&lol3;</lolz>'
        )
        bad_token = "wrong-" + "0123456789abcdef" * 3
        invalid = [(422, "request_invalid")]
        # name, method, path, keyword arguments of Http.request, accepted (status, code) pairs
        cases: list[tuple[str, str, str, dict[str, Any], list[tuple[int, str]]]] = [
            ("invalid-json", "POST", VALIDATE_RESULT, {"body": b'{"result": '}, invalid),
            ("empty-body", "POST", VALIDATE_RESULT, {"body": b""}, invalid),
            ("nan", "POST", VALIDATE_RESULT, {"body": b'{"result": NaN}'}, invalid),
            ("infinity", "POST", VALIDATE_RESULT, {"body": b'{"result": [Infinity]}'}, invalid),
            ("unknown-member", "POST", VALIDATE_RESULT, {"body": b'{"result": 1, "extra": 1}'}, invalid),
            ("deep-nesting", "POST", VALIDATE_RESULT, {"body": b'{"result":' + b"[" * 20000 + b"]" * 20000 + b"}"}, [(400, "http_error"), (422, "request_invalid")]),
            ("invalid-utf8", "POST", VALIDATE_RESULT, {"body": b'{"result":"\xff\xfe"}'}, [(400, "http_error"), (422, "request_invalid")]),
            ("zip-truncated", "POST", COMPILE, {"body": dumps({"package": b64(good[: len(good) // 2])})}, [(422, "package_error")]),
            ("zip-garbage", "POST", VALIDATE, {"body": dumps({"package": b64(b"PK\x03\x04" + bytes(range(256)) * 4)})}, [(422, "package_error")]),
            ("xml-dtd", "POST", XML_ROOT, {"body": dumps({"contentBase64": b64(dtd)})}, [(422, "package_error")]),
            ("xml-entity-expansion", "POST", XML_ROOT, {"body": dumps({"contentBase64": b64(laughs)})}, [(422, "package_error")]),
            ("xml-malformed", "POST", XML_ROOT, {"body": dumps({"contentBase64": b64(b"<a><b></a>")})}, [(422, "package_error")]),
            ("base64-invalid-xml", "POST", XML_ROOT, {"body": dumps({"contentBase64": "!!not base64!!"})}, invalid),
            ("base64-invalid-package", "POST", COMPILE, {"body": dumps({"package": "###", "registeredResources": []})}, invalid),
            ("unsupported-media-type", "POST", COMPILE, {"body": b"x", "content_type": "text/plain"}, [(415, "unsupported_media_type")]),
            ("multipart-without-boundary", "POST", COMPILE, {"body": b"x", "content_type": "multipart/form-data"}, invalid),
            ("no-token", "GET", CAPABILITIES, {"auth": False}, [(401, "unauthorized")]),
            ("no-token-with-body", "POST", COMPILE, {"auth": False, "body": dumps({"package": b64(good)})}, [(401, "unauthorized")]),
            ("wrong-token", "GET", CAPABILITIES, {"token": bad_token}, [(401, "unauthorized")]),
            ("unknown-route", "GET", f"{API}/nope", {}, [(404, "not_found")]),
            ("unknown-route-no-token", "GET", f"{API}/nope", {"auth": False}, [(401, "unauthorized")]),
            ("wrong-method", "DELETE", CAPABILITIES, {}, [(405, "method_not_allowed")]),
            ("unknown-schema", "GET", f"{API}/schemas/Nope", {}, [(404, "schema_not_found")]),
        ]
        observed: dict[str, str] = {}
        for name, method, path, kwargs, accepted in cases:
            reply = self.http.request(method, path, **kwargs)
            observed[name] = reply.label()
            step.check(
                f"{name}: status and code",
                (reply.status, reply.code) in accepted,
                " or ".join(f"{status} {code}" for status, code in accepted),
                reply.label(),
            )
            problem = mapping(reply.data)
            step.check(
                f"{name}: application/problem+json without traceback",
                reply.is_problem
                and problem.get("status") == reply.status
                and problem.get("type") == PROBLEM_PREFIX + reply.code
                and "Traceback" not in reply.body.decode("utf-8", "replace"),
                PROBLEM_TYPE,
                reply.headers.get("content-type", "") or "(none)",
            )
            if reply.status == 401:
                step.check(f"{name}: WWW-Authenticate", reply.headers.get("www-authenticate", "").startswith("Bearer"), "Bearer ...", reply.headers.get("www-authenticate", ""))
            if reply.status == 405:
                step.check(f"{name}: Allow", bool(reply.headers.get("allow")), "a list of methods", reply.headers.get("allow", ""))
        step.details["observed"] = observed
        public = [self.http.request("GET", path, auth=False) for path in ("/healthz", "/readyz")]
        step.equal("/healthz and /readyz need no token", [200, 200], [reply.status for reply in public])
        self.health(step.check, "after the hostile inputs")

    # -- 4. large bodies --------------------------------------------------------------

    def limits(self) -> tuple[int, int, int, int]:
        """``(body, slots, budget, pending)`` as published (else as expected)."""
        published = self.published

        def number(key: str, fallback: int) -> int:
            value = published.get(key)
            return value if isinstance(value, int) and not isinstance(value, bool) else fallback

        return (
            number("maxBodyBytes", self.expected.max_body_bytes),
            number("maxConcurrentOperations", self.expected.concurrency),
            number("memoryBudgetBytes", self.expected.memory_budget_bytes),
            number("maxPendingBodyBytes", self.expected.pending_body_bytes),
        )

    def ensure_published(self) -> None:
        if not self.published:
            reply = self.http.request("GET", CAPABILITIES)
            self.published = dict(mapping(mapping(mapping(reply.data).get("limits")).get("service")))

    def step_large_bodies(self, step: Step) -> None:
        self.ensure_published()
        body_max, _, budget, pending = self.limits()
        step.details["limits"] = {"maxBodyBytes": body_max, "memoryBudgetBytes": budget, "maxPendingBodyBytes": pending}

        for label, length in (("one byte over the limit", body_max + 1), ("1 GiB", 1024 * MIB)):
            reply = self.http.request("POST", VALIDATE_RESULT, declared_length=length, timeout=20)
            step.check(
                f"Content-Length {label}: 413 payload_too_large before any byte is sent",
                (reply.status, reply.code) == (413, "payload_too_large") and reply.is_problem,
                "413 payload_too_large",
                reply.label(),
            )
            step.check(f"Content-Length {label}: answered promptly with the connection closed", reply.seconds < 5 and reply.headers.get("connection", "").lower() == "close", "< 5 s, Connection: close", f"{reply.seconds:.2f} s, Connection: {reply.headers.get('connection', '')}")

        crossing = self.http.request("POST", VALIDATE_RESULT, body=json_chunks(body_max + 3 * 16384, close=False), chunked=True, timeout=30)
        step.check("chunked body that crosses the limit: 413 payload_too_large", (crossing.status, crossing.code) == (413, "payload_too_large"), "413 payload_too_large", crossing.label())
        under = self.http.request("POST", VALIDATE_RESULT, body=json_chunks(min(body_max, 64 * 1024), close=True), chunked=True, timeout=30)
        step.check("chunked body under the limit is served", under.status == 200, 200, under.label())

        if self.config.at_limit:
            exact = padded_result_body(body_max)
            at_limit = self.post(VALIDATE_RESULT, exact, timeout=60)
            admissible = budget == 0 or budget >= BODY_MEMORY_FACTOR * body_max
            step.check(
                "a body of exactly the advertised limit is served",
                at_limit.status == 200 if admissible else at_limit.status in {200, 413},
                200,
                at_limit.label(),
            )
            step.details["atLimit"] = {"bytes": len(exact), "status": at_limit.status, "ms": round(at_limit.seconds * 1000, 1)}

        self.pending_bodies(step, body_max, pending)
        self.health(step.check, "after the large bodies")

    def pending_bodies(self, step: Step, body_max: int, pending: int) -> None:
        """Bodies in flight above ``maxPendingBodyBytes``: the declared length of one more is refused with 429."""
        if pending <= 0:
            step.details["pending"] = "maxPendingBodyBytes is 0 (off): not applicable"
            return
        size = min(body_max, pending // 2)
        if size < 64:
            step.details["pending"] = f"maxPendingBodyBytes {pending} is too small to hold bodies open here"
            return
        holders = max(1, pending // size)
        if holders > 16:
            step.details["pending"] = f"{holders} bodies fit the limit: too many to hold open here"
            return
        data = padded_result_body(size)
        release = threading.Event()
        reached = [threading.Event() for _ in range(holders)]
        pool = ThreadPoolExecutor(max_workers=holders)
        try:
            futures = [
                pool.submit(self.http.slow_upload, VALIDATE_RESULT, data, first=size // 2, reached=reached[index], release=release, wait=30)
                for index in range(holders)
            ]
            for event in reached:
                event.wait(15)
            time.sleep(0.5)  # the service has registered the declared bytes of each holder
            refused = self.http.request("POST", VALIDATE_RESULT, declared_length=size, timeout=20)
            step.check(
                f"{holders} bodies of {size} bytes in flight: one more is refused 429 pending_body_bytes with Retry-After",
                (refused.status, refused.code) == (429, "pending_body_bytes") and (refused.retry_after or 0) >= 1,
                "429 pending_body_bytes, Retry-After >= 1",
                f"{refused.label()}, Retry-After {refused.headers.get('retry-after')}",
            )
            release.set()
            finished = [future.result(timeout=60) for future in futures]
        finally:
            release.set()
            pool.shutdown(wait=True)
        allowed = {(200, ""), (429, "memory_budget"), (503, "service_busy")}
        step.check(
            "the bodies in flight finish with 200, or a refusal for load with Retry-After",
            all((r.status, "" if r.status == 200 else r.code) in allowed and (r.status == 200 or (r.retry_after or 0) >= 1) for r in finished),
            "200 | 429 memory_budget | 503 service_busy",
            [r.label() for r in finished],
        )
        again = self.post(VALIDATE_RESULT, data, timeout=60)
        step.check("the bytes in flight were given back: the same body alone is served", again.status == 200, 200, again.label())
        step.details["pending"] = {"holders": holders, "bytesEach": size, "finished": [r.label() for r in finished]}

    # -- costly valid operations (saturation, health under load, timeout) -------------

    def body_cap(self) -> int:
        body_max = self.limits()[0]
        return int(body_max * self.config.body_fraction)

    def neighborhood_ceiling(self) -> float:
        value = self.published.get("neighborhoodMaxSeconds")
        return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 10.0

    def calibrate(self, *, seconds: float, target: float, stop_on_timeout: bool) -> CostlyPlan:
        """Grow the synthetic IR until one ``/neighborhood`` request alone lasts about ``target`` seconds.

        With ``stop_on_timeout`` the search ends at the first 503 ``operation_timeout`` (the request over the budget
        that the timeout step needs). Without it a request that times out is an overshoot: the best one below is kept.
        """
        cap = self.body_cap()
        tasks = max(1, self.config.start_tasks)
        history: list[dict[str, Any]] = []
        best: CostlyPlan | None = None
        capped = False
        per_task = 0.0
        for _ in range(MAX_RUNGS):
            if per_task and tasks * per_task > cap:  # known size per task: do not compile what cannot be sent
                tasks = max(1, int(cap / per_task * 0.98))
                capped = True
                if best is not None and tasks <= best.tasks:
                    break
            body = costly_body(tasks, seconds)
            per_task = len(body) / tasks
            if len(body) > cap:
                history.append({"tasks": tasks, "bodyBytes": len(body), "skipped": f"over the cost-body-fraction cap of {cap} bytes"})
                if tasks == 1:
                    break
                tasks = max(1, min(tasks - 1, int(cap / per_task * 0.98)))
                capped = True
                continue
            reply = self.post(NEIGHBORHOOD, body, timeout=self.config.request_timeout)
            history.append({"tasks": tasks, "bodyBytes": len(body), "status": reply.status, "code": reply.code, "seconds": round(reply.seconds, 3)})
            if reply.status == 503 and reply.code == "operation_timeout":
                plan = CostlyPlan(tasks, body, reply.seconds, 503, "operation_timeout", True, history)
                if stop_on_timeout:
                    return plan
                tasks = max(1, int(tasks * 0.7))
                if best is not None and tasks <= best.tasks:
                    break
                continue
            if reply.status != 200:
                note = f"the service answered {reply.label()} to a request of {len(body)} bytes ({tasks} tasks)"
                if best is not None:
                    best.note = note
                    best.history = history
                    return best
                return CostlyPlan(tasks, body, reply.seconds, reply.status, reply.code, False, history, note)
            best = CostlyPlan(tasks, body, reply.seconds, 200, "", reply.seconds >= target, history)
            if best.reached_target and not stop_on_timeout:
                return best
            if capped:
                break
            factor = min(6.0, max(1.4, target * 1.15 / max(reply.seconds, 0.02)))
            tasks = int(tasks * factor) + 1
        if best is None:
            return CostlyPlan(tasks, b"", 0.0, 0, "", False, history, "no request could be sent within the body cap")
        best.history = history
        best.note = best.note or "the body cap was reached before the request lasted long enough"
        return best

    def load_plan(self) -> CostlyPlan:
        if "load" not in self._plans:
            self.ensure_published()
            seconds = min(self.config.cost_seconds, self.neighborhood_ceiling())
            plan = self.calibrate(seconds=seconds, target=self.config.cost_seconds, stop_on_timeout=False)
            self._plans["load"] = plan
            self.observations["calibration"] = {
                "targetSeconds": self.config.cost_seconds,
                "tasks": plan.tasks,
                "bodyBytes": len(plan.body),
                "soloSeconds": round(plan.solo_seconds, 3),
                "reachedTarget": plan.reached_target,
                "note": plan.note,
                "rungs": plan.history,
            }
        return self._plans["load"]

    def outcome(self, reply: Reply) -> str:
        return "200" if reply.status == 200 else f"{reply.status}:{reply.code}" if reply.status else "no-answer"

    # -- 5. saturation ------------------------------------------------------------------

    def step_saturation(self, step: Step) -> None:
        plan = self.load_plan()
        if not step.check("a costly valid request could be built", plan.status == 200 and bool(plan.body), "200 from a calibration request", plan.note or f"{plan.status} {plan.code}"):
            return
        _, slots, _, _ = self.limits()
        clients = max(4, slots * 8)
        step.details["costly"] = {"tasks": plan.tasks, "bodyBytes": len(plan.body), "soloSeconds": round(plan.solo_seconds, 3), "clients": clients}
        replies = self.run_concurrent(clients, lambda _index: self.post(NEIGHBORHOOD, plan.body, timeout=self.config.request_timeout))
        counts: dict[str, int] = {}
        for reply in replies:
            counts[self.outcome(reply)] = counts.get(self.outcome(reply), 0) + 1
        step.details["outcomes"] = counts
        refused = [reply for reply in replies if (reply.status, reply.code) in REFUSALS]
        unexpected = [reply for reply in replies if reply.status != 200 and (reply.status, reply.code) not in REFUSALS]
        step.check("no unexpected answer (5xx other than service_busy, timeouts, connection errors)", not unexpected, "none", sorted({reply.label() for reply in unexpected}))
        step.check(f"{clients} concurrent costly requests on {slots} slots: some are refused (503 service_busy / 429)", bool(refused), ">= 1 refusal", counts)
        step.check("some requests are served", counts.get("200", 0) >= 1, ">= 1 x 200", counts.get("200", 0))
        step.check("every refusal carries Retry-After", all((reply.retry_after or 0) >= 1 for reply in refused), "Retry-After >= 1", [reply.headers.get("retry-after") for reply in refused][:5])
        deadline = time.monotonic() + 30
        recovered = self.normal_request()
        while recovered.status != 200 and time.monotonic() < deadline:
            time.sleep(0.5)
            recovered = self.normal_request()
        step.check("the service serves a normal request after the burst", recovered.status == 200, 200, recovered.label())
        self.health(step.check, "after the burst")

    # -- 6. /healthz while every slot computes ---------------------------------------------

    def step_healthz_under_load(self, step: Step) -> None:
        plan = self.load_plan()
        if not step.check("a costly valid request could be built", plan.status == 200 and bool(plan.body), "200 from a calibration request", plan.note or f"{plan.status} {plan.code}"):
            return
        _, slots, _, _ = self.limits()
        stop = threading.Event()
        load: list[Reply] = []
        lock = threading.Lock()

        def hammer() -> None:
            while not stop.is_set():
                reply = self.post(NEIGHBORHOOD, plan.body, timeout=self.config.request_timeout)
                with lock:
                    load.append(reply)
                if reply.status != 200:
                    stop.wait(0.05)

        samples: list[tuple[float, int]] = []
        ready: list[int] = []
        workers = max(slots + 1, slots * 2)
        pool = ThreadPoolExecutor(max_workers=workers)
        futures = [pool.submit(hammer) for _ in range(workers)]
        try:
            time.sleep(min(0.5, self.config.load_seconds))
            deadline = time.monotonic() + self.config.load_seconds
            tick = 0
            while time.monotonic() < deadline:
                reply = self.http.request("GET", "/healthz", auth=False, timeout=10)
                samples.append((reply.seconds * 1000, reply.status))
                if tick % 10 == 0:
                    ready.append(self.http.request("GET", "/readyz", auth=False, timeout=10).status)
                tick += 1
                time.sleep(0.05)
        finally:
            stop.set()
            for future in futures:
                future.result(timeout=self.config.request_timeout + 30)
            pool.shutdown(wait=True)
        latencies = [value for value, _ in samples]
        stats = {
            "samples": len(samples),
            "ok200": sum(1 for _, status in samples if status == 200),
            "p50Ms": round(percentile(latencies, 0.50), 1),
            "p95Ms": round(percentile(latencies, 0.95), 1),
            "maxMs": round(max(latencies, default=0.0), 1),
        }
        counts: dict[str, int] = {}
        for reply in load:
            counts[self.outcome(reply)] = counts.get(self.outcome(reply), 0) + 1
        step.details["healthz"] = stats
        step.details["load"] = {"clients": workers, "tasks": plan.tasks, "soloSeconds": round(plan.solo_seconds, 3), "outcomes": counts}
        self.observations["healthzUnderLoad"] = stats
        step.check("enough /healthz samples were taken", stats["samples"] >= 10, ">= 10", stats["samples"])
        step.check("every /healthz answer is 200", stats["ok200"] == stats["samples"], stats["samples"], stats["ok200"])
        step.check(f"/healthz p95 <= {self.config.healthz_p95_ms:g} ms", stats["p95Ms"] <= self.config.healthz_p95_ms, f"<= {self.config.healthz_p95_ms:g} ms", f"{stats['p95Ms']} ms")
        step.check(f"/healthz max <= {self.config.healthz_max_ms:g} ms", stats["maxMs"] <= self.config.healthz_max_ms, f"<= {self.config.healthz_max_ms:g} ms", f"{stats['maxMs']} ms")
        step.check("/readyz stayed 200", all(status == 200 for status in ready), "all 200", ready)
        step.check("the load really ran: costly requests were served", counts.get("200", 0) >= 1, ">= 1 x 200", counts)
        bad = [reply for reply in load if reply.status != 200 and (reply.status, reply.code) not in REFUSALS]
        step.check("no unexpected answer to the load", not bad, "none", sorted({reply.label() for reply in bad}))
        self.health(step.check, "after the load")

    # -- 7. timeout and replacement ----------------------------------------------------------

    def step_timeout_replacement(self, step: Step) -> None:
        self.ensure_published()
        timeout = self.expected.operation_timeout_seconds
        _, slots, _, _ = self.limits()
        step.equal("the service publishes the time budget of the probe manifest", timeout, self.published.get("operationTimeoutSeconds"))
        self.mark("timeout:baseline")
        baseline = self.normal_request()
        step.check("before: a normal request is served", baseline.status == 200, 200, baseline.label())

        self.mark("timeout:calibrate:start")
        ceiling = self.neighborhood_ceiling()
        plan = self.calibrate(seconds=ceiling, target=timeout * 1.3, stop_on_timeout=True)
        self.mark("timeout:calibrate:end")
        self.observations["timeoutCalibration"] = {
            "operation": f"POST {NEIGHBORHOOD} with limit {NEIGHBORHOOD_LIMIT} and seconds {ceiling:g} on a synthetic IR",
            "tasks": plan.tasks,
            "bodyBytes": len(plan.body),
            "rungs": plan.history,
            "note": plan.note,
        }
        if not step.check(
            "a valid request that lasts longer than the time budget could be built within the body cap",
            plan.status == 503 and plan.code == "operation_timeout",
            "503 operation_timeout from a valid request",
            plan.note or f"{plan.status} {plan.code}, longest {plan.solo_seconds:.2f} s",
        ):
            return
        self.hold("timeout:before-request")

        stop = threading.Event()
        samples: list[tuple[float, int]] = []
        parallel: list[Reply] = []

        def sample() -> None:
            while not stop.is_set():
                reply = self.http.request("GET", "/healthz", auth=False, timeout=10)
                samples.append((reply.seconds * 1000, reply.status))
                stop.wait(0.1)

        def serve_meanwhile() -> None:
            stop.wait(min(1.0, timeout / 3))
            while not stop.is_set():
                parallel.append(self.normal_request(timeout=30))
                stop.wait(0.5)

        threads = [threading.Thread(target=sample, daemon=True), threading.Thread(target=serve_meanwhile, daemon=True)]
        self.mark("timeout:request:start")
        for thread in threads:
            thread.start()
        over = self.post(NEIGHBORHOOD, plan.body, timeout=timeout + 60)
        self.mark("timeout:request:end")
        stop.set()
        for thread in threads:
            thread.join(30)
        step.check("the request over the budget: 503 operation_timeout", (over.status, over.code) == (503, "operation_timeout") and over.is_problem, "503 operation_timeout", over.label())
        step.check(
            f"it ends in about the time budget ({timeout:g} s)",
            timeout * 0.9 <= over.seconds <= timeout + 3,
            f"{timeout * 0.9:.1f}-{timeout + 3:g} s",
            f"{over.seconds:.2f} s",
        )
        latencies = [value for value, _ in samples]
        step.check("/healthz stayed 200 during the request", bool(samples) and all(status == 200 for _, status in samples), f"all 200 ({len(samples)} samples)", {"samples": len(samples), "non200": sum(1 for _, status in samples if status != 200), "maxMs": round(max(latencies, default=0.0), 1)})
        if slots >= 2:
            step.check(
                "another slot kept serving normal requests during the request",
                bool(parallel) and all(reply.status == 200 for reply in parallel),
                "all 200",
                [reply.label() for reply in parallel],
            )
        self.hold("timeout:after-request")

        self.mark("timeout:replacement:start")
        first = self.normal_request()
        step.check("the next normal request succeeds (the replacement worker serves it)", first.status == 200, 200, f"{first.label()} in {first.seconds * 1000:.0f} ms")
        later = [self.normal_request() for _ in range(10)]
        step.check("ten more normal requests succeed", all(reply.status == 200 for reply in later), "10 x 200", [reply.label() for reply in later if reply.status != 200] or "10 x 200")
        compiled = self.post(VALIDATE, {"package": b64(demo_zip()), "registeredResources": []})
        step.check("a real operation (validate of the demo package) succeeds", compiled.status == 200 and mapping(compiled.data).get("valid") is True, "200 valid", compiled.label())
        self.mark("timeout:replacement:end")
        self.hold("timeout:after-replacement")
        self.health(step.check, "after the replacement")
        step.details["timeout"] = {
            "budgetSeconds": timeout,
            "requestSeconds": round(over.seconds, 3),
            "requestMonotonic": round(over.started, 3),
            "requestEpoch": round(over.epoch, 3),
            "healthzSamples": len(samples),
            "healthzMaxMs": round(max(latencies, default=0.0), 1),
            "firstAfterMs": round(first.seconds * 1000, 1),
            "parallelNormalRequests": len(parallel),
        }


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------


def build_parser(environ: Mapping[str, str]) -> argparse.ArgumentParser:
    def number(name: str, default: Any, kind: type = int) -> Any:
        raw = environ.get(name)
        if raw in (None, ""):
            return default
        try:
            return kind(raw)
        except ValueError as exc:
            raise ConfigError(f"{name} must be a {kind.__name__}, not {raw!r}") from exc

    parser = argparse.ArgumentParser(description="Acceptance probe of bim-service in process mode (profile N2 by default).")
    parser.add_argument("--url", default=environ.get("BIM_SERVICE_URL") or DEFAULT_URL, help=f"service origin (default $BIM_SERVICE_URL or {DEFAULT_URL})")
    parser.add_argument("--token-file", default=environ.get("BIM_SERVICE_TOKEN_FILE") or DEFAULT_TOKEN_FILE, help="file with the bearer token (default $BIM_SERVICE_TOKEN_FILE or /run/bim/token)")
    parser.add_argument("--steps", default="all", help=f"comma list of {', '.join(STEP_NAMES)}; 'all' (default) or 'none'")
    parser.add_argument("--timeout-probe", action="store_true", help=f"also run {TIMEOUT_STEP} (the service must run with BIM_SERVICE_OPERATION_TIMEOUT_SECONDS=3)")
    parser.add_argument("--hold", type=float, default=0.0, help="seconds to pause between steps and between the phases of the timeout step, so metrics can be sampled")
    parser.add_argument("--repeat", type=int, default=2, help="times each valid operation is repeated (identical answers required)")
    parser.add_argument("--request-timeout", type=float, default=60.0, help="HTTP timeout of one request, seconds")
    parser.add_argument("--cost-seconds", type=float, default=1.0, help="solo duration aimed at for the costly request of the saturation and healthz steps")
    parser.add_argument("--load-seconds", type=float, default=6.0, help="how long /healthz is sampled under load")
    parser.add_argument("--cost-body-fraction", type=float, default=0.7, help="the costly request may use this fraction of the body limit")
    parser.add_argument("--cost-tasks-start", type=int, default=60, help="tasks of the synthetic IR of the first calibration request")
    parser.add_argument("--healthz-p95-ms", type=float, default=500.0)
    parser.add_argument("--healthz-max-ms", type=float, default=2500.0)
    parser.add_argument("--no-at-limit", action="store_true", help="do not send a body of exactly the advertised limit")
    parser.add_argument("--summary", action="store_true", help="stdout: one compact JSON line (failed checks, key figures, timeline); the full report goes to stderr")
    parser.add_argument("--expect-executor", default=environ.get("PROBE_EXPECT_EXECUTOR") or N2_DEFAULTS["executor"])
    parser.add_argument("--expect-max-body-bytes", type=int, default=number("PROBE_EXPECT_MAX_BODY_BYTES", N2_DEFAULTS["max_body_bytes"]))
    parser.add_argument("--expect-concurrency", type=int, default=number("PROBE_EXPECT_CONCURRENCY", N2_DEFAULTS["concurrency"]))
    parser.add_argument("--expect-tenant-limit", type=int, default=number("PROBE_EXPECT_TENANT_LIMIT", N2_DEFAULTS["tenant_limit"]))
    parser.add_argument("--expect-acquire-timeout-ms", type=int, default=number("PROBE_EXPECT_ACQUIRE_TIMEOUT_MS", N2_DEFAULTS["acquire_timeout_ms"]))
    parser.add_argument("--expect-memory-budget-bytes", type=int, default=number("PROBE_EXPECT_MEMORY_BUDGET_BYTES", N2_DEFAULTS["memory_budget_bytes"]))
    parser.add_argument("--expect-pending-body-bytes", type=int, default=number("PROBE_EXPECT_PENDING_BODY_BYTES", N2_DEFAULTS["pending_body_bytes"]))
    parser.add_argument("--expect-operation-timeout", type=float, default=number("PROBE_EXPECT_OPERATION_TIMEOUT", None, float), help="default 60, or 3 with --timeout-probe")
    parser.add_argument("--container-memory-bytes", type=int, default=number("PROBE_CONTAINER_MEMORY_BYTES", N2_DEFAULTS["container_memory_bytes"]), help="memory.max of the bim-service container, for the fit rule")
    return parser


def read_token(path: str) -> str:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"cannot read the token file {path!r}: {type(exc).__name__}") from exc
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    raise ConfigError(f"the token file {path!r} is empty")


def parse_steps(value: str) -> tuple[str, ...]:
    if value == "all":
        return STEP_NAMES
    if value == "none":
        return ()
    names = tuple(part.strip() for part in value.split(",") if part.strip())
    unknown = [name for name in names if name not in STEP_NAMES]
    if unknown:
        raise ConfigError(f"unknown step(s) {unknown}; the steps are {list(STEP_NAMES)} (the timeout step needs --timeout-probe)")
    return names


def make_config(argv: Sequence[str] | None, environ: Mapping[str, str]) -> tuple[ProbeConfig, bool]:
    """``(configuration, whether --summary was given)``."""
    args = build_parser(environ).parse_args(argv)
    timeout = args.expect_operation_timeout
    if timeout is None:
        timeout = PROBE_OPERATION_TIMEOUT if args.timeout_probe else DEFAULT_OPERATION_TIMEOUT
    expected = Expected(
        executor=args.expect_executor,
        max_body_bytes=args.expect_max_body_bytes,
        concurrency=args.expect_concurrency,
        tenant_limit=args.expect_tenant_limit,
        acquire_timeout_ms=args.expect_acquire_timeout_ms,
        memory_budget_bytes=args.expect_memory_budget_bytes,
        pending_body_bytes=args.expect_pending_body_bytes,
        container_memory_bytes=args.container_memory_bytes,
        operation_timeout_seconds=timeout,
    )
    steps = parse_steps(args.steps)
    if not steps and not args.timeout_probe:
        raise ConfigError("nothing to run: --steps none needs --timeout-probe")
    if args.repeat < 1 or args.hold < 0 or not 0 < args.cost_body_fraction <= 0.95:
        raise ConfigError("--repeat must be >= 1, --hold >= 0 and --cost-body-fraction in (0, 0.95]")
    config = ProbeConfig(
        url=args.url.rstrip("/"),
        token=read_token(args.token_file),
        expected=expected,
        steps=steps,
        timeout_probe=args.timeout_probe,
        hold=args.hold,
        repeat=args.repeat,
        request_timeout=args.request_timeout,
        cost_seconds=args.cost_seconds,
        load_seconds=args.load_seconds,
        body_fraction=args.cost_body_fraction,
        start_tasks=args.cost_tasks_start,
        healthz_p95_ms=args.healthz_p95_ms,
        healthz_max_ms=args.healthz_max_ms,
        at_limit=not args.no_at_limit,
    )
    return config, args.summary


def redact(text: str, token: str) -> str:
    return text.replace(token, "***") if len(token) >= 4 else text


#: The members of a step's ``details`` that the compact report keeps.
COMPACT_DETAILS = ("outcomes", "healthz", "load", "costly", "timeout", "fit", "atLimit", "pending")


def short(value: Any, limit: int = 120) -> Any:
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    return clip(text, limit)


def compact(report: Mapping[str, Any]) -> dict[str, Any]:
    """The report for runners that keep only the tail of the output: failed checks, key figures and the timeline."""
    steps = []
    for step in report["steps"]:
        failed = [
            {"check": check["name"], "expected": short(check["expected"]), "observed": short(check["observed"])}
            for check in step["checks"]
            if not check["ok"]
        ]
        steps.append(
            {
                "name": step["name"],
                "ok": step["ok"],
                "checks": len(step["checks"]),
                "failed": failed[:8],
                "elapsedMs": step["elapsedMs"],
                "details": {key: step["details"][key] for key in COMPACT_DETAILS if key in step["details"]},
            }
        )
    observations = mapping(report.get("observations"))
    calibration = mapping(observations.get("calibration"))
    timeout = mapping(observations.get("timeoutCalibration"))
    timeline = list(observations.get("timeline", []))
    # ``hold:before:<step>:*`` is the end of the previous step and the start of <step>: derivable, so left out here.
    marks = [entry for entry in timeline if not entry["phase"].startswith("hold:before:")]
    offset = round(timeline[0]["epoch"] - timeline[0]["monotonic"], 3) if timeline else None
    return {
        "tool": report["tool"],
        "ok": report["ok"],
        "steps": steps,
        "observations": {
            "skipped": observations.get("skipped"),
            "elapsedSeconds": observations.get("elapsedSeconds"),
            "toolchainMatchesProbe": observations.get("toolchainMatchesProbe"),
            "calibration": {key: calibration.get(key) for key in ("tasks", "bodyBytes", "soloSeconds", "reachedTarget")},
            "timeoutCalibration": {key: timeout.get(key) for key in ("operation", "tasks", "bodyBytes")},
            "timelineEpochMinusMonotonic": offset,
            "timeline": [[entry["phase"], entry["epoch"]] for entry in marks],
        },
    }


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    source = os.environ if environ is None else environ
    try:
        config, summary = make_config(argv, source)
    except ConfigError as exc:
        print(json.dumps({"tool": TOOL, "ok": False, "error": str(exc), "steps": []}))
        return EXIT_CONFIG
    report = Probe(config).run()
    if summary:
        print(redact(json.dumps(report, indent=2), config.token), file=sys.stderr)
        print(redact(json.dumps(compact(report), separators=(",", ":")), config.token))
    else:
        print(redact(json.dumps(report, indent=2), config.token))
    return EXIT_OK if report["ok"] else EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
