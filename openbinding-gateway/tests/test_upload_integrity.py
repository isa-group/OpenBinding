"""An upload whose address already exists on disk must find the right bytes there."""

from __future__ import annotations

import hashlib
from pathlib import Path

from _b1_helpers import make_account, make_org, gate  # noqa: F401,F811
from openbinding_gateway.core.settings import get_settings

OCTETS = {"Content-Type": "application/octet-stream"}


def stored_path(digest: str) -> Path:
    hexadecimal = digest.removeprefix("sha256-")
    return Path(get_settings().artifact_root) / hexadecimal[:2] / hexadecimal[2:4] / hexadecimal


async def project_url(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    organization = await make_org(api_client, headers)
    created = await api_client.post(
        f"/v1/organizations/{organization['slug']}/projects", headers=headers,
        json={"slug": "files", "name": "files", "visibility": "private"},
    )
    assert created.status_code == 201, created.text
    return f"/v1/organizations/{organization['slug']}/projects/files/blobs", {**headers, **OCTETS}


async def test_a_repeated_upload_of_intact_content_is_accepted(
    api_client, registration, db_session, gate  # noqa: F811
):
    url, headers = await project_url(api_client, registration, db_session, gate)

    first = await api_client.post(url, headers=headers, content=b"same bytes")
    second = await api_client.post(url, headers=headers, content=b"same bytes")

    assert first.status_code == 201 and second.status_code == 201
    assert first.json()["digest"] == second.json()["digest"]


async def test_a_corrupt_stored_file_is_reported_and_left_alone(
    api_client, registration, db_session, gate  # noqa: F811
):
    url, headers = await project_url(api_client, registration, db_session, gate)
    content = b"original bytes"
    digest = "sha256-" + hashlib.sha256(content).hexdigest()
    assert (await api_client.post(url, headers=headers, content=content)).status_code == 201
    path = stored_path(digest)
    path.write_bytes(b"corrupted on disk")

    response = await api_client.post(url, headers=headers, content=content)

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "content_integrity"
    assert path.read_bytes() == b"corrupted on disk"
    assert [p for p in path.parents[2].iterdir() if p.is_file()] == []  # no temporary left behind
