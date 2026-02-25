#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_INSTANCES_DIR = ROOT_DIR / "experimentation" / "instances"
DEFAULT_REPORTS_DIR = ROOT_DIR / "experimentation" / "reports"

EXPECTED_BEHAVIOR_VALUES = {
    "FEASIBLE",
    "INFEASIBLE",
    "UNKNOWN",
    "ANY_COMPLETED",
    "VALIDATION_ERROR",
}


@dataclass
class InstanceMeta:
    path: Path
    objective_type: str
    all_constraints_hard: bool
    has_soft_constraints: bool
    category: str
    expected_by_engine: Dict[str, str] = field(default_factory=dict)


@dataclass
class CaseResult:
    instance: str
    engine_id: str
    category: str
    objective_type: str
    all_constraints_hard: bool
    expected_to_solve: bool
    expected_behavior: str
    passed_expectation: bool
    outcome: str
    status_code: Optional[int] = None
    job_id: Optional[str] = None
    poll_count: int = 0
    elapsed_seconds: float = 0.0
    reason: str = ""
    feasibility: Optional[str] = None
    violation_codes: List[str] = field(default_factory=list)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run all experimentation instances against active gateway solvers using "
            "POST /v1/solve (async) and validate routing expectations."
        )
    )
    parser.add_argument(
        "--base-url",
        default="http://localhost:8000",
        help="Gateway base URL (default: http://localhost:8000)",
    )
    parser.add_argument(
        "--instances-dir",
        default=str(DEFAULT_INSTANCES_DIR),
        help=f"Directory with instance JSON files (default: {DEFAULT_INSTANCES_DIR})",
    )
    parser.add_argument(
        "--solve-timeout",
        type=int,
        default=900,
        help="Read timeout in seconds for /v1/solve request (default: 900)",
    )
    parser.add_argument(
        "--max-poll-seconds",
        type=int,
        default=10800,
        help="Maximum total polling time in seconds per job (default: 10800)",
    )
    parser.add_argument(
        "--poll-response-timeout",
        type=int,
        default=30,
        help="Read timeout in seconds for each /v1/jobs/{job_id} poll (default: 30)",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=2.0,
        help="Polling interval in seconds (default: 2.0)",
    )
    parser.add_argument(
        "--connect-timeout",
        type=float,
        default=10.0,
        help="HTTP connect timeout in seconds for all requests (default: 10)",
    )
    parser.add_argument(
        "--engines",
        default="",
        help="Optional comma-separated list of engine IDs to test instead of active engines",
    )
    parser.add_argument(
        "--reports-dir",
        default=str(DEFAULT_REPORTS_DIR),
        help=f"Directory where JSON/Markdown reports will be written (default: {DEFAULT_REPORTS_DIR})",
    )
    parser.add_argument(
        "--max-cases",
        type=int,
        default=0,
        help="Optional limit of total instance×engine runs (0 means all)",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable ANSI color output",
    )
    return parser.parse_args()


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_instances(instances_dir: Path) -> List[InstanceMeta]:
    if not instances_dir.exists() or not instances_dir.is_dir():
        raise FileNotFoundError(f"Instances directory not found: {instances_dir}")

    files = sorted(instances_dir.glob("*.json"))
    if not files:
        raise RuntimeError(f"No JSON files found in {instances_dir}")

    instances: List[InstanceMeta] = []
    for path in files:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)

        objective = str(payload.get("objective", {}).get("type", "")).upper()
        constraints = payload.get("constraints", []) or []
        expected_by_engine = _extract_expected_by_engine(payload)
        has_soft_constraints = any(
            c.get("hard", True) is False
            for c in constraints
            if isinstance(c, dict)
        )
        all_constraints_hard = not has_soft_constraints

        if objective == "MANY":
            category = "many"
        elif objective == "MONO" and all_constraints_hard:
            category = "mono_hard"
        elif objective == "MONO":
            category = "mono_soft"
        elif objective == "MULTI":
            category = "multi"
        else:
            category = "other"

        instances.append(
            InstanceMeta(
                path=path,
                objective_type=objective,
                all_constraints_hard=all_constraints_hard,
                has_soft_constraints=has_soft_constraints,
                category=category,
                expected_by_engine=expected_by_engine,
            )
        )

    return instances


