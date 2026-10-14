#!/usr/bin/env python3
"""End-to-end harness for an asynchronous ``bim-engine/v1`` engine (``engines/minizinc-csp``).

It does what the gateway does, minus the gateway: compile a BIM package with ``bim_core`` (the normalized IR),
send the job to the engine, wait for it, **re-evaluate the answer with ``bim_core.reevaluate``** and report the
outcome honestly as ``optimal`` / ``feasible`` / ``infeasible`` / ``unknown``, and exercise remote cancellation
(job -> ``DELETE`` -> the solver really dies -> final state -> the CPU is free).

Honesty rules of the classification:

* the number the engine reports is never used: the decision is re-evaluated by ``bim_core``;
* ``optimal`` needs the re-evaluated termination to stay ``OPTIMAL`` (the mode guarantees it) **and** a proof that
  does not come from the engine alone: an exhaustive enumeration of the binding space (when it is small) or, when
  it is not small, a real solver whose claim the mode allows. A result the harness cannot demonstrate optimal is
  ``feasible`` (the fake MiniZinc mode never earns more than the enumeration proves);
* an engine that claims ``OPTIMAL`` while a better binding exists is ``inconsistent`` and the run fails.

Modes (the engine under test):

``--fake-minizinc``    starts ``engines/minizinc-csp`` locally (node) with ``tests/fake_minizinc.mjs`` as the
                       solver: real processes, a canned incumbent for ``solve`` and a CPU-burning one with a
                       grandchild for ``cancel``. Proves the engine's plumbing, NOT the MiniZinc model.
``--local-minizinc``   the same engine with the real ``minizinc`` of this machine.
``--url URL``          an engine that is already running (the laboratory). The solver is not on this host, so
                       the process checks (group dead, CPU free, no zombie) are listed as ``not-executed``.

Exit status: 0 when no step failed or was inconclusive; steps that cannot run in the chosen mode are reported as
``not-executed`` (never as passed).
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import itertools
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path
from typing import Any

import httpx
from bim_client import InProcessBim
from bim_core import InstancePackage, ProtocolError
from bim_core.conformance import openapi_diagnostics
from bim_core.protocol import validate_job

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = Path(os.environ.get("OPENBINDING_REPO_ROOT", TOOLS_DIR.parents[1]))
ENGINE_DIR = REPO_ROOT / "engines" / "minizinc-csp"

PASSED, FAILED, INCONCLUSIVE, NOT_EXECUTED = "passed", "failed", "inconclusive", "not-executed"
CLASSIFICATIONS = ("optimal", "feasible", "infeasible", "unknown", "inconsistent")
#: What a mode that declares nothing is trusted with (``bim_core.reevaluate.DEFAULT_TERMINATIONS``).
CONSERVATIVE_TERMINATIONS = ("FEASIBLE", "UNKNOWN")
EXHAUSTIVE_LIMIT = 5000
JOB_PATH = "/internal/v1/jobs/{id}"


class HarnessUnavailable(Exception):
    """The harness cannot run the requested mode here (no node, engine not built, ...)."""


# --------------------------------------------------------------------------
# The BIM packages
# --------------------------------------------------------------------------


def _envelope(kind: str, name: str, spec: dict[str, Any]) -> dict[str, Any]:
    return {"apiVersion": "qos-binding/v1", "kind": kind, "metadata": {"name": name}, "spec": spec}


def _dump(document: dict[str, Any]) -> bytes:
    return json.dumps(document, indent=2).encode()


def minimal_files() -> dict[str, bytes]:
    """Three service tasks in sequence, one feature, four candidates: ``engines/minizinc-csp/tests/fixtures/simple-sequence``.

    Two bindings exist (t1 has two candidates), so the optimum can be proven by enumeration.
    """
    features = {
        "latency": {
            "unit": "ms",
            "direction": "minimize",
            "scope": "invocation",
            "aggregation": {
                "sequence": "sum", "parallel": "max", "exclusive": "weightedSum", "repeat": "scale", "selection": "sum"
            },
            "domain": {"kind": "real", "minimum": 0, "maximum": 1000},
        }
    }
    flow = [{"task": {"resource": "application", "id": task}} for task in ("t1", "t2", "t3")]
    candidates = {
        "c1a": ("service/t1", 10), "c1b": ("service/t1", 20), "c2a": ("service/t2", 15), "c3a": ("service/t3", 5),
    }
    documents = {
        "application.json": _envelope(
            "Application",
            "demo_01_simple_seq_application",
            {
                "tasks": {"t1": "service/t1", "t2": "service/t2", "t3": "service/t3"},
                "features": features,
                "workflow": {"sequence": flow},
            },
        ),
        "candidates.json": _envelope(
            "CandidateCatalog",
            "demo_01_simple_seq_catalog",
            {
                "candidates": {
                    name: {
                        "provides": provides,
                        "features": {"latency": latency},
                        "provider": {"resource": "catalog", "id": "p1"},
                    }
                    for name, (provides, latency) in candidates.items()
                },
                "providers": {"p1": {}},
                "featureBindings": {"latency": {"resource": "application", "id": "latency"}},
            },
        ),
        "optimization.json": _envelope(
            "Optimization",
            "demo_01_simple_seq_optimization",
            {
                "criteria": [
                    {
                        "id": "latency",
                        "feature": {"resource": "application", "id": "latency"},
                        "normalize": {"min": 0, "max": 1000, "clamp": True},
                    }
                ]
            },
        ),
    }
    instance = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": "demo_01_simple_seq", "version": "1.0.0"},
        "spec": {
            "profile": "qos-binding/v1",
            "resources": {
                "application": {"application": "application.json"},
                "candidateCatalog": {"catalog": "candidates.json"},
                "optimization": {"optimization": "optimization.json"},
            },
        },
    }
    files = {"instance.json": _dump(instance)}
    files.update({name: _dump(document) for name, document in documents.items()})
    return files


def _pseudo_random(seed: int) -> Iterator[int]:
    state = seed
    while True:
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        yield state >> 8


def hard_files(tasks: int = 150, per_task: int = 30, seed: int = 7) -> dict[str, bytes]:
    """A multiple-choice knapsack (strongly correlated cost and latency under a tight cost limit).

    Proving its optimum takes MiniZinc far longer than a cancellation test waits, which is what a ``cancel``
    against a real solver needs. It is a heuristic for "long job", not a guarantee: a run that finishes before the
    ``DELETE`` is reported ``inconclusive``.
    """
    draw = _pseudo_random(seed)
    names = [f"t{index}" for index in range(tasks)]
    candidates: dict[str, Any] = {}
    total_cost = 0
    for index in range(tasks):
        costs = []
        for slot in range(per_task):
            cost = 20 + next(draw) % 80
            latency = 130 - cost + next(draw) % 6
            costs.append(cost)
            candidates[f"c{index}x{slot}"] = {
                "provides": f"s{index}/v1",
                "features": {"latency": latency, "cost": cost},
                "provider": {"resource": "catalog", "id": "p"},
            }
        total_cost += sum(costs) // len(costs)
    shape = {"unit": "u", "direction": "minimize", "aggregation": "sum"}
    documents = {
        "application.json": _envelope(
            "Application",
            "hard-application",
            {
                "tasks": {task: f"s{index}/v1" for index, task in enumerate(names)},
                "features": {"latency": dict(shape), "cost": dict(shape)},
                "workflow": {"sequence": [{"task": {"resource": "application", "id": task}} for task in names]},
            },
        ),
        "candidates.json": _envelope(
            "CandidateCatalog",
            "hard-catalog",
            {
                "providers": {"p": {"name": "P"}},
                "featureBindings": {
                    "latency": {"resource": "application", "id": "latency"},
                    "cost": {"resource": "application", "id": "cost"},
                },
                "candidates": candidates,
            },
        ),
        "limits.json": _envelope(
            "ConstraintSet",
            "hard-limits",
            {"constraints": {"budget": {"assert": f"features.cost <= {total_cost}", "enforcement": "hard"}}},
        ),
        "optimization.json": _envelope(
            "Optimization",
            "hard-optimization",
            {
                "criteria": [
                    {
                        "id": "latency",
                        "feature": {"resource": "application", "id": "latency"},
                        "normalize": {"min": 0, "max": tasks * 140, "clamp": False},
                    }
                ]
            },
        ),
    }
    instance = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": "engine-e2e-hard"},
        "spec": {
            "profile": "qos-binding/v1",
            "resources": {
                "application": {"application": "application.json"},
                "candidateCatalog": {"catalog": "candidates.json"},
                "constraintSet": {"limits": "limits.json"},
                "optimization": {"optimization": "optimization.json"},
            },
        },
    }
    files = {"instance.json": _dump(instance)}
    files.update({name: _dump(document) for name, document in documents.items()})
    return files


def compile_files(bim: InProcessBim, files: dict[str, bytes]) -> dict[str, Any]:
    """The normalized IR (``BindingProblem``) of a package, compiled by ``bim_core``."""
    return bim.compile(InstancePackage(files).to_zip())["ir"]


def execution_optimization(ir: dict[str, Any]) -> dict[str, Any]:
    """SINGLE weighted-sum over every criterion with equal weights (summing to 1), as the minizinc mode requires."""
    criteria = [item["id"] for item in ir["spec"]["optimization"]["criteria"]]
    return {
        "type": "SINGLE",
        "scalarization": "weighted-sum",
        "weights": [{"criteria": item, "value": 1.0 / len(criteria)} for item in criteria],
    }


# --------------------------------------------------------------------------
# Re-evaluation and the honest classification
# --------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Exhaustive:
    """The best binding by enumeration, when the space was small enough to enumerate."""

    size: int
    binding: dict[str, Any]
    score: float


def exhaustive_best(
    bim: InProcessBim, ir: dict[str, Any], optimization: dict[str, Any], limit: int = EXHAUSTIVE_LIMIT
) -> Exhaustive | None:
    eligibility: dict[str, list[dict[str, str]]] = ir["spec"]["eligibility"]
    tasks = list(eligibility)
    size = 1
    for task in tasks:
        size *= len(eligibility[task])
        if size > limit:
            return None
    bindings = [dict(zip(tasks, combination, strict=True)) for combination in itertools.product(*(eligibility[t] for t in tasks))]
    outcomes = bim.evaluate_many(ir, bindings, optimization, on_error="collect")
    best: Exhaustive | None = None
    for binding, outcome in zip(bindings, outcomes, strict=True):
        evaluation = outcome.get("evaluation")
        if evaluation is None or any(item.get("enforcement") == "hard" for item in evaluation["violations"]):
            continue
        score = float(evaluation["objectives"]["score"])
        if best is None or score < best.score:
            best = Exhaustive(size, binding, score)
    return best


def canned_stdout(ir: dict[str, Any], binding: dict[str, Any], score: float) -> str:
    """What MiniZinc would print for ``binding``: indices into the engine's candidate list, in its order."""
    tasks = [name for name, task in ir["spec"]["application"]["tasks"].items() if task.get("kind") == "service"]
    candidates = [
        (resource, candidate)
        for resource, wrapper in ir["spec"]["candidates"].items()
        for candidate in wrapper["candidates"]
    ]
    selected = [candidates.index((binding[task]["resource"], binding[task]["id"])) + 1 for task in tasks]
    return json.dumps({"selected_cand": selected, "objective_value": score}) + "\n----------\n==========\n"


