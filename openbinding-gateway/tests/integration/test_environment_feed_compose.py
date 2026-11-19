"""An environment's feed on the compose stack: the Redis-backed limiter and the 304 headers (F4 A6).

Against ``gateway-dev`` directly (the CI integration stack starts no nginx; the lab's smoke checks the same headers
through its nginx). The admin seals a declared version into a new composition, creates an environment, adopts the
version and mints a feed key; then the key polls: 60 reads pass within a minute, the 61st is 429 with
``Retry-After``, and a conditional read is 304 with ``ETag`` and ``Vary``.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

GATEWAY_URL = "http://127.0.0.1:8000"
DOCUMENT = """\
syntaxVersion: "1.0"
composition: feed-check
version: 1.0.0
kind: workflow
workflow:
  seq: [t1]
binding:
  t1: {local: true}
values:
  latency: {value: 30, unit: ms}
"""


@pytest.mark.integration
def test_the_feed_is_limited_per_key_and_answers_304(bootstrap_admin_credentials: tuple[str, str]) -> None:
    username, password = bootstrap_admin_credentials
    with httpx.Client(base_url=GATEWAY_URL, timeout=30.0) as client:
        logged = client.post("/v1/auth/login", json={"username_or_email": username, "password": password})
        assert logged.status_code == 200, logged.text
        headers = {"Authorization": f"Bearer {logged.json()['access_token']}"}
        org = f"feed-{uuid.uuid4().hex[:8]}"
        assert client.post("/v1/organizations", headers=headers, json={"slug": org, "name": org}).status_code == 201
        base = f"/v1/organizations/{org}/compositions"
        created = client.post(base, headers=headers, json={"slug": "feed-check", "name": "Feed check"})
        assert created.status_code == 201, created.text
        sealed = client.post(
            f"{base}/feed-check/versions", headers={**headers, "content-type": "application/yaml"},
            content=DOCUMENT.encode(),
        )
        assert sealed.status_code == 201, sealed.text
        environments = f"{base}/feed-check/environments"
        environment = client.post(environments, headers=headers, json={"slug": "production", "name": "Production"})
        assert environment.status_code == 201, environment.text
        adopted = client.post(
            f"{environments}/production/adopt", headers={**headers, "If-Match": environment.headers["ETag"]},
            json={"version": "1.0.0"},
        )
        assert adopted.status_code == 200, adopted.text
        minted = client.post(f"{environments}/production/keys", headers=headers, json={"label": "integration"})
        assert minted.status_code == 201, minted.text
        key = {"X-API-Key": minted.json()["secret"]}
        feed = f"{environments}/production/composition"

        first = client.get(feed, headers=key)
        assert first.status_code == 200, first.text
        assert first.headers["ETag"] == f'"{sealed.json()["version"]["content_digest"]}"'
        cached = client.get(feed, headers={**key, "If-None-Match": first.headers["ETag"]})
        assert cached.status_code == 304
        assert cached.headers["ETag"] == first.headers["ETag"]
        assert cached.headers["Vary"] == "Authorization, X-API-Key"
        statuses = [client.get(feed, headers=key).status_code for _ in range(58)]
        assert set(statuses) == {200}
        limited = client.get(feed, headers=key)
        assert limited.status_code == 429, limited.text
        assert limited.json()["detail"]["code"] == "feed_rate_limited"
        assert 1 <= int(limited.headers["Retry-After"]) <= 60
