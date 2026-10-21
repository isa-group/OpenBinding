"""The JVM engines against ``bim_core`` 0.2.0, and their remote cancellation, end to end.

What it does, with the standard library plus ``bim_core`` (and ``bim_client.InProcessBim`` when it is
importable; the same operations are taken from ``bim_core`` directly otherwise):

1. compiles a small BIM package (source documents -> canonical IR 0.2.0) with ``bim_core``;
2. launches each Java engine as a real ``java`` process (the classes ``mvn test`` left in
   ``target/classes`` plus the Gson jar already in the local Maven repository: nothing is downloaded);
3. sends it a ``BindingProblemRequest`` in both modes, synchronous (the default) and asynchronous
   (``ENGINE_JOB_MODE=async``: 202, job id, GET), with a fixed seed;
4. validates the answer against ``bim-engine/v1`` and **re-evaluates every returned decision** with
   ``bim_core`` so that no number the engine reports is trusted; the engine's claims (features, objectives,
   penalties, violations) are compared with the authoritative ones;
5. enumerates the whole binding space of the instance, so the report can say honestly whether a heuristic
   happened to find the optimum (it never *claims* it: the declared termination is FEASIBLE or UNKNOWN);
6. cancels a job that cannot finish on its own (a million iterations over forty tasks) and measures, from
   ``/proc``, that the solver thread of the real process stops burning CPU.

Run it from the repository root with the gateway environment::

    cd openbinding-gateway
    PYTHONPATH=src:../bim-toolchain/packages/bim-core/src:../bim-toolchain/packages/bim-client/src \\
        uv run python ../engines/e2e/java_engines_ir02.py

Anything it cannot run (no ``java``, no ``target/classes``, no Gson jar in ``~/.m2``) is reported as NOT RUN
with the reason, never as passed.
"""

from __future__ import annotations

import argparse
import dataclasses
import itertools
import json
import math
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable, Iterator, Sequence

REPO = Path(__file__).resolve().parents[2]
ENGINES_DIR = REPO / "engines"
MANIFESTS = REPO / "schemas" / "bim" / "v1" / "manifests"
FEDERATION = REPO / "examples" / "federation"
SEED = 20260514
TOLERANCE = 1e-9
CLOCK_TICKS = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


# ---------------------------------------------------------------------------------------------------
# The BIM package and the bim_core port


def _application(tasks: int) -> dict[str, Any]:
    names = [f"t{index}" for index in range(1, tasks + 1)]
    return {
        "apiVersion": "qos-binding/v1",
        "kind": "Application",
        "metadata": {"name": "java_engines_application"},
        "spec": {
            "tasks": {name: f"service/{name}" for name in names},
            "features": {
                "cost": {
                    "unit": "eur", "direction": "minimize", "scope": "invocation", "aggregation": "sum",
                    "domain": {"kind": "real", "minimum": 0, "maximum": 10000},
                },
                "latency": {
                    "unit": "ms", "direction": "minimize", "scope": "invocation",
                    "aggregation": {
                        "sequence": "sum", "parallel": "max", "exclusive": "weightedSum",
                        "repeat": "scale", "selection": "sum",
                    },
                    "domain": {"kind": "real", "minimum": 0, "maximum": 100000},
                },
                "availability": {
                    "unit": "ratio", "direction": "maximize", "scope": "invocation", "aggregation": "product",
                    "domain": {"kind": "real", "minimum": 0, "maximum": 1},
                },
            },
            "workflow": {"sequence": [{"task": {"resource": "application", "id": name}} for name in names]},
        },
    }


