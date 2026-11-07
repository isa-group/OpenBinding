"""A novation guarded against concurrent edits, through the real client, offline.

``SpacePricingGate`` drives the installed ``space-python-client`` here; only the
client's HTTP transport is replaced (``httpx.MockTransport``) by ``FakeSpace``, a
few lines that answer like a SPACE advertising ``novation-preview``,
``contract-version`` and ``keep-billing-period`` - as the remote SPACE did on
2026-11-07. Nothing leaves the process. What is pinned:

* the change is first run as a dry run, then written with ``If-Match`` set to the
  contract version it was decided on, keeping the billing period, and never
  asking SPACE to refuse private plans;
* a contract that moved before the dry run, or between it and the write, is
  ``ContractChanged`` and the contract is left as somebody else left it;
* a SPACE without those capabilities gets the unconditional write it always got;
* a guarantee SPACE dropped *after* writing is reported as the change it is.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Callable

import httpx
import pytest

from openbinding_gateway.core import public_errors
from openbinding_gateway.core.settings import Settings
from openbinding_gateway.space_client import space as space_adapter
from openbinding_gateway.space_client import (
    ContractChanged,
    PricingUnavailable,
    SpacePricingGate,
    SubscriptionRejected,
)
from space_client import AsyncSpaceClient, SpaceConnectionOptions

SERVICE = "openbinding"
VERSION = "0.2.0"
USER = uuid.UUID("00000000-0000-4000-8000-000000000001")
CONTRACT = f"/api/v1/contracts/{USER}"
PREVIEW = f"{CONTRACT}/novation/preview"
#: What the remote SPACE advertises that these tests rely on (a subset of its header).
GUARDED = "contract-version,keep-billing-period,reject-private,novation-preview,idempotency-key"
PERIOD_START = "2026-11-01T00:00:00.000Z"
PERIOD_END = "2026-12-01T00:00:00.000Z"


class FakeSpace:
    """The contract endpoints of one SPACE contract, answering as SPACE does."""

    def __init__(self, capabilities: str | None = GUARDED, *, versions: bool = True):
        self.capabilities = capabilities
        self.versions = versions
        self.version = 1
        self.plan = "FREE"
        self.add_ons: dict[str, int] = {}
        self.start = PERIOD_START
        self.end = PERIOD_END
        self.history: list[dict] = []
        self.refusals: list[dict] = []
        self.sends_etag = True
        self.keeps_period = True
        self.requests: list[httpx.Request] = []
        #: Something that happens to the contract between the dry run and the write.
        self.before_write: Callable[[], None] | None = None
        #: Something that happens to SPACE while it answers the dry run.
        self.during_preview: Callable[[], None] | None = None

    def somebody_else_changes_it(self) -> None:
        self.plan = "LAB"
        self.version += 1

    def _contract(self) -> dict:
        document = {
            "userContact": {"userId": str(USER), "username": str(USER)},
            "billingPeriod": {
                "startDate": self.start, "endDate": self.end, "autoRenew": True, "renewalDays": 30,
            },
            "contractedServices": {SERVICE: VERSION},
            "subscriptionPlans": {SERVICE: self.plan},
            "subscriptionAddOns": {SERVICE: dict(self.add_ons)} if self.add_ons else {},
            "usageLevels": {},
            "history": list(self.history),
        }
        if self.versions:
            document["contractVersion"] = f"v{self.version}"
        return document

    def _answer(self, status: int, body: dict, etag: bool = False) -> httpx.Response:
        headers = {}
        if self.capabilities is not None:
            headers["X-Space-Capabilities"] = self.capabilities
        if etag and self.versions and self.sends_etag:
            headers["ETag"] = f'"v{self.version}"'
        return httpx.Response(status, json=body, headers=headers)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/api/v1/healthcheck":
            return self._answer(200, {"message": "Service is up and running!"})
        if path == CONTRACT and request.method == "GET":
            return self._answer(200, self._contract(), etag=True)
        if path == PREVIEW and request.method == "POST":
            if self.during_preview is not None:
                self.during_preview()
            body = json.loads(request.content)
            preview = {
                "valid": not self.refusals,
                "errors": self.refusals,
                "effective": body,
                "billingPeriod": {
                    "startDate": self.start,
                    "endDate": self.end,
                    "restarts": request.url.params.get("keepBillingPeriod") != "true",
                },
            }
            if self.versions:
                preview["contractVersion"] = f"v{self.version}"
            return self._answer(200, preview)
        if path == CONTRACT and request.method == "PUT":
            if self.before_write is not None:
                self.before_write()
            expected = request.headers.get("if-match")
            if expected is not None and expected.strip('"') != f"v{self.version}":
                return self._answer(412, {"error": "CONTRACT_CHANGED", "contractVersion": f"v{self.version}"})
            body = json.loads(request.content)
            self.history.append({"startDate": self.start, "endDate": self.end})
            self.plan = body["subscriptionPlans"][SERVICE]
            self.add_ons = dict((body.get("subscriptionAddOns") or {}).get(SERVICE, {}))
            if request.url.params.get("keepBillingPeriod") != "true" or not self.keeps_period:
                self.start, self.end = "2026-11-08T00:00:00.000Z", "2026-12-08T00:00:00.000Z"
            self.version += 1
            return self._answer(200, self._contract(), etag=True)
        return self._answer(404, {"error": f"no route for {request.method} {path}"})

    def sent(self, method: str, path: str) -> list[httpx.Request]:
        return [request for request in self.requests if request.method == method and request.url.path == path]


@pytest.fixture
async def connect():
    """A gate over the real client, whose HTTP goes to the given ``FakeSpace``."""
    clients: list[AsyncSpaceClient] = []

    async def gate_over(space: FakeSpace) -> SpacePricingGate:
        client = AsyncSpaceClient(SpaceConnectionOptions(url="https://space.invalid", api_key="k"))
        await client._http_client.aclose()
        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(space.handle))
        clients.append(client)
        return SpacePricingGate(Settings(_env_file=None), client=client)

    yield gate_over
    for client in clients:
        await client.close()


@pytest.fixture
async def space():
    return FakeSpace()


@pytest.fixture
async def gate(space, connect):
    return await connect(space)


@pytest.fixture
def logs(caplog, monkeypatch) -> pytest.LogCaptureFixture:
    """The gateway's log lines, even after a test that configured logging in-process (alembic does)."""
    monkeypatch.setattr(public_errors.logger, "disabled", False)
    monkeypatch.setattr(space_adapter.logger, "disabled", False)
    caplog.set_level(logging.INFO)
    return caplog


