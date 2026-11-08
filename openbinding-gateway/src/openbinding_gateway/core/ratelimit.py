"""Fixed-window throttling, and the throttling of authentication built on it.

``RateLimiter`` is the counting and its failure mode. Counters live in Redis
(``INCR`` + ``EXPIRE``) so that every replica of the gateway shares them. Two
limiters are built on it: ``AuthRateLimiter`` here, and the one in
``access/work_limits.py`` for the CPU-heavy routes open to anybody.

Authentication (login, registration and token refresh) is counted per
``(action, client address, identifier)`` and, with a larger budget, per
``(action, client address)``. The first stops guessing one account's password
from one place; the second stops one place spraying many identifiers.

Failure mode, decided on purpose: **when Redis does not answer, the limiter
does not switch itself off.** It falls back to counters held in the memory of
the process, logs the degradation and counts it (``Degradation``). Those
counters are per process, so with N replicas the effective budget is up to N
times larger until Redis is back - weaker than the shared limit, but never
"no limit", which is what a silent fail-open would give an attacker who can
make Redis slow. A failed Redis is retried only every
``auth_rate_limit_redis_retry_s`` seconds, so an outage costs one short timeout
per period rather than one per login.

What this does not do: it does not lock an account (that would let anybody
lock anybody out), it does not survive a restart in the fallback, and it
trusts the client address it is given - which is only meaningful behind
``uvicorn --proxy-headers`` with ``FORWARDED_ALLOW_IPS`` naming the real proxy
(see the Dockerfile and docker-compose.yml).
"""

from __future__ import annotations

import hashlib
import ipaddress
import logging
import time
from dataclasses import dataclass, field
from typing import Callable, ClassVar, Optional, Protocol

from fastapi import Request, status

from ..models.errors import api_error
from .settings import Settings, get_settings

logger = logging.getLogger(__name__)

#: Entries kept by the in-memory counters before expired ones are swept.
_MEMORY_SWEEP_AT = 10_000
#: Hard bound of the in-memory table; the oldest windows are dropped past it.
_MEMORY_MAX_KEYS = 50_000


class RateLimitBackend(Protocol):
    """A counter store: add ``cost`` hits to ``key`` and say where the window stands."""

    async def hit(self, key: str, window_s: int, cost: int = 1) -> tuple[int, int]:
        """``(hits in the current window including these, seconds until it ends, at least 1)``."""
        ...


class MemoryBackend:
    """Per-process fixed-window counters."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._windows: dict[str, tuple[int, float]] = {}

    async def hit(self, key: str, window_s: int, cost: int = 1) -> tuple[int, int]:
        now = self._clock()
        count, ends = self._windows.get(key, (0, 0.0))
        if now >= ends:
            count, ends = 0, now + window_s
        count += cost
        self._windows[key] = (count, ends)
        if len(self._windows) > _MEMORY_SWEEP_AT:
            self._sweep(now)
        return count, max(1, int(ends - now + 0.999))

    def _sweep(self, now: float) -> None:
        for stale in [name for name, (_, ends) in self._windows.items() if now >= ends]:
            del self._windows[stale]
        excess = len(self._windows) - _MEMORY_MAX_KEYS
        if excess > 0:
            for name in sorted(self._windows, key=lambda item: self._windows[item][1])[:excess]:
                del self._windows[name]

    def clear(self) -> None:
        self._windows.clear()


class RedisBackend:
    """Counters shared through Redis: ``INCR``, then ``EXPIRE`` on the first hit."""

    def __init__(self, client) -> None:
        self._redis = client

    @classmethod
    def from_url(cls, url: str) -> "RedisBackend":
        from redis.asyncio import Redis

        # Short timeouts: this sits on the path of every request it counts.
        return cls(Redis.from_url(url, socket_connect_timeout=0.5, socket_timeout=0.5))

    async def hit(self, key: str, window_s: int, cost: int = 1) -> tuple[int, int]:
        pipeline = self._redis.pipeline(transaction=True)
        pipeline.incr(key, cost)
        pipeline.ttl(key)
        count, ttl = await pipeline.execute()
        if ttl is None or ttl < 0:
            # First hit of the window - or a counter that lost its expiry,
            # which would otherwise never reset.
            await self._redis.expire(key, window_s)
            ttl = window_s
        # TTL rounds to the second, so the last half second reads 0. A window that
        # is still open has to say so: 0 would read as "no wait" to a caller.
        return int(count), max(1, int(ttl))

    async def aclose(self) -> None:
        await self._redis.aclose()


@dataclass
class Degradation:
    """How often the shared backend was unavailable (the 'metric')."""

    events: int = 0
    last_error: Optional[str] = None
    last_at: Optional[float] = None
    #: Monotonic time before which Redis is not tried again.
    retry_at: float = 0.0

    @property
    def degraded(self) -> bool:
        return self.events > 0 and time.monotonic() < self.retry_at


class RateLimited(Exception):
    def __init__(self, retry_after: int) -> None:
        super().__init__(f"rate limited; retry after {retry_after}s")
        self.retry_after = retry_after


@dataclass
class RateLimiter:
    """Counts hits through ``primary`` and, if it fails, through ``fallback``."""

    primary: Optional[RateLimitBackend]
    fallback: RateLimitBackend = field(default_factory=MemoryBackend)
    retry_after_failure_s: float = 15.0
    clock: Callable[[], float] = time.monotonic
    degradation: Degradation = field(default_factory=Degradation)

    #: Which limiter it is, in the log line of a degradation.
    label: ClassVar[str] = "rate limiter"

    async def _hit(self, key: str, window_s: int, cost: int = 1) -> tuple[int, int]:
        if self.primary is not None and self.clock() >= self.degradation.retry_at:
            try:
                return await self.primary.hit(key, window_s, cost)
            except Exception as error:  # noqa: BLE001 - any backend failure degrades, none disables
                self.degradation.events += 1
                self.degradation.last_error = type(error).__name__
                self.degradation.last_at = time.time()
                self.degradation.retry_at = self.clock() + self.retry_after_failure_s
                logger.warning(
                    "%s: shared backend unavailable (%s); using "
                    "per-process counters for %.0fs (degradation #%d)",
                    self.label,
                    type(error).__name__,
                    self.retry_after_failure_s,
                    self.degradation.events,
                )
        return await self.fallback.hit(key, window_s, cost)


@dataclass
class AuthRateLimiter(RateLimiter):
    """Counts login, registration and refresh attempts."""

    label: ClassVar[str] = "authentication rate limiter"

    async def check(
        self,
        action: str,
        client: str,
        identifier: Optional[str],
        *,
        attempts: int,
        ip_attempts: int,
        window_s: int,
    ) -> None:
        """Count one attempt; raise ``RateLimited`` once a budget is spent.

        ``attempts`` or ``ip_attempts`` of 0 switches that budget off.
        """
        retry_after = 0
        if ip_attempts > 0:
            count, ttl = await self._hit(f"authrl:{action}:ip:{client}", window_s)
            if count > ip_attempts:
                retry_after = max(retry_after, ttl)
        if attempts > 0 and identifier:
            digest = hashlib.sha256(identifier.strip().lower().encode("utf-8")).hexdigest()[:32]
            count, ttl = await self._hit(f"authrl:{action}:id:{client}:{digest}", window_s)
            if count > attempts:
                retry_after = max(retry_after, ttl)
        if retry_after:
            raise RateLimited(retry_after)


_limiter: Optional[AuthRateLimiter] = None


def build_limiter(settings: Settings) -> AuthRateLimiter:
    return AuthRateLimiter(
        primary=RedisBackend.from_url(settings.redis_url),
        retry_after_failure_s=settings.auth_rate_limit_redis_retry_s,
    )


def get_auth_limiter() -> AuthRateLimiter:
    """The process's limiter, built on first use from the settings."""
    global _limiter
    if _limiter is None:
        _limiter = build_limiter(get_settings())
    return _limiter


