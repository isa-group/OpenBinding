"""Seed data that the routes removed by M9.6 used to create (design.md §7, tasks.md S7).

Not a test module (no ``test_`` prefix). Tests whose setup called the report editor, the
library editor or the project-resource writes seed through the internal services here
instead: ``artifacts.seal_draft``, ``reports.create_report_context`` and
``reports.seal_report``. The rows are the ones those routes wrote.
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


async def report(db, project, user, *, slug: str, title: str, document: dict, study_run_id=None,
                 freeze: bool = False):
    """A project report through ``reports.create_report_context`` (and ``seal_report`` when ``freeze``)."""
    from openbinding_gateway.reports import create_report_context, seal_report

    project, user = await _project(db, project), await _user(db, user)
    value = await create_report_context(db, project, user, slug=slug, title=title, document=document,
        study_run_id=study_run_id)
    if freeze:
        await seal_report(db, value, user)
    return value


async def new_edition(db, value, user, document: dict | None = None):
    """A new sealed version of a frozen report, optionally with a new document (the removed draft, edit and
    freeze routes)."""
    from openbinding_gateway.reports import new_report_draft, seal_report

    user = await _user(db, user)
    draft = await new_report_draft(db, value, user)
    if document is not None:
        draft.payload = {**draft.payload, "content": document}
        draft.revision += 1
        await db.flush()
    return await seal_report(db, value, user)


async def report_publication(db, value, user, *, slug: str, citation: dict | None = None, version_id=None):
    """The rows the removed ``POST .../publications`` wrote: the version's publication and the project's."""
    from openbinding_gateway.db.models import Publication

    user = await _user(db, user)
    version_id = version_id or value.version_id
    recorded = {"title": value.title, **(citation or {})}
    if await db.get(ArtifactPublication, version_id) is None:
        db.add(ArtifactPublication(version_id=version_id, citation=recorded, published_by_id=user.id))
    row = Publication(project_id=value.project_id, report_id=value.id, version_id=version_id, slug=slug,
        citation=recorded, published_by_id=user.id)
    db.add(row)
    await db.flush()
    return row


async def project_by_slugs(db, org: str, project: str) -> Project:
    from sqlalchemy import select

    from openbinding_gateway.db.models import Organization

    return await db.scalar(select(Project).join(Organization, Organization.id == Project.organization_id)
        .where(Organization.slug == org, Project.slug == project))
