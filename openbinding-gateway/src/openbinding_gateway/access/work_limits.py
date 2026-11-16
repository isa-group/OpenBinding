"""How much work one client may ask of the routes that are open to anybody.

A visitor may do almost everything but solve, so a few routes do real CPU work for whoever
asks. Each request's cost is bounded where the work happens, a package in its size and in what
it would emit, but nothing bounded how often one client may ask, so one client could keep the
compiler busy for everybody else.

Every such route belongs to a class (``WORK_ROUTES``):

``compile``
    Runs the container's compiler in this process: real work per request and nothing an
    editor does at every pause in typing, so its budget is small.

``read``
    Reads or writes a Composition2Yaml document (validate, parse, serialise, diff): bounded
    work an editor asks for as its author types, so its budget is larger. Its concurrency is
    bounded apart, by the language slots (``modules/compositions/application/slots.py``).

``evaluate``
    Judges a composition against its problem and has the toolchain evaluate its binding (seal a
    version, check one, fork one, re-evaluate one, evaluate another binding of one, explore the
    neighbourhood of its binding, derive one from a binding): one evaluation or one bounded
    neighbourhood per request, and at most one compile per revision and toolchain release. Its
    concurrency is bounded apart, by the evaluation slots.

A client is the address the proxy resolved (``core/ratelimit.client_address``), or the /64 of an
IPv6 one, or, when signed in, the account, which gets ``WORK_RATE_LIMIT_SIGNED_IN_MULTIPLIER`` times
the budget and does not share it with whoever shares its address. A key and its account are one
caller. The counters are the ones in ``core/ratelimit.py``: Redis, so every replica shares them, and
counters per process while Redis does not answer.

The list of public compositions and the reads of one are open to anybody too (``ANONYMOUS_READ_ROUTES``).
They are cheap for a member, so only a visitor (no credential) is charged, against the ``read`` class's
anonymous budget: members paging versions, and every signed-in caller, are never limited there.

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
from .dependencies import counted_caller, get_optional_user, get_reader

WorkClass = Literal["compile", "read", "evaluate"]


def route_template(request: Request) -> str:
    """The matched route's path template (``/v1/organizations/{org}/problems``), else the raw path."""

    route = request.scope.get("route")
    return str(getattr(route, "path", request.url.path))

#: Every route counted here, by its method and template. A test walks the real route table and fails when a
#: compiling route is not listed, and the OpenAPI document declares the 429 from this table.
WORK_ROUTES: dict[tuple[str, str], WorkClass] = {
    ("POST", "/v1/bim/validate"): "compile",
    ("POST", "/v1/organizations/{org}/problems"): "compile",
    ("POST", "/v1/organizations/{org}/problems/{problem}/revisions"): "compile",
    # It compiles the revision on a miss (a toolchain release), as validation does.
    ("GET", "/v1/organizations/{org}/problems/{problem}/revisions/{revision}/compilation"): "compile",
    ("POST", "/v1/compositions/validate"): "read",
    ("POST", "/v1/compositions/parse"): "read",
    ("POST", "/v1/compositions/serialise"): "read",
    ("POST", "/v1/compositions/diff"): "read",
    # A seal or a check evaluates once, and compiles only on a miss (a toolchain release).
    ("POST", "/v1/organizations/{org}/compositions/{composition}/versions"): "evaluate",
    ("POST", "/v1/organizations/{org}/compositions/{composition}/versions/check"): "evaluate",
    # A fork seals its first version through the same pipeline as a seal.
    ("POST", "/v1/organizations/{org}/compositions/{composition}/fork"): "evaluate",
    # A stored version evaluated again: by the installed toolchain, with another binding, around its binding.
    ("POST", "/v1/organizations/{org}/compositions/{composition}/versions/{version}/evaluations"): "evaluate",
    ("POST", "/v1/organizations/{org}/compositions/{composition}/evaluate"): "evaluate",
    ("GET", "/v1/organizations/{org}/compositions/{composition}/neighborhood"): "evaluate",
    # A derivation evaluates the binding it writes the document of, and seals it as a seal does.
    ("POST", "/v1/organizations/{org}/compositions/{composition}/derive"): "evaluate",
}

#: The routes a visitor may read public compositions through (``get_reader``): the list of every organization's,
#: and the reads of one. Only a visitor is charged, one request of the ``read`` class each
#: (``charge_anonymous_read``). A test pins this table to the routes that depend on ``get_reader``, and the
#: OpenAPI document declares the 429 from it.
ANONYMOUS_READ_ROUTES: frozenset[tuple[str, str]] = frozenset({
    ("GET", "/v1/compositions"),
    # The organizations that publish a composition, and the public profile of one.
    ("GET", "/v1/organizations/public"),
    ("GET", "/v1/organizations/{org}/profile"),
    # What an invitation code joins, for whoever holds it.
    ("GET", "/v1/invitations/{code}/preview"),
    ("GET", "/v1/organizations/{org}/compositions/{composition}"),
    ("GET", "/v1/organizations/{org}/compositions/{composition}/versions"),
    ("GET", "/v1/organizations/{org}/compositions/{composition}/versions/{version}"),
    ("GET", "/v1/organizations/{org}/compositions/{composition}/versions/{version}/content"),
    ("GET", "/v1/organizations/{org}/compositions/{composition}/diff"),
})

#: The setting that holds each class's budget.
_BUDGETS: dict[WorkClass, str] = {
    "compile": "work_rate_limit_compile_requests",
    "read": "work_rate_limit_read_requests",
    "evaluate": "work_rate_limit_evaluate_requests",
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
    budget = int(getattr(settings, _BUDGETS[work_class]))
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
    await enforce_work_rate_limit(request, WORK_ROUTES[(request.method, route_template(request))], caller, settings=settings)


async def limit_work_of_counted_caller(
    request: Request,
    caller: Optional[User] = Depends(counted_caller),
    settings: Settings = Depends(get_settings),
) -> None:
    """``limit_work``, for a route that must not start authorizing the credentials it is sent."""
    await enforce_work_rate_limit(request, WORK_ROUTES[(request.method, route_template(request))], caller, settings=settings)


async def charge_anonymous_read(
    request: Request,
    reader: Optional[User] = Depends(get_reader),
    settings: Settings = Depends(get_settings),
) -> None:
    """Route dependency of ``ANONYMOUS_READ_ROUTES``: one ``read`` request of a visitor; a caller is not charged."""
    if reader is None:
        await enforce_work_rate_limit(request, "read", None, settings=settings)


__all__ = [
    "ANONYMOUS_READ_ROUTES",
    "WORK_ROUTES",
    "WorkClass",
    "WorkRateLimiter",
    "charge_anonymous_read",
    "enforce_work_rate_limit",
    "get_work_limiter",
    "limit_work",
    "limit_work_of_counted_caller",
    "set_work_limiter",
]
