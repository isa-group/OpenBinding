"""Configuration of the service: one frozen object, built from ``BIM_SERVICE_*`` variables.

Nothing here is secret.  The bearer tokens are read from a file (``BIM_SERVICE_TOKENS_FILE`` names it)
by :mod:`bim_service.auth`; they are never taken from the environment.  Unknown ``BIM_SERVICE_*``
variables are ignored on purpose: Kubernetes injects ``BIM_SERVICE_PORT`` and friends for a Service
called ``bim-service``.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field, replace
from typing import Any, Mapping

from bim_core import ContractError, Limits

#: Per-tenant limit when none is set and the tokens file names at least two tenants.
DEFAULT_MAX_CONCURRENCY_PER_TENANT = 2

#: Estimated peak memory of decoding and validating a request, as a multiple of its body.  Measured with
#: ``tracemalloc`` before the change that moved decoding to the pool: 3.8x for a package, 7.9x for an IR of small
#: objects (``docs/qa/analysis/BIM_B5_B8_M4_IR.md``).  An estimate, not a guarantee.  Resident memory at the body limit
#: (``tests/analysis/test_analysis_b8_rss.py``, ``docs/SERVICE.md``): 7.5x per additional concurrent request.
BODY_MEMORY_FACTOR = 8


class ServiceConfigError(Exception):
    """The configuration is invalid or incomplete: the service refuses to start."""


def _positive(name: str, value: Any, *, allow_zero: bool = False) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ServiceConfigError(f"{name} must be a number")
    if value < 0 or (value == 0 and not allow_zero):
        raise ServiceConfigError(f"{name} must be positive")


@dataclass(frozen=True)
class BimServiceSettings:
    """Effective configuration.  ``limits`` are the ``bim_core`` package limits (``BIM_MAX_*``)."""

    #: File with the bearer tokens, each optionally labelled with its tenant (``BIM_SERVICE_TOKENS_FILE``).
    tokens_file: str | None = None
    #: ``BIM_SERVICE_ALLOW_ANONYMOUS_DEV=1``: serve without authentication when no tokens file is set.
    allow_anonymous_dev: bool = False
    #: Largest accepted request body, in bytes; larger ones are refused with 413 before being read.
    max_body_bytes: int = 32 * 1024 * 1024
    #: Operations that may run at once (also the size of the worker thread pool).
    max_concurrency: int = 4
    #: Operations one tenant (the one bound to the authenticating token) may have in flight; 0 disables the limit.
    #: ``None`` (not set) means :data:`DEFAULT_MAX_CONCURRENCY_PER_TENANT`, applied only when the tokens file names two
    #: or more tenants: with one tenant (all the callers share a token) it would only halve the whole service.
    max_concurrency_per_tenant: int | None = None
    #: Tenants the tokens file names; filled in by :meth:`for_tenants` once the file is read, never from the environment.
    configured_tenants: int = 0
    #: How long a request waits for a free slot before answering 503.
    acquire_timeout_ms: int = 250
    #: Time budget of one operation; the response is 503 after it (the thread cannot be killed).
    operation_timeout_seconds: float = 60.0
    #: Value of ``Retry-After`` for 429 and 503.
    retry_after_seconds: int = 1
    max_registered_resources: int = 64
    max_bindings: int = 1000
    #: Largest ``seconds`` a neighbourhood analysis may ask for.
    neighborhood_max_seconds: float = 10.0
    #: ``sys.setswitchinterval`` to apply while the application runs (seconds); ``None`` leaves the interpreter's value
    #: alone.  Applied by the lifespan of the application, never when it is created, and restored at shutdown.
    switch_interval_seconds: float | None = None
    #: Memory the operations in flight may be estimated to need (bytes); 0 disables the budget.  An operation is
    #: charged :data:`BODY_MEMORY_FACTOR` times its request body while its thread runs.
    memory_budget_bytes: int = 0
    #: Request-body bytes that may be in flight at once, waiting for a slot or admitted, counted from the moment the body
    #: starts to be read until the operation's thread ends; 0 disables the cap.  ``None`` (not set) derives it from the
    #: memory budget, see :attr:`effective_max_pending_body_bytes`.
    max_pending_body_bytes: int | None = None
    log_level: str = "INFO"
    limits: Limits = field(default_factory=Limits)

    def __post_init__(self) -> None:
        _positive("BIM_SERVICE_MAX_BODY_BYTES", self.max_body_bytes)
        _positive("BIM_SERVICE_MAX_CONCURRENCY", self.max_concurrency)
        if self.max_concurrency_per_tenant is not None:
            _positive("BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT", self.max_concurrency_per_tenant, allow_zero=True)
        _positive("BIM_SERVICE_ACQUIRE_TIMEOUT_MS", self.acquire_timeout_ms, allow_zero=True)
        _positive("BIM_SERVICE_OPERATION_TIMEOUT_SECONDS", self.operation_timeout_seconds)
        _positive("BIM_SERVICE_RETRY_AFTER_SECONDS", self.retry_after_seconds)
        _positive("BIM_SERVICE_MAX_REGISTERED_RESOURCES", self.max_registered_resources)
        _positive("BIM_SERVICE_MAX_BINDINGS", self.max_bindings)
        _positive("BIM_SERVICE_NEIGHBORHOOD_MAX_SECONDS", self.neighborhood_max_seconds)
        if self.switch_interval_seconds is not None:
            _positive("BIM_SERVICE_SWITCH_INTERVAL", self.switch_interval_seconds)
        _positive("BIM_SERVICE_MEMORY_BUDGET_BYTES", self.memory_budget_bytes, allow_zero=True)
        if self.max_pending_body_bytes is not None:
            _positive("BIM_SERVICE_MAX_PENDING_BODY_BYTES", self.max_pending_body_bytes, allow_zero=True)

    @property
    def effective_max_pending_body_bytes(self) -> int:
        """The cap on in-flight request-body bytes in force (0 = none).

        Explicit setting, else with a memory budget twice what the budget can admit as raw bodies
        (``budget // BODY_MEMORY_FACTOR``): as many bytes may wait for a slot as may run.  Without a budget, none.
        """
        if self.max_pending_body_bytes is not None:
            return self.max_pending_body_bytes
        return 2 * (self.memory_budget_bytes // BODY_MEMORY_FACTOR)

    def for_tenants(self, count: int) -> BimServiceSettings:
        """These settings once the tokens file is known to name ``count`` tenants."""
        return replace(self, configured_tenants=count)

    @property
    def effective_max_concurrency_per_tenant(self) -> int:
        """The per-tenant limit in force (0 = none): the explicit setting, else the default with 2+ tenants."""
        if self.max_concurrency_per_tenant is not None:
            return self.max_concurrency_per_tenant
        return DEFAULT_MAX_CONCURRENCY_PER_TENANT if self.configured_tenants >= 2 else 0

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> BimServiceSettings:
        """Build the settings from ``environ`` (the process environment in a deployment).

        ``BIM_MAX_*`` entries configure the package limits of ``bim_core``.
        """

        def read(name: str, convert: type, default: Any) -> Any:
            raw = environ.get(f"BIM_SERVICE_{name}")
            if raw is None or raw == "":
                return default
            try:
                return convert(raw)
            except ValueError as exc:
                raise ServiceConfigError(f"BIM_SERVICE_{name} must be a {convert.__name__}") from exc

        defaults = cls()
        try:
            limits = Limits.from_env(environ)
        except ContractError as exc:
            raise ServiceConfigError(str(exc)) from exc
        return cls(
            tokens_file=read("TOKENS_FILE", str, defaults.tokens_file),
            allow_anonymous_dev=environ.get("BIM_SERVICE_ALLOW_ANONYMOUS_DEV") == "1",
            max_body_bytes=read("MAX_BODY_BYTES", int, defaults.max_body_bytes),
            max_concurrency=read("MAX_CONCURRENCY", int, defaults.max_concurrency),
            max_concurrency_per_tenant=read(
                "MAX_CONCURRENCY_PER_TENANT", int, defaults.max_concurrency_per_tenant
            ),
            acquire_timeout_ms=read("ACQUIRE_TIMEOUT_MS", int, defaults.acquire_timeout_ms),
            operation_timeout_seconds=read(
                "OPERATION_TIMEOUT_SECONDS", float, defaults.operation_timeout_seconds
            ),
            retry_after_seconds=read("RETRY_AFTER_SECONDS", int, defaults.retry_after_seconds),
            max_registered_resources=read(
                "MAX_REGISTERED_RESOURCES", int, defaults.max_registered_resources
            ),
            max_bindings=read("MAX_BINDINGS", int, defaults.max_bindings),
            neighborhood_max_seconds=read(
                "NEIGHBORHOOD_MAX_SECONDS", float, defaults.neighborhood_max_seconds
            ),
            switch_interval_seconds=read("SWITCH_INTERVAL", float, defaults.switch_interval_seconds),
            memory_budget_bytes=read("MEMORY_BUDGET_BYTES", int, defaults.memory_budget_bytes),
            max_pending_body_bytes=read("MAX_PENDING_BODY_BYTES", int, defaults.max_pending_body_bytes),
            log_level=read("LOG_LEVEL", str, defaults.log_level).upper(),
            limits=limits,
        )

    def public_limits(self) -> dict[str, Any]:
        """The effective limits as published by ``GET /bim/v1/capabilities``."""
        return {
            "maxBodyBytes": self.max_body_bytes,
            "maxConcurrentOperations": self.max_concurrency,
            "maxConcurrentOperationsPerTenant": self.effective_max_concurrency_per_tenant,
            "acquireTimeoutMs": self.acquire_timeout_ms,
            "operationTimeoutSeconds": self.operation_timeout_seconds,
            "retryAfterSeconds": self.retry_after_seconds,
            "maxRegisteredResources": self.max_registered_resources,
            "maxBindingsPerRequest": self.max_bindings,
            "neighborhoodMaxSeconds": self.neighborhood_max_seconds,
            # The interval in force in the process: the configured one once the application runs, else the interpreter's.
            "switchIntervalSeconds": sys.getswitchinterval(),
            "memoryBudgetBytes": self.memory_budget_bytes,
            "maxPendingBodyBytes": self.effective_max_pending_body_bytes,
        }
