"""A problem upload whose address already exists on disk must find the right bytes there."""

from __future__ import annotations

import hashlib
from pathlib import Path

from _b1_helpers import make_account, gate  # noqa: F401,F811
from _problem_helpers import ZIP, make_org, package_bytes
from openbinding_gateway.core.settings import get_settings


def stored_path(digest: str) -> Path:
    hexadecimal = digest.removeprefix("sha256-")
    return Path(get_settings().artifact_root) / hexadecimal[:2] / hexadecimal[2:4] / hexadecimal


async def upload(api_client, headers, org: str, slug: str, content: bytes):
    return await api_client.post(
        f"/v1/organizations/{org}/problems", params={"slug": slug}, content=content, headers={**headers, **ZIP},
    )


async def test_a_repeated_upload_of_intact_content_is_accepted(
    api_client, registration, db_session, gate  # noqa: F811
):
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, headers)
    content = package_bytes()

    first = await upload(api_client, headers, org, "first", content)
    second = await upload(api_client, headers, org, "second", content)

    assert first.status_code == 201 and second.status_code == 201, (first.text, second.text)
    assert stored_path("sha256-" + hashlib.sha256(content).hexdigest()).read_bytes() == content


async def test_a_corrupt_stored_file_is_reported_and_left_alone(
    api_client, registration, db_session, gate  # noqa: F811
):
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, headers)
    content = package_bytes()
    assert (await upload(api_client, headers, org, "first", content)).status_code == 201
    path = stored_path("sha256-" + hashlib.sha256(content).hexdigest())
    path.write_bytes(b"corrupted on disk")

    response = await upload(api_client, headers, org, "second", content)

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "content_integrity"
    assert path.read_bytes() == b"corrupted on disk"
    assert [p for p in path.parent.iterdir() if p.name != path.name] == []  # no temporary left behind
