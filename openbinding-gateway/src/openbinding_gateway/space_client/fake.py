"""A pricing gate that needs no SPACE instance.

Two jobs. It is what the tests use, so that "this account is out of quota" is a
state a test can simply set rather than a SPACE deployment it has to arrange.
And it is what a gateway with ``SPACE_ENABLED=false`` runs on, so that local
development does not require the whole pricing stack to be up.

It keeps real balances rather than saying yes to everything, because a fake
that cannot refuse would let the enforcement paths go untested.
"""

from __future__ import annotations

import uuid
from typing import Dict, Optional

from .gate import LimitUsage, PlanCaps, UsageSnapshot, Verdict

#: What each plan allows. Kept in step with space/pricing/openbinding.yml.
PLAN_LIMITS: Dict[str, Dict[str, float]] = {
    "BASIC": {
        "tasksLimit": 100,
        "solverTimeLimit": 3600,
        "federatedTasksLimit": 200,
        "concurrentTasksLimit": 1,
        "federatedEnginesLimit": 1,
        "apiKeysLimit": 2,
    },
    "PRO": {
        "tasksLimit": 100000,
        "solverTimeLimit": 1000000,
        "federatedTasksLimit": 100000,
        "concurrentTasksLimit": 5,
        "federatedEnginesLimit": 10,
        "apiKeysLimit": 10,
    },
}

PLAN_CAPS: Dict[str, PlanCaps] = {
    "BASIC": PlanCaps(
        plan="BASIC",
        max_timeout_s=300.0,
        max_iterations=10_000,
        max_payload_mb=16,
        max_binding_space_log10=9.0,
        job_history_days=7,
    ),
    "PRO": PlanCaps(
        plan="PRO",
        max_timeout_s=1800.0,
        max_iterations=10_000_000,
        max_payload_mb=512,
        max_binding_space_log10=30.0,
        job_history_days=90,
    ),
}


class FakePricingGate:
    """An in-memory pricing service, with balances that really run out."""

    def __init__(self, plan: str = "BASIC"):
        self.default_plan = plan
        self.plans: Dict[uuid.UUID, str] = {}
        self.consumed: Dict[uuid.UUID, Dict[str, float]] = {}
        self.contracts: Dict[uuid.UUID, str] = {}
        #: Set to have every call raise PricingUnavailable, for the tests that
        #: check what the gateway does when SPACE is down.
        self.unavailable = False
        #: Every evaluate() the gateway made, for tests that assert on metering.
        self.evaluations: list[tuple[uuid.UUID, str, Dict[str, float]]] = []

    # -- Helpers ---------------------------------------------------------

    def _check_available(self) -> None:
        if self.unavailable:
            from .gate import PricingUnavailable

            raise PricingUnavailable("The fake pricing service is switched off.")

    def plan_of(self, user_id: uuid.UUID) -> str:
        return self.plans.get(user_id, self.default_plan)

    def _limits(self, user_id: uuid.UUID) -> Dict[str, float]:
        return PLAN_LIMITS[self.plan_of(user_id)]

    def _consumed(self, user_id: uuid.UUID) -> Dict[str, float]:
        return self.consumed.setdefault(user_id, {})

    def spend(self, user_id: uuid.UUID, limit_id: str, amount: float) -> None:
        """Move a balance directly, for tests that want a quota nearly spent."""
        self._consumed(user_id)[limit_id] = self._consumed(user_id).get(limit_id, 0.0) + amount

    def exhaust(self, user_id: uuid.UUID, limit_id: str) -> None:
        """Leave a limit with nothing left."""
        self._consumed(user_id)[limit_id] = self._limits(user_id).get(limit_id, 0.0)

    # -- The protocol ----------------------------------------------------

    async def evaluate(
        self, user_id: uuid.UUID, feature: str, expected: Optional[Dict[str, float]] = None
    ) -> Verdict:
        """Whether the feature may be used. Asks; does not spend.

        Deliberately mirrors ``SpacePricingGate``, which sends no expected
        consumption because SPACE loses all but one of the increments when
        several limits are involved. A fake that quietly consumed would let
        every enforcement test pass while production kept no accounts.
        """
        self._check_available()
        expected = expected or {}
        self.evaluations.append((user_id, feature, dict(expected)))

        limits = self._limits(user_id)
        consumed = self._consumed(user_id)

        caps = PLAN_CAPS[self.plan_of(user_id)]
        if not caps.allows(feature):
            return Verdict.no(f"The {caps.plan} plan does not include {feature}.")

        for limit_id, allowed in limits.items():
            if consumed.get(limit_id, 0.0) >= allowed:
                return Verdict.no(
                    f"{limit_id} is spent.",
                    LimitUsage(limit_id, allowed, consumed[limit_id]),
                )
        return Verdict.yes()

    async def revert(self, user_id: uuid.UUID, feature: str) -> None:
        """A no-op, as it effectively is against SPACE.

        Evaluation spends nothing, so there is nothing for a revert to give
        back. Work that did not happen is corrected with a negative
        ``adjust_usage``, which is the only thing that ever moved a balance.
        """
        self._check_available()

    async def adjust_usage(self, user_id: uuid.UUID, increments: Dict[str, float]) -> None:
        self._check_available()
        consumed = self._consumed(user_id)
        for limit_id, amount in increments.items():
            consumed[limit_id] = max(0.0, consumed.get(limit_id, 0.0) + amount)

    async def caps(self, user_id: uuid.UUID) -> PlanCaps:
        self._check_available()
        return PLAN_CAPS[self.plan_of(user_id)]

    async def usage(self, user_id: uuid.UUID) -> UsageSnapshot:
        self._check_available()
        limits = self._limits(user_id)
        consumed = self._consumed(user_id)
        return UsageSnapshot(
            plan=self.plan_of(user_id),
            limits={
                name: LimitUsage(name, allowed, consumed.get(name, 0.0))
                for name, allowed in limits.items()
            },
        )

    async def create_contract(self, user_id: uuid.UUID, plan: str, email: str) -> None:
        self._check_available()
        self.contracts[user_id] = email
        self.plans[user_id] = plan

    async def change_plan(self, user_id: uuid.UUID, plan: str) -> None:
        self._check_available()
        self.plans[user_id] = plan

    async def pricing_token(self, user_id: uuid.UUID) -> str:
        self._check_available()
        return f"fake-pricing-token-for-{user_id}"
