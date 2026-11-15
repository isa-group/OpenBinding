"""Where a problem revision came from (F2b B3): the producer read into an origin, and the list filters on it.

The origin is fixed when the revision is stored, from the upload's ``?producer=``; the problem list filters on the
origin of each problem's latest revision.
"""

from __future__ import annotations

import typing
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from _b1_helpers import make_account, gate  # noqa: F401
from _problem_helpers import EXAMPLE, ZIP, make_org, package_bytes, seed_problem_run
from openbinding_gateway.db.models import BindingCaseRevision, User
from openbinding_gateway.modules.problems.application import ORIGINS, ProblemOrigin, origin_of

#: Another package, to make a second revision of a problem.
SECOND = package_bytes(EXAMPLE.parent / "02_parallel")


@pytest.mark.parametrize(
    ("producer", "origin"),
    [
        (None, "upload"),
        ("", "upload"),
        ("openbinding-upload", "upload"),
        ("openbinding-problem-editor", "editor"),
        ("qacoforge", "qacoforge"),
        ("qacoforge-push", "qacoforge"),
        ("qacoforge.cli", "qacoforge"),
        ("sphere", "upload"),
        ("a-script", "upload"),
    ],
)
def test_the_producer_is_read_into_an_origin(producer, origin):
    assert origin_of(producer) == origin


def test_the_origins_are_one_closed_list():
    assert ORIGINS == typing.get_args(ProblemOrigin) == ("upload", "editor", "qacoforge", "sphere")


async def upload(api_client, headers, org, *, producer=None, slug="checkout", archive=None, path="problems"):
    url = f"/v1/organizations/{org}/problems" + (f"/{slug}/revisions" if path == "revisions" else "")
    params = {"producer": producer} if producer else {}
    if path == "problems":
        params["slug"] = slug
    response = await api_client.post(
        url, params=params, content=archive or package_bytes(), headers={**headers, **ZIP},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_a_revision_keeps_its_producer_and_its_origin(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, headers)

    made = await upload(api_client, headers, org, producer="openbinding-problem-editor")

    assert made["revision"]["origin"] == "editor"
    assert made["revision"]["provenance"] == {"producer": "openbinding-problem-editor"}
    assert made["problem"]["latest_revision"]["origin"] == "editor"
    stored = await db_session.scalar(
        select(BindingCaseRevision).where(BindingCaseRevision.id == uuid.UUID(made["revision"]["id"]))
    )
    assert stored.origin == "editor"
    read = await api_client.get(f"/v1/organizations/{org}/problems/checkout/revisions/1", headers=headers)
    assert read.json()["origin"] == "editor"
    listed = await api_client.get(f"/v1/organizations/{org}/problems/checkout/revisions", headers=headers)
    assert [row["origin"] for row in listed.json()] == ["editor"]


async def test_the_list_filters_on_the_origin_of_the_latest_revision(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, headers)
    await upload(api_client, headers, org, producer="openbinding-problem-editor", slug="edited")
    await upload(api_client, headers, org, producer="qacoforge", slug="generated")
    # ``moved`` began in the editor; its latest revision is an upload, so it is an upload now.
    await upload(api_client, headers, org, producer="openbinding-problem-editor", slug="moved")
    await upload(api_client, headers, org, slug="moved", archive=SECOND, path="revisions")

    async def slugs(**params):
        response = await api_client.get(f"/v1/organizations/{org}/problems", params=params, headers=headers)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["total"] == len(body["problems"])
        return [row["slug"] for row in body["problems"]]

    assert await slugs() == ["edited", "generated", "moved"]
    assert await slugs(origin="editor") == ["edited"]
    assert await slugs(origin="qacoforge") == ["generated"]
    assert await slugs(origin="upload") == ["moved"]
    assert await slugs(origin="sphere") == []
    assert await slugs(origin="editor", q="mov") == []
    refused = await api_client.get(f"/v1/organizations/{org}/problems", params={"origin": "other"}, headers=headers)
    assert refused.status_code == 422


async def test_the_database_refuses_an_unknown_origin(db_session):
    user = User(
        username=f"u{uuid.uuid4().hex[:8]}", email=f"{uuid.uuid4().hex[:8]}@example.org", password_hash="x", plan_cache="FREE",
    )
    db_session.add(user)
    await db_session.flush()
    seeded = await seed_problem_run(db_session, created_by_id=user.id)
    revision = await db_session.get(BindingCaseRevision, seeded["revision_id"])
    assert revision.origin == "upload"
    revision.origin = "elsewhere"
    with pytest.raises(IntegrityError):
        await db_session.flush()
