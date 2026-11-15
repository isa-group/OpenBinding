"""``MAX_PACKAGE_BYTES`` also applies to a ``.bim.zip`` sent without Content-Length.

A chunked upload has no Content-Length, so a ceiling checked against the declared size alone would let it
through. The problem upload reads the body within the ceiling and refuses it once the bytes actually read pass it.
"""

from __future__ import annotations

import pytest

from _b1_helpers import gate, make_account  # noqa: F401,F811
from _problem_helpers import ZIP, make_org, package_bytes
from openbinding_gateway.core.settings import get_settings

CEILING = 1000


@pytest.fixture
def low_ceiling(monkeypatch):
    monkeypatch.setattr(get_settings(), "max_package_bytes", CEILING)


async def chunks(data: bytes, size: int = 512):
    for start in range(0, len(data), size):
        yield data[start:start + size]


async def test_a_chunked_package_above_the_ceiling_is_refused(
    api_client, registration, db_session, gate, low_ceiling  # noqa: F811
):
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, headers)
    archive = package_bytes()
    assert len(archive) > CEILING
    url = f"/v1/organizations/{org}/problems"

    chunked = await api_client.post(url, headers={**headers, **ZIP}, content=chunks(archive))
    declared = await api_client.post(url, headers={**headers, **ZIP}, content=archive)

    assert "content-length" not in chunked.request.headers
    assert chunked.status_code == 413, chunked.text
    assert chunked.json()["detail"]["code"] == "payload_too_large"
    assert declared.status_code == 413, declared.text


async def test_a_package_within_the_ceiling_is_not_refused_for_its_size(
    api_client, registration, db_session, gate, monkeypatch  # noqa: F811
):
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, headers)
    archive = package_bytes()
    monkeypatch.setattr(get_settings(), "max_package_bytes", len(archive))

    accepted = await api_client.post(f"/v1/organizations/{org}/problems", headers={**headers, **ZIP}, content=chunks(archive))

    assert accepted.status_code == 201, accepted.text
