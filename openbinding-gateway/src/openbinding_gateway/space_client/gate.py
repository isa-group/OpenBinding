"""What the gateway needs from a pricing service, and nothing more.

Entitlements are not decided here. They are decided by a SPACE instance, which
holds a contract per user and knows what each plan allows. This module is the
seam between the two: a narrow protocol the rest of the gateway talks to, an
adapter over SPACE's own client, and a stateless open gate for development. The
tests build their own fake from a synthetic pricing fixture (``tests/_pricing.py``).

The seam is the point. SPACE is early-stage software whose API will move, and
when it does ``SpacePricingGate`` changes and nothing else does.

The protocol only reads and manages contracts: what a plan includes (``caps``),
the contract itself and the token the browser evaluates features against. The
gateway counts and charges no consumption.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Protocol, runtime_checkable

from ..core.settings import DEFAULT_SPACE_SERVICE_NAME


def feature_id(feature: str, service_name: str = DEFAULT_SPACE_SERVICE_NAME) -> str:
    """The identifier SPACE knows a feature by.

    Feature identifiers are ``<service>-<feature>``, where the service is the
    one configured in ``Settings.space_service_name``. One helper, because the
    convention is easy to get subtly wrong and a mistyped identifier fails as
    "feature not in your plan" rather than as an error - which is exactly the
    kind of bug that reaches production.
    """
    return f"{service_name}-{feature}"


@dataclass(frozen=True)
class PlanCaps:
    """Entitlements resolved by SPACE for one exact Pricing2Yaml contract."""

    plan: str
    features: Dict[str, bool] = field(default_factory=dict)
    limits: Dict[str, float] = field(default_factory=dict)

    def allows(self, identifier: str) -> bool:
        """Unknown identifiers and absent token values fail closed."""
        return self.features.get(identifier, False)

    def limit(self, identifier: str) -> Optional[float]:
        """Return an allowance in the canonical iPricing unit.

        Missing token values are zero (fail closed); infinity is ``None``.
        """
        if identifier not in self.limits:
            return 0.0
        value = float(self.limits[identifier])
        return None if not math.isfinite(value) else value

    def http_view(self) -> dict[str, Any]:
        return {
            "plan": self.plan,
            "features": dict(self.features),
            "limits": dict(self.limits),
            "capabilities": {
                identifier: self.limit(identifier) for identifier in self.limits
            },
        }


@dataclass(frozen=True)
class SubscriptionSnapshot:
    """The immutable pricing selection currently pinned to one contract.

    ``contract_version`` is the opaque version of the contract this was read
    from (SPACE's ``contractVersion``, also its ``ETag``), or ``None`` when the
    pricing service keeps no versions. A change decided on this snapshot hands
    it back as ``expected_contract_version``.
    """

    plan: str
    pricing_version: str
    add_ons: Dict[str, int] = field(default_factory=dict)
    renews_at: Optional[str] = None
    contract_version: Optional[str] = None


class PricingUnavailable(RuntimeError):
    """SPACE could not be reached, and the caller has to decide what that means.

    Deliberately distinct from a refusal: "your plan does not include this" and
    "I could not find out what your plan includes" call for different answers,
    and conflating them would either hand out features to everyone or refuse
    everyone the moment SPACE restarts.
    """


class SubscriptionRejected(PricingUnavailable):
    """SPACE did not accept the requested plan/add-on selection.

    SPACE validates every novation against the pricing version it has deployed;
    this is that refusal, so a caller can answer "that selection is invalid"
    instead of "the pricing service is down". It is still a ``PricingUnavailable``
    for callers that do not tell the two apart.
    """


class ContractChanged(PricingUnavailable):
    """The contract changed after the read a novation was computed on; nothing was written.

    Another administrator, a renewal or the account's own CAS link moved it in
    between. Read the subscription again and decide again: applying the change
    anyway would silently undo whatever happened in between. It is still a
    ``PricingUnavailable`` for callers that do not tell the two apart, since the
    change was not made.
    """


@runtime_checkable
class PricingGate(Protocol):
    """Everything the gateway asks a pricing service."""

    async def caps(self, user_id: uuid.UUID) -> PlanCaps:
        """The features and static ceilings this user's plan imposes."""

    async def create_contract(
        self,
        user_id: uuid.UUID,
        plan: Optional[str],
        email: str,
        pricing_version: Optional[str] = None,
    ) -> None:
        """Create a newly registered account's contract.

        ``plan`` may be ``None``: SPACE then assigns the plan itself.
        """

    async def change_plan(
        self,
        user_id: uuid.UUID,
        plan: str,
        pricing_version: Optional[str] = None,
        expected_contract_version: Optional[str] = None,
    ) -> None:
        """Move an account to another plan, keeping its add-ons. SPACE calls this a novation.

        ``expected_contract_version`` is the version of the snapshot the caller
        decided on; ``ContractChanged`` if the contract is no longer at it.
        """

    async def subscription(self, user_id: uuid.UUID) -> SubscriptionSnapshot:
        """Read the plan, add-ons and pricing version pinned to a contract."""

    async def change_subscription(
        self,
        user_id: uuid.UUID,
        plan: str,
        add_ons: Dict[str, int],
        pricing_version: Optional[str] = None,
        expected_contract_version: Optional[str] = None,
    ) -> SubscriptionSnapshot:
        """Novate a plan/add-on selection against an explicit pricing release.

        ``expected_contract_version`` is the version of the snapshot the caller
        decided on; ``ContractChanged`` if the contract is no longer at it.
        """

    async def pricing_token(self, user_id: uuid.UUID) -> str:
        """A signed token the browser evaluates features against locally."""

    async def remove_contract(self, user_id: uuid.UUID) -> None:
        """Remove the contract after an account deletion."""