def _normalize_expected_behavior(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    normalized = value.strip().upper()
    if normalized in EXPECTED_BEHAVIOR_VALUES:
        return normalized
    return ""


def _extract_expected_by_engine(payload: Dict[str, Any]) -> Dict[str, str]:
    metadata = payload.get("metadata")
    if not isinstance(metadata, dict):
        return {}

    experiments = metadata.get("experiments")
    if not isinstance(experiments, dict):
        return {}

    raw = experiments.get("expected_feasibility_by_engine")
    if not isinstance(raw, dict):
        return {}

    out: Dict[str, str] = {}
    for engine_id, behavior in raw.items():
        if not isinstance(engine_id, str) or not engine_id.strip():
            continue
        normalized = _normalize_expected_behavior(behavior)
        if normalized:
            out[engine_id.strip()] = normalized
    return out


def expected_behavior_for_engine(engine_id: str, meta: InstanceMeta) -> str:
    explicit = meta.expected_by_engine.get(engine_id)
    if explicit:
        return explicit

    if meta.objective_type == "MULTI":
        return "VALIDATION_ERROR"

    if meta.objective_type == "MANY":
        return "ANY_COMPLETED" if engine_id == "many-heuristic" else "VALIDATION_ERROR"

    if meta.objective_type != "MONO":
        return "VALIDATION_ERROR"

    if not meta.all_constraints_hard:
        return "ANY_COMPLETED" if engine_id == "random-search" else "VALIDATION_ERROR"

    hard_rules = {
        "minizinc-csp": "FEASIBLE",
        "random-search": "ANY_COMPLETED",
    }
    resolved = hard_rules.get(engine_id)
    if resolved:
        return resolved

    return "VALIDATION_ERROR"


def expected_to_solve(engine_id: str, meta: InstanceMeta) -> bool:
    return expected_behavior_for_engine(engine_id, meta) != "VALIDATION_ERROR"


def sanitize_base_url(base_url: str) -> str:
    return base_url.rstrip("/")


def fetch_active_engines(
    session: requests.Session,
    base_url: str,
    connect_timeout: float,
    read_timeout: float,
) -> List[str]:
    url = f"{sanitize_base_url(base_url)}/v1/engines"
    response = session.get(url, timeout=(connect_timeout, read_timeout))
    response.raise_for_status()
    engines = response.json()
    if not isinstance(engines, list):
        raise RuntimeError("Unexpected /v1/engines response format: expected list")

    active = [e.get("id") for e in engines if isinstance(e, dict) and e.get("active")]
    active_ids = [eid for eid in active if isinstance(eid, str) and eid.strip()]
    if not active_ids:
        raise RuntimeError("No active engines found in /v1/engines")
    return sorted(set(active_ids))


def parse_validation_violations(resp_json: Dict[str, Any]) -> Tuple[bool, List[str], str]:
    detail = resp_json.get("detail")
    if not isinstance(detail, dict):
        return False, [], "Missing or non-object 'detail' in 422 response"

    violations = detail.get("violations")
    if not isinstance(violations, list):
        return False, [], "Missing or non-list 'detail.violations' in 422 response"

    codes: List[str] = []
    for violation in violations:
        if isinstance(violation, dict):
            code = violation.get("code")
            if isinstance(code, str) and code:
                codes.append(code)

    return True, codes, ""


def poll_job_until_terminal(
    session: requests.Session,
    base_url: str,
    job_id: str,
    connect_timeout: float,
    poll_response_timeout: int,
    max_poll_seconds: int,
    poll_interval: float,
) -> Tuple[str, Optional[Dict[str, Any]], int, str]:
    deadline = time.monotonic() + max_poll_seconds
    polls = 0
    last_error = ""

    while time.monotonic() < deadline:
        polls += 1
        try:
            response = session.get(
                f"{sanitize_base_url(base_url)}/v1/jobs/{job_id}",
                timeout=(connect_timeout, poll_response_timeout),
            )
            response.raise_for_status()
            payload = response.json()
            status = str(payload.get("status", "")).lower()

            if status in {"completed", "failed"}:
                return status, payload, polls, ""

            if status not in {"queued", "running"}:
                return "failed", payload, polls, f"Unknown job status '{status}'"

            time.sleep(poll_interval)
        except requests.RequestException as exc:
            last_error = f"Polling error: {exc}"
            time.sleep(min(poll_interval, 5.0))
        except ValueError as exc:
            last_error = f"Invalid JSON while polling: {exc}"
            time.sleep(min(poll_interval, 5.0))

    return "timeout", None, polls, (
        last_error or f"Polling exceeded {max_poll_seconds} seconds"
    )


def _mark_result(result: CaseResult, outcome: str, reason: str, passed: bool) -> None:
    result.outcome = outcome
    result.reason = reason
    result.passed_expectation = passed


def _has_non_empty_binding(solutions: Any) -> bool:
    if not isinstance(solutions, list):
        return False
    for solution in solutions:
        if not isinstance(solution, dict):
            continue
        binding = solution.get("binding") or {}
        if isinstance(binding, dict) and len(binding) > 0:
            return True
    return False


def _normalize_feasibility(value: Any) -> str:
    if isinstance(value, str) and value:
        return value.upper()
    return ""


def _infer_feasibility_from_body(body: Dict[str, Any]) -> str:
    result_obj = body.get("result") if isinstance(body, dict) else None
    if not isinstance(result_obj, dict):
        return "UNKNOWN"

    feasibility = _normalize_feasibility(result_obj.get("feasibility"))
    if feasibility:
        return feasibility

    if _has_non_empty_binding(result_obj.get("solutions", [])):
        return "FEASIBLE"

    return "UNKNOWN"


def _mark_expected_feasibility_match(result: CaseResult, feasibility: str) -> None:
    if feasibility == "FEASIBLE":
        _mark_result(
            result,
            outcome="solved",
            reason="Completed with expected FEASIBLE result",
            passed=True,
        )
        return

    _mark_result(
        result,
        outcome="expected_no_solution",
        reason=f"Completed with expected {feasibility} result",
        passed=True,
    )


def _mark_expected_feasibility_mismatch(
    result: CaseResult,
    feasibility: str,
    expected_behavior: str,
) -> None:
    if result.engine_id == "minizinc-csp":
        _mark_result(
            result,
            outcome="no_solution",
            reason=f"MiniZinc completed with {feasibility} (expected {expected_behavior})",
            passed=False,
        )
        return

    if result.engine_id in {"random-search", "many-heuristic"}:
        _mark_result(
            result,
            outcome="no_solution_tolerated",
            reason=f"Completed with {feasibility} (expected {expected_behavior})",
            passed=False,
        )
        return

    _mark_result(
        result,
        outcome="no_solution",
        reason=f"Completed with {feasibility} (expected {expected_behavior})",
        passed=False,
    )


def _handle_completed_status(
    result: CaseResult,
    expected: bool,
    body: Dict[str, Any],
    expected_behavior: str,
) -> None:
    feasibility = _infer_feasibility_from_body(body or {})
    result.feasibility = feasibility

    if not expected:
        _mark_result(
            result,
            outcome="solved" if feasibility == "FEASIBLE" else "no_solution",
            reason=f"Expected validation error (422), but job completed with {feasibility}",
            passed=False,
        )
        return

    if expected_behavior == "ANY_COMPLETED":
        if feasibility == "FEASIBLE":
            _mark_result(result, outcome="solved", reason="Completed with FEASIBLE result", passed=True)
            return
        _mark_result(
            result,
            outcome="no_solution_tolerated",
            reason=f"Completed with {feasibility}; tolerated by expectation policy",
            passed=True,
        )
        return

    if expected_behavior in {"FEASIBLE", "INFEASIBLE", "UNKNOWN"}:
        if feasibility == expected_behavior:
            _mark_expected_feasibility_match(result, feasibility)
            return

        _mark_expected_feasibility_mismatch(result, feasibility, expected_behavior)
        return

    _mark_expected_feasibility_mismatch(result, feasibility, expected_behavior)


def _handle_422_case(result: CaseResult, body: Dict[str, Any], expected: bool) -> None:
    has_valid_violations, codes, violation_error = parse_validation_violations(body)
    result.violation_codes = codes

    if expected:
        _mark_result(
            result,
            outcome="validation_error",
            reason="Expected solver success but got validation error",
            passed=False,
        )
        return

    if has_valid_violations:
        _mark_result(
            result,
            outcome="validation_error",
            reason="Validation failure as expected",
            passed=True,
        )
        return

    _mark_result(
        result,
        outcome="validation_error",
        reason=f"Expected 422 with violations, but payload was invalid: {violation_error}",
        passed=False,
    )


def _handle_terminal_status(
    result: CaseResult,
    status: str,
    expected: bool,
    expected_behavior: str,
    body: Optional[Dict[str, Any]] = None,
    error: str = "",
) -> None:
    if status == "completed":
        _handle_completed_status(
            result=result,
            expected=expected,
            body=body or {},
            expected_behavior=expected_behavior,
        )
        return

    if status == "failed":
        _mark_result(result, outcome="job_failed", reason=error or "Job failed", passed=False)
        return

    _mark_result(
        result,
        outcome="technical_error",
        reason=f"Unexpected status: {status or '<missing>'}",
        passed=False,
    )


def _handle_async_case(
    result: CaseResult,
    session: requests.Session,
    base_url: str,
    job_id: str,
    connect_timeout: float,
    poll_response_timeout: int,
    max_poll_seconds: int,
    poll_interval: float,
    expected: bool,
    expected_behavior: str,
) -> None:
    final_status, poll_payload, poll_count, poll_error = poll_job_until_terminal(
        session=session,
        base_url=base_url,
        job_id=job_id,
        connect_timeout=connect_timeout,
        poll_response_timeout=poll_response_timeout,
        max_poll_seconds=max_poll_seconds,
        poll_interval=poll_interval,
    )
    result.poll_count = poll_count

    if final_status == "timeout":
        _mark_result(result, outcome="poll_timeout", reason=poll_error, passed=False)
        return

    if final_status == "completed":
        _handle_terminal_status(
            result,
            status="completed",
            expected=expected,
            expected_behavior=expected_behavior,
            body=poll_payload,
        )
        return

    if final_status == "failed":
        job_error = ""
        if isinstance(poll_payload, dict):
            job_error = str(poll_payload.get("error") or "")
        _handle_terminal_status(
            result,
            status="failed",
            expected=expected,
            expected_behavior=expected_behavior,
            body=poll_payload,
            error=job_error or poll_error,
        )
        return

    _mark_result(
        result,
        outcome="technical_error",
        reason=f"Unexpected final status: {final_status}",
        passed=False,
    )


def run_single_case(
    session: requests.Session,
    base_url: str,
    engine_id: str,
    instance_meta: InstanceMeta,
    connect_timeout: float,
    solve_timeout: int,
    poll_response_timeout: int,
    max_poll_seconds: int,
    poll_interval: float,
) -> CaseResult:
    expected_behavior = expected_behavior_for_engine(engine_id, instance_meta)
    expected = expected_behavior != "VALIDATION_ERROR"
    start = time.monotonic()
    instance_name = instance_meta.path.name

    with instance_meta.path.open("r", encoding="utf-8") as handle:
        instance_payload = json.load(handle)

    request_payload = {
        "engine_id": engine_id,
        "instance": instance_payload,
        "options": {},
        "verbose": False,
    }

    result = CaseResult(
        instance=instance_name,
        engine_id=engine_id,
        category=instance_meta.category,
        objective_type=instance_meta.objective_type,
        all_constraints_hard=instance_meta.all_constraints_hard,
        expected_to_solve=expected,
        expected_behavior=expected_behavior,
        passed_expectation=False,
        outcome="unknown",
    )

    try:
        response = session.post(
            f"{sanitize_base_url(base_url)}/v1/solve",
            json=request_payload,
            timeout=(connect_timeout, solve_timeout),
        )
        result.status_code = response.status_code

        if response.status_code == 422:
            _handle_422_case(result=result, body=response.json(), expected=expected)
            result.elapsed_seconds = time.monotonic() - start
            return result

        response.raise_for_status()
        body = response.json()

        status = str(body.get("status", "")).lower()
        job_id = body.get("job_id")
        if isinstance(job_id, str):
            result.job_id = job_id

        if status in {"queued", "running"}:
            if not isinstance(job_id, str) or not job_id:
                _mark_result(
                    result,
                    outcome="technical_error",
                    reason="Async response without job_id",
                    passed=False,
                )
                result.elapsed_seconds = time.monotonic() - start
                return result

            _handle_async_case(
                result=result,
                session=session,
                base_url=base_url,
                job_id=job_id,
                connect_timeout=connect_timeout,
                poll_response_timeout=poll_response_timeout,
                max_poll_seconds=max_poll_seconds,
                poll_interval=poll_interval,
                expected=expected,
                expected_behavior=expected_behavior,
            )
            result.elapsed_seconds = time.monotonic() - start
            return result

        sync_error = str(body.get("error") or "") if isinstance(body, dict) else ""
        _handle_terminal_status(
            result,
            status=status,
            expected=expected,
            expected_behavior=expected_behavior,
            body=body,
            error=sync_error,
        )

    except requests.HTTPError as exc:
        _mark_result(result, outcome="http_error", reason=f"HTTP error: {exc}", passed=False)
    except requests.RequestException as exc:
        _mark_result(result, outcome="network_error", reason=f"Network error: {exc}", passed=False)
    except ValueError as exc:
        _mark_result(result, outcome="parse_error", reason=f"JSON parse error: {exc}", passed=False)
    except Exception as exc:
        _mark_result(result, outcome="technical_error", reason=f"Unexpected error: {exc}", passed=False)

    result.elapsed_seconds = time.monotonic() - start
    return result


def colored(text: str, color_code: str, use_color: bool) -> str:
    if not use_color:
        return text
    return f"\033[{color_code}m{text}\033[0m"


def progress_bar(current: int, total: int, width: int = 30) -> str:
    total = max(total, 1)
    ratio = min(max(current / total, 0.0), 1.0)
    filled = int(ratio * width)
    return "█" * filled + "░" * (width - filled)


def print_progress(
    done: int,
    total: int,
    passed: int,
    failed: int,
    current_label: str,
    use_color: bool,
) -> None:
    pct = (done / max(total, 1)) * 100
    bar = progress_bar(done, total)
    status = (
        f"[{bar}] {done}/{total} ({pct:5.1f}%) | "
        f"{colored('PASS', '32', use_color)} {passed} | "
        f"{colored('FAIL', '31', use_color)} {failed} | "
        f"{current_label}"
    )
    sys.stdout.write("\r" + status[:180].ljust(180))
    sys.stdout.flush()


def format_seconds(seconds: float) -> str:
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m:02d}m {s:02d}s"
    if m:
        return f"{m}m {s:02d}s"
    return f"{s}s"


