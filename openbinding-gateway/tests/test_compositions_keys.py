"""API keys on the compositions of an organization: the composition pair, and the boundary (F1 B7)."""

from __future__ import annotations

from _b1_helpers import make_account, make_key, gate  # noqa: F401,F811
from _problem_helpers import make_org


async def bounded_key(client, headers, permissions: list[str], boundary: dict) -> dict[str, str]:
    response = await client.post(
        "/v1/users/me/api-keys",
        headers=headers,
        json={
            "name": "bounded composition key",
            "permissions": permissions,
            "engine_access": {"all": True, "engines": []},
            "boundary": boundary,
        },
    )
    assert response.status_code == 201, response.text
    return {"X-API-Key": response.json()["secret"]}


async def setup(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, headers)
    base = f"/v1/organizations/{org}/compositions"
    for slug in ("a", "b"):
        created = await api_client.post(base, headers=headers, json={"slug": slug, "name": slug})
        assert created.status_code == 201, created.text
    return headers, org, base


def refused_for(response, missing: str) -> None:
    assert response.status_code == 403, response.text
    assert response.json()["detail"]["code"] == "insufficient_api_key_permission"
    assert response.json()["detail"]["missing_permissions"] == [missing]


async def test_a_problems_key_cannot_touch_compositions(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base = await setup(api_client, registration, db_session, gate)
    key = await make_key(api_client, headers, ["problems:read", "problems:write"])

    refused_for(await api_client.get(base, headers=key), "compositions:read")
    refused_for(await api_client.get(f"{base}/a", headers=key), "compositions:read")
    refused_for(await api_client.post(base, headers=key, json={"slug": "c", "name": "C"}), "compositions:write")
    refused_for(await api_client.delete(f"{base}/a", headers=key), "compositions:write")


async def test_the_composition_pair_reads_and_writes(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base = await setup(api_client, registration, db_session, gate)
    reader = await make_key(api_client, headers, ["compositions:read"])
    writer = await make_key(api_client, headers, ["compositions:read", "compositions:write"])

    assert (await api_client.get(base, headers=reader)).json()["total"] == 2
    assert (await api_client.get(f"{base}/a", headers=reader)).status_code == 200
    refused_for(await api_client.patch(f"{base}/a", headers=reader, json={"name": "A"}), "compositions:write")
    assert (await api_client.post(base, headers=writer, json={"slug": "c", "name": "C"})).status_code == 201
    assert (await api_client.patch(f"{base}/c", headers=writer, json={"archived": True})).status_code == 200
    assert (await api_client.delete(f"{base}/c", headers=writer)).status_code == 204


async def test_a_key_bounded_to_one_slug_cannot_read_another(api_client, registration, db_session, gate):  # noqa: F811
    headers, org, base = await setup(api_client, registration, db_session, gate)
    key = await bounded_key(
        api_client, headers, ["compositions:read"],
        {"organizations": [org], "resource_kinds": ["compositions"], "slugs": ["a"]},
    )

    allowed = await api_client.get(f"{base}/a", headers=key)
    denied = await api_client.get(f"{base}/b", headers=key)

    assert allowed.status_code == 200, allowed.text
    assert denied.status_code == 403, denied.text
    assert denied.json()["detail"]["code"] == "api_key_boundary"


async def test_an_organization_admin_key_cannot_create_a_composition(api_client, registration, db_session, gate):  # noqa: F811
    headers, org, base = await setup(api_client, registration, db_session, gate)
    key = await make_key(api_client, headers, ["organizations:read", "organizations:write", "compositions:read"])

    assert (await api_client.get(f"/v1/organizations/{org}", headers=key)).status_code == 200
    refused_for(await api_client.post(base, headers=key, json={"slug": "c", "name": "C"}), "compositions:write")
    refused_for(await api_client.delete(f"{base}/a", headers=key), "compositions:write")