def declared_terminations() -> tuple[str, ...]:
    """The terminations the minizinc mode guarantees, from the installed manifest; the conservative set if unknown."""
    candidates = [REPO_ROOT / "schemas", Path(os.environ.get("SCHEMAS_DIR", "/nonexistent"))]
    for root in candidates:
        path = root / "bim" / "v1" / "manifests" / "minizinc-csp.json"
        if path.is_file():
            try:
                modes = json.loads(path.read_text(encoding="utf-8"))["spec"]["modes"]
                return tuple(next(mode for mode in modes if mode["id"] == "exact-weighted")["guarantees"]["termination"])
            except (KeyError, StopIteration, ValueError, OSError):
                continue
    return CONSERVATIVE_TERMINATIONS


def classify(
    raw: dict[str, Any], verified: dict[str, Any], exhaustive: Exhaustive | None, *, real_solver: bool
) -> dict[str, Any]:
    """The honest label of a result. ``verified`` is ``bim_core.reevaluate`` of ``raw``."""
    claimed, termination = raw.get("termination"), verified["termination"]
    report: dict[str, Any] = {
        "engine_termination": claimed,
        "verified_termination": termination,
        "proof": "none",
        "notes": [],
    }
    if claimed != termination:
        report["notes"].append(f"re-evaluation changed the termination {claimed} -> {termination}")
    solutions = verified["solutions"]
    if termination == "INFEASIBLE" and not solutions:
        return {**report, "classification": "infeasible", "proof": "solver-claim-allowed-by-mode"}
    if not solutions:
        # includes every decision the re-evaluation dropped (malformed, ineligible): never "feasible"
        return {**report, "classification": "unknown"}
    if any(item.get("enforcement") == "hard" for item in solutions[0]["violations"]):
        report["notes"].append("the decision violates a hard constraint")
        return {**report, "classification": "unknown"}
    score = float(solutions[0]["objectives"]["score"])
    report["score"] = score
    if termination != "OPTIMAL":
        if exhaustive is not None and abs(score - exhaustive.score) <= 1e-9:
            report["notes"].append("equals the exhaustive optimum but the engine did not prove it")
        return {**report, "classification": "feasible"}
    if exhaustive is not None:
        if score <= exhaustive.score + 1e-9:
            return {**report, "classification": "optimal", "proof": "exhaustive-enumeration"}
        report["notes"].append(f"a binding with score {exhaustive.score} exists, the engine's is {score}")
        return {**report, "classification": "inconsistent"}
    if real_solver:
        return {**report, "classification": "optimal", "proof": "solver-claim-allowed-by-mode"}
    report["notes"].append("OPTIMAL cannot be demonstrated: the space is too large to enumerate and the solver is a fake")
    return {**report, "classification": "feasible"}