def build_package(*, tasks: int, candidates: int, seed: int) -> bytes:
    """A deterministic ``.bim.zip``: ``tasks`` sequential service tasks with ``candidates`` candidates each,
    three features (cost, latency, availability) and one criterion per feature."""
    rng = random.Random(seed)
    names = [f"t{index}" for index in range(1, tasks + 1)]
    catalog_candidates = {}
    for name in names:
        for index in range(candidates):
            catalog_candidates[f"{name}_c{index}"] = {
                "provides": f"service/{name}",
                "features": {
                    "cost": rng.randint(1, 100),
                    "latency": rng.randint(5, 200),
                    "availability": round(rng.uniform(0.90, 0.999), 3),
                },
                "provider": {"resource": "catalog", "id": "p1"},
            }
    bounds = {"cost": (0, 10000), "latency": (0, 100000), "availability": (0, 1)}
    documents = {
        "instance.json": {
            "apiVersion": "bim/v1",
            "kind": "Instance",
            "metadata": {"name": "java_engines_ir02", "version": "1.0.0"},
            "spec": {
                "profile": "qos-binding/v1",
                "resources": {
                    "application": {"application": "application.json"},
                    "candidateCatalog": {"catalog": "candidates.json"},
                    "optimization": {"optimization": "optimization.json"},
                },
            },
        },
        "application.json": _application(tasks),
        "candidates.json": {
            "apiVersion": "qos-binding/v1",
            "kind": "CandidateCatalog",
            "metadata": {"name": "java_engines_catalog"},
            "spec": {
                "candidates": catalog_candidates,
                "providers": {"p1": {}},
                "featureBindings": {
                    feature: {"resource": "application", "id": feature} for feature in bounds
                },
            },
        },
        "optimization.json": {
            "apiVersion": "qos-binding/v1",
            "kind": "Optimization",
            "metadata": {"name": "java_engines_optimization"},
            "spec": {
                "criteria": [
                    {
                        "id": feature,
                        "feature": {"resource": "application", "id": feature},
                        "normalize": {"min": low, "max": high, "clamp": True},
                    }
                    for feature, (low, high) in bounds.items()
                ]
            },
        },
    }
    buffer = tempfile.SpooledTemporaryFile()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        for path in sorted(documents):
            info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o644 << 16
            archive.writestr(info, json.dumps(documents[path], sort_keys=True, indent=2).encode("utf-8"))
    buffer.seek(0)
    return buffer.read()


class BimPort:
    """The four operations this module needs, through ``InProcessBim`` or, failing that, ``bim_core``."""

    def __init__(self) -> None:
        import bim_core

        self.core_version = bim_core.__version__
        self._core = bim_core
        try:
            from bim_client import InProcessBim

            self._port = InProcessBim()
            self.implementation = "bim_client.InProcessBim"
        except ImportError:
            self._port = None
            self.implementation = "bim_core (bim_client not importable)"

    def compile(self, package: bytes) -> dict[str, Any]:
        if self._port is not None:
            return self._port.compile(package)["ir"]
        loaded = self._core.load_package(package)
        return self._core.compile_instance(loaded).document

    def evaluate(self, ir: dict[str, Any], binding: dict[str, Any], execution: dict[str, Any]) -> dict[str, Any]:
        if self._port is not None:
            return self._port.evaluate(ir, binding, execution)
        return self._core.evaluate(self._core.BindingProblem.from_document(ir), binding, execution)

    def evaluate_many(
        self, ir: dict[str, Any], selections: list[dict[str, Any]], execution: dict[str, Any]
    ) -> list[dict[str, Any]]:
        if self._port is not None:
            return [item["evaluation"] for item in self._port.evaluate_many(ir, selections, execution)]
        problem = self._core.BindingProblem.from_document(ir)
        return list(self._core.evaluate_many(problem, selections, execution))

    def reevaluate(
        self, ir: dict[str, Any], result: dict[str, Any], execution: dict[str, Any], allowed: Sequence[str]
    ) -> dict[str, Any]:
        if self._port is not None:
            return self._port.reevaluate(ir, result, execution, list(allowed))
        problem = self._core.BindingProblem.from_document(ir)
        return self._core.reevaluate_result(problem, result, execution, list(allowed))

    def validate_result(self, payload: Any) -> dict[str, Any]:
        if self._port is not None:
            return self._port.validate_result(payload)
        try:
            self._core.validate_result(payload, finite=True)
        except self._core.ProtocolError as exc:
            return {"valid": False, "error": {"code": exc.code, "message": exc.message}}
        return {"valid": True, "error": None}


