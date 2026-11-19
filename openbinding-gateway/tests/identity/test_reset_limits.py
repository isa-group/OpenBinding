"""Password reset is rate limited per address and per email, uniformly, and never fails open (architecture G)."""

from __future__ import annotations

import pytest

from openbinding_gateway.core.ratelimit import AuthRateLimiter, set_auth_limiter


async def test_reset_requests_are_limited_per_email_whether_or_not_the_account_exists(api_client) -> None:
    answers = [
        await api_client.post("/v1/auth/password-reset/request", json={"email": "nobody@example.org"}) for _ in range(4)
    ]
    assert [a.status_code for a in answers[:3]] == [202, 202, 202]
    assert {a.json()["accepted"] for a in answers[:3]} == {True}
    assert answers[3].status_code == 429 and int(answers[3].headers["retry-after"]) > 0


async def test_reset_requests_are_limited_per_address(api_client) -> None:
    codes = [
        (await api_client.post("/v1/auth/password-reset/request", json={"email": f"n{i}@example.org"})).status_code
        for i in range(6)
    ]
    assert codes == [202] * 5 + [429]


async def test_reset_completions_are_limited_per_address(api_client) -> None:
    codes = [
        (await api_client.post("/v1/auth/password-reset/complete", json={"token": "obr_" + "x" * 40, "new_password": "whatever-password-1"})).status_code
        for _ in range(11)
    ]
    assert codes[:10] == [401] * 10 and codes[10] == 429


async def test_redis_down_falls_back_to_memory_and_never_opens(api_client) -> None:
    class Broken:
        async def hit(self, key, window_s, cost=1):
            raise ConnectionError("redis down")

    set_auth_limiter(AuthRateLimiter(primary=Broken()))
    codes = [
        (await api_client.post("/v1/auth/password-reset/request", json={"email": "same@example.org"})).status_code
        for _ in range(4)
    ]
    assert codes == [202, 202, 202, 429]


@pytest.mark.parametrize("action", ["identity_login", "identity_callback", "identity_complete", "identity_session", "reset_request", "reset_complete"])
def test_the_closed_action_table_has_the_sign_in_actions(action) -> None:
    from openbinding_gateway.core.ratelimit import FIXED_BUDGETS

    assert action in FIXED_BUDGETS and FIXED_BUDGETS[action][1] > 0
