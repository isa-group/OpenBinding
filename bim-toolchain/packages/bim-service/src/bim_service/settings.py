"""Configuration of the service: one frozen object, built from ``BIM_SERVICE_*`` variables.

Nothing here is secret.  The bearer tokens are read from a file (``BIM_SERVICE_TOKENS_FILE`` names it)
by :mod:`bim_service.auth`; they are never taken from the environment.  Unknown ``BIM_SERVICE_*``
variables are ignored on purpose: Kubernetes injects ``BIM_SERVICE_PORT`` and friends for a Service
called ``bim-service``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from bim_core import ContractError, Limits


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

    #: File with one or two bearer tokens (``BIM_SERVICE_TOKENS_FILE``).
    tokens_file: str | None = None
    #: ``BIM_SERVICE_ALLOW_ANONYMOUS_DEV=1``: serve without authentication when no tokens file is set.
    allow_anonymous_dev: bool = False
    #: Largest accepted request body, in bytes; larger ones are refused with 413 before being read.
    max_body_bytes: int = 32 * 1024 * 1024
    #: Operations that may run at once (also the size of the worker thread pool).
    max_concurrency: int = 4
    #: Operations one ``X-BIM-Tenant`` may have in flight; 0 disables the per-tenant limit.
    max_concurrency_per_tenant: int = 2
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
    log_level: str = "INFO"
    limits: Limits = field(default_factory=Limits)

    def __post_init__(self) -> None:
        _positive("BIM_SERVICE_MAX_BODY_BYTES", self.max_body_bytes)
        _positive("BIM_SERVICE_MAX_CONCURRENCY", self.max_concurrency)
        _positive("BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT", self.max_concurrency_per_tenant, allow_zero=True)
        _positive("BIM_SERVICE_ACQUIRE_TIMEOUT_MS", self.acquire_timeout_ms, allow_zero=True)
        _positive("BIM_SERVICE_OPERATION_TIMEOUT_SECONDS", self.operation_timeout_seconds)
        _positive("BIM_SERVICE_RETRY_AFTER_SECONDS", self.retry_after_seconds)
        _positive("BIM_SERVICE_MAX_REGISTERED_RESOURCES", self.max_registered_resources)
        _positive("BIM_SERVICE_MAX_BINDINGS", self.max_bindings)
        _positive("BIM_SERVICE_NEIGHBORHOOD_MAX_SECONDS", self.neighborhood_max_seconds)

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
            log_level=read("LOG_LEVEL", str, defaults.log_level).upper(),
            limits=limits,
        )

    def public_limits(self) -> dict[str, Any]:
        """The effective limits as published by ``GET /bim/v1/capabilities``."""
        return {
            "maxBodyBytes": self.max_body_bytes,
            "maxConcurrentOperations": self.max_concurrency,
            "maxConcurrentOperationsPerTenant": self.max_concurrency_per_tenant,
            "acquireTimeoutMs": self.acquire_timeout_ms,
            "operationTimeoutSeconds": self.operation_timeout_seconds,
            "retryAfterSeconds": self.retry_after_seconds,
            "maxRegisteredResources": self.max_registered_resources,
            "maxBindingsPerRequest": self.max_bindings,
            "neighborhoodMaxSeconds": self.neighborhood_max_seconds,
        }