def build_summary_tables(results: List[CaseResult]) -> str:
    by_engine_category: Dict[Tuple[str, str], Dict[str, int]] = {}
    for result in results:
        key = (result.engine_id, result.category)
        if key not in by_engine_category:
            by_engine_category[key] = {"total": 0, "pass": 0, "fail": 0}
        by_engine_category[key]["total"] += 1
        if result.passed_expectation:
            by_engine_category[key]["pass"] += 1
        else:
            by_engine_category[key]["fail"] += 1

    headers = ["Engine", "Category", "Total", "Pass", "Fail", "Pass %"]
    rows = [headers]
    for (engine_id, category), counters in sorted(by_engine_category.items()):
        total = counters["total"]
        pcount = counters["pass"]
        fcount = counters["fail"]
        ratio = (pcount / total * 100.0) if total else 0.0
        rows.append(
            [
                engine_id,
                category,
                str(total),
                str(pcount),
                str(fcount),
                f"{ratio:5.1f}",
            ]
        )

    widths = [max(len(row[i]) for row in rows) for i in range(len(headers))]
    lines = []
    for idx, row in enumerate(rows):
        line = " | ".join(cell.ljust(widths[i]) for i, cell in enumerate(row))
        lines.append(line)
        if idx == 0:
            sep = "-+-".join("-" * widths[i] for i in range(len(widths)))
            lines.append(sep)
    return "\n".join(lines)


