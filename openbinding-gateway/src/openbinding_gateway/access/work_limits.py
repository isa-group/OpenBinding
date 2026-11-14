"""How much work one client may ask of the routes that are open to anybody.

A visitor may do almost everything but solve, so a few routes do real CPU work for whoever
asks. Each request's cost is bounded where the work happens: a source in its length, a package
in what it would emit, and the composition pools answer 503 when they are full. Nothing bounded
how often one client may ask, so one client could keep those pools full and everybody else would
get the 503.

Every such route belongs to one of two classes (``WORK_ROUTES``):

``read``
    Reads or writes YAML, what an editor asks at every pause in typing.
``compile``
    Runs the container's compiler in this process: far more work per request
    and nothing an editor does by itself, so its budget is much smaller.

``GET /v1/compositions/language`` and ``/schema`` are in neither: they answer from a cache.

A client is the address the proxy resolved (``core/ratelimit.client_address``), or the /64 of an
IPv6 one, or, when signed in, the account, which gets ``WORK_RATE_LIMIT_SIGNED_IN_MULTIPLIER`` times
the budget and does not share it with whoever shares its address. A key and its account are one
caller. The counters are the ones in ``core/ratelimit.py``: Redis, so every replica shares them, and
counters per process while Redis does not answer.

A request is counted when it arrives, whatever becomes of it, so a malformed one is not free. What this
does not do: it counts requests rather than their size, and on a route with a JSON body it runs after FastAPI
has read and parsed that body, so it stops the work and not the upload. The body limits bound that, and
a client that needs stopping before it reaches the gateway is the proxy's to stop.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar, Literal, Optional

from fastapi import Depends, Request, status

from ..core.ratelimit import RateLimited, RateLimiter, RedisBackend, client_address, client_bucket
from ..core.settings import Settings, get_settings
from ..db.models import User
from ..models.errors import api_error
from .dependencies import counted_caller, get_optional_user
from .public_read import route_template

WorkClass = Literal["read", "compile"]

#: Every route counted here, by its template. A test walks the real route table and fails when a
#: route under these prefixes is not listed, and the OpenAPI document declares the 429 from this table.
WORK_ROUTES: dict[str, WorkClass] = {
    "/v1/compositions/validate": "read",
    "/v1/compositions/parse": "read",
    "/v1/compositions/serialise": "read",
    "/v1/compositions/diff": "read",
    "/v1/compositions/compile": "compile",
    "/v1/compositions/package": "compile",
    "/v1/compositions/import": "compile",
    "/v1/instances/validate": "compile",
}


@dataclass
class WorkRateLimiter(RateLimiter):
    """Counts the requests of each class per client."""

    label: ClassVar[str] = "work rate limiter"

    async def check(
        self, work_class: WorkClass, client: str, *, budget: int, window_s: int,
    ) -> None:
        """Count one request of this client; raise ``RateLimited`` once past the budget."""
        count, ttl = await self._hit(f"workrl:{work_class}:{client}", window_s)
        if count > budget:
            raise RateLimited(ttl)


_limiter: Optional[WorkRateLimiter] = None


def get_work_limiter() -> WorkRateLimiter:
    """The process's limiter, built on first use from the settings."""
    global _limiter
    if _limiter is None:
        settings = get_settings()
        _limiter = WorkRateLimiter(
            primary=RedisBackend.from_url(settings.redis_url),
            retry_after_failure_s=settings.auth_rate_limit_redis_retry_s,
        )
    return _limiter


def set_work_limiter(limiter: Optional[WorkRateLimiter]) -> None:
    """Install (or, with ``None``, forget) the limiter; tests inject theirs here."""
    global _limiter
    _limiter = limiter


def _budget(settings: Settings, work_class: WorkClass, signed_in: bool) -> int:
    budget = (
        settings.work_rate_limit_compile_requests
        if work_class == "compile"
        else settings.work_rate_limit_read_requests
    )
    return budget * settings.work_rate_limit_signed_in_multiplier if signed_in else budget


async def enforce_work_rate_limit(
    request: Request,
    work_class: WorkClass,
    caller: Optional[User],
    *,
    settings: Optional[Settings] = None,
) -> None:
    """Count one request of this client and refuse with 429 when over budget."""
    settings = settings or get_settings()
    budget = _budget(settings, work_class, caller is not None)
    if budget <= 0:
        return
    client = f"user:{caller.id}" if caller is not None else f"ip:{client_bucket(client_address(request))}"
    window_s = settings.work_rate_limit_window_s
    try:
        await get_work_limiter().check(
            work_class, client, budget=budget, window_s=window_s,
        )
    except RateLimited as limited:
        advice = "" if caller is not None else " An account has a larger allowance."
        raise api_error(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "rate_limit_exceeded",
            f"Too many {work_class} requests from this client; retry after the window ends.{advice}",
            headers={"Retry-After": str(limited.retry_after)},
            retry_after_seconds=limited.retry_after,
            limit=budget,
            window_seconds=window_s,
            work_class=work_class,
        ) from None


async def limit_work(
    request: Request,
    caller: Optional[User] = Depends(get_optional_user),
    settings: Settings = Depends(get_settings),
) -> None:
    """Route dependency: one request of the class ``WORK_ROUTES`` gives this route."""
    await enforce_work_rate_limit(request, WORK_ROUTES[route_template(request)], caller, settings=settings)


async def limit_work_of_counted_caller(
    request: Request,
    caller: Optional[User] = Depends(counted_caller),
    settings: Settings = Depends(get_settings),
) -> None:
    """``limit_work``, for a route that must not start authorizing the credentials it is sent."""
    await enforce_work_rate_limit(request, WORK_ROUTES[route_template(request)], caller, settings=settings)


__all__ = [
    "WORK_ROUTES",
    "WorkClass",
    "WorkRateLimiter",
    "enforce_work_rate_limit",
    "get_work_limiter",
    "limit_work",
    "limit_work_of_counted_caller",
    "set_work_limiter",
]
