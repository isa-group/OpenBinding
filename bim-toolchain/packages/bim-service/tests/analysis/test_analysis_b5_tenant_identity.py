"""B5 (analysis, ``docs/qa/analysis/BIM_B5_B8_M4_IR.md``): the per-tenant share of ``bim-service``.

``X-BIM-Tenant`` is read from the request by ``ContextMiddleware`` (middleware.py:77-79) and used as the key of the
per-tenant share (runtime.py:33-46); the token is not tied to it.  The tests that pass pin what already holds (the
global ceiling, no effect on results, what the SDK sends); the ``xfail(strict=True)`` tests are the open defect: when
the share is keyed by the authenticated identity they XPASS, the suite fails, and they must become normal tests.
"""

from __future__ import annotations

import asyncio
import inspect
import threading
import time

import httpx
import pytest
from service_support import TOKEN_NEW, TOKEN_OLD, async_client, bearer, run

from bim_client import HttpBim
from bim_service import operations

EVALUATE = "/bim/v1/evaluate"
CAPABILITIES = "/bim/v1/capabilities"


class OpenDefect(AssertionError):
    """The one failure an ``xfail`` below accepts: any other error in a test is a broken test, not the defect."""


def expect_share_refused(status: int) -> None:
    if status != 429:
        raise OpenDefect(f"answered {status}: the second request was not counted against the first one's share")


async def wait_until(predicate, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.005)


class Holder:
    """An ``operations.evaluate`` that blocks every request whose first binding says ``hold``."""

    def __init__(self) -> None:
        self.release = threading.Event()
        self.lock = threading.Lock()
        self.running = 0
        self.peak = 0

    def __call__(self, ir, bindings, execution, on_error):
        if bindings[0].get("hold"):
            with self.lock:
                self.running += 1
                self.peak = max(self.peak, self.running)
            try:
                assert self.release.wait(15), "never released"
            finally:
                with self.lock:
                    self.running -= 1
        return {"results": []}


@pytest.fixture
def holder(monkeypatch) -> Holder:
    holder = Holder()
    monkeypatch.setattr(operations, "evaluate", holder)
    yield holder
    holder.release.set()


def held(**headers: str) -> dict:
    return {"json": {"ir": {}, "bindings": [{"hold": True}]}, "headers": {**bearer(), **headers}}


def quick(**headers: str) -> dict:
    return {"json": {"ir": {}, "bindings": [{}]}, "headers": {**bearer(), **headers}}


# --- what already holds ----------------------------------------------------------------------------------


def test_the_global_ceiling_holds_whatever_tenant_each_request_claims(make_app, holder) -> None:
    """Ten tenants, one token, two slots: never more than two operations at once; the rest get 503."""
    app = make_app(max_concurrency=2, max_concurrency_per_tenant=1, acquire_timeout_ms=40)

    async def scenario() -> list[int]:
        async with async_client(app) as client:
            tasks = [asyncio.create_task(client.post(EVALUATE, **held(**{"X-BIM-Tenant": f"t{i}"}))) for i in range(10)]
            await wait_until(lambda: holder.running == 2)
            await asyncio.sleep(0.2)
            assert holder.peak == 2
            holder.release.set()
            return sorted(response.status_code for response in await asyncio.gather(*tasks))

    assert run(scenario()) == [200, 200] + [503] * 8


def test_a_caller_can_burn_the_share_of_a_tenant_label_it_does_not_own(make_app, holder) -> None:
    """Today's impersonation: not data (there is none) but the *quota* of someone else's label."""
    app = make_app(max_concurrency=4, max_concurrency_per_tenant=1, acquire_timeout_ms=40)

    async def scenario() -> int:
        async with async_client(app) as client:
            attacker = asyncio.create_task(
                client.post(EVALUATE, json=held()["json"], headers=bearer(TOKEN_OLD, **{"X-BIM-Tenant": "org-victim"}))
            )
            await wait_until(lambda: holder.running == 1)
            victim = await client.post(
                EVALUATE, json=quick()["json"], headers=bearer(TOKEN_NEW, **{"X-BIM-Tenant": "org-victim"})
            )
            holder.release.set()
            await attacker
            return victim.status_code

    assert run(scenario()) == 429