def build_top_failures(results: List[CaseResult], limit: int = 8) -> List[CaseResult]:
    failures = [r for r in results if not r.passed_expectation]
    failures.sort(key=lambda r: (-r.elapsed_seconds, r.instance, r.engine_id))
    return failures[:limit]


def write_reports(
    reports_dir: Path,
    started_at: str,
    finished_at: str,
    base_url: str,
    engines: List[str],
    instances_dir: Path,
    results: List[CaseResult],
    total_elapsed: float,
) -> Tuple[Path, Path]:
    reports_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    json_path = reports_dir / f"run_experiments_{stamp}.json"
    md_path = reports_dir / f"run_experiments_{stamp}.md"

    payload = {
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_seconds": total_elapsed,
        "base_url": base_url,
        "instances_dir": str(instances_dir),
        "engines": engines,
        "totals": {
            "cases": len(results),
            "pass": sum(1 for r in results if r.passed_expectation),
            "fail": sum(1 for r in results if not r.passed_expectation),
        },
        "results": [asdict(r) for r in results],
    }

    with json_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)

    lines = [
        "# OpenBinding Experiment Report",
        "",
        f"- Started (UTC): {started_at}",
        f"- Finished (UTC): {finished_at}",
        f"- Duration: {format_seconds(total_elapsed)}",
        f"- Gateway: {base_url}",
        f"- Engines: {', '.join(engines)}",
        f"- Instances dir: {instances_dir}",
        "",
        "## Summary",
        "",
        f"- Total cases: {payload['totals']['cases']}",
        f"- Passed expectations: {payload['totals']['pass']}",
        f"- Failed expectations: {payload['totals']['fail']}",
        "",
        "## Matrix (engine × category)",
        "",
        "```",
        build_summary_tables(results),
        "```",
    ]

    top_failures = build_top_failures(results)
    lines.extend(["", "## Top expectation mismatches", ""])
    if not top_failures:
        lines.append("All expectations were satisfied ✅")
    else:
        for row in top_failures:
            lines.append(
                f"- {row.instance} | {row.engine_id} | {row.outcome} | "
                f"expected_to_solve={row.expected_to_solve} | {row.reason}"
            )

    with md_path.open("w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")

    return json_path, md_path


