#!/usr/bin/env python3
"""Run the resumable three-engine QACOBench campaign through the v1 gateway."""

from __future__ import annotations

import argparse
from collections import Counter
import asyncio
import hashlib
import json
import os
import random
import shutil
import time
from pathlib import Path
from typing import Any

import httpx

from _common import (
    ACTIVE_SUITES,
    DEFAULT_ENGINES,
    ENGINE_MODES,
    EXPECTED_SUITE_COUNTS,
    HEURISTIC_ENGINES,
    discover_project_root,
    install_gateway_import,
    package_execution_spec,
    package_digest_from_dir,
    stable_instance_seed,
)

ROOT = discover_project_root(Path(__file__))
install_gateway_import(ROOT)

from bim_core import digest as manifest_digest  # noqa: E402
from bim_core import load_package  # noqa: E402

MAX_TIMEOUT_MS = 5_000
MANIFEST_DIR = Path(os.environ.get("SCHEMAS_DIR", ROOT / "schemas")) / "bim" / "v1" / "manifests"


def expected_engine_digests(engines: tuple[str, ...]) -> dict[str, str | None]:
    """Digest of each engine manifest in this checkout (None when the manifest is unavailable)."""
    result: dict[str, str | None] = {}
    for engine in engines:
        path = MANIFEST_DIR / f"{engine}.json"
        try:
            result[engine] = manifest_digest(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            result[engine] = None
    return result


def termination_reason(engine: str, status: str, provenance: dict[str, Any], timeout_ms: int) -> str:
    """Why the engine stopped: a proof, the evaluation budget, the time budget or an incompatibility."""
    if status in {"INCOMPATIBLE", "ERROR"}:
        return status.lower()
    if engine == "minizinc-csp":
        return "proof" if status in {"OPTIMAL", "UNSAT"} else "time_budget"
    options = provenance.get("options") or {}
    reported = provenance.get("engineReported") or {}
    budget = options.get("iterations", options.get("max_evaluations"))
    evaluations = reported.get("evaluations")
    elapsed = reported.get("elapsed_ms")
    if isinstance(budget, (int, float)) and isinstance(evaluations, (int, float)) and evaluations >= budget:
        return "evaluation_budget"
    if isinstance(elapsed, (int, float)) and elapsed >= 0.95 * timeout_ms:
        return "time_budget"
    return "engine_stop"


def _packages(root: Path, suite_filter: str | None, explicit: list[Path]) -> list[Path]:
    if explicit:
        result = [(item if item.is_absolute() else root / item).resolve() for item in explicit]
        for item in result:
            if not (item / "instance.json").is_file():
                raise FileNotFoundError(f"not a BIM package: {item}")
        return result
    suites = [suite_filter] if suite_filter else ["07_qfbs", *ACTIVE_SUITES[:-1]]
    result = []
    for suite in suites:
        if suite not in ACTIVE_SUITES:
            raise ValueError(f"inactive suite: {suite}")
        for directory, children, files in os.walk(root / suite):
            children[:] = [child for child in children if not child.startswith(".") and child != "__pycache__"]
            if "instance.json" in files and "optimization.json" in files:
                result.append(Path(directory))
                children[:] = []
    priority = {suite: index for index, suite in enumerate(suites)}
    return sorted(result, key=lambda path: (priority[path.relative_to(root).parts[0]], path.relative_to(root).as_posix()))


def _resume_key(record: dict[str, Any]) -> tuple[str, str, str, int, int, str]:
    return (
        str(record.get("suite", "")),
        str(record.get("instance_id", "")),
        str(record.get("engine", "")),
        int(record.get("timeout_ms", 0)),
        int(record.get("seed", 0)),
        str(record.get("package_digest", "")),
    )


def _normalized_result(data: dict[str, Any], wall_ms: float) -> dict[str, Any]:
    result = data.get("result") or {}
    # Classified by the job's failure code. Until the gateway emits `engine_incompatible`, capability refusals
    # carry `engine_rejected` and are recorded ERROR (which stops the campaign like any unclassified error).
    failed = data.get("status") == "failed"
    incompatible = failed and result.get("code") == "engine_incompatible"
    if failed:
        error = result.get("error") or data.get("error") or "gateway job failed"
        status = "INCOMPATIBLE" if incompatible else "ERROR"
        return {"status": status, "runtime_ms": 0.0, "wall_ms": round(wall_ms, 3), "overhead_ms": round(wall_ms, 3), "binding": None, "features": None, "objectives": {}, "quality": None, "violations": [], "provenance": {}, "trace": [], "trace_kind": None, "engine_evaluations": None, "error": error, "diagnostics": [{"code": "engine_incompatible", "message": error}] if incompatible else []}
    termination = str(result.get("termination") or "UNKNOWN").upper()
    status = {
        "INFEASIBLE": "UNSAT",
        "UNSATISFIABLE": "UNSAT",
        "TIMED_OUT": "TIMEOUT",
        "UNKNOWN": "TIMEOUT",
    }.get(termination, termination if termination in {"OPTIMAL", "FEASIBLE", "UNSAT", "TIMEOUT"} else "ERROR")
    error = result.get("error") or data.get("error")
    if error:
        status = "ERROR"
    solutions = result.get("solutions") or []
    solution = solutions[0] if solutions else {}
    provenance = result.get("provenance") or {}
    engine_reported = provenance.get("engineReported") or {}
    runtime = engine_reported.get("elapsed_ms")
    runtime_ms = float(runtime) if isinstance(runtime, (int, float)) else wall_ms
    objectives = solution.get("objectives") or {}
    score = objectives.get("score") if isinstance(objectives, dict) else None
    return {
        "status": status,
        "termination": termination,
        "runtime_ms": round(runtime_ms, 3),
        "wall_ms": round(wall_ms, 3),
        "overhead_ms": round(max(0.0, wall_ms - runtime_ms), 3),
        "binding": (solution.get("decision") or {}).get("binding"),
        "features": solution.get("features", solution.get("metrics")),
        "objectives": objectives,
        "quality": float(score) if isinstance(score, (int, float)) else None,
        "violations": solution.get("violations") or [],
        "provenance": provenance,
        "engine_options": provenance.get("options") or {},
        "engine_digest": (provenance.get("engine") or {}).get("digest"),
        "trace": engine_reported.get("trace") or [],
        "trace_kind": engine_reported.get("trace_kind"),
        "engine_evaluations": engine_reported.get("evaluations"),
        "error": result.get("error") or data.get("error"),
    }


class Gateway:
    def __init__(self, url: str, username: str, password: str, expected_digests: dict[str, str | None]):
        self.url = url.rstrip("/")
        self.username = username
        self.password = password
        self.headers: dict[str, str] = {}
        self.expected_digests = expected_digests

    async def connect(self, client: httpx.AsyncClient) -> None:
        health = await client.get(f"{self.url}/health", timeout=5)
        health.raise_for_status()
        login = await client.post(
            f"{self.url}/v1/auth/login",
            json={"username_or_email": self.username, "password": self.password},
            timeout=10,
        )
        if login.status_code != 200 or not login.json().get("access_token"):
            raise RuntimeError(f"gateway authentication failed: HTTP {login.status_code} {login.text[:200]}")
        self.headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    async def prepare(self, client: httpx.AsyncClient, archive: bytes) -> tuple[str, dict[str, Any]]:
        snapshot = await client.post(
            f"{self.url}/v1/instances",
            content=archive,
            headers={**self.headers, "Content-Type": "application/vnd.bim+zip"},
            timeout=180,
        )
        if snapshot.status_code == 401:
            await self.connect(client)
            snapshot = await client.post(
                f"{self.url}/v1/instances",
                content=archive,
                headers={**self.headers, "Content-Type": "application/vnd.bim+zip"},
                timeout=180,
            )
        if snapshot.status_code not in (200, 201):
            raise RuntimeError(f"snapshot rejected: HTTP {snapshot.status_code} {snapshot.text[:300]}")
        snapshot_id = snapshot.json()["id"]
        validation = await client.post(
            f"{self.url}/v1/validate",
            json={"snapshot": snapshot_id},
            headers=self.headers,
            timeout=600,
        )
        if validation.status_code == 401:
            await self.connect(client)
            validation = await client.post(
                f"{self.url}/v1/validate",
                json={"snapshot": snapshot_id},
                headers=self.headers,
                timeout=600,
            )
        if validation.status_code != 200:
            raise RuntimeError(f"validation rejected: HTTP {validation.status_code} {validation.text[:300]}")
        return snapshot_id, validation.json()

    def select_mode(self, compatible_modes: list[dict[str, Any]], engine: str) -> dict[str, Any] | None:
        """Pick the installed mode for `engine`; it must be the revision described by this checkout's manifest.

        A gateway database that outlives a manifest change keeps the previous EngineRevision
        registered; running the campaign against it would silently negotiate stale capabilities.
        """
        mode = ENGINE_MODES[engine]
        entries = [item for item in compatible_modes if item.get("engine", {}).get("name") == engine and item.get("mode") == mode]
        expected = self.expected_digests.get(engine)
        if expected is None:
            return entries[0] if entries else None
        matching = [item for item in entries if item.get("engine", {}).get("digest") == expected]
        if matching:
            return matching[0]
        if entries:
            installed = sorted({str(item.get("engine", {}).get("version")) + "@" + str(item.get("engine", {}).get("digest"))[:19] for item in entries})
            raise RuntimeError(
                f"engine {engine!r} is registered as {installed} but this checkout's manifest has digest "
                f"{expected[:19]}...: the gateway registry is stale. Run `run.sh reset` (drops the Compose volumes) "
                "and `run.sh build` before the campaign."
            )
        return None

    async def solve(
        self,
        client: httpx.AsyncClient,
        snapshot_id: str,
        compatible_modes: list[dict[str, Any]],
        engine: str,
        timeout_ms: int,
        seed: int,
        idempotency_key: str,
        optimization: dict[str, Any],
    ) -> dict[str, Any]:
        mode = ENGINE_MODES[engine]
        selected = self.select_mode(compatible_modes, engine)
        if selected is None or not selected.get("compatible"):
            return {
                "status": "INCOMPATIBLE",
                "runtime_ms": 0.0,
                "wall_ms": 0.0,
                "overhead_ms": 0.0,
                "engine_ref": selected.get("engine") if selected else None,
                "registration_ref": selected.get("registration") if selected else None,
                "mode": mode,
                "diagnostics": selected.get("diagnostics", []) if selected else [{"message": "engine/mode not installed"}],
                "trace": [],
            }
        options: dict[str, Any] = {"time_budget_ms": timeout_ms}
        if engine in HEURISTIC_ENGINES:
            options["seed"] = seed
        payload = {
            "snapshot": snapshot_id,
            "engine": selected["engine"],
            "registration": selected["registration"],
            "mode": mode,
            "options": options,
            "optimization": optimization,
        }
        started = time.monotonic()
        for attempt in range(3):
            try:
                response = await client.post(
                    f"{self.url}/v1/jobs",
                    json=payload,
                    headers={**self.headers, "Idempotency-Key": idempotency_key},
                    timeout=180,
                )
            except httpx.TransportError:
                if attempt == 2:
                    raise
                await asyncio.sleep(0.5 * 2**attempt)
                continue
            if response.status_code == 401 and attempt < 2:
                await self.connect(client)
                continue
            break
        if response.status_code not in (200, 201, 202):
            if response.status_code == 429 or response.status_code >= 500:
                raise RuntimeError(f"gateway job submission failed: HTTP {response.status_code} {response.text[:500]}")
            status = "ERROR"
            diagnostics: list[dict[str, Any]] = []
            try:
                body = response.json()
                if isinstance(body, dict):
                    # RFC 7807 problem document: `code` and `diagnostics` at the top level, `detail` a sentence.
                    # A `detail` object (older shape) is read as a fallback.
                    code = body.get("code")
                    detail = body.get("detail")
                    message = None
                    listed = body.get("diagnostics")
                    if isinstance(detail, dict):
                        code = code or detail.get("code")
                        message = detail.get("message")
                        if not isinstance(listed, list):
                            listed = detail.get("diagnostics")
                    elif isinstance(detail, str):
                        message = detail
                    if response.status_code == 422 and code == "engine_mode_incompatible":
                        status = "INCOMPATIBLE"
                    if isinstance(listed, list) and listed:
                        diagnostics = list(listed)
                    elif message:
                        diagnostics = [{"code": code, "message": message}]
            except ValueError:
                pass
            return {"status": status, "runtime_ms": 0.0, "wall_ms": 0.0, "overhead_ms": 0.0, "mode": mode, "engine_ref": selected["engine"], "registration_ref": selected["registration"], "error": response.text[:500], "diagnostics": diagnostics, "trace": []}
        job_id = response.json()["id"]
        deadline = time.monotonic() + timeout_ms / 1000 + 30
        while time.monotonic() < deadline:
            try:
                poll = await client.get(f"{self.url}/v1/jobs/{job_id}", headers=self.headers, timeout=15)
            except httpx.TransportError:
                await asyncio.sleep(0.5)
                continue
            if poll.status_code == 401:
                await self.connect(client)
                continue
            if poll.status_code == 200:
                data = poll.json()
                if data.get("status") in {"completed", "failed"}:
                    result = _normalized_result(data, (time.monotonic() - started) * 1000)
                    return {**result, "job_id": job_id, "mode": mode, "engine_ref": selected["engine"], "registration_ref": selected["registration"]}
            await asyncio.sleep(0.1)
        raise RuntimeError(f"gateway polling deadline exceeded for job {job_id}")


def _load_completed(out: Path, redo_engines: set[str]) -> tuple[set[tuple], int]:
    """Return the resume keys already recorded, rewriting the file without the engines to redo."""
    completed: set[tuple] = set()
    dropped = 0
    if not out.exists():
        return completed, dropped
    lines = out.read_text(encoding="utf-8").splitlines()
    if redo_engines:
        backup = out.with_name(f"{out.name}.bak-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}")
        shutil.copyfile(out, backup)
        kept: list[str] = []
        for line in lines:
            try:
                record = json.loads(line)
            except (ValueError, json.JSONDecodeError):
                kept.append(line)
                continue
            if record.get("engine") in redo_engines:
                dropped += 1
                continue
            kept.append(line)
        out.write_text("".join(f"{line}\n" for line in kept), encoding="utf-8")
        lines = kept
        print(f"redo: dropped {dropped} records of {sorted(redo_engines)} (backup: {backup.name})", flush=True)
    for line in lines:
        try:
            record = json.loads(line)
            if record.get("status") != "ERROR":
                completed.add(_resume_key(record))
        except (ValueError, json.JSONDecodeError):
            continue
    return completed, dropped


async def run(args: argparse.Namespace) -> int:
    if not 1 <= args.timeout_ms <= MAX_TIMEOUT_MS:
        raise SystemExit(f"--timeout-ms must be between 1 and {MAX_TIMEOUT_MS}")
    engines = tuple(item.strip() for item in args.engines.split(",") if item.strip())
    unknown = set(engines) - set(DEFAULT_ENGINES)
    if unknown:
        raise SystemExit(f"unsupported campaign engines: {sorted(unknown)}")
    redo_engines = {item.strip() for item in (args.redo_engine or []) if item.strip()}
    if redo_engines - set(engines):
        raise SystemExit(f"--redo-engine names engines outside --engines: {sorted(redo_engines - set(engines))}")
    if args.repeats < 1 or args.concurrency < 1:
        raise SystemExit("--repeats and --concurrency must be positive")
    packages = _packages(args.instances_dir, args.suite, args.package)
    if args.source_only:
        if args.suite or args.package:
            raise SystemExit("--source-only cannot be combined with --suite or --package")
        packages = [package for package in packages if package.relative_to(args.instances_dir).parts[0] != "07_qfbs"]
    if not args.all and not args.package and not args.source_only:
        rng = random.Random(args.seed)
        packages = sorted(rng.sample(packages, min(args.sample, len(packages))))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    full_campaign = args.all and not args.suite and not args.package and not args.source_only and args.repeats == 1
    if full_campaign:
        expected_packages = sum(EXPECTED_SUITE_COUNTS.values())
        counts = Counter(package.relative_to(args.instances_dir).parts[0] for package in packages)
        if counts != EXPECTED_SUITE_COUNTS:
            raise RuntimeError(f"campaign corpus counts do not match the design: {dict(counts)}; expected {EXPECTED_SUITE_COUNTS}")
        del expected_packages
    marker = args.out.with_name("CAMPAIGN_DONE")
    if full_campaign:
        marker.unlink(missing_ok=True)
    if args.fresh and args.out.exists():
        args.out.unlink()
    completed, _dropped = _load_completed(args.out, redo_engines)
    gateway = Gateway(args.gateway_url, args.username, args.password, expected_engine_digests(engines))
    current_completed = 0
    write_lock = asyncio.Lock()
    semaphore = asyncio.Semaphore(args.concurrency)
    progress = {"done": 0}

    async with httpx.AsyncClient(limits=httpx.Limits(max_connections=8 * args.concurrency)) as client:
        await gateway.connect(client)
        output = args.out.open("a", encoding="utf-8")

        async def process(position: int, package_dir: Path) -> int:
            nonlocal current_completed
            relative = package_dir.relative_to(args.instances_dir).as_posix()
            suite, instance_id = relative.split("/", 1)
            package_digest = package_digest_from_dir(package_dir)
            metadata = []
            for engine in engines:
                for repeat in range(args.repeats):
                    seed = stable_instance_seed(args.seed, suite, instance_id, engine)
                    if repeat:
                        if engine not in HEURISTIC_ENGINES:
                            continue
                        seed = stable_instance_seed(args.seed + repeat, suite, instance_id, engine)
                    key = (suite, instance_id, engine, args.timeout_ms, seed, package_digest)
                    if key in completed:
                        current_completed += 1
                        continue
                    metadata.append((engine, seed, repeat, key))
            if not metadata:
                progress["done"] += 1
                print(f"[{progress['done']}/{len(packages)}] {relative}: 0 new runs", flush=True)
                return 0
            async with semaphore:
                package = load_package(package_dir)
                execution_optimization = package_execution_spec(package)
                snapshot_id, validation = await gateway.prepare(client, package.to_zip())
                pending = []
                for engine, seed, repeat, key in metadata:
                    idem = hashlib.sha256("\0".join(map(str, key)).encode()).hexdigest()
                    pending.append(gateway.solve(client, snapshot_id, validation.get("compatibleModes", []), engine, args.timeout_ms, seed, f"qacobench-{idem}", execution_optimization))
                if args.serial_engines:
                    results = []
                    for request in pending:
                        results.append(await request)
                else:
                    results = await asyncio.gather(*pending)
            async with write_lock:
                for (engine, seed, repeat, key), result in zip(metadata, results):
                    if result.get("status") == "ERROR":
                        raise RuntimeError(f"engine or gateway error at {relative}/{engine}: {result.get('error')}")
                    record = {
                        "schema": "qacobench/run/v1",
                        "suite": suite,
                        "instance_id": instance_id,
                        "package_path": relative,
                        "package_digest": package_digest,
                        "engine": engine,
                        "timeout_ms": args.timeout_ms,
                        "seed": seed,
                        "repeat": repeat,
                        **result,
                    }
                    record["termination_reason"] = termination_reason(engine, record.get("status", "ERROR"), record.get("provenance") or {}, args.timeout_ms)
                    output.write(json.dumps(record, sort_keys=True) + "\n")
                    output.flush()
                    os.fsync(output.fileno())
                    completed.add(key)
                    current_completed += 1
                progress["done"] += 1
                print(f"[{progress['done']}/{len(packages)}] {relative}: {len(results)} new runs", flush=True)
            return len(results)

        try:
            if args.concurrency == 1:
                for position, package_dir in enumerate(packages, start=1):
                    await process(position, package_dir)
            else:
                await asyncio.gather(*(process(position, package_dir) for position, package_dir in enumerate(packages, start=1)))
        finally:
            output.close()
    if full_campaign:
        expected = len(packages) * len(engines)
        if current_completed != expected:
            raise RuntimeError(f"campaign incomplete: {current_completed}/{expected} unique runs")
        marker.write_text(f"{current_completed}\n", encoding="utf-8")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--instances-dir", type=Path, default=ROOT / "datasets")
    parser.add_argument("--gateway-url", default=os.environ.get("OPENBINDING_GATEWAY_URL", "http://localhost:8000"))
    parser.add_argument("--username", default=os.environ.get("OPENBINDING_USERNAME", "admin"))
    parser.add_argument("--password", default=os.environ.get("OPENBINDING_PASSWORD", "devpass123"))
    parser.add_argument("--engines", default=",".join(DEFAULT_ENGINES))
    parser.add_argument("--timeout-ms", type=int, default=5_000)
    parser.add_argument("--seed", type=int, default=20260921)
    parser.add_argument("--suite", choices=ACTIVE_SUITES)
    parser.add_argument("--package", type=Path, action="append", default=[])
    parser.add_argument("--sample", type=int, default=10)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--source-only", action="store_true", help="Run all six source suites while QFBS is generating")
    parser.add_argument("--fresh", action="store_true")
    parser.add_argument(
        "--redo-engine",
        action="append",
        default=[],
        help="drop the recorded runs of this engine (a backup of the results file is kept) and run it again; repeatable",
    )
    parser.add_argument(
        "--repeats",
        type=int,
        default=1,
        help="number of heuristic repetitions per instance with distinct seeds (repeat k uses base seed + k); 1 = reference campaign",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=1,
        help="packages in flight at once (each still runs its engines in parallel); >1 speeds the campaign up but adds CPU contention to runtime measurements",
    )
    parser.add_argument(
        "--serial-engines",
        action="store_true",
        help="dispatch one engine job at a time for single-concurrency gateway plans",
    )
    parser.add_argument("--out", type=Path, default=ROOT / ".artifacts/qacobench/results.jsonl")
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
