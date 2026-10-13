"""The plan's ``maxPayloadBytes`` also applies to a ``.bim.zip`` sent without Content-Length.

A chunked upload has no Content-Length, so the route reported a body size of 0
and the submission skipped the plan ceiling. The size of the bytes actually
read is what counts when the declared size is 0 or unknown.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from _repo import REPO_ROOT
from openbinding_gateway import space_client
from openbinding_gateway.services import job_submission
from openbinding_gateway.services.job_submission import JobSubmission, JobSubmissionInput, _Finished
from openbinding_gateway.space_client import OpenCaps, OpenGate, PlanCaps
from bim_core.package import load_package

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
CEILING = 1000


def low_ceiling_caps() -> PlanCaps:
    limits = dict(OpenCaps().limits)
    limits["maxPayloadBytes"] = CEILING
    return PlanCaps(plan="MICRO", features={"solve": True}, limits=limits)


class LowCeilingGate(OpenGate):
    """A fake SPACE whose plan allows only ``CEILING`` bytes of payload."""

    async def caps(self, user_id):
        return low_ceiling_caps()


@pytest.fixture
def no_dispatch(monkeypatch):
    from openbinding_gateway.routes import v1 as routes

    async def queued(*args, **kwargs):
        return None

    monkeypatch.setattr(routes, "dispatch_persisted_job", queued)


async def chunks(data: bytes, size: int = 512):
    for start in range(0, len(data), size):
        yield data[start:start + size]


async def test_a_chunked_package_above_the_plan_ceiling_is_refused(
    api_client, registration, no_dispatch, monkeypatch
):
    # A package upload cannot carry the execution mode and optimization, so engine selection would
    # stop it first; the upload, the compilation and the plan ceiling are what this test is about.
    async def any_engine(self, source):
        return SimpleNamespace(options={})

    monkeypatch.setattr(JobSubmission, "_select_engine", any_engine)
    space_client.set_gate(LowCeilingGate())
    details = registration()
    assert (await api_client.post("/v1/auth/register", json=details)).status_code == 201
    login = await api_client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]}
    )
    headers = {
        "Authorization": f"Bearer {login.json()['access_token']}",
        "Content-Type": "application/vnd.bim+zip",
    }
    archive = load_package(EXAMPLE).to_zip()
    assert len(archive) > CEILING

    chunked = await api_client.post("/v1/jobs", headers=headers, content=chunks(archive))
    declared = await api_client.post("/v1/jobs", headers=headers, content=archive)

    assert "content-length" not in chunked.request.headers
    assert chunked.status_code == 413, chunked.text
    assert chunked.json()["title"] == "payload_too_large"
    assert declared.status_code == 413, declared.text


def caller_and_terms(monkeypatch, ceiling: int):
    caps = low_ceiling_caps()
    caps.limits["maxPayloadBytes"] = ceiling
    monkeypatch.setattr(job_submission.entitlement_service, "caps_for", AsyncMock(return_value=caps))
    submission = JobSubmission(None, SimpleNamespace(id="caller"))
    source = SimpleNamespace(compilation=SimpleNamespace(binding_space_log10=0.0))
    engine = SimpleNamespace(options={})
    return submission, source, engine


async def test_the_size_of_the_archive_stands_in_for_an_unknown_body_size(monkeypatch):
    submission, source, engine = caller_and_terms(monkeypatch, CEILING)
    unknown_size = JobSubmissionInput({}, 0, None, archive=b"x" * (CEILING + 1))

    with pytest.raises(_Finished) as refused:
        await submission._plan_terms(unknown_size, source, engine)

    assert refused.value.result.status == 413
    assert refused.value.result.body["title"] == "payload_too_large"


async def test_an_archive_within_the_ceiling_is_not_refused_for_its_size(monkeypatch):
    submission, source, engine = caller_and_terms(monkeypatch, CEILING)
    unknown_size = JobSubmissionInput({}, 0, None, archive=b"x" * CEILING)

    terms = await submission._plan_terms(unknown_size, source, engine)

    assert terms.caps.limit("maxPayloadBytes") == CEILING
