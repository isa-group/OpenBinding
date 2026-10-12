"""B1 #9: the verifier names only what the caller may see; the rest looks unregistered."""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import event

from _b1_helpers import (  # noqa: F401
    SECRET,
    add_version,
    gate,
    make_account,
    make_key,
    make_org,
    put_member,
    random_digest,
)
from openbinding_gateway.db.models import (
    ArtifactPublication,
    EngineRevision,
    InstanceSnapshot,
    Project,
    Report,
    ReportState,
    Study,
    StudyRun,
    Visibility,
)

INSPECT = "/v1/verifier/inspect"
INSPECT_FILE = "/v1/verifier/inspect-file"
PROJECT = "private-proj"
CASE_TITLE = "Secret Case Title"


@pytest.fixture
async def ctx(api_client, registration, db_session, gate):
    accounts = {}
    for name in ("owner", "admin", "member", "viewer", "outsider"):
        accounts[name] = await make_account(api_client, registration, db_session, gate)
    owner, owner_headers = accounts["owner"]
    organization = await make_org(api_client, owner_headers)
    for name, role in (("admin", "ADMIN"), ("member", "MEMBER"), ("viewer", "VIEWER")):
        added = await put_member(api_client, owner_headers, organization["slug"], accounts[name][0]["id"], role)
        assert added.status_code == 200, added.text
    created = await api_client.post(
        f"/v1/organizations/{organization['slug']}/projects", headers=owner_headers,
        json={"slug": PROJECT, "name": "Private project", "visibility": "private"},
    )
    assert created.status_code == 201, created.text
    return SimpleNamespace(
        headers={name: value[1] for name, value in accounts.items()},
        accounts={name: value[0] for name, value in accounts.items()},
        org=organization["slug"], org_id=uuid.UUID(organization["id"]),
        user_id=uuid.UUID(owner["id"]), project_id=uuid.UUID(created.json()["id"]),
        projects=f"/v1/organizations/{organization['slug']}/projects/{PROJECT}",
    )


async def inspect(api_client, ctx, who: str, digest: str):
    return await api_client.post(INSPECT, headers=ctx.headers[who], json={"digest": digest})


async def inspect_file(api_client, ctx, who: str, content: bytes):
    return await api_client.post(
        INSPECT_FILE,
        headers={**ctx.headers[who], "x-filename": "f.bin", "content-type": "application/octet-stream"},
        content=content,
    )


def normalized(body: dict, digest: str) -> str:
    """The response with everything derived from the digest abstracted away."""
    text = json.dumps({key: value for key, value in body.items() if key != "verified_at"}, sort_keys=True)
    return text.replace(digest, "<digest>").replace(digest[7:19].upper(), "<doi>").replace(digest[7:15], "<short>")


def unregistered_like(response, digest: str, unknown_response, unknown_digest: str) -> None:
    assert response.status_code == unknown_response.status_code == 200
    assert response.json()["entities"] == []
    assert normalized(response.json(), digest) == normalized(unknown_response.json(), unknown_digest)
    for leak in (SECRET, CASE_TITLE, PROJECT):
        assert leak not in response.text


async def make_case(api_client, ctx) -> str:
    base = f"{ctx.projects}/cases"
    created = await api_client.post(base, headers=ctx.headers["owner"], json={"slug": "secret-case", "name": CASE_TITLE})
    assert created.status_code == 201, created.text
    revision = await api_client.post(
        f"{base}/secret-case/revisions", headers=ctx.headers["owner"],
        json={"document": {"apiVersion": "bim/v1", "kind": "BindingCase", "title": "t"}},
    )
    assert revision.status_code == 201, revision.text
    return revision.json()["digest"]


async def set_visibility(db_session, ctx, visibility: Visibility) -> None:
    project = await db_session.get(Project, ctx.project_id)
    project.visibility = visibility
    await db_session.flush()