def print_final_report(
    results: List[CaseResult],
    started_at: str,
    finished_at: str,
    elapsed: float,
    engines: List[str],
    json_report_path: Path,
    md_report_path: Path,
    use_color: bool,
) -> None:
    total = len(results)
    passed = sum(1 for r in results if r.passed_expectation)
    failed = total - passed
    validation_failures = sum(1 for r in results if r.outcome == "validation_error")
    solved = sum(1 for r in results if r.outcome == "solved")
    no_solution_tolerated = sum(1 for r in results if r.outcome == "no_solution_tolerated")
    technical = sum(
        1
        for r in results
        if r.outcome
        in {
            "poll_timeout",
            "job_failed",
            "http_error",
            "network_error",
            "parse_error",
            "technical_error",
            "no_solution",
        }
    )

    print("\n")
    print("=" * 92)
    print("OpenBinding | Experiment execution report")
    print("=" * 92)
    print(f"Started (UTC):  {started_at}")
    print(f"Finished (UTC): {finished_at}")
    print(f"Duration:       {format_seconds(elapsed)}")
    print(f"Engines:        {', '.join(engines)}")
    print("-")
    print(
        f"Cases: {total} | "
        f"{colored('PASS', '32', use_color)}: {passed} | "
        f"{colored('FAIL', '31', use_color)}: {failed}"
    )
    print(
        f"Outcomes -> solved: {solved}, no_solution_tolerated: {no_solution_tolerated}, validation_error: {validation_failures}, "
        f"technical/job errors: {technical}"
    )
    print("-")
    print(build_summary_tables(results))

    top_failures = build_top_failures(results)
    print("-")
    if top_failures:
        print("Top mismatches:")
        for row in top_failures:
            code_suffix = f" | codes={','.join(row.violation_codes[:3])}" if row.violation_codes else ""
            print(
                f"  ❌ {row.instance} | {row.engine_id} | {row.outcome} | "
                f"expected_to_solve={row.expected_to_solve} | {row.reason}{code_suffix}"
            )
    else:
        print("All expectations satisfied ✅")

    print("-")
    print(f"JSON report: {json_report_path}")
    print(f"Markdown report: {md_report_path}")
    print("=" * 92)


