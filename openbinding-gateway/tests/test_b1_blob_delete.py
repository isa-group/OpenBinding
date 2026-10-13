"""B1 #5: a project file that sealed or revisioned elements depend on is not deletable."""

from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from _b1_helpers import (  # noqa: F401
    SECRET,
    add_blob,
    add_case_revision,
    add_version,
    gate,
    make_account,
    make_key,
    make_org,
    put_member,
    random_digest,
)
from openbinding_gateway.db.models import (
    Blob,
    Collection,
    CollectionItem,
    CollectionRevision,
    InstanceSnapshot,
    ProjectResource,
    ProjectResourceRevision,
    Publication,
    Report,
    ReportState,
)

@pytest.fixture
async def ctx(api_client, registration, db_session, gate):  # noqa: F811
    owner, headers = await make_account(api_client, registration, db_session, gate)
    organization = await make_org(api_client, headers)
    slug = organization["slug"]
    projects = {}
    for name in ("files", "other"):
        created = await api_client.post(
            f"/v1/organizations/{slug}/projects", headers=headers,
            json={"slug": name, "name": name, "visibility": "private"},
        )
        assert created.status_code == 201, created.text
        projects[name] = created.json()["id"]
    return SimpleNamespace(
        owner=owner, headers=headers, org=slug, org_id=uuid.UUID(organization["id"]),
        user_id=uuid.UUID(owner["id"]), project_id=uuid.UUID(projects["files"]),
        other_project_id=uuid.UUID(projects["other"]),
        url=f"/v1/organizations/{slug}/projects/files/blobs",
    )


async def upload(api_client, ctx, content: bytes | None = None) -> str:
    content = content or uuid.uuid4().bytes
    response = await api_client.post(
        ctx.url, headers={**ctx.headers, "Content-Type": "application/octet-stream"}, content=content
    )
    assert response.status_code == 201, response.text
    assert response.json()["digest"] == "sha256-" + hashlib.sha256(content).hexdigest()
    return response.json()["digest"]


async def add_collection_revision(db, ctx, *, digest: str) -> CollectionRevision:
    collection = Collection(
        project_id=ctx.project_id, slug=f"{SECRET}-col-{uuid.uuid4().hex[:6]}",
        name=f"{SECRET} collection", created_by_id=ctx.user_id,
    )
    db.add(collection)
    await db.flush()
    revision = CollectionRevision(
        collection_id=collection.id, revision=1, digest=digest, created_by_id=ctx.user_id
    )
    db.add(revision)
    await db.flush()
    return revision


# Each builder makes one dependency on `blob` (a project file); the second item is the
# `references` the refusal must report.
async def library_version(db, ctx, blob):
    await add_version(db, ctx, kind="Dataset", content_digest=blob.digest, project_id=ctx.project_id)


async def version_pointing_at_the_blob(db, ctx, blob):
    await add_version(db, ctx, kind="Dataset", content_digest=random_digest(), blob=blob)


async def sealed_report(db, ctx, blob):
    await add_version(db, ctx, kind="Report", content_digest=blob.digest, project_id=ctx.project_id)


async def sealed_collection(db, ctx, blob):
    await add_version(db, ctx, kind="Collection", content_digest=blob.digest, project_id=ctx.project_id)


async def case_revision(db, ctx, blob):
    await add_case_revision(db, ctx, digest=blob.digest)


async def package_snapshot(db, ctx, blob):
    snapshot = InstanceSnapshot(
        owner_id=ctx.user_id, name=f"{SECRET} snapshot", instance_digest=random_digest(),
        package_digest=blob.digest, root_document={}, resource_digests={}, source_archive=b"x",
    )
    db.add(snapshot)
    await db.flush()
    await add_case_revision(db, ctx, digest=random_digest(), snapshot_id=snapshot.id)


async def resource_snapshot(db, ctx, blob):
    from openbinding_gateway.db.models import InstanceResource

    snapshot = InstanceSnapshot(
        owner_id=ctx.user_id, name=f"{SECRET} snapshot", instance_digest=random_digest(),
        package_digest=random_digest(), root_document={}, resource_digests={}, source_archive=b"x",
    )
    db.add(snapshot)
    await db.flush()
    db.add(InstanceResource(
        snapshot_id=snapshot.id, resource_id="r1", role="catalog", api_version="bim/v1", kind="Catalog",
        dialect_id="d", path="catalog.json", digest=blob.digest, media_type="application/json", content=b"{}",
    ))
    await db.flush()
    await add_case_revision(db, ctx, digest=random_digest(), snapshot_id=snapshot.id)


