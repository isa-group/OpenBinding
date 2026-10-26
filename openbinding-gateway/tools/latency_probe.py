#!/usr/bin/env python3
"""Lab latency probe for INTENT O9: p95 of ``POST /v1/jobs`` (accept) and ``POST /v1/validate`` on corpus packages.

It talks only HTTP (httpx) to the ``web`` service as a seeded synthetic user, one client, one request at a time. Only
the request itself is timed; the answers that are not the expected success are counted as errors and never enter the
percentiles. ``POST /v1/jobs`` is timed in both accept variants (a snapshot id in JSON, and a multipart ZIP upload).
Every accepted job is cancelled and drained to a terminal state before the next accept (the lab allows 3 concurrent
jobs per account); that part is not timed. The probe never prints the password or a token.

Output: ONE JSON document on stdout (``--markdown`` prints the same table as Markdown).
Exit code: 0 every route meets its target, 1 a target is missed (a measurement, not a defect of the tool) or a job
could not be drained, 2 configuration error, 3 blocked by SPACE (``503 pricing_unavailable``; not a miss).

Environment:
    DEMO_SEED_PASSWORD   required; the password the seed gave every synthetic user.
    SMOKE_BASE_URL       optional; default http://web:8080 (the proxy inside the lab network).

Usage:
    python tools/latency_probe.py [--base-url URL] [--user lab-member] [--samples 40] [--warmup 3]
                                  [--examples top3|all|a,b] [--markdown]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx

DEFAULT_BASE_URL = "http://web:8080"
EXIT_OK, EXIT_MISS, EXIT_CONFIG, EXIT_BLOCKED = 0, 1, 2, 3

BIM_ZIP = "application/vnd.bim+zip"
TERMINAL = frozenset({"completed", "failed", "cancelled"})
PRICING_UNAVAILABLE = "pricing_unavailable"
#: Same job the smoke test launches: random-search needs its mode and the execution-time optimization named.
JOB_BODY = {
    "engine": "random-search", "mode": "seeded",
    "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"}, "options": {"iterations": 10, "seed": 1},
}
TOP = 3
DRAIN_ATTEMPTS, DRAIN_POLL_S = 120, 0.5


class Blocked(Exception):
    """The gateway cannot read the account's entitlements (503 pricing_unavailable); not a measurement."""


class ProbeError(Exception):
    """The probe cannot continue (message is safe to print after redaction)."""


@dataclass
class Config:
    base_url: str = DEFAULT_BASE_URL
    user: str = "lab-member"
    password: str = ""
    samples: int = 40
    warmup: int = 3
    examples: str = "top3"
    jobs_target_ms: float = 500.0
    validate_target_ms: float = 2000.0


def percentile(values: Sequence[float], q: float) -> float:
    """Nearest-rank percentile (``q`` in 0..1); 0.0 for no values (same as process_probe.percentile)."""
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(max(1, math.ceil(q * len(ordered))), len(ordered)) - 1]


