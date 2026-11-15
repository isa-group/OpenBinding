"""What a ``null`` limit in SPACE's token means.

Today ``null`` is read as an authoritative "unlimited": SPACE's JSON has no Infinity, and the
token serialises an unlimited entitlement that way. Whether SPACE also sends ``null`` for a
limit a plan never declared has not been verified (SPACE is on hold), so there is a switch,
off by default, that reads ``null`` as *unknown* instead: ``SPACE_NULL_LIMIT_IS_UNKNOWN``.
Nothing here changes the remote contract, only how the token is read; the tokens are synthetic.
"""

from __future__ import annotations

import math
import uuid

import pytest

from _space_tokens import ORGANIZATION
from test_space_client import Recorder, a_token
from openbinding_gateway.core.settings import Settings
from openbinding_gateway.domain.entitlements import ConcurrencyLimit, concurrency_limit
from openbinding_gateway.space_client import SpacePricingGate

SIZE = "maxRepositoryStorage"
JOBS = "maxConcurrentRuns"
KEYS = "maxApiKeys"


def gate(**settings) -> SpacePricingGate:
    token = a_token(limits={SIZE: None, JOBS: None, KEYS: None, "maxRunMinutes": 10})
    return SpacePricingGate(
        Settings(_env_file=None, space_organization_id=ORGANIZATION, **settings), client=Recorder(token=token)
    )


async def caps_of(**settings):
    return await gate(**settings).caps(uuid.uuid4())


def test_the_switch_is_off_by_default_and_read_from_the_environment(monkeypatch):
    monkeypatch.delenv("SPACE_NULL_LIMIT_IS_UNKNOWN", raising=False)
    assert Settings(_env_file=None).space_null_limit_is_unknown is False

    monkeypatch.setenv("SPACE_NULL_LIMIT_IS_UNKNOWN", "true")
    assert Settings(_env_file=None).space_null_limit_is_unknown is True


async def test_by_default_a_null_limit_is_unlimited():
    caps = await caps_of()

    assert caps.limits[SIZE] == math.inf and caps.limits[JOBS] == math.inf
    assert caps.limit(KEYS) is None
    assert caps.limit(SIZE) is None
    # Unlimited concurrency is not unlimited jobs: the cap still holds.
    assert concurrency_limit(caps, 8) == ConcurrencyLimit(8, "technical")


async def test_with_the_switch_a_null_limit_is_unknown_exactly_like_an_absent_one():
    caps = await caps_of(space_null_limit_is_unknown=True)

    assert SIZE not in caps.limits and JOBS not in caps.limits and KEYS not in caps.limits
    # A number in the same token is untouched.
    assert caps.limit("maxRunMinutes") == 10


async def test_with_the_switch_concurrency_keeps_the_cap_and_the_numeric_allowances_fail_closed():
    caps = await caps_of(space_null_limit_is_unknown=True)

    assert concurrency_limit(caps, 8) == ConcurrencyLimit(8, "technical")
    # An allowance that is unknown is zero, as for any absent one (``PlanCaps.limit``).
    assert caps.limit(KEYS) == 0
    assert caps.limit(SIZE) == 0


@pytest.mark.parametrize("switch", [False, True])
async def test_a_declared_number_is_never_touched_by_the_switch(switch):
    token = a_token(limits={SIZE: 12, JOBS: 3, KEYS: 0})
    caps = await SpacePricingGate(
        Settings(_env_file=None, space_organization_id=ORGANIZATION, space_null_limit_is_unknown=switch),
        client=Recorder(token=token),
    ).caps(uuid.uuid4())

    assert (caps.limits[SIZE], caps.limits[JOBS], caps.limits[KEYS]) == (12.0, 3.0, 0.0)
