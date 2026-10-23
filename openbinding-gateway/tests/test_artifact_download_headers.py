"""A stored blob is user content: it is only ever served as an inert attachment.

The upload keeps the client's ``Content-Type``, and the SPA lives on the same origin as the
API, so a downloaded HTML/SVG file must never be rendered inline by a browser.
"""

from __future__ import annotations

import re
import uuid
from urllib.parse import quote

import pytest
from sqlalchemy import select

from _b1_helpers import make_account, make_org, gate  # noqa: F401,F811
from openbinding_gateway.db.models import Blob, Organization, Project

HTML = b"<!doctype html><script>fetch('/v1/users/me', {headers: localStorage})</script>"
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>'

SAFE_DISPOSITION = re.compile(r'^attachment; filename="[A-Za-z0-9._-]+"$')


def assert_inert(response, digest: str | None = None) -> None:
    assert response.status_code == 200, response.text
    disposition = response.headers["content-disposition"]
    assert SAFE_DISPOSITION.fullmatch(disposition), disposition
    if digest is not None:
        assert disposition == f'attachment; filename="{digest}"'
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["etag"].startswith('"') and response.headers["etag"].endswith('"')
    for name, value in response.headers.items():
        assert "\r" not in value and "\n" not in value, name


@pytest.fixture
async def project(api_client, registration, db_session, gate):  # noqa: F811
    account, headers = await make_account(api_client, registration, db_session, gate)
    organization = await make_org(api_client, headers)
    created = await api_client.post(
        f"/v1/organizations/{organization['slug']}/projects", headers=headers,
        json={"slug": "files", "name": "files", "visibility": "public"},
    )
    assert created.status_code == 201, created.text
    return {
        "url": f"/v1/organizations/{organization['slug']}/projects/files",
        "headers": headers,
        "user_id": uuid.UUID(account["id"]),
        "organization": organization["slug"],
    }


@pytest.mark.parametrize(
    ("content_type", "content"), [("text/html", HTML), ("image/svg+xml", SVG)]
)
async def test_active_content_is_served_as_an_attachment(api_client, project, content_type, content):
    uploaded = await api_client.post(
        f"{project['url']}/blobs", headers={**project["headers"], "Content-Type": content_type},
        content=content,
    )
    assert uploaded.status_code == 201, uploaded.text
    digest = uploaded.json()["digest"]

    response = await api_client.get(f"{project['url']}/blobs/{digest}", headers=project["headers"])

    assert_inert(response, digest)
    assert response.content == content  # the bytes are untouched; only the delivery changes


async def test_anonymous_readers_of_a_public_blob_get_the_same_headers(api_client, project):
    uploaded = await api_client.post(
        f"{project['url']}/blobs?public=true",
        headers={**project["headers"], "Content-Type": "text/html"}, content=HTML,
    )
    assert uploaded.status_code == 201, uploaded.text
    digest = uploaded.json()["digest"]

    response = await api_client.get(f"{project['url']}/blobs/{digest}")

    assert_inert(response, digest)
    assert response.content == HTML


async def test_a_hostile_digest_cannot_break_or_inject_into_the_headers(
    api_client, db_session, project, tmp_path
):
    # Uploads always compute the digest, but nothing in the schema guarantees its shape, so the
    # header must be safe whatever the row holds: quotes, CR/LF, separators and non-Latin-1.
    hostile = 'x";\r\nX-Injected: 1\\..☃'
    organization = (await db_session.execute(
        select(Organization).where(Organization.slug == project["organization"])
    )).scalars().one()
    row = (await db_session.execute(
        select(Project).where(Project.organization_id == organization.id, Project.slug == "files")
    )).scalars().one()
    stored = tmp_path / "hostile.bin"
    stored.write_bytes(SVG)
    db_session.add(Blob(
        organization_id=organization.id, project_id=row.id, digest=hostile,
        media_type="image/svg+xml", size_bytes=len(SVG), storage_uri=str(stored),
        public=False, created_by_id=project["user_id"],
    ))
    await db_session.flush()

    response = await api_client.get(
        f"{project['url']}/blobs/{quote(hostile, safe='')}", headers=project["headers"]
    )

    assert_inert(response)
    assert "x-injected" not in response.headers
    assert response.content == SVG