def set_auth_limiter(limiter: Optional[AuthRateLimiter]) -> None:
    """Install (or, with ``None``, forget) the limiter; tests inject theirs here."""
    global _limiter
    _limiter = limiter


def client_address(request: Request) -> str:
    """The address the request came from, as the server saw it.

    With ``uvicorn --proxy-headers`` and a trusted ``FORWARDED_ALLOW_IPS`` the
    server has already replaced the socket peer with the ``X-Forwarded-For``
    value of the trusted proxy; without it, this is the socket peer. The header
    is deliberately never read here, so a client cannot choose its own bucket.
    """
    client = request.scope.get("client")
    return str(client[0]) if client else "unknown"


def client_bucket(address: str) -> str:
    """What one client is counted as: its address, or for IPv6 the /64 it belongs to.

    A single IPv6 subscriber holds a whole /64 and may use a new address for every request,
    so a counter per address would count nothing. An IPv4 address mapped into IPv6 is that
    IPv4 address; anything that is not an address (``unknown``) is its own bucket.
    """
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return address
    if parsed.version == 4:
        return address
    if parsed.ipv4_mapped is not None:
        return str(parsed.ipv4_mapped)
    return f"{ipaddress.IPv6Address(int(parsed) >> 64 << 64)}/64"


def _budget(settings: Settings, action: str) -> int:
    return {
        "login": settings.auth_rate_limit_login_attempts,
        "register": settings.auth_rate_limit_register_attempts,
        "refresh": settings.auth_rate_limit_refresh_attempts,
    }[action]


async def enforce_auth_rate_limit(
    request: Request,
    action: str,
    identifier: Optional[str],
    settings: Optional[Settings] = None,
    limiter: Optional[AuthRateLimiter] = None,
) -> None:
    """Count one ``action`` attempt by this client and refuse with 429 when over budget.

    The refusal carries ``Retry-After`` and the platform's ``{"detail": {"code",
    ...}}`` error shape (``rate_limit_exceeded``).
    """
    settings = settings or get_settings()
    attempts = _budget(settings, action)
    if attempts <= 0:
        return
    limiter = limiter or get_auth_limiter()
    try:
        await limiter.check(
            action,
            client_address(request),
            identifier,
            attempts=attempts,
            ip_attempts=attempts * settings.auth_rate_limit_ip_multiplier,
            window_s=settings.auth_rate_limit_window_s,
        )
    except RateLimited as limited:
        raise api_error(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "rate_limit_exceeded",
            "Too many attempts. Try again later.",
            headers={"Retry-After": str(limited.retry_after)},
            retry_after_seconds=limited.retry_after,
        ) from None


__all__ = [
    "AuthRateLimiter",
    "Degradation",
    "MemoryBackend",
    "RateLimitBackend",
    "RateLimited",
    "RateLimiter",
    "RedisBackend",
    "client_address",
    "client_bucket",
    "enforce_auth_rate_limit",
    "get_auth_limiter",
    "set_auth_limiter",
]
