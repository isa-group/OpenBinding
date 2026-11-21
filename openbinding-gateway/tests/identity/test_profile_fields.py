"""The display name and the avatar: set in Settings in local mode, Identity's in scoretech mode (F5-C C3, owner Q21).

``PATCH /v1/users/me`` takes ``display_name`` and ``avatar`` (SCORETech Identity's descriptor shapes) without the current
password in ``local`` mode: they are what others see, not a way in. Absent keeps a field, null removes it. In
``scoretech`` mode both are Identity's, re-synced from every sign-in, so a change answers 409 ``managed_by_identity``.
"""

from __future__ import annotations

import pytest

from _b1_helpers import gate, make_account  # noqa: F401

LEAF = {"kind": "icon", "assetId": "leaf", "backgroundColor": "#212529", "foregroundColor": "#FFFFFF"}


async def test_local_mode_sets_and_removes_both_without_a_password(api_client, registration, db_session, gate) -> None:  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)

    changed = await api_client.patch(
        "/v1/users/me", headers=headers, json={"display_name": "  Lucía   Vega ", "avatar": LEAF}
    )
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert body["display_name"] == "Lucía Vega"
    assert body["avatar"] == {**LEAF, "foregroundColor": "#ffffff"}

    # Absent keeps a field; the display name alone changes.
    renamed = await api_client.patch("/v1/users/me", headers=headers, json={"display_name": "Lucía"})
    assert renamed.json()["display_name"] == "Lucía" and renamed.json()["avatar"]["assetId"] == "leaf"

    preset = await api_client.patch("/v1/users/me", headers=headers, json={"avatar": {"kind": "preset", "assetId": "fox"}})
    assert preset.json()["avatar"] == {"kind": "preset", "assetId": "fox"}

    cleared = await api_client.patch("/v1/users/me", headers=headers, json={"display_name": "", "avatar": None})
    assert cleared.status_code == 200
    assert cleared.json()["display_name"] is None and cleared.json()["avatar"] is None
    assert (await api_client.get("/v1/users/me", headers=headers)).json()["avatar"] is None


@pytest.mark.parametrize(
    "change",
    [
        {"avatar": {"kind": "photo", "imageUrl": "https://example.invalid/me.png"}},
        {"avatar": {"kind": "preset", "assetId": "dragon"}},
        {"avatar": {"kind": "preset", "assetId": "owl", "backgroundColor": "#212529"}},
        {"avatar": {"kind": "icon", "assetId": "leaf", "backgroundColor": "graphite", "foregroundColor": "#ffffff"}},
        {"avatar": {"kind": "initials", "backgroundColor": "#fff", "foregroundColor": "#000000"}},
        {"avatar": "static/avatars/users/default/avatar-1.svg"},
        {"display_name": "x" * 161},
    ],
)
async def test_anything_else_is_refused(api_client, registration, db_session, gate, change) -> None:  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    refused = await api_client.patch("/v1/users/me", headers=headers, json=change)
    assert refused.status_code == 422, refused.text
    assert (await api_client.get("/v1/users/me", headers=headers)).json()["avatar"] is None


async def test_the_credentials_still_need_the_password(api_client, registration, db_session, gate) -> None:  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    refused = await api_client.patch(
        "/v1/users/me", headers=headers, json={"display_name": "Ana", "email": "ana-new@example.org"}
    )
    assert refused.status_code == 401
    assert (await api_client.get("/v1/users/me", headers=headers)).json()["display_name"] is None


@pytest.mark.parametrize("change", [{"display_name": "Someone Else"}, {"avatar": LEAF}, {"avatar": None}])
async def test_both_are_identitys_in_scoretech_mode(browser, fake_issuer, db_session, change) -> None:
    from ._flow import known_user, sign_in

    user, _, person = await known_user(db_session, fake_issuer)
    await sign_in(browser, fake_issuer, person)
    token = (await browser.post("/v1/auth/identity/session")).json()["access_token"]
    headers = {"authorization": f"Bearer {token}"}
    refused = await browser.patch("/v1/users/me", json=change, headers=headers)
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "managed_by_identity"
    assert "display name and avatar" in refused.json()["detail"]["error"]
    # What Identity shared at sign-in stands.
    me = (await browser.get("/v1/users/me", headers=headers)).json()
    assert me["display_name"] == person.display_name
    assert me["avatar"] == {"kind": "initials", "backgroundColor": "#212529", "foregroundColor": "#ffffff"}