def resolve_engines(
    args: argparse.Namespace,
    session: requests.Session,
    base_url: str,
) -> List[str]:
    if args.engines.strip():
        engines = sorted({e.strip() for e in args.engines.split(",") if e.strip()})
        if not engines:
            raise RuntimeError("No valid engine IDs provided via --engines")
        return engines

    return fetch_active_engines(
        session=session,
        base_url=base_url,
        connect_timeout=float(args.connect_timeout),
        read_timeout=float(args.poll_response_timeout),
    )


def print_run_header(args: argparse.Namespace, instances_count: int, engines_count: int, total_cases: int) -> None:
    print(
        f"Running {instances_count} instances against {engines_count} engines "
        f"({total_cases} total cases)"
    )
    print(
        "Timeouts -> "
        f"solve: {args.solve_timeout}s, "
        f"poll response: {args.poll_response_timeout}s, "
        f"max poll window: {args.max_poll_seconds}s"
    )


def execute_cases(
    args: argparse.Namespace,
    session: requests.Session,
    base_url: str,
    instances: List[InstanceMeta],
    engines: List[str],
    total_cases: int,
    use_color: bool,
) -> Tuple[List[CaseResult], bool]:
    results: List[CaseResult] = []
    completed = 0
    passed = 0
    failed = 0

    try:
        for instance_meta in instances:
            for engine_id in engines:
                if args.max_cases > 0 and completed >= args.max_cases:
                    return results, False

                label = f"{instance_meta.path.name} -> {engine_id}"
                print_progress(
                    done=completed,
                    total=total_cases,
                    passed=passed,
                    failed=failed,
                    current_label=label,
                    use_color=use_color,
                )

                case = run_single_case(
                    session=session,
                    base_url=base_url,
                    engine_id=engine_id,
                    instance_meta=instance_meta,
                    connect_timeout=float(args.connect_timeout),
                    solve_timeout=int(args.solve_timeout),
                    poll_response_timeout=int(args.poll_response_timeout),
                    max_poll_seconds=int(args.max_poll_seconds),
                    poll_interval=float(args.poll_interval),
                )
                results.append(case)

                completed += 1
                if case.passed_expectation:
                    passed += 1
                else:
                    failed += 1

                print_progress(
                    done=completed,
                    total=total_cases,
                    passed=passed,
                    failed=failed,
                    current_label=label,
                    use_color=use_color,
                )

    except KeyboardInterrupt:
        return results, True

    return results, False