# --------------------------------------------------------------------------
# The processes (Linux /proc)
# --------------------------------------------------------------------------


CLOCK_TICKS = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


@dataclasses.dataclass(frozen=True)
class Proc:
    state: str
    ppid: int
    pgrp: int
    ticks: int


def proc_table() -> dict[int, Proc]:
    table: dict[int, Proc] = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            raw = Path(f"/proc/{entry}/stat").read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        fields = raw[raw.rindex(")") + 2:].split()
        table[int(entry)] = Proc(fields[0], int(fields[1]), int(fields[2]), int(fields[11]) + int(fields[12]))
    return table


def live_members(table: dict[int, Proc], pgrp: int) -> list[int]:
    return [pid for pid, proc in table.items() if proc.pgrp == pgrp and proc.state not in ("Z", "X")]


def solver_leaders(table: dict[int, Proc], engine_pid: int) -> list[int]:
    """Process groups the engine started for its solvers: its children that lead their own group."""
    return [pid for pid, proc in table.items() if proc.ppid == engine_pid and proc.pgrp == pid and proc.state != "Z"]


def zombie_children(table: dict[int, Proc], parent: int) -> list[int]:
    return [pid for pid, proc in table.items() if proc.ppid == parent and proc.state == "Z"]


def ticks_of(pids: Sequence[int]) -> int:
    table = proc_table()
    return sum(table[pid].ticks for pid in pids if pid in table)


