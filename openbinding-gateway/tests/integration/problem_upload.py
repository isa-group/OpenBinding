"""Upload a ``.bim.zip`` as a problem of a new organization of the caller, and read its compilation."""

from __future__ import annotations

import uuid

import httpx

ZIP = {"Content-Type": "application/vnd.bim+zip"}


def upload_problem(client: httpx.Client, headers: dict[str, str], archive: bytes) -> dict:
    """``{"org", "problem", "revision", "compilation", "created", "revision_path"}`` of a fresh upload.

    Each call makes its own organization, so uploading one package twice gives two problems.
    """
    org = f"integration-{uuid.uuid4().hex[:10]}"
    created = client.post("/v1/organizations", headers=headers, json={"slug": org, "name": org})
    assert created.status_code == 201, created.text
    uploaded = client.post(f"/v1/organizations/{org}/problems", headers={**headers, **ZIP}, content=archive)
    assert uploaded.status_code == 201, uploaded.text
    body = uploaded.json()
    revision_path = f"/v1/organizations/{org}/problems/{body['problem']['slug']}/revisions/{body['revision']['id']}"
    return {"org": org, **body, "revision_path": revision_path}


def compatible_modes(client: httpx.Client, headers: dict[str, str], upload: dict) -> list[dict]:
    """The engine modes the caller can run the uploaded revision with (``GET .../compilation``)."""
    response = client.get(f"{upload['revision_path']}/compilation", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["compatible_modes"]