@pytest.mark.parametrize("endpoint", [INSPECT, INSPECT_FILE])
async def test_anonymous_callers_are_still_refused(api_client, endpoint):
    response = await api_client.post(endpoint, json={"digest": random_digest()})
    assert response.status_code == 401, response.text
    assert response.json()["detail"]["code"] == "unauthorized"


async def test_members_see_a_private_case_and_everyone_else_sees_nothing(api_client, ctx):
    digest = await make_case(api_client, ctx)
    unknown = random_digest()
    unknown_response = await inspect(api_client, ctx, "outsider", unknown)

    for who in ("owner", "admin", "member", "viewer"):
        response = await inspect(api_client, ctx, who, digest)
        body = response.json()
        assert response.status_code == 200 and body["status"] == "verified", (who, response.text)
        assert [(e["entity_type"], e["organization_slug"], e["project_slug"], e["slug"]) for e in body["entities"]] == [
            ("case", ctx.org, PROJECT, "secret-case")
        ]
        assert body["entities"][0]["title_or_name"] == f"{CASE_TITLE} (r1)"

    hidden = await inspect(api_client, ctx, "outsider", digest)
    unregistered_like(hidden, digest, unknown_response, unknown)
    assert hidden.json()["status"] == "not_found" and hidden.json()["matches"] is False
    assert hidden.json()["detail"] == "Digest not registered in platform ledger."
    assert ctx.org not in hidden.text


async def test_a_document_is_computed_and_names_nothing(api_client, ctx):
    document = {"apiVersion": "bim/v1", "kind": "BindingCase", "title": "doc"}
    from openbinding_gateway.v1.canonical import digest as canonical_digest

    expected = canonical_digest(document)
    response = await api_client.post(INSPECT, headers=ctx.headers["outsider"], json={"document": document})
    assert response.status_code == 200
    assert response.json()["status"] == "computed" and response.json()["digest"] == expected
    assert response.json()["entities"] == []


async def test_a_public_project_is_visible_to_anyone_with_an_account(api_client, db_session, ctx):
    digest = await make_case(api_client, ctx)
    await set_visibility(db_session, ctx, Visibility.PUBLIC)

    opened = await inspect(api_client, ctx, "outsider", digest)
    await set_visibility(db_session, ctx, Visibility.PRIVATE)
    closed = await inspect(api_client, ctx, "outsider", digest)

    assert opened.json()["status"] == "verified"
    assert [e["project_slug"] for e in opened.json()["entities"]] == [PROJECT]
    assert closed.json()["status"] == "not_found" and closed.json()["entities"] == []


async def test_a_hidden_digest_runs_the_same_queries_as_an_unknown_one(api_client, db_session, ctx):
    digest = await make_case(api_client, ctx)
    unknown = random_digest()
    await inspect(api_client, ctx, "outsider", unknown)  # warm-up: one-off account bookkeeping

    engine = db_session.sync_session.get_bind()
    counts = []
    for target in (unknown, digest, unknown, digest):
        statements = []
        hook = lambda *args, **kwargs: statements.append(args[2])  # noqa: E731
        event.listen(engine, "before_cursor_execute", hook)
        try:
            await inspect(api_client, ctx, "outsider", target)
        finally:
            event.remove(engine, "before_cursor_execute", hook)
        counts.append(len(statements))

    assert counts[0] == counts[1] == counts[2] == counts[3], counts


