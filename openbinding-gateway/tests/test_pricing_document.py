"""The pricing document, checked against the gateway that has to honour it.

``space/pricing/openbinding.yml`` is uploaded to a SPACE instance and decides
what every account may do, but nothing in the running gateway reads it - by the
time a request arrives, the answer comes from a contract. So a limit renamed
here and not there fails silently, as a quota that is never enforced.

These tests are what makes that fail loudly instead.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml

from openbinding_gateway.core.settings import Settings
from openbinding_gateway.space_client.fake import PLAN_LIMITS

PRICING_PATH = (
    Path(os.path.dirname(os.path.abspath(__file__))).parents[1] / "space" / "pricing" / "openbinding.yml"
)


@pytest.fixture(scope="module")
def pricing() -> dict:
    with open(PRICING_PATH, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def test_the_pricing_document_is_where_it_is_expected():
    # Not under `pricings/`, which holds the provider iPricings that
    # experiments read as candidate cost data. Different thing entirely.
    assert PRICING_PATH.exists()


def test_it_names_the_service_the_gateway_uses(pricing):
    from openbinding_gateway.space_client import SERVICE_NAME

    assert pricing["saasName"] == SERVICE_NAME


def test_it_declares_both_plans(pricing):
    assert set(pricing["plans"]) == {"FREE", "PRO"}


def test_the_free_plan_is_free(pricing):
    assert pricing["plans"]["FREE"]["price"] == 0.0


def test_every_usage_limit_is_linked_to_a_feature(pricing):
    # An unlinked limit constrains nothing: SPACE has no way to know which
    # feature to apply it to.
    features = set(pricing["features"])
    for name, limit in pricing["usageLimits"].items():
        linked = limit.get("linkedFeatures") or []
        assert linked, f"{name} is linked to no feature"
        assert set(linked) <= features, f"{name} links to a feature that does not exist"


def test_every_renewable_limit_states_its_period(pricing):
    for name, limit in pricing["usageLimits"].items():
        if limit["type"] == "RENEWABLE":
            assert "period" in limit, f"{name} renews but never says when"
            assert set(limit["period"]) == {"value", "unit"}


def test_non_renewable_limits_say_whether_they_are_tracked(pricing):
    # A tracked limit is a balance that goes up and down; an untracked one is a
    # ceiling. Enforcement reads them differently, so the distinction cannot be
    # left implicit.
    for name, limit in pricing["usageLimits"].items():
        if limit["type"] == "NON_RENEWABLE":
            assert "trackable" in limit, f"{name} does not say whether it is tracked"


def test_no_limit_claims_to_be_unlimited(pricing):
    # Pricing2Yaml has no way to say it, and a limit nobody can reach is still
    # what stops a runaway script.
    for name, limit in pricing["usageLimits"].items():
        default = limit["defaultValue"]
        assert isinstance(default, (int, float)), f"{name} has a non-numeric default"
        assert default == default, f"{name} is NaN"  # NaN is the one value that fails this
        assert default != float("inf"), f"{name} is unbounded"

    for override in pricing["plans"]["PRO"].get("usageLimits", {}).values():
        assert override["value"] != float("inf")


def test_pro_is_never_meaner_than_the_free_plan(pricing):
    defaults = {name: limit["defaultValue"] for name, limit in pricing["usageLimits"].items()}
    for name, override in pricing["plans"]["PRO"].get("usageLimits", {}).items():
        assert override["value"] >= defaults[name], f"PRO gets less {name} than FREE"


def test_the_fake_gate_agrees_with_the_document(pricing):
    # The fake is what every quota test runs against. If it drifts from the
    # document, the tests pass while the deployed pricing does something else.
    defaults = {name: limit["defaultValue"] for name, limit in pricing["usageLimits"].items()}
    pro = {name: value["value"] for name, value in pricing["plans"]["PRO"]["usageLimits"].items()}

    for name, expected in PLAN_LIMITS["FREE"].items():
        assert defaults[name] == expected, f"FREE {name} disagrees with the pricing document"
    for name, expected in PLAN_LIMITS["PRO"].items():
        assert pro[name] == expected, f"PRO {name} disagrees with the pricing document"


def test_the_pro_timeout_matches_what_the_gateway_will_wait(pricing):
    # Selling a longer solve than ENGINE_SOLVE_TIMEOUT_S would be a promise the
    # gateway cannot keep: it gives up first.
    ceiling = pricing["plans"]["PRO"]["usageLimits"]["maxTimeoutPerTaskLimit"]["value"]

    assert ceiling <= Settings(_env_file=None).engine_solve_timeout_s


def test_the_pro_payload_ceiling_matches_the_gateway_limit(pricing):
    from openbinding_gateway.main import MAX_SOLVE_BODY_BYTES

    ceiling_mb = pricing["plans"]["PRO"]["usageLimits"]["maxPayloadSizeLimit"]["value"]

    assert ceiling_mb * 1024 * 1024 <= MAX_SOLVE_BODY_BYTES


def test_the_free_binding_space_ceiling_matches_the_advisory_threshold(pricing):
    # The gateway already warns above 10^9 combinations. The free plan refusing
    # exactly where the warning starts keeps one number in the system.
    from openbinding_gateway.validation.analysis import LARGE_SPACE_LOG10_THRESHOLD

    assert (
        pricing["usageLimits"]["maxBindingSpaceLimit"]["defaultValue"]
        == LARGE_SPACE_LOG10_THRESHOLD
    )
