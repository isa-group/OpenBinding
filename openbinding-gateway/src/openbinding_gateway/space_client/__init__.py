"""The pricing service, and the seam that keeps it replaceable."""

from typing import Optional

from ..core.settings import Settings
from .gate import (
    SERVICE_NAME,
    PlanCaps,
    PricingGate,
    PricingUnavailable,
    SubscriptionRejected,
    SubscriptionSnapshot,
    feature_id,
)
from .open import OpenCaps, OpenGate
from .space import SpacePricingGate

_gate: Optional[PricingGate] = None


def build_gate(settings: Settings) -> PricingGate:
    """The gate this deployment should use.

    SPACE is the only source of plans and contracts. With it switched off
    (development and QacoBench; ``Settings`` refuses this in ``APP_ENV=prod``)
    the gateway runs a stateless open gate that grants every functional
    capability and keeps no plan or counter.
    """
    if settings.space_enabled:
        return SpacePricingGate(settings)
    if settings.app_env == "prod":
        raise RuntimeError(
            "SPACE_ENABLED is false while APP_ENV=prod: production needs SPACE for plans and contracts."
        )
    return OpenGate()


def set_gate(gate: Optional[PricingGate]) -> None:
    """Install the process-wide gate. Called from the application's lifespan."""
    global _gate
    _gate = gate


def get_gate() -> PricingGate:
    """The installed gate.

    There is deliberately no fallback: a process that never installed a gate
    must not guess one, because the guess would decide what accounts may do.
    Tests install theirs in ``tests/conftest.py``.
    """
    if _gate is None:
        raise RuntimeError("No pricing gate is installed; the application lifespan did not run.")
    return _gate


__all__ = [
    "OpenCaps",
    "OpenGate",
    "PlanCaps",
    "PricingGate",
    "PricingUnavailable",
    "SERVICE_NAME",
    "SpacePricingGate",
    "SubscriptionRejected",
    "SubscriptionSnapshot",
    "build_gate",
    "feature_id",
    "get_gate",
    "set_gate",
]