async def test_files_follow_project_and_file_visibility(api_client, db_session, ctx):
    owner = ctx.headers["owner"]
    contents = {name: uuid.uuid4().bytes for name in ("public_file", "private_file")}
    for name, content in contents.items():
        uploaded = await api_client.post(
            f"{ctx.projects}/blobs?public={'true' if name == 'public_file' else 'false'}",
            headers={**owner, "Content-Type": "application/octet-stream"}, content=content,
        )
        assert uploaded.status_code == 201, uploaded.text
    unknown = uuid.uuid4().bytes

    async def seen(who, name):
        response = await inspect_file(api_client, ctx, who, contents[name])
        return response.json()["status"], [e["entity_type"] for e in response.json()["entities"]]

    # Private project: nobody outside sees even a file marked public.
    assert await seen("outsider", "public_file") == ("computed", [])
    assert await seen("viewer", "public_file") == ("verified", ["artifact"])
    assert await seen("owner", "private_file") == ("verified", ["artifact"])
    hidden = await inspect_file(api_client, ctx, "outsider", contents["private_file"])
    reference = await inspect_file(api_client, ctx, "outsider", unknown)
    digest = hidden.json()["digest"]
    assert normalized(hidden.json(), digest) == normalized(reference.json(), reference.json()["digest"])
    assert PROJECT not in hidden.text

    # Public project: only files marked public open up.
    await set_visibility(db_session, ctx, Visibility.PUBLIC)
    assert await seen("outsider", "public_file") == ("verified", ["artifact"])
    assert await seen("outsider", "private_file") == ("computed", [])
    shown = (await inspect_file(api_client, ctx, "outsider", contents["public_file"])).json()["entities"][0]
    assert shown["project_slug"] == PROJECT and shown["organization_slug"] == ctx.org


async def test_engines_are_visible_when_published_or_owned(api_client, db_session, ctx):
    owner_id = ctx.user_id
    digests = {"private": random_digest(), "published": random_digest()}
    for state, digest in digests.items():
        db_session.add(EngineRevision(
            owner_id=owner_id, namespace=f"ns-{state}", name=f"{SECRET}-{state}", version="1.0.0",
            digest=digest, document={}, state=state,
        ))
    await db_session.flush()

    owner_private = await inspect(api_client, ctx, "owner", digests["private"])
    outsider_private = await inspect(api_client, ctx, "outsider", digests["private"])
    outsider_published = await inspect(api_client, ctx, "outsider", digests["published"])
    reference = await inspect(api_client, ctx, "outsider", random_digest())

    assert [e["entity_type"] for e in owner_private.json()["entities"]] == ["engine"]
    assert [e["entity_type"] for e in outsider_published.json()["entities"]] == ["engine"]
    unregistered_like(outsider_private, digests["private"], reference, reference.json()["digest"])


async def test_snapshots_are_visible_to_their_owner_or_through_a_visible_case(api_client, db_session, ctx):
    from _b1_helpers import add_case_revision

    def snapshot(owner_id, package_digest):
        row = InstanceSnapshot(
            owner_id=owner_id, name=f"{SECRET} snapshot", instance_digest=random_digest(),
            package_digest=package_digest, root_document={}, resource_digests={}, source_archive=b"x",
        )
        db_session.add(row)
        return row

    owned, in_case = random_digest(), random_digest()
    snapshot(ctx.user_id, owned)
    attached = snapshot(ctx.user_id, in_case)
    await db_session.flush()
    await add_case_revision(db_session, ctx, digest=random_digest(), snapshot_id=attached.id)
    reference = await inspect(api_client, ctx, "outsider", random_digest())

    async def kinds(who, digest):
        return [e["entity_type"] for e in (await inspect(api_client, ctx, who, digest)).json()["entities"]]

    assert await kinds("owner", owned) == ["snapshot"]
    assert await kinds("viewer", owned) == []  # another member's private snapshot
    assert await kinds("viewer", in_case) == ["snapshot"]  # via a case of a project the viewer can open
    assert await kinds("outsider", in_case) == []
    unregistered_like(await inspect(api_client, ctx, "outsider", owned), owned, reference, reference.json()["digest"])


