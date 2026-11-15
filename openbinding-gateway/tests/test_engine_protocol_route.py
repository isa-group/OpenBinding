"""``GET /v1/engines/protocol``: what a federated engine reads to register, anonymously (D12)."""

from __future__ import annotations

import pytest

from openbinding_gateway.integrations import bim
from openbinding_gateway.services.engines import profiles_document

pytestmark = pytest.mark.asyncio


async def test_the_protocol_is_the_profile_entry_and_answers_anybody(api_client):
    response = await api_client.get("/v1/engines/protocol")

    assert response.status_code == 200, response.text
    assert response.json() == profiles_document()
    entry = response.json()["profiles"][0]
    assert entry["protocolDigest"] == bim.protocol_digest()
    assert entry["protocol"] == "bim-engine/v1"


async def test_the_route_is_not_taken_for_an_engine_name(api_client):
    # Declared before /engines/{name}, which would answer 401 (it needs an account) or 422 (no namespace).
    response = await api_client.get("/v1/engines/protocol", params={"namespace": "x", "version": "1", "digest": "d"})

    assert response.status_code == 200, response.text
    assert "profiles" in response.json()


async def test_an_api_key_needs_no_permission_for_it(api_client):
    response = await api_client.get("/v1/engines/protocol", headers={"X-API-Key": "obk_00000000_not-a-key"})

    assert response.status_code == 200, response.text
