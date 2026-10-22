"""Library content is user-controlled bytes: it is always served as a sandboxed attachment."""

from __future__ import annotations

import re
import uuid

import pytest
import pytest_asyncio

from openbinding_gateway import space_client
from _pricing import fake_pricing_gate, largest_plan

HTML = '<!doctype html><html><body><script>fetch("/steal?"+localStorage.getItem("token"))</script></body></html>\n'
SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"><script>alert(1)</script></svg>\n'


@pytest_asyncio.fixture
async def platform_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


async def owner(client, registration, gate):
    details = registration()
    created = await client.post('/v1/auth/register', json=details)
    login = await client.post('/v1/auth/login',
        json={'username_or_email': details['username'], 'password': details['password']})
    gate.plans[uuid.UUID(created.json()['id'])] = largest_plan()
    return {'Authorization': f"Bearer {login.json()['access_token']}"}


async def sealed_dataset(client, headers, media_type: str, text: str, name: str) -> tuple[str, str]:
    org = f'library-{uuid.uuid4().hex[:8]}'
    assert (await client.post('/v1/organizations', headers=headers, json={'slug': org, 'name': 'Library lab'})).status_code == 201
    created = await client.post(f'/v1/organizations/{org}/library', headers=headers,
        json={'name': name, 'display_name': name, 'kind': 'Dataset'})
    assert created.status_code == 201, created.text
    base = f"/v1/artifacts/{created.json()['id']}"
    draft = await client.post(f'{base}/drafts', headers=headers, json={'content': text, 'media_type': media_type})
    assert draft.status_code == 201, draft.text
    sealed = await client.post(f"{base}/drafts/{draft.json()['id']}/seal", headers=headers, json={'revision': 1})
    assert sealed.status_code == 201, sealed.text
    return base, sealed.json()['id']


def assert_hardened(response, media_type: str, text: str) -> None:
    assert response.status_code == 200, response.text
    assert response.headers['content-type'].startswith(media_type)
    assert response.content == text.encode()
    disposition = response.headers['content-disposition']
    match = re.fullmatch(r'attachment; filename="([A-Za-z0-9._-]+)"', disposition)
    assert match, disposition
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert response.headers['content-security-policy'] == "default-src 'none'; sandbox"
    assert response.headers['etag'].startswith('"') and response.headers['etag'].endswith('"')


@pytest.mark.parametrize('media_type,text', [('text/html', HTML), ('image/svg+xml', SVG)])
async def test_private_content_is_an_attachment_with_unchanged_bytes(api_client, registration, platform_gate, media_type, text):
    headers = await owner(api_client, registration, platform_gate)
    # The artifact name is chosen by the uploader; the download name must not follow it.
    base, version = await sealed_dataset(api_client, headers, media_type, text, 'evil-name')
    response = await api_client.get(f'{base}/versions/{version}/content', headers=headers)
    assert_hardened(response, media_type, text)
    assert 'evil' not in response.headers['content-disposition']
    assert response.headers['cache-control'] == 'private, no-store'


@pytest.mark.parametrize('media_type,text', [('text/html', HTML), ('image/svg+xml', SVG)])
async def test_published_content_keeps_public_caching_and_is_hardened_for_anonymous_readers(
        api_client, registration, platform_gate, media_type, text):
    headers = await owner(api_client, registration, platform_gate)
    base, version = await sealed_dataset(api_client, headers, media_type, text, 'published-page')
    published = await api_client.post(f'{base}/versions/{version}/publish', headers=headers, json={})
    assert published.status_code == 200, published.text
    owner_response = await api_client.get(f'{base}/versions/{version}/content', headers=headers)
    anonymous = await api_client.get(f'{base}/versions/{version}/content')
    for response in (owner_response, anonymous):
        assert_hardened(response, media_type, text)
        assert response.headers['cache-control'] == 'public, max-age=31536000, immutable'
    assert anonymous.headers['etag'] == owner_response.headers['etag']
    assert anonymous.headers['content-disposition'] == owner_response.headers['content-disposition']