async def test_library_collections_follow_membership_and_publication(api_client, db_session, ctx):
    digest = random_digest()
    _, version = await add_version(
        db_session, ctx, kind="Collection", content_digest=digest, project_id=ctx.project_id
    )
    reference = await inspect(api_client, ctx, "outsider", random_digest())

    member = (await inspect(api_client, ctx, "viewer", digest)).json()
    hidden = await inspect(api_client, ctx, "outsider", digest)
    assert [(e["entity_type"], e["project_slug"]) for e in member["entities"]] == [("collection", PROJECT)]
    unregistered_like(hidden, digest, reference, reference.json()["digest"])

    db_session.add(ArtifactPublication(version_id=version.id, published_by_id=ctx.user_id))
    await db_session.flush()
    published = (await inspect(api_client, ctx, "outsider", digest)).json()
    # Published: the element is visible, but a private project is still not named.
    assert [(e["entity_type"], e["organization_slug"], e["project_slug"]) for e in published["entities"]] == [
        ("collection", ctx.org, None)
    ]
    await set_visibility(db_session, ctx, Visibility.PUBLIC)
    named = (await inspect(api_client, ctx, "outsider", digest)).json()
    assert [e["project_slug"] for e in named["entities"]] == [PROJECT]


async def test_reports_follow_membership_and_publication(api_client, db_session, ctx):
    digest = random_digest()
    artifact, version = await add_version(
        db_session, ctx, kind="Report", content_digest=digest, project_id=ctx.project_id
    )
    db_session.add(Report(
        project_id=ctx.project_id, slug="secret-report", title=f"{SECRET} report", artifact_id=artifact.id,
        version_id=version.id, state=ReportState.FROZEN, created_by_id=ctx.user_id,
    ))
    await db_session.flush()
    reference = await inspect(api_client, ctx, "outsider", random_digest())

    member = (await inspect(api_client, ctx, "member", digest)).json()
    hidden = await inspect(api_client, ctx, "outsider", digest)
    assert [e["entity_type"] for e in member["entities"]] == ["report"]
    unregistered_like(hidden, digest, reference, reference.json()["digest"])

    db_session.add(ArtifactPublication(version_id=version.id, published_by_id=ctx.user_id))
    await db_session.flush()
    published = (await inspect(api_client, ctx, "outsider", digest)).json()
    assert [(e["entity_type"], e["project_slug"]) for e in published["entities"]] == [("report", None)]


async def test_study_runs_follow_project_visibility(api_client, db_session, ctx):
    _, definition = await add_version(
        db_session, ctx, kind="Study", content_digest=random_digest(), project_id=ctx.project_id
    )
    study = Study(
        project_id=ctx.project_id, slug="secret-study", name=f"{SECRET} study",
        definition_version_id=definition.id, created_by_id=ctx.user_id,
    )
    db_session.add(study)
    await db_session.flush()
    matrix = random_digest()
    db_session.add(StudyRun(
        study_id=study.id, definition_version_id=definition.id, run_number=1,
        matrix_digest=matrix, created_by_id=ctx.user_id,
    ))
    await db_session.flush()
    reference = await inspect(api_client, ctx, "outsider", random_digest())

    member = (await inspect(api_client, ctx, "member", matrix)).json()
    hidden = await inspect(api_client, ctx, "outsider", matrix)

    assert [e["entity_type"] for e in member["entities"]] == ["study_run"]
    unregistered_like(hidden, matrix, reference, reference.json()["digest"])


async def test_api_keys_see_what_their_account_sees(api_client, ctx):
    digest = await make_case(api_client, ctx)
    key = await make_key(api_client, ctx.headers["viewer"], ["instances:read"])
    outsider_key = await make_key(api_client, ctx.headers["outsider"], ["instances:read"])
    no_permission = await make_key(api_client, ctx.headers["viewer"], ["jobs:read"])

    seen = await api_client.post(INSPECT, headers=key, json={"digest": digest})
    unseen = await api_client.post(INSPECT, headers=outsider_key, json={"digest": digest})
    refused = await api_client.post(INSPECT, headers=no_permission, json={"digest": digest})

    assert [e["entity_type"] for e in seen.json()["entities"]] == ["case"]
    assert unseen.json()["entities"] == [] and unseen.json()["status"] == "not_found"
    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == "insufficient_api_key_permission"
