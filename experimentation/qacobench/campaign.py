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

from openbinding_gateway.v1.package import load_package  # noqa: E402

MAX_TIMEOUT_MS = 5_000


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
    if data.get("status") == "failed" and not result:
        return {"status": "ERROR", "runtime_ms": 0.0, "wall_ms": round(wall_ms, 3), "overhead_ms": round(wall_ms, 3), "binding": None, "features": None, "objectives": {}, "quality": None, "violations": [], "provenance": {}, "trace": [], "trace_kind": None, "engine_evaluations": None, "error": data.get("error") or "gateway job failed"}
    termination = str(result.get("termination") or "UNKNOWN").upper()
    status = {
        "INFEASIBLE": "UNSAT",
        "UNSATISFIABLE": "UNSAT",
        "TIMED_OUT": "TIMEOUT",
        "UNKNOWN": "TIMEOUT",
    }.get(termination, termination if termination in {"OPTIMAL", "FEASIBLE", "UNSAT", "TIMEOUT"} else "ERROR")
    error = result.get("error") or data.get("error")
    if isinstance(error, str) and error.startswith("engine rejected BindingProblem (422)"):
        status = "INCOMPATIBLE"
    elif error:
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
        "trace": engine_reported.get("trace") or [],
        "trace_kind": engine_reported.get("trace_kind"),
        "engine_evaluations": engine_reported.get("evaluations"),
        "error": result.get("error") or data.get("error"),
    }


class Gateway:
    def __init__(self, url: str, username: str, password: str):
        self.url = url.rstrip("/")
        self.username = username
        self.password = password
        self.headers: dict[str, str] = {}

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
        selected = next((item for item in compatible_modes if item.get("engine", {}).get("name") == engine and item.get("mode") == mode), None)
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
            status = "INCOMPATIBLE" if response.status_code == 422 else "ERROR"
            return {"status": status, "runtime_ms": 0.0, "wall_ms": 0.0, "overhead_ms": 0.0, "mode": mode, "engine_ref": selected["engine"], "registration_ref": selected["registration"], "error": response.text[:500], "trace": []}
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


async def run(args: argparse.Namespace) -> int:
    if not 1 <= args.timeout_ms <= MAX_TIMEOUT_MS:
        raise SystemExit(f"--timeout-ms must be between 1 and {MAX_TIMEOUT_MS}")
    engines = tuple(item.strip() for item in args.engines.split(",") if item.strip())
    unknown = set(engines) - set(DEFAULT_ENGINES)
    if unknown:
        raise SystemExit(f"unsupported campaign engines: {sorted(unknown)}")
    packages = _packages(args.instances_dir, args.suite, args.package)
    if args.source_only:
        if args.suite or args.package:
            raise SystemExit("--source-only cannot be combined with --suite or --package")
        packages = [package for package in packages if package.relative_to(args.instances_dir).parts[0] != "07_qfbs"]
    if not args.all and not args.package and not args.source_only:
        rng = random.Random(args.seed)
        packages = sorted(rng.sample(packages, min(args.sample, len(packages))))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    full_campaign = args.all and not args.suite and not args.package and not args.source_only
    if full_campaign:
        expected_packages = sum(EXPECTED_SUITE_COUNTS.values())
        counts = Counter(package.relative_to(args.instances_dir).parts[0] for package in packages)
        if counts != EXPECTED_SUITE_COUNTS:
            raise RuntimeError(f"campaign corpus counts do not match the design: {dict(counts)}; expected {EXPECTED_SUITE_COUNTS}")
    marker = args.out.with_name("CAMPAIGN_DONE")
    if full_campaign:
        marker.unlink(missing_ok=True)
    if args.fresh and args.out.exists():
        args.out.unlink()
    completed = set()
    if args.out.exists():
        for line in args.out.read_text(encoding="utf-8").splitlines():
            try:
                record = json.loads(line)
                if record.get("status") != "ERROR":
                    completed.add(_resume_key(record))
            except (ValueError, json.JSONDecodeError):
                continue
    gateway = Gateway(args.gateway_url, args.username, args.password)
    current_completed = 0
    async with httpx.AsyncClient(limits=httpx.Limits(max_connections=8)) as client:
        await gateway.connect(client)
        with args.out.open("a", encoding="utf-8") as output:
            for position, package_dir in enumerate(packages, start=1):
                relative = package_dir.relative_to(args.instances_dir).as_posix()
                suite, instance_id = relative.split("/", 1)
                package_digest = package_digest_from_dir(package_dir)
                metadata = []
                for engine in engines:
                    seed = stable_instance_seed(args.seed, suite, instance_id, engine)
                    key = (suite, instance_id, engine, args.timeout_ms, seed, package_digest)
                    if key in completed:
                        current_completed += 1
                        continue
                    metadata.append((engine, seed, key))
                if not metadata:
                    print(f"[{position}/{len(packages)}] {relative}: 0 new runs", flush=True)
                    continue
                package = load_package(package_dir)
                execution_optimization = package_execution_spec(package)
                snapshot_id, validation = await gateway.prepare(client, package.to_zip())
                pending = []
                for engine, seed, key in metadata:
                    idem = hashlib.sha256("\0".join(map(str, key)).encode()).hexdigest()
                    pending.append(gateway.solve(client, snapshot_id, validation.get("compatibleModes", []), engine, args.timeout_ms, seed, f"qacobench-{idem}", execution_optimization))
                if args.serial_engines:
                    results = []
                    for request in pending:
                        results.append(await request)
                else:
                    results = await asyncio.gather(*pending)
                for (engine, seed, key), result in zip(metadata, results):
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
                        **result,
                    }
                    output.write(json.dumps(record, sort_keys=True) + "\n")
                    output.flush()
                    os.fsync(output.fileno())
                    completed.add(key)
                    current_completed += 1
                print(f"[{position}/{len(packages)}] {relative}: {len(results)} new runs", flush=True)
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
        "--serial-engines",
        action="store_true",
        help="dispatch one engine job at a time for single-concurrency gateway plans",
    )
    parser.add_argument("--out", type=Path, default=ROOT / ".artifacts/qacobench/results.jsonl")
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
