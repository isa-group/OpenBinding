"""Seed data that the routes removed by M9.6 used to create (design.md §7, tasks.md S7).

Not a test module (no ``test_`` prefix). Tests whose setup called the library editor or the
project-resource writes seed through the internal services here instead
(``artifacts.seal_draft``). The rows are the ones those routes wrote.
"""

from __future__ import annotations

import uuid

from bim_core.canonical import canonical_json, digest

from openbinding_gateway.artifacts import seal_draft, store_blob
from openbinding_gateway.db.models import (
    Artifact,
    ArtifactDraft,
    ArtifactPublication,
    ArtifactVersion,
    Project,
    ProjectArtifact,
    User,
)
from openbinding_gateway.models.artifacts import DraftContent


async def _user(db, user) -> User:
    return user if isinstance(user, User) else await db.get(User, uuid.UUID(str(user)))


async def _project(db, project) -> Project:
    return project if isinstance(project, Project) else await db.get(Project, uuid.UUID(str(project)))


async def project_resource(db, project, user, *, slug: str, name: str, kind: str = "bim-resource",
                           description: str = "", documents=()) -> tuple[Artifact, list[ArtifactVersion]]:
    """A project resource and one revision per JSON document, as the former write routes stored them."""
    project, user = await _project(db, project), await _user(db, user)
    resource = Artifact(organization_id=project.organization_id, namespace=str(project.organization_id),
        name=slug, display_name=name, description=description, kind=kind, created_by_id=user.id)
    db.add(resource)
    await db.flush()
    db.add(ProjectArtifact(project_id=project.id, artifact_id=resource.id))
    await db.flush()
    versions = []
    for ordinal, document in enumerate(documents, 1):
        content_digest = digest(document)
        blob = await store_blob(db, resource, user, canonical_json(document), "application/json")
        manifest = {"apiVersion": "openbinding/artifact/v1", "kind": resource.kind,
            "identity": {"namespace": resource.namespace, "name": resource.name, "version": str(ordinal)},
            "contentDigest": content_digest, "mediaType": "application/json", "contracts": [], "dependencies": []}
        version = ArtifactVersion(artifact_id=resource.id, ordinal=ordinal, version=str(ordinal), blob_id=blob.id,
            content_digest=content_digest, version_digest=digest(manifest), manifest=manifest, created_by_id=user.id)
        db.add(version)
        await db.flush()
        versions.append(version)
    return resource, versions


async def library_artifact(db, organization_id, user, *, name: str, kind: str, display_name: str | None = None,
                           description: str = "") -> Artifact:
    """An organization library artifact, as ``POST /v1/organizations/{org}/library`` created it."""
    user = await _user(db, user)
    organization_id = uuid.UUID(str(organization_id))
    row = Artifact(organization_id=organization_id, namespace=str(organization_id), name=name,
        display_name=display_name or name, description=description, kind=kind, created_by_id=user.id)
    db.add(row)
    await db.flush()
    return row


async def seal(db, artifact: Artifact, user, content, *, media_type: str = "application/json", version=None,
               dependencies=(), contracts=(), based_on_id=None) -> ArtifactVersion:
    """Draft ``content`` and seal it with ``artifacts.seal_draft`` (what the draft and seal routes did)."""
    user = await _user(db, user)
    payload = DraftContent(content=content, media_type=media_type, contracts=list(contracts),
        dependencies=list(dependencies)).model_dump(mode="json")
    draft = ArtifactDraft(artifact_id=artifact.id, payload=payload, based_on_id=based_on_id, created_by_id=user.id)
    db.add(draft)
    await db.flush()
    return await seal_draft(db, artifact, draft, draft.revision, version, user)


async def publish(db, version: ArtifactVersion, user, citation: dict | None = None) -> ArtifactPublication:
    """The publication record of a version (the removed publish route wrote this row)."""
    user = await _user(db, user)
    row = ArtifactPublication(version_id=version.id, citation=citation or {}, published_by_id=user.id)
    db.add(row)
    await db.flush()
    return row


async def project_by_slugs(db, org: str, project: str) -> Project:
    from sqlalchemy import select

    from openbinding_gateway.db.models import Organization

    return await db.scalar(select(Project).join(Organization, Organization.id == Project.organization_id)
        .where(Organization.slug == org, Project.slug == project))