async def legacy_collection_revision(db, ctx, blob):
    await add_collection_revision(db, ctx, digest=blob.digest)


async def collection_item(db, ctx, blob):
    revision = await add_collection_revision(db, ctx, digest=random_digest())
    db.add(CollectionItem(
        collection_revision_id=revision.id, position=0, target_kind="instance",
        target_digest=blob.digest, target_ref={}, added_by_id=ctx.user_id,
    ))
    await db.flush()


async def resource_revision(db, ctx, blob):
    resource = ProjectResource(
        project_id=ctx.project_id, slug=f"{SECRET}-res", name=f"{SECRET} resource", created_by_id=ctx.user_id
    )
    db.add(resource)
    await db.flush()
    db.add(ProjectResourceRevision(
        project_resource_id=resource.id, revision=1, digest=blob.digest, document={}, created_by_id=ctx.user_id
    ))
    await db.flush()


async def published_report(db, ctx, blob):
    artifact, version = await add_version(
        db, ctx, kind="Report", content_digest=blob.digest, project_id=ctx.project_id
    )
    report = Report(
        project_id=ctx.project_id, slug=f"{SECRET}-report", title=f"{SECRET} report", artifact_id=artifact.id,
        version_id=version.id, state=ReportState.FROZEN, created_by_id=ctx.user_id,
    )
    db.add(report)
    await db.flush()
    db.add(Publication(
        project_id=ctx.project_id, report_id=report.id, version_id=version.id,
        slug=f"{SECRET}-publication", citation={}, published_by_id=ctx.user_id,
    ))
    await db.flush()


def refs(**counts: int) -> list[dict]:
    return [{"type": kind, "count": count} for kind, count in sorted(counts.items())]


SCENARIOS = {
    "library_version": (library_version, refs(library_version=1)),
    "version_blob_id": (version_pointing_at_the_blob, refs(library_version=1)),
    "sealed_report": (sealed_report, refs(report=1)),
    "sealed_collection": (sealed_collection, refs(collection_revision=1)),
    "case_revision": (case_revision, refs(case_revision=1)),
    "package_snapshot": (package_snapshot, refs(case_revision=1, snapshot=1)),
    "resource_snapshot": (resource_snapshot, refs(case_revision=1, snapshot=1)),
    "legacy_collection_revision": (legacy_collection_revision, refs(collection_revision=1)),
    "collection_item": (collection_item, refs(collection_revision=1)),
    "project_resource_revision": (resource_revision, refs(project_resource_revision=1)),
    "published_report": (published_report, refs(publication=1, report=1)),
}


async def test_an_unreferenced_file_is_deleted(api_client, ctx):
    digest = await upload(api_client, ctx)

    deleted = await api_client.delete(f"{ctx.url}/{digest}", headers=ctx.headers)
    listing = await api_client.get(ctx.url, headers=ctx.headers)
    again = await api_client.delete(f"{ctx.url}/{digest}", headers=ctx.headers)

    assert deleted.status_code == 204, deleted.text
    assert listing.json() == []
    assert again.status_code == 404


@pytest.mark.parametrize("scenario", sorted(SCENARIOS))
async def test_a_file_something_sealed_depends_on_is_refused(api_client, db_session, ctx, scenario):
    builder, expected = SCENARIOS[scenario]
    digest = await upload(api_client, ctx)
    blob = (await db_session.execute(
        select(Blob).where(Blob.project_id == ctx.project_id, Blob.digest == digest)
    )).scalars().one()
    await builder(db_session, ctx, blob)

    response = await api_client.delete(f"{ctx.url}/{digest}", headers=ctx.headers)

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "blob_in_use"
    assert detail["references"] == expected
    assert SECRET not in response.text
    # Nothing was removed: row and bytes are still there.
    assert Path(blob.storage_uri).is_file()
    listing = await api_client.get(ctx.url, headers=ctx.headers)
    assert [row["digest"] for row in listing.json()] == [digest]