def code_of(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return ""
    if not isinstance(body, Mapping):
        return ""
    detail = body.get("detail")
    code = body.get("code") or (detail.get("code") if isinstance(detail, Mapping) else None)
    return code if isinstance(code, str) else ""


class Probe:
    def __init__(self, config: Config, client: httpx.Client, clock: Callable[[], float], sleep: Callable[[float], None]):
        self.config, self.client, self.clock, self.sleep = config, client, clock, sleep
        self.secrets = [config.password]
        self.headers: dict[str, str] = {}
        self.packages_cache: dict[str, bytes] = {}

    def scrub(self, text: object) -> str:
        value = str(text)
        for secret in self.secrets:
            if secret:
                value = value.replace(secret, "***")
        return re.sub(r"(?i)bearer\s+[\w.~+/=-]+|eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}", "***", value)

    def call(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        kwargs.setdefault("timeout", 60.0)
        kwargs["headers"] = {**self.headers, **kwargs.get("headers", {})}
        response = self.client.request(method, f"/api{path}", **kwargs)
        if response.status_code == 503 and code_of(response) == PRICING_UNAVAILABLE:
            raise Blocked(f"503 {PRICING_UNAVAILABLE} on {method} {path}")
        return response

    def login(self) -> None:
        response = self.client.post(
            "/api/v1/auth/login", json={"username_or_email": self.config.user, "password": self.config.password}, timeout=60.0
        )
        try:
            token = response.json().get("access_token")
        except (ValueError, AttributeError):
            token = None
        if response.status_code != 200 or not isinstance(token, str) or not token:
            raise ProbeError(f"login of {self.config.user} failed ({response.status_code})")
        self.secrets.append(token)
        self.headers = {"Authorization": f"Bearer {token}"}

    def gateway_version(self) -> str | None:
        try:
            info = self.client.get("/api/openapi.json", timeout=30.0).json().get("info", {})
            return str(info["version"])
        except (httpx.HTTPError, ValueError, AttributeError, KeyError):
            return None

    def packages(self) -> dict[str, bytes]:
        """The chosen corpus examples (path -> ZIP bytes): the three largest, all, or the named ones."""
        choice = self.config.examples
        if choice in {"top3", "all"}:
            listing = self.call("GET", "/v1/examples")
            names = listing.json().get("examples") if listing.status_code == 200 else None
            if not isinstance(names, list) or not names:
                raise ProbeError(f"GET /v1/examples answered {listing.status_code}")
        else:
            names = [name.strip() for name in choice.split(",") if name.strip()]
        found: dict[str, bytes] = {}
        for name in names:
            response = self.call("GET", f"/v1/examples/{name}")
            if response.status_code != 200 or not response.content:
                raise ProbeError(f"example {name}: {response.status_code}")
            found[str(name)] = response.content
        ranked = sorted(found, key=lambda path: (-len(found[path]), path))
        return {path: found[path] for path in (ranked[:TOP] if choice == "top3" else ranked)}

    def drain(self, job_id: str) -> None:
        """Cancel a job and wait for a terminal state (not timed); bounded, so a stuck job cannot hang the run."""
        self.call("POST", f"/v1/jobs/{job_id}/cancel")
        for _ in range(DRAIN_ATTEMPTS):
            response = self.call("GET", f"/v1/jobs/{job_id}")
            if response.status_code == 200 and response.json().get("status") in TERMINAL:
                return
            self.sleep(DRAIN_POLL_S)
        raise ProbeError(f"job {job_id} did not end after {DRAIN_ATTEMPTS} polls")

    def measure(
        self, request: Callable[[], httpx.Response], expected: int, after: Callable[[httpx.Response], None] | None = None
    ) -> tuple[list[float], dict[str, int]]:
        """Durations in ms of the answers with the expected status, and the other answers by status (warmup excluded)."""
        timings: list[float] = []
        errors: dict[str, int] = {}
        for index in range(self.config.warmup + self.config.samples):
            started = self.clock()
            response = request()
            elapsed_ms = (self.clock() - started) * 1000
            if response.status_code == 503 and code_of(response) == PRICING_UNAVAILABLE:
                raise Blocked(f"503 {PRICING_UNAVAILABLE}")
            ok = response.status_code == expected
            if ok and after is not None:
                after(response)
            if index >= self.config.warmup:
                if ok:
                    timings.append(elapsed_ms)
                else:
                    label = f"{response.status_code} {code_of(response)}".strip()
                    errors[label] = errors.get(label, 0) + 1
        return timings, errors

    def snapshot_id(self, archive: bytes) -> str:
        response = self.call("POST", "/v1/instances", headers={"Content-Type": BIM_ZIP}, content=archive)
        snapshot = response.json().get("id") if response.status_code == 201 else None
        if not isinstance(snapshot, str):
            raise ProbeError(f"snapshot upload: {response.status_code}")
        return snapshot

    def row(
        self, route: str, variant: str, package: str, target: float, outcome: tuple[list[float], dict[str, int]]
    ) -> dict[str, Any]:
        timings, errors = outcome
        p95 = percentile(timings, 0.95)
        return {
            "route": route, "variant": variant, "package": package, "samples": len(timings),
            "errors": sum(errors.values()), "errorAnswers": errors,
            "p50Ms": round(percentile(timings, 0.50), 3), "p95Ms": round(p95, 3), "maxMs": round(max(timings, default=0.0), 3),
            "targetMs": target, "meetsTarget": bool(timings) and p95 <= target,
        }

    def run(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for path, archive in self.packages_cache.items():
            snapshot = self.snapshot_id(archive)

            def accept(response: httpx.Response) -> None:
                job_id = response.json().get("id")
                if isinstance(job_id, str):
                    self.drain(job_id)

            def by_snapshot(snapshot: str = snapshot) -> httpx.Response:
                return self.call("POST", "/v1/jobs", headers={"Idempotency-Key": f"lat-{uuid.uuid4().hex}"},
                                 json={"snapshot": snapshot, **JOB_BODY})

            def by_zip(path: str = path, archive: bytes = archive) -> httpx.Response:
                return self.call("POST", "/v1/jobs", headers={"Idempotency-Key": f"lat-{uuid.uuid4().hex}"},
                                 files={"file": (f"{path.rsplit('/', 1)[-1]}.bim.zip", archive, BIM_ZIP)})

            def validate(archive: bytes = archive) -> httpx.Response:
                return self.call("POST", "/v1/validate", headers={"Content-Type": BIM_ZIP}, content=archive)

            jobs, check = "POST /v1/jobs", "POST /v1/validate"
            rows.append(self.row(jobs, "snapshot", path, self.config.jobs_target_ms, self.measure(by_snapshot, 202, accept)))
            rows.append(self.row(jobs, "zip", path, self.config.jobs_target_ms, self.measure(by_zip, 202, accept)))
            rows.append(self.row(check, "package", path, self.config.validate_target_ms, self.measure(validate, 200)))
        return rows


def run_probe(
    config: Config,
    client: httpx.Client,
    *,
    clock: Callable[[], float] = time.perf_counter,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[dict[str, Any], int]:
    """The report and the exit code of one run. ``clock`` is read twice per timed request and nowhere else."""
    probe = Probe(config, client, clock, sleep)
    report: dict[str, Any] = {
        "tool": "latency_probe", "ok": False, "measuredAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "baseUrl": config.base_url, "gatewayVersion": None,
        "config": {
            "user": config.user, "samples": config.samples, "warmup": config.warmup, "examples": config.examples,
            "jobsTargetMs": config.jobs_target_ms, "validateTargetMs": config.validate_target_ms,
        },
        "packages": [], "routes": [],
    }
    code = EXIT_MISS
    try:
        probe.login()
        report["gatewayVersion"] = probe.gateway_version()
        probe.packages_cache = probe.packages()
        report["packages"] = [{"path": path, "bytes": len(data)} for path, data in probe.packages_cache.items()]
        report["routes"] = probe.run()
        report["ok"] = all(row["meetsTarget"] for row in report["routes"])
        code = EXIT_OK if report["ok"] else EXIT_MISS
    except Blocked as error:
        report["blocked"], code = probe.scrub(error), EXIT_BLOCKED
    except (ProbeError, httpx.HTTPError) as error:
        report["error"] = probe.scrub(f"{type(error).__name__}: {error}")
        code = EXIT_CONFIG if not report["packages"] else EXIT_MISS
    return report, code


def markdown(report: Mapping[str, Any]) -> str:
    lines = [
        f"# Latency probe (INTENT O9), {report['measuredAt']}", "",
        f"Base URL `{report['baseUrl']}`, gateway {report['gatewayVersion'] or 'unknown'}, "
        f"{report['config']['samples']} samples after {report['config']['warmup']} warmup, one client, sequential.", "",
        "Packages: " + (", ".join(f"`{p['path']}` ({p['bytes']} B)" for p in report["packages"]) or "none"), "",
        "| route | variant | package | samples | errors | p50 ms | p95 ms | max ms | target ms | meets |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for row in report["routes"]:
        errors = f" ({', '.join(f'{label} x{count}' for label, count in row['errorAnswers'].items())})" if row["errors"] else ""
        lines.append(
            f"| {row['route']} | {row['variant']} | {row['package']} | {row['samples']} | {row['errors']}{errors} | {row['p50Ms']} "
            f"| {row['p95Ms']} | {row['maxMs']} | {row['targetMs']} | {'yes' if row['meetsTarget'] else 'NO'} |"
        )
    for key in ("blocked", "error"):
        if key in report:
            lines += ["", f"**{key}**: {report[key]}"]
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Lab latency probe of POST /v1/jobs and POST /v1/validate (INTENT O9).")
    parser.add_argument("--base-url", default=None, help=f"proxy origin (default $SMOKE_BASE_URL or {DEFAULT_BASE_URL})")
    parser.add_argument("--user", default="lab-member", help="seeded user to sign in as")
    parser.add_argument("--samples", type=int, default=40, help="timed requests per route and package")
    parser.add_argument("--warmup", type=int, default=3, help="untimed requests before the samples")
    parser.add_argument("--examples", default="top3", help="top3 (the 3 largest packages), all, or comma-separated example paths")
    parser.add_argument("--jobs-target-ms", type=float, default=500.0, help="p95 target of POST /v1/jobs")
    parser.add_argument("--validate-target-ms", type=float, default=2000.0, help="p95 target of POST /v1/validate")
    parser.add_argument("--markdown", action="store_true", help="print a Markdown report instead of JSON")
    return parser


def main(
    argv: Sequence[str] | None = None,
    environ: Mapping[str, str] | None = None,
    *,
    transport: httpx.BaseTransport | None = None,
    clock: Callable[[], float] = time.perf_counter,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    args = build_parser().parse_args(argv)
    source = os.environ if environ is None else environ
    password = source.get("DEMO_SEED_PASSWORD", "")
    base_url = (args.base_url or source.get("SMOKE_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    if not password or args.samples < 1 or args.warmup < 0:
        print(json.dumps({"tool": "latency_probe", "ok": False, "error": "DEMO_SEED_PASSWORD and samples >= 1 are required"}))
        return EXIT_CONFIG
    config = Config(
        base_url=base_url, user=args.user, password=password, samples=args.samples, warmup=args.warmup,
        examples=args.examples, jobs_target_ms=args.jobs_target_ms, validate_target_ms=args.validate_target_ms,
    )
    with httpx.Client(base_url=base_url, transport=transport, follow_redirects=False) as client:
        report, code = run_probe(config, client, clock=clock, sleep=sleep)
    print(markdown(report) if args.markdown else json.dumps(report, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
