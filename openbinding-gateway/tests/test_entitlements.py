"""The three ways a pricing verdict can refuse a job, studies included."""

from __future__ import annotations

from openbinding_gateway.domain.entitlements import Refusal, refusal_for_verdict
from openbinding_gateway.models.errors import api_error
from openbinding_gateway.models.problem import problem_body
from openbinding_gateway.space_client import LimitUsage, Verdict


def test_concurrent_jobs_limit_is_a_retryable_429() -> None:
    verdict = Verdict.no("", LimitUsage(limit_id="concurrentJobs", limit=2, used=2))

    refusal = refusal_for_verdict(verdict, default_quota_detail="ignored")

    assert refusal == Refusal(
        429,
        "concurrency_limit_exceeded",
        "Concurrency limit exceeded.",
        extra={"concurrency": {"limit_id": "concurrentJobs", "limit": 2, "used": 2}},
        headers={"Retry-After": "15"},
    )


def test_concurrency_refusal_keeps_the_pricing_reason() -> None:
    verdict = Verdict.no("Too many solves at once.", LimitUsage(limit_id="concurrentJobs", limit=1, used=1))

    assert refusal_for_verdict(verdict).detail == "Too many solves at once."


def test_exhausted_quota_is_a_402_naming_the_limit() -> None:
    limit = LimitUsage(limit_id="monthlySolves", limit=10, used=10, unit="solves", renews_at="2026-11-01T00:00:00Z")

    refusal = refusal_for_verdict(Verdict.no("", limit))

    assert refusal.status == 402
    assert refusal.code == "quota_exceeded"
    assert refusal.detail == "Solve quota exhausted."
    assert refusal.headers == {}
    assert refusal.extra == {
        "quota": {
            "limit_id": "monthlySolves",
            "limit": 10,
            "used": 10,
            "unit": "solves",
            "renews_at": "2026-11-01T00:00:00Z",
        }
    }


def test_quota_default_detail_is_chosen_by_the_caller() -> None:
    verdict = Verdict.no("", LimitUsage(limit_id="studyRuns", limit=1, used=1))

    assert refusal_for_verdict(verdict, default_quota_detail="Study-run quota exhausted.").detail == (
        "Study-run quota exhausted."
    )
    assert refusal_for_verdict(
        Verdict.no("Plan reason.", LimitUsage(limit_id="studyRuns", limit=1, used=1)),
        default_quota_detail="Study-run quota exhausted.",
    ).detail == "Plan reason."


def test_refusal_without_a_limit_is_a_403() -> None:
    refusal = refusal_for_verdict(Verdict.no(""))

    assert refusal == Refusal(403, "feature_not_entitled", "The current plan does not entitle this feature.")
    assert refusal.extra == {} and refusal.headers == {}


def test_not_entitled_default_detail_is_chosen_by_the_caller() -> None:
    refusal = refusal_for_verdict(Verdict.no(""), default_not_entitled_detail="The current plan does not entitle studies.")

    assert refusal.detail == "The current plan does not entitle studies."
    assert refusal_for_verdict(Verdict.no("Upgrade needed.")).detail == "Upgrade needed."


def test_refusal_renders_identically_as_exception_and_as_problem() -> None:
    limit = LimitUsage(limit_id="monthlySolves", limit=10, used=10)
    refusal = refusal_for_verdict(Verdict.no("Out of solves.", limit))

    error = api_error(refusal.status, refusal.code, refusal.detail, headers=refusal.headers or None, **refusal.extra)
    body = problem_body(refusal.status, refusal.code, refusal.detail, extra=refusal.extra)

    assert error.status_code == 402
    assert error.detail["code"] == "quota_exceeded"
    assert error.detail["quota"] == body["quota"] == {
        "limit_id": "monthlySolves",
        "limit": 10,
        "used": 10,
        "unit": None,
        "renews_at": None,
    }
    assert body["detail"] == "Out of solves."


def test_the_launch_codes_that_mean_not_now_are_the_ones_the_verdicts_emit() -> None:
    from openbinding_gateway.study_jobs import RETRYABLE_LAUNCH_CODES

    emitted = {
        refusal_for_verdict(Verdict.no("", LimitUsage(limit_id=limit_id, limit=1, used=1))).code
        for limit_id in ("concurrentJobs", "monthlySolves")
    }

    assert emitted == {"concurrency_limit_exceeded", "quota_exceeded"}
    assert emitted <= RETRYABLE_LAUNCH_CODES
    assert "quota_exhausted" not in RETRYABLE_LAUNCH_CODES


def test_concurrency_refusal_carries_retry_after_in_both_styles() -> None:
    refusal = refusal_for_verdict(Verdict.no("", LimitUsage(limit_id="concurrentJobs", limit=3, used=3)))

    error = api_error(refusal.status, refusal.code, refusal.detail, headers=refusal.headers or None, **refusal.extra)

    assert error.status_code == 429
    assert error.headers == {"Retry-After": "15"}
    assert error.detail["concurrency"] == {"limit_id": "concurrentJobs", "limit": 3, "used": 3}