def test_the_tenant_header_never_changes_an_answer(app) -> None:
    from starlette.testclient import TestClient

    client = TestClient(app, base_url="http://bim.test", headers=bearer())
    plain = client.get(CAPABILITIES)
    others = [client.get(CAPABILITIES, headers={"X-BIM-Tenant": tenant}) for tenant in ("a", "b", "not valid!", "")]
    assert plain.status_code == 200
    assert all(other.status_code == 200 and other.json() == plain.json() for other in others)


def test_the_sdk_sends_the_one_tenant_it_was_built_with_and_forwards_no_other_header() -> None:
    seen: list[httpx.Headers] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers)
        return httpx.Response(200, json={"profiles": []})

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://bim.test")
    bim = HttpBim(client=client, token=TOKEN_NEW, tenant="org-1")
    assert bim.profiles() == []
    assert seen[0]["x-bim-tenant"] == "org-1" and seen[0]["authorization"] == f"Bearer {TOKEN_NEW}"
    own = {"host", "accept-encoding", "connection", "user-agent", "accept", "authorization", "x-bim-tenant"}
    assert set(seen[0].keys()) <= own, set(seen[0].keys()) - own
    # No call accepts a tenant or any header: the label is fixed when the client is built.
    for name in ("profiles", "compile", "evaluate", "evaluate_many", "reevaluate"):
        parameters = inspect.signature(getattr(HttpBim, name)).parameters
        assert not {"tenant", "headers"} & set(parameters), (name, parameters)


# --- open defect: the share is keyed by a header the client chooses --------------------------------------


@pytest.mark.xfail(
    raises=OpenDefect,
    strict=True,
    reason=(
        "B5: the share is keyed by X-BIM-Tenant, which any holder of a valid token chooses per request "
        "(middleware.py:77-79, runtime.py:33-46), so changing the header takes a fresh share."
    ),
)
def test_rotating_the_tenant_header_does_not_buy_a_fresh_share(make_app, holder) -> None:
    app = make_app(max_concurrency=4, max_concurrency_per_tenant=1, acquire_timeout_ms=40)

    async def scenario() -> int:
        async with async_client(app) as client:
            first = asyncio.create_task(client.post(EVALUATE, **held(**{"X-BIM-Tenant": "alpha"})))
            await wait_until(lambda: holder.running == 1)
            second = await client.post(EVALUATE, **quick(**{"X-BIM-Tenant": "beta"}))
            holder.release.set()
            await first
            return second.status_code

    expect_share_refused(run(scenario()))


@pytest.mark.xfail(
    raises=OpenDefect,
    strict=True,
    reason="B5: a request without X-BIM-Tenant (or with a value the pattern refuses) has no share at all (runtime.py:35).",
)
@pytest.mark.parametrize("second_headers", [{}, {"X-BIM-Tenant": "not valid!"}], ids=["omitted", "malformed"])
def test_omitting_the_tenant_header_does_not_skip_the_share(make_app, holder, second_headers) -> None:
    app = make_app(max_concurrency=4, max_concurrency_per_tenant=1, acquire_timeout_ms=40)

    async def scenario() -> int:
        async with async_client(app) as client:
            first = asyncio.create_task(client.post(EVALUATE, **held(**{"X-BIM-Tenant": "alpha"})))
            await wait_until(lambda: holder.running == 1)
            second = await client.post(EVALUATE, **quick(**second_headers))
            holder.release.set()
            await first
            return second.status_code

    expect_share_refused(run(scenario()))


@pytest.mark.xfail(
    raises=OpenDefect,
    strict=True,
    reason=(
        "B5: during a rotation the old and the new token are two requests' worth of share when each is sent with a "
        "different X-BIM-Tenant; with identity = token -> tenant both tokens of one tenant share one count."
    ),
)
def test_the_two_tokens_of_a_rotation_share_one_count(make_app, holder) -> None:
    app = make_app(max_concurrency=4, max_concurrency_per_tenant=1, acquire_timeout_ms=40)

    async def scenario() -> int:
        async with async_client(app) as client:
            first = asyncio.create_task(
                client.post(EVALUATE, json=held()["json"], headers=bearer(TOKEN_OLD, **{"X-BIM-Tenant": "alpha"}))
            )
            await wait_until(lambda: holder.running == 1)
            second = await client.post(EVALUATE, json=quick()["json"], headers=bearer(TOKEN_NEW, **{"X-BIM-Tenant": "alpha-2"}))
            holder.release.set()
            await first
            return second.status_code

    expect_share_refused(run(scenario()))