# -- Guarded --------------------------------------------------------------------


async def test_a_change_is_dry_run_then_written_to_the_version_it_was_decided_on(space, gate):
    decided_on = await gate.subscription(USER)

    after = await gate.change_subscription(
        USER, "LAB", {}, VERSION, expected_contract_version=decided_on.contract_version
    )

    assert decided_on.contract_version == "v1"
    [preview] = space.sent("POST", PREVIEW)
    [write] = space.sent("PUT", CONTRACT)
    assert preview.url.params.get("keepBillingPeriod") == "true"
    assert write.url.params.get("keepBillingPeriod") == "true"
    assert write.headers["if-match"] == '"v1"'
    assert all("rejectPrivate" not in request.url.params for request in space.requests)
    assert (space.plan, after.plan, after.contract_version) == ("LAB", "LAB", "v2")
    # The billing period was kept: the renewal date did not move.
    assert after.renews_at == PERIOD_END


async def test_a_contract_changed_before_the_dry_run_is_refused_without_writing(space, gate):
    decided_on = await gate.subscription(USER)
    space.somebody_else_changes_it()

    with pytest.raises(ContractChanged) as refused:
        await gate.change_subscription(
            USER, "FREE", {}, VERSION, expected_contract_version=decided_on.contract_version
        )

    assert isinstance(refused.value, PricingUnavailable)
    assert space.sent("PUT", CONTRACT) == []
    assert space.plan == "LAB"


