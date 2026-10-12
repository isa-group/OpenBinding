"""The two refusals left in the entitlements layer: a missing feature and the concurrency limit."""

from __future__ import annotations

from openbinding_gateway.domain.entitlements import Refusal, concurrency_refusal, feature_refusal
from openbinding_gateway.models.errors import api_error
from openbinding_gateway.models.problem import problem_body
from openbinding_gateway.space_client import PlanCaps


def test_a_plan_with_the_feature_is_not_refused() -> None:
    caps = PlanCaps(plan="X", features={"solve": True})

    assert feature_refusal(caps, "solve") is None


def test_a_plan_without_the_feature_is_a_403() -> None:
    caps = PlanCaps(plan="X", features={"solve": True, "studies": False})

    refusal = feature_refusal(caps, "studies")

    assert refusal == Refusal(403, "feature_not_entitled", "The current plan does not entitle this feature.")
    assert refusal.extra == {} and refusal.headers == {}


def test_an_unknown_feature_fails_closed() -> None:
    assert feature_refusal(PlanCaps(plan="X"), "never-heard-of").status == 403


def test_the_not_entitled_detail_is_chosen_by_the_caller() -> None:
    refusal = feature_refusal(
        PlanCaps(plan="X"), "studies", default_not_entitled_detail="The current plan does not entitle studies."
    )

    assert refusal.detail == "The current plan does not entitle studies."


def test_the_concurrency_limit_is_a_retryable_429() -> None:
    refusal = concurrency_refusal(8, 8)

    assert refusal == Refusal(
        429,
        "concurrency_limit_exceeded",
        "Concurrency limit exceeded.",
        extra={"concurrency": {"limit": 8, "active": 8}},
        headers={"Retry-After": "15"},
    )


def test_the_concurrency_refusal_carries_retry_after_in_both_styles() -> None:
    refusal = concurrency_refusal(3, 3)

    error = api_error(refusal.status, refusal.code, refusal.detail, headers=refusal.headers or None, **refusal.extra)
    body = problem_body(refusal.status, refusal.code, refusal.detail, extra=refusal.extra)

    assert error.status_code == 429
    assert error.headers == {"Retry-After": "15"}
    assert error.detail["concurrency"] == body["concurrency"] == {"limit": 3, "active": 3}


def test_the_launch_codes_that_mean_not_now_include_the_concurrency_refusal() -> None:
    from openbinding_gateway.study_jobs import RETRYABLE_LAUNCH_CODES

    assert concurrency_refusal(1, 1).code in RETRYABLE_LAUNCH_CODES
    assert "pricing_unavailable" in RETRYABLE_LAUNCH_CODES
    assert not {"quota_exceeded", "quota_exhausted"} & RETRYABLE_LAUNCH_CODES