async def test_every_dependency_kind_is_counted_together(api_client, db_session, ctx):
    digest = await upload(api_client, ctx)
    blob = (await db_session.execute(
        select(Blob).where(Blob.project_id == ctx.project_id, Blob.digest == digest)
    )).scalars().one()
    for builder in (library_version, case_revision, collection_item, resource_revision, published_report):
        await builder(db_session, ctx, blob)
    await case_revision(db_session, ctx, blob)

    response = await api_client.delete(f"{ctx.url}/{digest}", headers=ctx.headers)

    assert response.status_code == 409
    assert response.json()["detail"]["references"] == refs(
        case_revision=2, collection_revision=1, library_version=1, project_resource_revision=1,
        publication=1, report=1,
    )


async def test_dependencies_of_other_projects_do_not_block(api_client, db_session, ctx):
    digest = await upload(api_client, ctx)
    # The same digest, but sealed into artifacts of a different project.
    await add_version(db_session, ctx, kind="Dataset", content_digest=digest, project_id=ctx.other_project_id)
    await add_blob(db_session, ctx, digest, project_id=ctx.other_project_id)

    deleted = await api_client.delete(f"{ctx.url}/{digest}", headers=ctx.headers)

    assert deleted.status_code == 204, deleted.text


async def test_an_unrelated_dependency_does_not_block(api_client, db_session, ctx):
    digest = await upload(api_client, ctx)
    await add_version(db_session, ctx, kind="Dataset", content_digest=random_digest(), project_id=ctx.project_id)
    await add_case_revision(db_session, ctx, digest=random_digest())

    deleted = await api_client.delete(f"{ctx.url}/{digest}", headers=ctx.headers)

    assert deleted.status_code == 204, deleted.text


async def test_roles_and_credentials(api_client, registration, db_session, gate, ctx):  # noqa: F811
    viewer, viewer_headers = await make_account(api_client, registration, db_session, gate)
    member, member_headers = await make_account(api_client, registration, db_session, gate)
    _, outsider_headers = await make_account(api_client, registration, db_session, gate)
    admin, admin_headers = await make_account(api_client, registration, db_session, gate)
    for account, role in ((viewer, "VIEWER"), (member, "MEMBER"), (admin, "ADMIN")):
        assert (await put_member(api_client, ctx.headers, ctx.org, account["id"], role)).status_code == 200
    digest = await upload(api_client, ctx)
    await add_version(db_session, ctx, kind="Dataset", content_digest=digest, project_id=ctx.project_id)

    # The 409 is the same for every caller who may delete at all; others are refused first.
    outcomes = {}
    for name, headers in (
        ("viewer", viewer_headers), ("member", member_headers), ("outsider", outsider_headers),
        ("anonymous", {}), ("admin", admin_headers), ("owner", ctx.headers),
    ):
        response = await api_client.delete(f"{ctx.url}/{digest}", headers=headers)
        outcomes[name] = (response.status_code, response.json()["detail"]["code"])

    assert outcomes == {
        "viewer": (403, "organization_forbidden"),
        "member": (403, "organization_forbidden"),
        "outsider": (403, "organization_forbidden"),
        "anonymous": (401, "unauthorized"),
        "admin": (409, "blob_in_use"),
        "owner": (409, "blob_in_use"),
    }


async def test_api_keys_need_the_artifact_write_permission(api_client, db_session, ctx):
    writer = await make_key(api_client, ctx.headers, ["artifacts:write"])
    reader = await make_key(api_client, ctx.headers, ["artifacts:read"])
    protected = await upload(api_client, ctx)
    await add_version(db_session, ctx, kind="Dataset", content_digest=protected, project_id=ctx.project_id)
    loose = await upload(api_client, ctx)

    read_only = await api_client.delete(f"{ctx.url}/{loose}", headers=reader)
    refused = await api_client.delete(f"{ctx.url}/{protected}", headers=writer)
    deleted = await api_client.delete(f"{ctx.url}/{loose}", headers=writer)

    assert read_only.status_code == 403
    assert read_only.json()["detail"]["code"] == "insufficient_api_key_permission"
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "blob_in_use"
    assert deleted.status_code == 204, deleted.text


async def test_unknown_digests_stay_404_for_admins(api_client, ctx):
    response = await api_client.delete(f"{ctx.url}/{random_digest()}", headers=ctx.headers)
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "not_found"
    assert json.dumps(response.json()).count("references") == 0