def bindings(ir: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Every binding of the instance: the whole space, in a deterministic order."""
    eligibility = ir["spec"]["eligibility"]
    tasks = list(eligibility)
    for combination in itertools.product(*(eligibility[task] for task in tasks)):
        yield {task: dict(ref) for task, ref in zip(tasks, combination)}


def weighted_execution(ir: dict[str, Any]) -> dict[str, Any]:
    ids = [criterion["id"] for criterion in ir["spec"]["optimization"]["criteria"]]
    values = {3: [0.5, 0.3, 0.2]}[len(ids)]
    return {
        "type": "SINGLE",
        "scalarization": "weighted-sum",
        "weights": [{"criteria": name, "value": value} for name, value in zip(ids, values)],
    }


def pareto_execution(objective_type: str) -> Callable[[dict[str, Any]], dict[str, Any]]:
    def build(_: dict[str, Any]) -> dict[str, Any]:
        return {"type": objective_type, "scalarization": "pareto-front", "weights": []}

    return build


# ---------------------------------------------------------------------------------------------------
# Engines and cases


@dataclasses.dataclass(frozen=True)
class Case:
    label: str
    mode_id: str
    execution: Callable[[dict[str, Any]], dict[str, Any]]
    options: dict[str, Any]
    slow_options: dict[str, Any]


@dataclasses.dataclass(frozen=True)
class EngineSpec:
    name: str
    module: str
    main_class: str
    manifest: Path
    min_java: int
    cases: tuple[Case, ...]


_RANDOM = {"seed": SEED}
ENGINE_SPECS: tuple[EngineSpec, ...] = (
    EngineSpec(
        "random-search", "random-search", "es.us.isa.qosawarewsbinding.api.Server",
        MANIFESTS / "random-search.json", 8,
        (Case("weighted-sum", "seeded", weighted_execution,
              {"iterations": 3000, **_RANDOM}, {"iterations": 1000000, **_RANDOM}),),
    ),
    EngineSpec(
        "many-heuristic", "many-heuristic", "es.us.isa.qosawarewsbinding.api.Server",
        MANIFESTS / "many-heuristic.json", 8,
        (Case("pareto-front MANY", "pareto-sampling", pareto_execution("MANY"),
              {"iterations": 3000, "archive_size": 50, **_RANDOM},
              {"iterations": 1000000, "archive_size": 50, **_RANDOM}),),
    ),
    EngineSpec(
        "multi-heuristic", "multi-heuristic", "es.us.isa.qosawarewsbinding.api.Server",
        FEDERATION / "multi-heuristic" / "engine.json", 8,
        (Case("pareto-front MULTI", "pareto-sampling", pareto_execution("MULTI"),
              {"iterations": 3000, "archive_size": 50, **_RANDOM},
              {"iterations": 1000000, "archive_size": 50, **_RANDOM}),),
    ),
    EngineSpec(
        "evolutionary-heuristics", "evolutionary-heuristics", "es.us.isa.openbinding.evolutionary.Server",
        MANIFESTS / "evolutionary-heuristics.json", 17,
        (
            Case("elitist-genetic weighted-sum", "elitist-genetic", weighted_execution,
                 {"algorithm": "elitist-genetic", "population_size": 30, "max_evaluations": 3000, **_RANDOM},
                 {"algorithm": "elitist-genetic", "population_size": 50, "max_evaluations": 10000000, **_RANDOM}),
            Case("pareto-genetic pareto-front MANY", "pareto-genetic", pareto_execution("MANY"),
                 {"algorithm": "pareto-genetic", "population_size": 30, "max_evaluations": 3000,
                  "archive_size": 50, **_RANDOM},
                 {"algorithm": "pareto-genetic", "population_size": 50, "max_evaluations": 10000000,
                  "archive_size": 50, **_RANDOM}),
        ),
    ),
)


def declared_guarantees(spec: EngineSpec, mode_id: str) -> dict[str, Any]:
    manifest = json.loads(spec.manifest.read_text(encoding="utf-8"))
    for mode in manifest["spec"]["modes"]:
        if mode["id"] == mode_id:
            return mode["guarantees"]
    raise KeyError(f"{spec.manifest.name} declares no mode {mode_id}")


# ---------------------------------------------------------------------------------------------------
# Locating Java and the classpath, without downloading anything


def java_binary() -> str | None:
    home = os.environ.get("JAVA_HOME")
    if home and (Path(home) / "bin" / "java").exists():
        return str(Path(home) / "bin" / "java")
    return shutil.which("java")


def java_major(java: str) -> int:
    completed = subprocess.run([java, "-version"], capture_output=True, text=True, timeout=30, check=False)
    match = re.search(r'version "(\d+)(?:\.(\d+))?', completed.stderr + completed.stdout)
    if not match:
        return 0
    major = int(match.group(1))
    return int(match.group(2) or 0) if major == 1 else major


def _readable(path: Path, directory: bool = False) -> bool:
    try:
        return path.is_dir() if directory else path.is_file()
    except OSError:  # e.g. /root is not traversable for this user
        return False


def maven_repositories() -> list[Path]:
    candidates = []
    if os.environ.get("OPENBINDING_M2"):
        candidates.append(Path(os.environ["OPENBINDING_M2"]))
    candidates.append(Path.home() / ".m2" / "repository")
    candidates.append(Path("/root/.m2/repository"))
    return [path for path in candidates if _readable(path, directory=True)]


def _jar_resolved_by_maven(spec: EngineSpec, version: str) -> Path | None:
    """The Gson jar that ``mvn test`` itself resolved: its surefire reports list the test class path with
    absolute paths, wherever the local repository is.  Nothing is downloaded."""
    pattern = re.compile(r"(/[^:\"<>\s]*/gson-" + re.escape(version) + r"\.jar)")
    for module in (spec.module, "binding-core"):
        reports = ENGINES_DIR / module / "target" / "surefire-reports"
        if not _readable(reports, directory=True):
            continue
        for report in sorted(reports.glob("TEST-*.xml")):
            try:
                text = report.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for match in pattern.finditer(text):
                if _readable(Path(match.group(1))):
                    return Path(match.group(1))
    return None


def gson_version(spec: EngineSpec) -> str:
    pom = (ENGINES_DIR / spec.module / "pom.xml").read_text(encoding="utf-8")
    match = re.search(r"<artifactId>gson</artifactId>\s*<version>([^<]+)</version>", pom)
    if not match:
        raise RuntimeError(f"{spec.module}/pom.xml does not declare Gson")
    return match.group(1).strip()


def classpath(spec: EngineSpec) -> tuple[list[Path] | None, str]:
    """``(entries, "")`` or ``(None, reason)``: the compiled classes and the Gson jar they were built with."""
    classes = ENGINES_DIR / spec.module / "target" / "classes"
    core = ENGINES_DIR / "binding-core" / "target" / "classes"
    for path in (classes, core):
        if not any(path.rglob("*.class")) if path.is_dir() else True:
            return None, f"{path.relative_to(REPO)} has no compiled classes (run `mvn test` in engines/ first)"
    version = gson_version(spec)
    resolved = _jar_resolved_by_maven(spec, version)
    if resolved is not None:
        return [classes, core, resolved], ""
    for repository in maven_repositories():
        jar = repository / "com" / "google" / "code" / "gson" / "gson" / version / f"gson-{version}.jar"
        if _readable(jar):
            return [classes, core, jar], ""
    return None, (f"gson-{version}.jar is neither in the surefire reports of `mvn test` nor in a readable local "
                  f"Maven repository ({[str(p) for p in maven_repositories()]}); set OPENBINDING_M2")


def prerequisites(spec: EngineSpec) -> tuple[bool, str]:
    java = java_binary()
    if java is None:
        return False, "no `java` on PATH or JAVA_HOME"
    major = java_major(java)
    if major < spec.min_java:
        return False, f"{spec.name} needs Java {spec.min_java}+, found {major}"
    entries, reason = classpath(spec)
    return (entries is not None), reason


# ---------------------------------------------------------------------------------------------------
# A real engine process


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Reply:
    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))


def http(method: str, url: str, body: bytes | None = None, token: str | None = None, timeout: float = 60.0) -> Reply:
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            return Reply(response.status, {k.lower(): v for k, v in response.headers.items()}, response.read())
    except urllib.error.HTTPError as error:
        return Reply(error.code, {k.lower(): v for k, v in error.headers.items()}, error.read())


class JavaEngine:
    """``java -cp classes:gson Server`` on a free loopback port; stopped on exit."""

    def __init__(self, spec: EngineSpec, *, asynchronous: bool, extra_env: dict[str, str] | None = None) -> None:
        entries, reason = classpath(spec)
        java = java_binary()
        if entries is None or java is None:
            raise RuntimeError(reason or "no java")
        self.spec = spec
        self.asynchronous = asynchronous
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        env = {key: value for key, value in os.environ.items() if not key.startswith("ENGINE_")}
        env["PORT"] = str(self.port)
        if asynchronous:
            env["ENGINE_JOB_MODE"] = "async"
        env.update(extra_env or {})
        self._log = tempfile.TemporaryFile()
        self.process = subprocess.Popen(
            [java, "-Xmx256m", "-XX:+UseSerialGC", "-cp", os.pathsep.join(map(str, entries)), spec.main_class],
            env=env, stdout=self._log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        )

    def __enter__(self) -> "JavaEngine":
        self.wait_ready()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.stop()

    def output(self) -> str:
        self._log.flush()
        self._log.seek(0)
        return self._log.read().decode("utf-8", "replace")

    def wait_ready(self, timeout: float = 60.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f"{self.spec.name} exited with {self.process.returncode}: {self.output()[-2000:]}")
            try:
                if http("GET", self.url + "/health", timeout=2).status == 200:
                    return
            except (urllib.error.URLError, ConnectionError, OSError):
                pass
            time.sleep(0.1)
        raise RuntimeError(f"{self.spec.name} was not ready in {timeout}s: {self.output()[-2000:]}")

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        self._log.close()

    # --- requests

    def post(self, payload: bytes, token: str | None = None) -> Reply:
        return http("POST", self.url + "/internal/v1/binding-problems", payload, token)

    def job(self, job_id: str, token: str | None = None) -> Reply:
        return http("GET", f"{self.url}/internal/v1/jobs/{job_id}", None, token)

    def delete(self, job_id: str, token: str | None = None) -> Reply:
        return http("DELETE", f"{self.url}/internal/v1/jobs/{job_id}", None, token)

    def await_job(self, job_id: str, states: Sequence[str], timeout: float = 120.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        last = ""
        while time.monotonic() < deadline:
            reply = self.job(job_id)
            last = f"{reply.status} {reply.body[:300]!r}"
            if reply.status == 200 and reply.json().get("status") in states:
                return reply.json()
            time.sleep(0.05)
        raise TimeoutError(f"job {job_id} never reached {list(states)}; last answer {last}")

    def solve(self, payload: bytes) -> dict[str, Any]:
        """The ``BindingResult``: the 200 body of the synchronous mode, or the completed job."""
        if not self.asynchronous:
            reply = self.post(payload)
            if reply.status != 200:
                raise RuntimeError(f"POST answered {reply.status}: {reply.body[:500]!r}")
            return reply.json()
        reply = self.post(payload)
        if reply.status != 202:
            raise RuntimeError(f"POST answered {reply.status}: {reply.body[:500]!r}")
        receipt = reply.json()
        if set(receipt) != {"id", "status"} or receipt["status"] != "queued":
            raise RuntimeError(f"not an EngineJobAccepted receipt: {receipt}")
        job = self.await_job(receipt["id"], ("completed", "failed"))
        if job["status"] != "completed":
            raise RuntimeError(f"job failed: {job}")
        return job["result"]

    # --- CPU, from /proc

    def process_ticks(self) -> int:
        return process_ticks(self.process.pid)

    def job_thread_ticks(self) -> int | None:
        """CPU ticks of the threads named ``engine-job-*``; ``None`` if the OS does not expose their names."""
        found = False
        total = 0
        for task in Path(f"/proc/{self.process.pid}/task").iterdir():
            try:
                name = (task / "comm").read_text().strip()
                if name.startswith("engine-job"):
                    found = True
                    total += _stat_ticks((task / "stat").read_text())
            except OSError:
                continue
        return total if found else None


def _stat_ticks(stat: str) -> int:
    fields = stat.rsplit(")", 1)[1].split()
    return int(fields[11]) + int(fields[12])  # utime + stime


def process_ticks(pid: int) -> int:
    return _stat_ticks(Path(f"/proc/{pid}/stat").read_text())


# ---------------------------------------------------------------------------------------------------
# Comparing the engine's claims with bim_core


def _close(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return left is right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return math.isclose(left, right, rel_tol=TOLERANCE, abs_tol=TOLERANCE)
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_close(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(_close(a, b) for a, b in zip(left, right))
    return left == right


def _violation_key(entry: dict[str, Any]) -> tuple:
    ref = entry.get("constraint") or {}
    return (ref.get("resource", ""), ref.get("id", ""), entry.get("enforcement", ""))


def claim_discrepancies(claimed: dict[str, Any], authoritative: dict[str, Any]) -> list[str]:
    """What the engine reported that ``bim_core`` does not reproduce (empty when they agree)."""
    problems: list[str] = []
    mine = claimed.get("solutions", [])
    theirs = authoritative.get("solutions", [])
    if len(mine) != len(theirs):
        return [f"{len(mine)} solutions returned, {len(theirs)} survive re-evaluation"]
    for index, (reported, truth) in enumerate(zip(mine, theirs)):
        if reported["decision"] != truth["decision"]:
            problems.append(f"solution {index}: decision changed")
        for field in ("features", "penalties"):
            if not _close(reported[field], truth[field]):
                problems.append(f"solution {index}: {field} {reported[field]} != {truth[field]}")
        if not _close(reported["objectives"], truth["objectives"]):
            problems.append(f"solution {index}: objectives {reported['objectives']} != {truth['objectives']}")
        left = sorted(reported["violations"], key=_violation_key)
        right = sorted(truth["violations"], key=_violation_key)
        keys = ("constraint", "enforcement", "penalty")
        if not _close([{k: v[k] for k in keys} for v in left], [{k: v[k] for k in keys} for v in right]):
            problems.append(f"solution {index}: violations differ")
    return problems


def dominates(left: Sequence[float], right: Sequence[float]) -> bool:
    return all(a <= b for a, b in zip(left, right)) and any(a < b for a, b in zip(left, right))


@dataclasses.dataclass
class SpaceTruth:
    """The whole binding space of the instance, evaluated by ``bim_core``."""

    count: int
    best_score: float | None
    front: list[list[float]]


def enumerate_space(port: BimPort, ir: dict[str, Any], execution: dict[str, Any]) -> SpaceTruth:
    vectors: list[list[float]] = []
    scores: list[float] = []
    selections = list(bindings(ir))
    count = len(selections)
    for evaluation in port.evaluate_many(ir, selections, execution):
        if any(item.get("enforcement") == "hard" for item in evaluation["violations"]):
            continue
        score = evaluation["objectives"]["score"]
        if isinstance(score, list):
            vectors.append([float(value) for value in score])
        else:
            scores.append(float(score))
    front = [v for v in vectors if not any(dominates(w, v) for w in vectors if w is not v)]
    unique: list[list[float]] = []
    for vector in front:
        if not any(_close(vector, seen) for seen in unique):
            unique.append(vector)
    return SpaceTruth(count, min(scores) if scores else None, sorted(unique))


# ---------------------------------------------------------------------------------------------------
# One case, both modes


def request_payload(ir: dict[str, Any], execution: dict[str, Any], options: dict[str, Any]) -> bytes:
    return json.dumps({
        "apiVersion": "bim/v1",
        "kind": "BindingProblemRequest",
        "protocol": "bim-engine/v1",
        "problem": ir,
        "optimization": execution,
        "options": options,
    }).encode("utf-8")


def _strip_timing(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _strip_timing(item) for key, item in value.items() if key != "elapsed_ms"}
    if isinstance(value, list):
        return [_strip_timing(item) for item in value]
    return value


def run_case(port: BimPort, ir: dict[str, Any], truth_cache: dict[str, SpaceTruth],
             spec: EngineSpec, case: Case) -> list[dict[str, Any]]:
    """One report per mode (synchronous, asynchronous) for ``spec`` x ``case``."""
    execution = case.execution(ir)
    guarantees = declared_guarantees(spec, case.mode_id)
    key = json.dumps(execution, sort_keys=True)
    if key not in truth_cache:
        truth_cache[key] = enumerate_space(port, ir, execution)
    truth = truth_cache[key]
    payload = request_payload(ir, execution, case.options)
    reports = []
    answers = {}
    for asynchronous in (False, True):
        with JavaEngine(spec, asynchronous=asynchronous) as engine:
            started = time.monotonic()
            result = engine.solve(payload)
            wall = time.monotonic() - started
        answers[asynchronous] = result
        validation = port.validate_result(result)
        reevaluated = port.reevaluate(ir, result, execution, guarantees["termination"])
        authoritative_scores = [s["objectives"]["score"] for s in reevaluated["solutions"]]
        scalars = [value for value in authoritative_scores if not isinstance(value, list)]
        score = min(scalars) if scalars else None
        vectors = [value for value in authoritative_scores if isinstance(value, list)]
        if truth.best_score is not None and score is not None:
            matches = math.isclose(score, truth.best_score, rel_tol=1e-9, abs_tol=1e-9)
        else:
            matches = None
        front_hits = sum(1 for vector in vectors if any(_close(vector, known) for known in truth.front))
        reports.append({
            "engine": spec.name,
            "case": case.label,
            "mode": "async" if asynchronous else "sync",
            "engineMode": case.mode_id,
            "seed": case.options["seed"],
            "options": case.options,
            "declared": {"exact": guarantees["exact"], "termination": guarantees["termination"]},
            "claimedTermination": result["termination"],
            "reevaluatedTermination": reevaluated["termination"],
            "protocolValid": validation["valid"],
            "protocolError": validation["error"],
            "solutions": len(result["solutions"]),
            "discrepancies": claim_discrepancies(result, reevaluated),
            "bestScore": score,
            "spaceSize": truth.count,
            "spaceBestScore": truth.best_score,
            "foundSpaceOptimum": matches,
            "paretoFrontSize": len(truth.front),
            "paretoPointsOnTrueFront": front_hits if vectors else None,
            "wallSeconds": round(wall, 3),
            "engineElapsedMs": result.get("provenance", {}).get("elapsed_ms"),
        })
    reports[0]["sameAnswerInBothModes"] = reports[1]["sameAnswerInBothModes"] = (
        _strip_timing(answers[False]) == _strip_timing(answers[True])
    )
    return reports


# ---------------------------------------------------------------------------------------------------
# Cancellation against a real process


def run_cancellation(port: BimPort, spec: EngineSpec, case: Case, heavy_ir: dict[str, Any],
                     quick_ir: dict[str, Any]) -> dict[str, Any]:
    """Submit a job that cannot finish, DELETE it, and watch the real process stop working."""
    slow = request_payload(heavy_ir, case.execution(heavy_ir), case.slow_options)
    quick = request_payload(quick_ir, case.execution(quick_ir), case.options)
    report: dict[str, Any] = {"engine": spec.name, "case": case.label, "seed": case.slow_options["seed"]}
    with JavaEngine(spec, asynchronous=True) as engine:
        reply = engine.post(slow)
        assert reply.status == 202, (reply.status, reply.body)
        job_id = reply.json()["id"]
        engine.await_job(job_id, ("running",), timeout=60)

        before_process, before_thread = engine.process_ticks(), engine.job_thread_ticks()
        time.sleep(1.0)
        busy_process, busy_thread = engine.process_ticks(), engine.job_thread_ticks()
        report["runningCpuSecondsPerSecond"] = round((busy_process - before_process) / CLOCK_TICKS, 3)
        if busy_thread is not None and before_thread is not None:
            report["jobThreadRunningCpuSeconds"] = round((busy_thread - before_thread) / CLOCK_TICKS, 3)

        started = time.monotonic()
        deleted = engine.delete(job_id)
        report["deleteStatus"] = deleted.status
        report["deleteBody"] = deleted.json()
        report["deleteSeconds"] = round(time.monotonic() - started, 3)

        after_process, after_thread = engine.process_ticks(), engine.job_thread_ticks()
        time.sleep(1.5)
        idle_process, idle_thread = engine.process_ticks(), engine.job_thread_ticks()
        report["afterCancelProcessCpuSeconds"] = round((idle_process - after_process) / CLOCK_TICKS, 3)
        if idle_thread is not None and after_thread is not None:
            report["afterCancelJobThreadCpuSeconds"] = round((idle_thread - after_thread) / CLOCK_TICKS, 3)

        job = engine.job(job_id)
        report["jobAfterCancel"] = job.json()
        again = engine.delete(job_id)
        report["secondDelete"] = [again.status, again.json()]
        report["processAlive"] = engine.process.poll() is None

        stranger = engine.delete("00000000-0000-0000-0000-000000000000")
        report["unknownIdStatus"] = stranger.status

        # The slot is free again: a small job runs to completion in the same process.
        follow = engine.post(quick)
        assert follow.status == 202, (follow.status, follow.body)
        done = engine.await_job(follow.json()["id"], ("completed", "failed"), timeout=60)
        report["followUpStatus"] = done["status"]
        document = http("GET", engine.url + "/openapi.json")
        report["openapiStatus"] = document.status
        if document.status == 200:
            report["openapiCancellation"] = document.json().get("extensions", {}).get("cancellation")
    # A synchronous engine has no job endpoints at all.
    with JavaEngine(spec, asynchronous=False) as engine:
        report["syncDeleteStatus"] = engine.delete("00000000-0000-0000-0000-000000000000").status
        report["syncPostStatus"] = engine.post(quick).status
    return report


# ---------------------------------------------------------------------------------------------------
# Report


def render_matrix(reports: Sequence[dict[str, Any]]) -> str:
    rows = [
        "| engine | case | mode | seed | declared (exact / terminations) | claimed | re-evaluated | solutions | "
        "best score | space optimum | found optimum | claims agree | same answer sync/async |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for report in reports:
        score = report["bestScore"]
        best = report["spaceBestScore"]
        if score is None and report["paretoPointsOnTrueFront"] is not None:
            score_text = f"front {report['paretoPointsOnTrueFront']}/{report['solutions']} on true"
            best_text = f"front of {report['paretoFrontSize']}"
            found = "-"
        else:
            score_text = "-" if score is None else f"{score:.6f}"
            best_text = "-" if best is None else f"{best:.6f}"
            found = {True: "yes", False: "no", None: "-"}[report["foundSpaceOptimum"]]
        rows.append(
            f"| {report['engine']} | {report['case']} | {report['mode']} | {report['seed']} | "
            f"{'exact' if report['declared']['exact'] else 'heuristic'} / {'|'.join(report['declared']['termination'])} | "
            f"{report['claimedTermination']} | {report['reevaluatedTermination']} | {report['solutions']} | "
            f"{score_text} | {best_text} | {found} | {'yes' if not report['discrepancies'] else 'NO'} | "
            f"{'yes' if report.get('sameAnswerInBothModes') else 'NO'} |"
        )
    return "\n".join(rows)


def render_cancellation(reports: Sequence[dict[str, Any]]) -> str:
    rows = [
        "| engine | DELETE | after DELETE | busy CPU s/s (process / job thread) | CPU s in 1.5 s after cancel "
        "(process / job thread) | GET after cancel | 2nd DELETE | follow-up job | sync DELETE |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for report in reports:
        job = report["jobAfterCancel"]
        rows.append(
            f"| {report['engine']} | {report['deleteStatus']} {report['deleteBody'].get('status')} "
            f"in {report['deleteSeconds']} s | {'alive' if report['processAlive'] else 'DEAD'} | "
            f"{report['runningCpuSecondsPerSecond']} / {report.get('jobThreadRunningCpuSeconds', 'n/a')} | "
            f"{report['afterCancelProcessCpuSeconds']} / {report.get('afterCancelJobThreadCpuSeconds', 'n/a')} | "
            f"{job['status']}: {job.get('error', '')} | {report['secondDelete'][0]} "
            f"{report['secondDelete'][1].get('status')} | {report['followUpStatus']} | {report['syncDeleteStatus']} |"
        )
    return "\n".join(rows)


def collect(selected: Sequence[str] | None = None, cancellation: bool = True) -> dict[str, Any]:
    port = BimPort()
    small_ir = port.compile(build_package(tasks=5, candidates=3, seed=SEED))
    heavy_ir = port.compile(build_package(tasks=40, candidates=2, seed=7))
    truth_cache: dict[str, SpaceTruth] = {}
    out: dict[str, Any] = {
        "bimCore": port.core_version, "port": port.implementation,
        "irApiVersion": small_ir["apiVersion"], "irKind": small_ir["kind"],
        "spaceSize": 3 ** 5, "cases": [], "cancellation": [], "notRun": [],
    }
    for spec in ENGINE_SPECS:
        if selected and spec.name not in selected:
            continue
        ok, reason = prerequisites(spec)
        if not ok:
            out["notRun"].append({"engine": spec.name, "reason": reason})
            continue
        for case in spec.cases:
            out["cases"].extend(run_case(port, small_ir, truth_cache, spec, case))
            if cancellation:
                out["cancellation"].append(run_cancellation(port, spec, case, heavy_ir, small_ir))
    return out


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--engine", action="append", help="limit to this engine (repeatable)")
    parser.add_argument("--no-cancellation", action="store_true")
    parser.add_argument("--json", type=Path, help="also write the raw report here")
    args = parser.parse_args(argv)
    out = collect(args.engine, not args.no_cancellation)
    print(f"bim_core {out['bimCore']} via {out['port']}; IR {out['irApiVersion']} {out['irKind']}; "
          f"binding space {out['spaceSize']} bindings")
    if out["cases"]:
        print(render_matrix(out["cases"]))
    if out["cancellation"]:
        print()
        print(render_cancellation(out["cancellation"]))
    for item in out["notRun"]:
        print(f"NOT RUN {item['engine']}: {item['reason']}")
    if args.json:
        args.json.write_text(json.dumps(out, indent=2, sort_keys=True), encoding="utf-8")
    bad = [c for c in out["cases"] if c["discrepancies"] or not c["protocolValid"]]
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
