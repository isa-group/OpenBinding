"""B6: internal error text reaching public responses.

Closed by contract C1 (``tests/test_public_errors.py``): an unhandled exception
does not put its text in the public 500, and that 500 carries a ``correlationId``.

Closed by contracts C2 and C3 (``tests/test_job_error_text.py``,
``tests/test_pricing_public_errors.py``): the owner's view of ``result.error`` is a
fixed sentence of the catalog (no host names of engine endpoints, driver
messages or whatever an engine wrote), and the pricing 503s do not repeat the
reason the SPACE / SPHERE clients gave (one of them to anonymous callers).
A VIEWER's view of a failed job carries a fixed sentence too (B1).
"""

from __future__ import annotations

from httpx import ASGITransport, AsyncClient

from openbinding_gateway import space_client
from openbinding_gateway.db.models import JobState
from openbinding_gateway.security.redaction import GENERIC_ERROR, redact_result
from openbinding_gateway.services import execution
from openbinding_gateway.space_client import PricingUnavailable
from openbinding_gateway.v1 import remote
from openbinding_gateway.v1.remote import RemoteEngineError, RemoteRegistration

from ._helpers import account_headers, account_with_snapshot, only_job, precondition, submit

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


async def test_the_transport_does_not_name_the_engine_host_in_the_jobs_error(
    api_client, db_session, registration, monkeypatch
):
    """Closed (C2): the transport still names the host in its message; the job shows a fixed sentence."""
    real_solve = remote.solve_remote

    async def solve(*_args, **_kwargs):
        unreachable = RemoteRegistration(endpoint=f"https://{PRIVATE_HOST}:8443", mappings={})
        return await real_solve(unreachable, {}, {}, {}, timeout_s=2.0)

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await account_with_snapshot(api_client, registration)
    await submit(api_client, headers, snapshot_id)

    body = await _public_view_of_the_only_job(api_client, db_session, headers)

    assert PRIVATE_HOST not in body


async def test_an_unexpected_exception_text_does_not_reach_the_jobs_error(
    api_client, db_session, registration, monkeypatch
):
    """Closed (C2): whatever ``exc`` says, the job shows the sentence of its code."""

    async def solve(*_args, **_kwargs):
        raise RuntimeError("connection to server at db-internal.corp (10.1.2.3), port 5432 failed")

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await account_with_snapshot(api_client, registration)
    await submit(api_client, headers, snapshot_id)

    body = await _public_view_of_the_only_job(api_client, db_session, headers)

    assert "db-internal.corp" not in body
    assert "10.1.2.3" not in body


async def test_the_error_text_an_engine_writes_is_bounded(api_client, db_session, registration, monkeypatch):
    """Closed (C2): an engine's own ``error`` (up to the 4 MiB response limit) is never the job's error."""

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


async def test_the_pricing_503_does_not_repeat_the_reason_of_the_pricing_client(api_client, registration):
    """Closed (C3): ``routes/users.py`` answers the fixed sentence of ``pricing_unavailable``."""
    headers = await account_headers(api_client, registration)
    space_client.set_gate(_UnreachablePricing())

    response = await api_client.get("/v1/users/me/pricing-token", headers=headers)

    precondition(response.status_code == 503, f"answered {response.status_code}")
    assert "space.internal.corp" not in response.text


async def test_the_anonymous_pricing_503_does_not_repeat_what_sphere_said(api_client, monkeypatch):
    """Closed (C3): ``routes/pricing.py`` answers an anonymous caller with a fixed sentence."""
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


async def test_the_public_500_carries_a_correlation_id(api_client, registration, monkeypatch):
    """Closed (contract C1): the 500 is ``internal_error`` and names its log line in ``correlationId``."""
    response = await _unhandled_500(api_client, registration, monkeypatch)

    assert "correlation" in (response.text + repr(dict(response.headers))).lower()
    assert response.json()["code"] == "internal_error"