def wait_until(predicate: Callable[[], Any], timeout: float, interval: float = 0.05) -> Any:
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if time.monotonic() >= deadline:
            return value
        time.sleep(interval)


# --------------------------------------------------------------------------
# The engine under test
# --------------------------------------------------------------------------


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def ensure_built(engine_dir: Path) -> None:
    """``dist/index.js`` must exist and not be older than the sources; otherwise compile with the engine's tsc."""
    entry = engine_dir / "dist" / "index.js"
    sources = list((engine_dir / "src").glob("*.ts"))
    if entry.is_file() and all(entry.stat().st_mtime >= path.stat().st_mtime for path in sources):
        return
    compiler = engine_dir / "node_modules" / "typescript" / "bin" / "tsc"
    node = shutil.which("node")
    if node is None or not compiler.is_file():
        raise HarnessUnavailable(f"{entry} is missing or stale and the engine cannot be built here (run `pnpm install && pnpm build` in {engine_dir})")
    done = subprocess.run([node, str(compiler), "-p", "tsconfig.json"], cwd=engine_dir, capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise HarnessUnavailable(f"building the engine did not succeed:\n{done.stdout}{done.stderr}")


class LocalEngine:
    """``node dist/index.js`` of the engine under test, in its own session; stopped with SIGTERM like a container."""

    def __init__(self, engine_dir: Path, env: dict[str, str]) -> None:
        self.engine_dir = engine_dir
        self.port = free_port()
        self.env = {**os.environ, **env, "PORT": str(self.port)}
        self.proc: subprocess.Popen[bytes] | None = None
        self.log = tempfile.NamedTemporaryFile(prefix="engine-", suffix=".log", delete=False)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def pid(self) -> int:
        assert self.proc is not None
        return self.proc.pid

    def start(self) -> None:
        node = shutil.which("node")
        if node is None:
            raise HarnessUnavailable("node is not installed")
        ensure_built(self.engine_dir)
        self.proc = subprocess.Popen(
            [node, "dist/index.js"],
            cwd=self.engine_dir,
            env=self.env,
            stdout=self.log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

        def healthy() -> bool:
            if self.proc is not None and self.proc.poll() is not None:
                raise HarnessUnavailable(f"the engine exited with {self.proc.returncode}:\n{self.tail()}")
            try:
                return httpx.get(f"{self.url}/health", timeout=1.0, trust_env=False).status_code == 200
            except httpx.HTTPError:
                return False

        if not wait_until(healthy, 30.0, 0.1):
            self.stop()
            raise HarnessUnavailable(f"the engine did not become healthy:\n{self.tail()}")

    def tail(self) -> str:
        self.log.flush()
        return Path(self.log.name).read_text(encoding="utf-8", errors="replace")[-2000:]

    def stop(self) -> None:
        proc, self.proc = self.proc, None
        if proc is not None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        self.log.close()
        with contextlib.suppress(OSError):
            os.unlink(self.log.name)


class EngineClient:
    def __init__(self, url: str, token: str | None = None) -> None:
        headers = {"accept": "application/json"}
        if token:
            headers["authorization"] = f"Bearer {token}"
        self.http = httpx.Client(base_url=url.rstrip("/"), headers=headers, timeout=20.0, trust_env=False)

    def close(self) -> None:
        self.http.close()

    def get(self, path: str) -> httpx.Response:
        return self.http.get(path)

    def submit(self, ir: dict[str, Any], optimization: dict[str, Any], options: dict[str, Any]) -> httpx.Response:
        body = {
            "apiVersion": "bim/v1",
            "kind": "BindingProblemRequest",
            "protocol": "bim-engine/v1",
            "problem": ir,
            "optimization": optimization,
            "options": options,
        }
        return self.http.post(
            "/internal/v1/binding-problems",
            content=json.dumps(body, separators=(",", ":"), allow_nan=False),
            headers={"content-type": "application/json"},
        )

    def job(self, job_id: str) -> httpx.Response:
        return self.http.get(JOB_PATH.replace("{id}", job_id))

    def cancel(self, job_id: str) -> httpx.Response:
        """The ``DELETE`` the gateway sends: a JSON content-type and no body."""
        return self.http.request("DELETE", JOB_PATH.replace("{id}", job_id), headers={"content-type": "application/json"})


# --------------------------------------------------------------------------
# The report
# --------------------------------------------------------------------------


@dataclasses.dataclass
class Step:
    name: str
    status: str
    detail: str = ""
    data: dict[str, Any] = dataclasses.field(default_factory=dict)


@dataclasses.dataclass
class Report:
    mode: str
    steps: list[Step] = dataclasses.field(default_factory=list)

    def check(self, name: str, condition: bool, detail: str = "", **data: Any) -> bool:
        self.steps.append(Step(name, PASSED if condition else FAILED, detail, data))
        return bool(condition)

    def inconclusive(self, name: str, detail: str) -> None:
        self.steps.append(Step(name, INCONCLUSIVE, detail))

    def not_executed(self, name: str, detail: str) -> None:
        self.steps.append(Step(name, NOT_EXECUTED, detail))

    @property
    def ok(self) -> bool:
        return all(step.status in (PASSED, NOT_EXECUTED) for step in self.steps)

    def as_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "ok": self.ok,
            "steps": [dataclasses.asdict(step) for step in self.steps],
        }

    def lines(self) -> list[str]:
        marks = {PASSED: "PASS", FAILED: "FAIL", INCONCLUSIVE: "INCONCLUSIVE", NOT_EXECUTED: "NO EJECUTADO"}
        return [f"[{marks[step.status]}] {step.name}" + (f": {step.detail}" if step.detail else "") for step in self.steps]


# --------------------------------------------------------------------------
# The scenarios
# --------------------------------------------------------------------------


def scenario_registration(report: Report, client: EngineClient, *, bearer: bool) -> None:
    """The engine's OpenAPI conforms to bim-engine/v1 and backs the cancellation capability the gateway reads."""
    from openbinding_gateway.services.engine_registry import cancellation_capability

    served = client.get("/openapi.json")
    if not report.check("registration: /openapi.json is served", served.status_code == 200, f"HTTP {served.status_code}"):
        return
    document = served.json()
    scheme = "bearer" if bearer else "none"
    mappings = {
        "request": "/internal/v1/binding-problems",
        "job": JOB_PATH,
        "health": "/internal/v1/health" if bearer else "/health",
        "openapi": "/openapi.json",
    }
    findings = openapi_diagnostics(document, auth_scheme=scheme, mappings=mappings)
    report.check("registration: the OpenAPI conforms to the installed bim-engine/v1", not findings, json.dumps(findings)[:400])
    spec = {
        "extensions": {"cancellation": {"supported": True, "idScope": "attempt"}},
        "mappings": mappings,
        "auth": {"scheme": scheme},
    }
    capability = cancellation_capability(spec, document)
    report.check(
        "registration: the gateway reads cancellation (idScope attempt) as supported",
        capability.supported and capability.per_attempt,
        capability.reason or "",
    )
    without = cancellation_capability({**spec, "extensions": {}}, document)
    report.check("registration: without the declaration the capability is off", not without.supported)
    broken = json.loads(json.dumps(document))
    broken["paths"][JOB_PATH].pop("delete")
    report.check(
        "registration: an OpenAPI that does not describe DELETE turns the capability off",
        not cancellation_capability(spec, broken).supported,
    )


def poll_job(client: EngineClient, job_id: str, *, timeout: float) -> dict[str, Any] | None:
    """The job document once it is ``completed`` or ``failed``; ``None`` on timeout."""

    def done() -> dict[str, Any] | None:
        payload = client.job(job_id).json()
        return payload if payload.get("status") in ("completed", "failed") else None

    return wait_until(done, timeout, 0.1)


def scenario_solve(
    report: Report,
    client: EngineClient,
    bim: InProcessBim,
    ir: dict[str, Any],
    optimization: dict[str, Any],
    exhaustive: Exhaustive | None,
    *,
    real_solver: bool,
    expect: str,
    timeout: float,
) -> None:
    receipt = client.submit(ir, optimization, {"time_budget_ms": 20000})
    body = receipt.json() if receipt.status_code == 202 else {}
    if not report.check(
        "solve: POST answers 202 with an EngineJobAccepted receipt",
        receipt.status_code == 202 and set(body) == {"id", "status"} and body.get("status") == "queued",
        f"HTTP {receipt.status_code} {receipt.text[:200]}",
    ):
        return
    job_id = body["id"]
    payload = poll_job(client, job_id, timeout=timeout)
    if payload is None:
        report.check("solve: the job finishes in time", False, f"still not finished after {timeout:.0f} s")
        return
    try:
        raw = validate_job(payload, job_id, finite=True)
    except ProtocolError as exc:
        report.check("solve: the job ends completed with a valid bim-engine/v1 result", False, f"{exc.code}: {exc.message}")
        return
    if not report.check("solve: the job ends completed with a valid bim-engine/v1 result", raw is not None):
        return
    verified = bim.reevaluate(ir, raw, optimization, list(declared_terminations()))
    outcome = classify(raw, verified, exhaustive, real_solver=real_solver)
    label = outcome["classification"]
    report.check(
        f"solve: result re-evaluated by bim_core and classified {label}",
        label != "inconsistent",
        "; ".join(outcome["notes"]),
        **outcome,
    )
    if expect != "any":
        report.check(f"solve: the classification is the expected {expect}", label == expect, f"got {label}")


def scenario_cancel(
    report: Report,
    client: EngineClient,
    other_tenant: EngineClient | None,
    ir: dict[str, Any],
    optimization: dict[str, Any],
    *,
    engine_pid: int | None,
    timeout: float,
    leave_running: bool = False,
) -> None:
    """Submit a long job, cancel it, and check what the engine and the host say about it.

    ``leave_running`` keeps the last resubmitted job running (a local engine is stopped afterwards, which must
    stop its solver); against a shared engine (``--url``) nothing is left behind.
    """
    receipt = client.submit(ir, optimization, {"time_budget_ms": 600000})
    body = receipt.json() if receipt.status_code == 202 else {}
    if not report.check("cancel: a long job is accepted (202)", receipt.status_code == 202, f"HTTP {receipt.status_code} {receipt.text[:200]}"):
        return
    job_id = body["id"]
    running = wait_until(lambda: client.job(job_id).json().get("status") in ("running", "completed", "failed"), timeout, 0.1)
    state = client.job(job_id).json().get("status")
    if not running or state != "running":
        report.inconclusive("cancel: the job is running when it is cancelled", f"the job is {state!r} (it finished before the DELETE)")
        return
    report.check("cancel: the job reads as running", True)

    leaders: list[int] = []
    members: list[int] = []
    if engine_pid is not None:
        leaders = wait_until(lambda: solver_leaders(proc_table(), engine_pid), 15.0, 0.1) or []
        if report.check("cancel: the engine started a solver process group", bool(leaders), f"leaders={leaders}"):
            members = live_members(proc_table(), leaders[0])
            before = ticks_of(members)
            time.sleep(1.0)
            burnt = ticks_of(members) - before
            report.check(
                "cancel: before the DELETE the solver group burns CPU",
                burnt >= 0.1 * CLOCK_TICKS,
                f"{burnt} ticks in 1 s over {len(members)} process(es)",
            )
    else:
        report.not_executed("cancel: process checks (CPU, group, zombies)", "the solver does not run on this host (--url)")

    first = client.cancel(job_id)
    answers = [first.status_code]
    final = first
    if first.status_code == 202:
        deadline = time.monotonic() + timeout
        while final.status_code == 202 and time.monotonic() < deadline:
            time.sleep(0.5)
            final = client.cancel(job_id)
            answers.append(final.status_code)
    final_body = final.json() if final.status_code in (200, 202) else {}
    report.check(
        "cancel: DELETE answers 200 cancelled (202 cancelling only while the solver is not confirmed gone)",
        final.status_code == 200 and final_body == {"id": job_id, "status": "cancelled"},
        f"answers {answers}, last {final.text[:200]}",
    )

    after = client.job(job_id).json()
    report.check(
        "cancel: GET projects the cancelled job onto the contract (failed + 'cancelled:' error)",
        after.get("status") == "failed"
        and str(after.get("error", "")).startswith("cancelled:")
        and set(after) == {"id", "status", "created_at", "error"},
        json.dumps(after)[:300],
    )

    if engine_pid is not None and leaders:
        table = proc_table()
        report.check(
            "cancel: the solver process group is gone and reaped (no live member, no zombie child of the engine)",
            not live_members(table, leaders[0]) and leaders[0] not in table and not zombie_children(table, engine_pid),
            f"members={live_members(table, leaders[0])} zombies={zombie_children(table, engine_pid)}",
        )
        engine_before = ticks_of([engine_pid])
        time.sleep(1.0)
        engine_used = ticks_of([engine_pid]) - engine_before
        report.check(
            "cancel: the CPU is free (nothing of the group runs and the engine is idle)",
            not live_members(proc_table(), leaders[0]) and engine_used < 0.5 * CLOCK_TICKS,
            f"engine used {engine_used} ticks in 1 s",
        )

    again = client.cancel(job_id)
    report.check(
        "cancel: DELETE is idempotent (repeating it answers the same 200 cancelled)",
        again.status_code == 200 and again.json() == {"id": job_id, "status": "cancelled"},
        f"HTTP {again.status_code}",
    )
    missing = client.cancel("00000000-0000-4000-8000-000000000000")
    report.check("cancel: an unknown id is 404", missing.status_code == 404, f"HTTP {missing.status_code}")
    if other_tenant is not None:
        foreign_get, foreign_delete = other_tenant.job(job_id), other_tenant.cancel(job_id)
        report.check(
            "cancel: another tenant gets the same 404 as for an unknown id, for GET and DELETE",
            foreign_get.status_code == foreign_delete.status_code == 404 and foreign_get.json() == missing.json(),
            f"GET {foreign_get.status_code}, DELETE {foreign_delete.status_code}",
        )
    resubmitted = client.submit(ir, optimization, {"time_budget_ms": 600000})
    if report.check("cancel: a resubmission is accepted as a new job", resubmitted.status_code == 202):
        new_id = resubmitted.json()["id"]
        report.check(
            "cancel: the resubmission has a new id and the cancelled job stays cancelled",
            new_id != job_id and client.cancel(job_id).json().get("status") == "cancelled",
        )
        if not leave_running:
            client.cancel(new_id)


# --------------------------------------------------------------------------
# The modes
# --------------------------------------------------------------------------


@dataclasses.dataclass
class Options:
    mode: str  # fake | local | url
    url: str | None
    token: str | None
    token_b: str | None
    scenario: str
    expect: str
    engine_dir: Path
    timeout: float
    tasks: int
    candidates: int


def run(options: Options) -> Report:
    report = Report(options.mode)
    bim = InProcessBim()
    run_registration = options.scenario in ("all", "registration")
    run_solve = options.scenario in ("all", "solve")
    run_cancel = options.scenario in ("all", "cancel")
    local = options.mode in ("fake", "local")

    ir = compile_files(bim, minimal_files())
    optimization = execution_optimization(ir)
    exhaustive = exhaustive_best(bim, ir, optimization)
    cancel_ir, cancel_optimization = ir, optimization
    if options.mode != "fake" and run_cancel:
        cancel_ir = compile_files(bim, hard_files(options.tasks, options.candidates))
        cancel_optimization = execution_optimization(cancel_ir)

    engines: list[LocalEngine] = []
    clients: list[EngineClient] = []
    scratch = Path(tempfile.mkdtemp(prefix="engine-e2e-"))
    cancel_engine: LocalEngine | None = None
    left_running: list[int] = []
    try:
        token_a, token_b = options.token, options.token_b
        solve_url = cancel_url = options.url
        if local:
            token_a, token_b = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
            base_env = {"ENGINE_AUTH_TOKENS": f"tenant-a={token_a},tenant-b={token_b}"}
            if options.mode == "fake":
                if exhaustive is None:
                    raise HarnessUnavailable("the fake solver needs the optimum of the package by enumeration")
                canned = scratch / "stdout.txt"
                canned.write_text(canned_stdout(ir, exhaustive.binding, exhaustive.score), encoding="utf-8")
                command = json.dumps(["node", str(options.engine_dir / "tests" / "fake_minizinc.mjs")])
                solve_env = {**base_env, "MINIZINC_COMMAND": command, "FAKE_MINIZINC_STDOUT_FILE": str(canned)}
                cancel_env = {**base_env, "MINIZINC_COMMAND": command, "FAKE_MINIZINC_MODE": "hang"}
            else:
                solve_env = cancel_env = base_env
            solve_engine: LocalEngine | None = None
            if run_registration or run_solve:
                solve_engine = LocalEngine(options.engine_dir, solve_env)
                engines.append(solve_engine)
                solve_engine.start()
                solve_url = solve_engine.url
            if run_cancel:
                cancel_engine = solve_engine if options.mode == "local" and solve_engine else None
                if cancel_engine is None:
                    cancel_engine = LocalEngine(options.engine_dir, cancel_env)
                    engines.append(cancel_engine)
                    cancel_engine.start()
                cancel_url = cancel_engine.url
        if (run_registration or run_solve) and solve_url is None:
            raise HarnessUnavailable("no engine to test: pass --url, --fake-minizinc or --local-minizinc")
        if run_cancel and cancel_url is None:
            raise HarnessUnavailable("no engine to test: pass --url, --fake-minizinc or --local-minizinc")

        def client_for(url: str, token: str | None) -> EngineClient:
            clients.append(EngineClient(url, token))
            return clients[-1]

        if run_registration or run_solve:
            assert solve_url is not None
            main_client = client_for(solve_url, token_a)
            if run_registration:
                scenario_registration(report, main_client, bearer=bool(token_a))
            if run_solve:
                scenario_solve(
                    report, main_client, bim, ir, optimization, exhaustive,
                    real_solver=options.mode != "fake", expect=options.expect, timeout=options.timeout,
                )
        if run_cancel:
            assert cancel_url is not None
            scenario_cancel(
                report,
                client_for(cancel_url, token_a),
                client_for(cancel_url, token_b) if token_b else None,
                cancel_ir,
                cancel_optimization,
                engine_pid=cancel_engine.pid if cancel_engine is not None else None,
                timeout=options.timeout,
                leave_running=local,
            )
            if cancel_engine is not None:
                # the scenario left one job running: stopping the engine (SIGTERM) must stop its solver too
                left_running = wait_until(lambda: solver_leaders(proc_table(), cancel_engine.pid), 10.0, 0.1) or []
    finally:
        for client in clients:
            client.close()
        for engine in engines:
            engine.stop()
        shutil.rmtree(scratch, ignore_errors=True)
    if left_running:
        report.check(
            "shutdown: SIGTERM to the engine stops the solver it still had running",
            all(not live_members(proc_table(), leader) for leader in left_running),
            f"groups {left_running}",
        )
    elif local and run_cancel:
        report.inconclusive("shutdown: SIGTERM to the engine stops the solver it still had running", "no solver was left running")
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--url", help="base URL of a running engine (laboratory)")
    target.add_argument("--fake-minizinc", action="store_true", help="start the engine locally with tests/fake_minizinc.mjs")
    target.add_argument("--local-minizinc", action="store_true", help="start the engine locally with the real minizinc of this host")
    parser.add_argument("--token", default=os.environ.get("ENGINE_E2E_TOKEN"), help="bearer token for --url (tenant a)")
    parser.add_argument("--token-b", default=os.environ.get("ENGINE_E2E_TOKEN_B"), help="bearer token of a second tenant for --url")
    parser.add_argument("--scenario", choices=("all", "registration", "solve", "cancel"), default="all")
    parser.add_argument("--expect", choices=("any", *CLASSIFICATIONS), default="any", help="fail unless the solve is classified so")
    parser.add_argument("--engine-dir", type=Path, default=ENGINE_DIR)
    parser.add_argument("--timeout", type=float, default=120.0, help="seconds to wait for a job or a cancellation")
    parser.add_argument("--tasks", type=int, default=150, help="size of the hard package used to cancel a real solver")
    parser.add_argument("--candidates", type=int, default=30)
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    mode = "url" if args.url else "fake" if args.fake_minizinc else "local"
    options = Options(
        mode, args.url, args.token, args.token_b, args.scenario, args.expect, args.engine_dir, args.timeout,
        args.tasks, args.candidates,
    )
    try:
        report = run(options)
    except HarnessUnavailable as exc:
        print(f"engine_e2e: cannot run: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report.as_dict(), indent=2))
    else:
        print("\n".join(report.lines()))
        print("engine_e2e: " + ("ok" if report.ok else "NOT ok"))
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