async def test_a_contract_changed_between_the_dry_run_and_the_write_is_refused_by_space(space, gate):
    decided_on = await gate.subscription(USER)
    space.before_write = space.somebody_else_changes_it

    with pytest.raises(ContractChanged):
        await gate.change_subscription(
            USER, "FREE", {}, VERSION, expected_contract_version=decided_on.contract_version
        )

    [write] = space.sent("PUT", CONTRACT)
    assert write.headers["if-match"] == '"v1"'
    assert (space.plan, space.version) == ("LAB", 2)


async def test_a_plan_change_is_computed_on_its_own_read_unless_the_caller_decided_earlier(space, gate):
    space.add_ons = {"seats": 2}

    await gate.change_plan(USER, "LAB", VERSION)
    [write] = space.sent("PUT", CONTRACT)
    assert write.headers["if-match"] == '"v1"'
    assert space.add_ons == {"seats": 2}

    with pytest.raises(ContractChanged):
        await gate.change_plan(USER, "FREE", VERSION, expected_contract_version="v1")
    assert space.plan == "LAB"


async def test_without_a_version_from_the_caller_the_dry_run_supplies_it(space, gate):
    await gate.change_subscription(USER, "LAB", {}, VERSION)

    [write] = space.sent("PUT", CONTRACT)
    assert write.headers["if-match"] == '"v1"'


async def test_a_selection_the_dry_run_refuses_is_rejected_and_never_written(space, gate):
    space.refusals = [{"code": "PLAN_NOT_FOUND", "service": SERVICE, "message": "Plan GOLD does not exist"}]

    with pytest.raises(SubscriptionRejected, match="PLAN_NOT_FOUND"):
        await gate.change_subscription(USER, "GOLD", {}, VERSION)

    assert space.sent("PUT", CONTRACT) == []


async def test_no_version_to_condition_the_write_on_is_an_outage_not_an_unguarded_write(connect):
    space = FakeSpace(versions=False)
    gate = await connect(space)

    with pytest.raises(PricingUnavailable) as refused:
        await gate.change_subscription(USER, "LAB", {}, VERSION)

    assert not isinstance(refused.value, (ContractChanged, SubscriptionRejected))
    assert space.sent("PUT", CONTRACT) == []


async def test_capabilities_lost_before_the_write_leave_the_contract_alone(space, gate):
    space.during_preview = lambda: setattr(space, "capabilities", "novation-preview,keep-billing-period")

    with pytest.raises(PricingUnavailable) as refused:
        await gate.change_subscription(USER, "LAB", {}, VERSION, expected_contract_version="v1")

    assert not isinstance(refused.value, (ContractChanged, SubscriptionRejected))
    assert space.sent("PUT", CONTRACT) == []
    assert space.plan == "FREE"


# -- A guarantee dropped after writing ---------------------------------------------


@pytest.mark.parametrize("dropped", ["sends_etag", "keeps_period"])
async def test_a_guarantee_space_dropped_after_writing_is_reported_as_the_change_it_is(
    space, gate, logs, dropped
):
    setattr(space, dropped, False)

    after = await gate.change_subscription(USER, "LAB", {}, VERSION, expected_contract_version="v1")

    assert (space.plan, after.plan) == ("LAB", "LAB")
    assert "SPACE novation guarantee failed: SpaceFeatureUnsupportedError" in logs.text


# -- Unguarded ---------------------------------------------------------------------


async def test_a_space_without_the_capabilities_gets_the_unconditional_write(connect, logs):
    space = FakeSpace(capabilities=None)
    gate = await connect(space)

    await gate.change_subscription(USER, "LAB", {}, VERSION, expected_contract_version="v1")

    [write] = space.sent("PUT", CONTRACT)
    assert space.sent("POST", PREVIEW) == []
    assert "if-match" not in write.headers
    assert dict(write.url.params) == {}
    assert space.plan == "LAB"
    assert "without a concurrency guard" in logs.text


async def test_the_billing_period_is_kept_whenever_space_can_keep_it(connect):
    space = FakeSpace(capabilities="keep-billing-period")
    gate = await connect(space)

    after = await gate.change_subscription(USER, "LAB", {}, VERSION)

    [write] = space.sent("PUT", CONTRACT)
    assert space.sent("POST", PREVIEW) == []
    assert "if-match" not in write.headers
    assert write.url.params.get("keepBillingPeriod") == "true"
    assert after.renews_at == PERIOD_END
