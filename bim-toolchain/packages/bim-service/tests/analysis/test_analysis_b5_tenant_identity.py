"""B5 (``docs/qa/analysis/BIM_B5_B8_M4_IR.md``): the per-tenant share of ``bim-service`` is keyed by identity.

The tenant is the one bound to the token that authenticated the request (``bim_service.auth``); ``X-BIM-Tenant`` is
what the caller claims and decides nothing.  The first part pins what held before and still holds (the global ceiling,
no effect on results, what the SDK sends); the second is what the analysis found open (changing, omitting or
malforming the header evaded the share, the label of another caller could be burned, the two tokens of a rotation
counted twice) and is now ordinary tests; the third covers when the share applies and what is published.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import threading
import time
from pathlib import Path

import httpx
import pytest
from service_support import (
    BASE_URL,
    TOKEN_ACME,
    TOKEN_ACME_NEXT,
    TOKEN_NEW,
    TOKEN_OLD,
    TOKEN_OTHER,
    async_client,
    bearer,
    run,
)
from starlette.testclient import TestClient

from bim_client import HttpBim
from bim_service import auth, operations
from bim_service.app import create_app
from bim_service.settings import BimServiceSettings, ServiceConfigError

EVALUATE = "/bim/v1/evaluate"
CAPABILITIES = "/bim/v1/capabilities"


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


def call(token: str, *, hold: bool = False, claim: str | None = None) -> dict:
    """The arguments of a request authenticated with ``token`` that claims ``claim`` as ``X-BIM-Tenant`` (if any)."""
    headers = bearer(token) if claim is None else bearer(token, **{"X-BIM-Tenant": claim})
    return {"json": {"ir": {}, "bindings": [{"hold": True} if hold else {}]}, "headers": headers}


def while_held(app, holder: Holder, first: dict, *others: dict) -> list[int]:
    """Statuses of ``others`` while ``first`` is running; ``first`` must end 200."""

    async def scenario() -> list[int]:
        async with async_client(app) as client:
            running = asyncio.create_task(client.post(EVALUATE, **first))
            await wait_until(lambda: holder.running == 1)
            statuses = [(await client.post(EVALUATE, **other)).status_code for other in others]
            holder.release.set()
            assert (await running).status_code == 200
            return statuses

    return run(scenario())


def published(app, token: str = TOKEN_NEW) -> dict:
    client = TestClient(app, base_url=BASE_URL, headers=bearer(token))
    return client.get(CAPABILITIES).json()["limits"]["service"]


def write_tokens(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "tokens"
    path.write_text(text, encoding="utf-8")
    path.chmod(0o600)
    return path


# --- what already held, and still does ---------------------------------------------------------------------


@pytest.mark.parametrize("layout", ["ten-tenants", "one-tenant-no-share"])
def test_the_global_ceiling_holds_whatever_tenant_each_request_claims(tmp_path, holder, layout) -> None:
    """Ten callers, two slots: never more than two operations at once; the rest get 503 (never a share's 429)."""
    tokens = [f"{index:02d}" + "k" * 32 for index in range(10)]
    if layout == "ten-tenants":
        # the shares add up to more than the slots: only the global ceiling can refuse
        path = write_tokens(tmp_path, "".join(f"t{index} {token}\n" for index, token in enumerate(tokens)))
        share: dict = {"max_concurrency_per_tenant": 1}
    else:
        path = write_tokens(tmp_path, tokens[0] + "\n")
        tokens = tokens[:1] * 10
        share = {}
    app = create_app(BimServiceSettings(tokens_file=str(path), max_concurrency=2, acquire_timeout_ms=40, **share))

    async def scenario() -> list[int]:
        async with async_client(app) as client:
            tasks = [
                asyncio.create_task(client.post(EVALUATE, **call(token, hold=True, claim=f"claim-{index}")))
                for index, token in enumerate(tokens)
            ]
            await wait_until(lambda: holder.running == 2)
            await asyncio.sleep(0.2)
            assert holder.peak == 2
            holder.release.set()
            return sorted(response.status_code for response in await asyncio.gather(*tasks))

    assert run(scenario()) == [200, 200] + [503] * 8


def test_the_tenant_header_never_changes_an_answer(app) -> None:
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


# --- impersonation: the share follows the token, not the header --------------------------------------------


def test_rotating_the_tenant_header_does_not_buy_a_fresh_share(make_tenant_app, holder) -> None:
    app = make_tenant_app(max_concurrency=4, max_concurrency_per_tenant=1, acquire_timeout_ms=40)
    statuses = while_held(
        app, holder, call(TOKEN_ACME, hold=True, claim="alpha"), call(TOKEN_ACME, claim="beta"), call(TOKEN_ACME, claim="gamma")
    )
    assert statuses == [429, 429]


@pytest.mark.parametrize("claim", [None, "not valid!", "", "x" * 500], ids=["omitted", "malformed", "empty", "too-long"])
def test_omitting_or_malforming_the_tenant_header_does_not_skip_the_share(make_tenant_app, holder, claim) -> None:
    app = make_tenant_app(max_concurrency=4, max_concurrency_per_tenant=1, acquire_timeout_ms=40)
    assert while_held(app, holder, call(TOKEN_ACME, hold=True, claim="alpha"), call(TOKEN_ACME, claim=claim)) == [429]


def test_a_token_counts_for_its_own_tenant_whatever_label_it_claims(make_tenant_app, holder) -> None:
    """S1: the token of ``acme`` claiming ``other`` is counted in ``acme``; ``other`` keeps its whole share."""
    app = make_tenant_app(max_concurrency=4, max_concurrency_per_tenant=1, acquire_timeout_ms=40)
    statuses = while_held(
        app,
        holder,
        call(TOKEN_ACME, hold=True, claim="other"),
        call(TOKEN_ACME, claim="other"),
        call(TOKEN_ACME, claim="acme"),
        call(TOKEN_OTHER, claim="acme"),
        call(TOKEN_OTHER),
    )
    assert statuses == [429, 429, 200, 200]


def test_a_tenant_at_its_limit_does_not_throttle_another_tenant(make_tenant_app, holder) -> None:
    """S3: the tenant of ``TOKEN_NEW`` (``default``), ``other`` and ``acme`` do not share a count."""
    app = make_tenant_app(max_concurrency=4, max_concurrency_per_tenant=1, acquire_timeout_ms=40)
    statuses = while_held(
        app, holder, call(TOKEN_ACME, hold=True), call(TOKEN_ACME), call(TOKEN_OTHER), call(TOKEN_NEW), call(TOKEN_ACME_NEXT)
    )
    assert statuses == [429, 200, 200, 429]


def test_a_caller_cannot_burn_the_share_of_a_tenant_label_it_does_not_own(make_tenant_app, holder) -> None:
    """S4: ``other`` holding its share while claiming to be ``acme`` leaves ``acme`` untouched, and counts for itself."""
    app = make_tenant_app(max_concurrency=4, max_concurrency_per_tenant=1, acquire_timeout_ms=40)
    statuses = while_held(
        app,
        holder,
        call(TOKEN_OTHER, hold=True, claim="acme"),
        call(TOKEN_ACME),
        call(TOKEN_ACME, claim="acme"),
        call(TOKEN_ACME, claim="other"),
        call(TOKEN_OTHER, claim="acme"),
    )
    assert statuses == [200, 200, 200, 429]


def test_the_anonymous_dev_mode_is_one_identity_whatever_the_header_says(holder) -> None:
    app = create_app(BimServiceSettings(allow_anonymous_dev=True, max_concurrency_per_tenant=1, acquire_timeout_ms=40))
    first = {"json": call(TOKEN_NEW, hold=True)["json"], "headers": {"X-BIM-Tenant": "one"}}
    second = {"json": call(TOKEN_NEW)["json"], "headers": {"X-BIM-Tenant": "two"}}
    assert while_held(app, holder, first, second) == [429]


# --- rotation: two tokens of one tenant --------------------------------------------------------------------


def test_the_two_tokens_of_a_rotation_share_one_count(make_tenant_app, holder) -> None:
    """R1: ``acme`` has an old and a new token, both accepted, with a single count between them."""
    app = make_tenant_app(max_concurrency=4, max_concurrency_per_tenant=1, acquire_timeout_ms=40)
    assert while_held(app, holder, call(TOKEN_ACME, hold=True, claim="alpha"), call(TOKEN_ACME_NEXT, claim="alpha-2")) == [429]


def test_the_two_untagged_tokens_of_the_default_tenant_share_one_count(make_app, holder) -> None:
    app = make_app(max_concurrency=4, max_concurrency_per_tenant=1, acquire_timeout_ms=40)
    assert while_held(app, holder, call(TOKEN_OLD, hold=True, claim="alpha"), call(TOKEN_NEW, claim="alpha-2")) == [429]


def comparable(response) -> tuple[int, dict, dict]:
    headers = {key: value for key, value in response.headers.items() if key not in {"traceparent", "content-length"}}
    return response.status_code, headers, response.json()


def test_both_tokens_of_a_tenant_are_accepted_in_either_order_and_other_tenants_are_unaffected(
    tenant_tokens_path, make_tenant_app
) -> None:
    """R1/R2."""
    for text in (
        f"acme {TOKEN_ACME}\nacme {TOKEN_ACME_NEXT}\nother {TOKEN_OTHER}\n",
        f"other {TOKEN_OTHER}\nacme {TOKEN_ACME_NEXT}\nacme {TOKEN_ACME}\n",
    ):
        tenant_tokens_path.write_text(text, encoding="utf-8")
        client = TestClient(make_tenant_app(), base_url=BASE_URL)
        assert [client.get(CAPABILITIES, headers=bearer(token)).status_code for token in (TOKEN_ACME, TOKEN_ACME_NEXT, TOKEN_OTHER)] == [200] * 3
        assert client.get(CAPABILITIES, headers=bearer(TOKEN_NEW)).status_code == 401


def test_a_retired_token_of_a_tenant_is_refused_like_any_wrong_token(tenant_tokens_path, make_tenant_app) -> None:
    """R3: after the old line is removed and the service restarted."""
    tenant_tokens_path.write_text(f"acme {TOKEN_ACME_NEXT}\nother {TOKEN_OTHER}\n", encoding="utf-8")
    client = TestClient(make_tenant_app(), base_url=BASE_URL)
    retired = client.get(CAPABILITIES, headers=bearer(TOKEN_ACME))
    invented = client.get(CAPABILITIES, headers=bearer("never-" + "z" * 40))
    assert retired.status_code == 401 and comparable(retired) == comparable(invented)
    assert client.get(CAPABILITIES, headers=bearer(TOKEN_ACME_NEXT)).status_code == 200


@pytest.mark.parametrize("token", [TOKEN_ACME, TOKEN_ACME_NEXT, TOKEN_OTHER, TOKEN_NEW, "x" * 40])
def test_every_stored_token_is_compared_whatever_the_outcome(make_tenant_app, monkeypatch, token) -> None:
    """R4: one ``compare_digest`` per stored token (four here), for a match in any position and for a miss."""
    calls: list[int] = []
    real = auth.hmac.compare_digest

    def spy(left, right):
        calls.append(1)
        return real(left, right)

    client = TestClient(make_tenant_app(), base_url=BASE_URL)
    monkeypatch.setattr(auth.hmac, "compare_digest", spy)
    client.get(CAPABILITIES, headers=bearer(token))
    assert len(calls) == 4


# --- when the share applies, and what is published ---------------------------------------------------------


def test_one_tenant_is_not_throttled_by_the_default_limit(make_app, holder) -> None:
    """S7: gateway, worker and seed share one token; the default of 2 on 4 slots must not halve their traffic."""
    app = make_app()  # nothing set: gateway-style deployment with a single tenant
    assert published(app)["maxConcurrentOperationsPerTenant"] == 0

    async def scenario() -> list[int]:
        async with async_client(app) as client:
            tasks = [asyncio.create_task(client.post(EVALUATE, **call(TOKEN_NEW, hold=True))) for _ in range(3)]
            tasks.append(asyncio.create_task(client.post(EVALUATE, **call(TOKEN_OLD, hold=True))))
            await wait_until(lambda: holder.running == 4)
            holder.release.set()
            return [response.status_code for response in await asyncio.gather(*tasks)]

    assert run(scenario()) == [200] * 4
    assert holder.peak == 4


def test_the_default_limit_applies_when_two_tenants_are_configured(make_tenant_app, holder) -> None:
    app = make_tenant_app(acquire_timeout_ms=40)
    assert published(app)["maxConcurrentOperationsPerTenant"] == 2

    async def scenario() -> list[int]:
        async with async_client(app) as client:
            tasks = [asyncio.create_task(client.post(EVALUATE, **call(token, hold=True))) for token in (TOKEN_ACME, TOKEN_ACME_NEXT)]
            await wait_until(lambda: holder.running == 2)
            third = await client.post(EVALUATE, **call(TOKEN_ACME))
            other = await client.post(EVALUATE, **call(TOKEN_OTHER))
            holder.release.set()
            await asyncio.gather(*tasks)
            return [third.status_code, other.status_code]

    assert run(scenario()) == [429, 200]


def test_an_explicit_limit_applies_to_a_single_tenant_and_is_published(make_app, holder) -> None:
    app = make_app(max_concurrency_per_tenant=2, acquire_timeout_ms=40)
    assert published(app)["maxConcurrentOperationsPerTenant"] == 2

    async def scenario() -> list[int]:
        async with async_client(app) as client:
            tasks = [asyncio.create_task(client.post(EVALUATE, **call(TOKEN_NEW, hold=True))) for _ in range(2)]
            await wait_until(lambda: holder.running == 2)
            third = await client.post(EVALUATE, **call(TOKEN_OLD))
            holder.release.set()
            await asyncio.gather(*tasks)
            return [third.status_code]

    assert run(scenario()) == [429]


def test_zero_switches_the_share_off_even_with_several_tenants(make_tenant_app) -> None:
    assert published(make_tenant_app(max_concurrency_per_tenant=0))["maxConcurrentOperationsPerTenant"] == 0


def test_the_public_limits_are_the_effective_ones() -> None:
    settings = BimServiceSettings()
    assert settings.max_concurrency_per_tenant is None
    cases = [
        (settings, 0),  # no tokens file read yet: nothing to share between
        (settings.for_tenants(1), 0),
        (settings.for_tenants(2), 2),
        (settings.for_tenants(64), 2),
        (BimServiceSettings(max_concurrency_per_tenant=2).for_tenants(1), 2),
        (BimServiceSettings(max_concurrency_per_tenant=3).for_tenants(5), 3),
        (BimServiceSettings(max_concurrency_per_tenant=0).for_tenants(5), 0),
    ]
    for candidate, expected in cases:
        assert candidate.public_limits()["maxConcurrentOperationsPerTenant"] == expected


def test_an_anonymous_service_has_one_tenant_and_no_default_share() -> None:
    app = create_app(BimServiceSettings(allow_anonymous_dev=True))
    assert published(app)["maxConcurrentOperationsPerTenant"] == 0


def test_the_per_tenant_setting_comes_from_the_environment_only_when_set() -> None:
    assert BimServiceSettings.from_env({}).max_concurrency_per_tenant is None
    assert BimServiceSettings.from_env({"BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT": ""}).max_concurrency_per_tenant is None
    assert BimServiceSettings.from_env({"BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT": "2"}).max_concurrency_per_tenant == 2
    assert BimServiceSettings.from_env({"BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT": "0"}).max_concurrency_per_tenant == 0
    with pytest.raises(ServiceConfigError, match="BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT"):
        BimServiceSettings.from_env({"BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT": "-1"})


# --- logs ----------------------------------------------------------------------------------------------------


def test_the_log_names_the_identity_and_the_claim_but_never_a_token(make_tenant_app, caplog) -> None:
    """S8."""
    caplog.set_level(logging.DEBUG)
    client = TestClient(make_tenant_app(), base_url=BASE_URL)
    client.get(CAPABILITIES, headers=bearer(TOKEN_ACME, **{"X-BIM-Tenant": "other"}))
    client.get(CAPABILITIES, headers=bearer(TOKEN_ACME, **{"X-BIM-Tenant": "acme"}))
    client.get(CAPABILITIES, headers=bearer(TOKEN_OTHER))
    client.get(CAPABILITIES, headers={"Authorization": "", "X-BIM-Tenant": "acme"})
    lines = [record.getMessage() for record in caplog.records if record.getMessage().startswith("request ")]
    assert "tenant=acme claimed_tenant=other " in lines[0]
    assert "tenant=acme trace=" in lines[1]
    assert "tenant=other trace=" in lines[2]
    assert "tenant=- claimed_tenant=acme " in lines[3] and "status=401" in lines[3]
    for secret in (TOKEN_ACME, TOKEN_ACME_NEXT, TOKEN_OTHER, TOKEN_NEW):
        assert secret not in caplog.text
