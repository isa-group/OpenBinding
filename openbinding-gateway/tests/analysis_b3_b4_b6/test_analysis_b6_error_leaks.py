"""B6 at head cd0e05f: internal error text reaching public responses.

Closed here: a VIEWER's view of a failed job carries a fixed sentence, and an
unhandled exception does not put its text in the public 500.

Open here (``xfail(strict=True)``): the owner's view of ``result.error`` is the
raw ``str(exc)`` (host names of engine endpoints, driver messages, whatever an
engine wrote), the pricing 503s repeat the reason the SPACE / SPHERE clients
gave (one of them to anonymous callers), and the gateway has no correlation id
on its errors.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from openbinding_gateway import space_client
from openbinding_gateway.db.models import JobState
from openbinding_gateway.security.redaction import GENERIC_ERROR, redact_result
from openbinding_gateway.services import execution
from openbinding_gateway.space_client import PricingUnavailable
from openbinding_gateway.v1 import remote
from openbinding_gateway.v1.remote import RemoteEngineError, RemoteRegistration

from ._helpers import account_headers, account_with_snapshot, only_job, precondition, submit

OPEN = pytest.mark.xfail(strict=True, raises=AssertionError)

#: ``.invalid`` never resolves (RFC 2606), so the real transport fails offline and says why.
PRIVATE_HOST = "private-engine.invalid"


async def _public_view_of_the_only_job(client, db_session, headers) -> str:
    job = await only_job(db_session)
    precondition(job.state is JobState.FAILED, f"the job ended {job.state.value}, not failed")
    response = await client.get(f"/v1/jobs/{job.id}", headers=headers)
    precondition(response.status_code == 200, f"GET /v1/jobs/<id> answered {response.status_code}")
    return response.text


async def test_a_viewers_view_of_a_failed_job_carries_a_fixed_sentence():
    """Closed (B1): ``security/redaction.py`` replaces the stored text."""
    stored = {
        "termination": "UNKNOWN",
        "solutions": [],
        "error": f"engine request failed: connect to https://{PRIVATE_HOST}:8443 refused",
    }

    redacted = redact_result(stored)

    assert redacted["error"] == GENERIC_ERROR
    assert PRIVATE_HOST not in repr(redacted)
    assert stored["error"].endswith("refused")  # the stored row is not touched


@OPEN
async def test_the_transport_does_not_name_the_engine_host_in_the_jobs_error(
    api_client, db_session, registration, monkeypatch
):
    """B6 open: ``v1/remote.py:90`` puts the host in the message and ``execution.py:312`` stores ``str(exc)``."""
    real_solve = remote.solve_remote

    async def solve(*_args, **_kwargs):
        unreachable = RemoteRegistration(endpoint=f"https://{PRIVATE_HOST}:8443", mappings={})
        return await real_solve(unreachable, {}, {}, {}, timeout_s=2.0)

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await account_with_snapshot(api_client, registration)
    await submit(api_client, headers, snapshot_id)

    body = await _public_view_of_the_only_job(api_client, db_session, headers)

    assert PRIVATE_HOST not in body


@OPEN
async def test_an_unexpected_exception_text_does_not_reach_the_jobs_error(
    api_client, db_session, registration, monkeypatch
):
    """B6 open: ``services/execution.py:355-357`` stores ``Execution failed: {exc}`` whatever ``exc`` is."""

    async def solve(*_args, **_kwargs):
        raise RuntimeError("connection to server at db-internal.corp (10.1.2.3), port 5432 failed")

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await account_with_snapshot(api_client, registration)
    await submit(api_client, headers, snapshot_id)

    body = await _public_view_of_the_only_job(api_client, db_session, headers)

    assert "db-internal.corp" not in body
    assert "10.1.2.3" not in body


@OPEN
async def test_the_error_text_an_engine_writes_is_bounded(api_client, db_session, registration, monkeypatch):
    """B6 open: an engine's own ``error`` (up to the 4 MiB response limit) is stored as the job's error."""

    async def solve(*_args, **_kwargs):
        raise RemoteEngineError("x" * 100_000)

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await account_with_snapshot(api_client, registration)
    await submit(api_client, headers, snapshot_id)

    job = await only_job(db_session)
    precondition(job.state is JobState.FAILED, "the job failed")

    assert len(job.result["error"]) <= 1024


class _UnreachablePricing:
    """A SPACE stand-in that is down. Nothing is sent anywhere."""

    async def pricing_token(self, user_id):
        raise PricingUnavailable(
            "SPACE is not reachable: HTTPSConnectionPool(host='space.internal.corp', port=443)"
        )


@OPEN
async def test_the_pricing_503_does_not_repeat_the_reason_of_the_pricing_client(api_client, registration):
    """B6 open: ``routes/users.py:572-577`` (and the other handlers listed in the analysis report) put ``{error}`` of ``PricingUnavailable`` in the 503."""
    headers = await account_headers(api_client, registration)
    space_client.set_gate(_UnreachablePricing())

    response = await api_client.get("/v1/users/me/pricing-token", headers=headers)

    precondition(response.status_code == 503, f"answered {response.status_code}")
    assert "space.internal.corp" not in response.text


@OPEN
async def test_the_anonymous_pricing_503_does_not_repeat_what_sphere_said(api_client, monkeypatch):
    """B6 open: ``routes/pricing.py:42-45`` answers an anonymous caller with ``str(PricingCatalogError)``."""
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.pricing_catalog import PricingCatalogError
    from openbinding_gateway.routes import pricing

    async def unavailable(_settings):
        raise PricingCatalogError("SPHERE is unavailable: ConnectError to https://sphere.internal.corp")

    monkeypatch.setattr(get_settings(), "sphere_enabled", True)
    monkeypatch.setattr(pricing, "published_pricing", unavailable)

    response = await api_client.get("/v1/pricing/current")

    precondition(response.status_code == 503, f"answered {response.status_code}")
    assert "sphere.internal.corp" not in response.text


async def _unhandled_500(api_client, registration, monkeypatch):
    from openbinding_gateway.main import app

    headers = await account_headers(api_client, registration)

    async def boom(*_args, **_kwargs):
        raise RuntimeError("secret-internal-host.corp exploded")

    monkeypatch.setattr("openbinding_gateway.repositories.jobs.list_owned", boom)
    # The shared client re-raises application errors; a real client sees the 500.
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://gateway") as client:
        response = await client.get("/v1/jobs", headers=headers)
    precondition(response.status_code == 500, f"answered {response.status_code}")
    return response


async def test_an_unhandled_exception_does_not_put_its_text_in_the_public_500(
    api_client, registration, monkeypatch
):
    """Closed: Starlette answers a fixed body; the traceback goes to the log."""
    response = await _unhandled_500(api_client, registration, monkeypatch)

    assert "secret-internal-host.corp" not in response.text
    assert "Traceback" not in response.text


@OPEN
async def test_the_public_500_carries_a_correlation_id(api_client, registration, monkeypatch):
    """B6 open: no module of the gateway defines one (only ``bim-service`` does); a 500 cannot be matched to its log."""
    response = await _unhandled_500(api_client, registration, monkeypatch)

    assert "correlation" in (response.text + repr(dict(response.headers))).lower()