def main() -> int:
    args = parse_args()
    use_color = not args.no_color

    base_url = sanitize_base_url(args.base_url)
    instances_dir = Path(args.instances_dir).resolve()
    reports_dir = Path(args.reports_dir).resolve()

    started_at = now_utc_iso()
    run_start = time.monotonic()

    try:
        instances = load_instances(instances_dir)
    except Exception as exc:
        print(f"Failed to load instances: {exc}", file=sys.stderr)
        return 2

    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})

    try:
        engines = resolve_engines(args=args, session=session, base_url=base_url)
    except Exception as exc:
        print(f"Failed to resolve engines: {exc}", file=sys.stderr)
        return 2

    total_cases = len(instances) * len(engines)
    if args.max_cases > 0:
        total_cases = min(total_cases, args.max_cases)
    print_run_header(args=args, instances_count=len(instances), engines_count=len(engines), total_cases=total_cases)

    results, interrupted = execute_cases(
        args=args,
        session=session,
        base_url=base_url,
        instances=instances,
        engines=engines,
        total_cases=total_cases,
        use_color=use_color,
    )
    if interrupted:
        print("\nInterrupted by user. Generating partial report...", file=sys.stderr)

    finished_at = now_utc_iso()
    elapsed = time.monotonic() - run_start

    json_report_path, md_report_path = write_reports(
        reports_dir=reports_dir,
        started_at=started_at,
        finished_at=finished_at,
        base_url=base_url,
        engines=engines,
        instances_dir=instances_dir,
        results=results,
        total_elapsed=elapsed,
    )

    print_final_report(
        results=results,
        started_at=started_at,
        finished_at=finished_at,
        elapsed=elapsed,
        engines=engines,
        json_report_path=json_report_path,
        md_report_path=md_report_path,
        use_color=use_color,
    )

    if not results:
        return 3

    return 0 if all(r.passed_expectation for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
