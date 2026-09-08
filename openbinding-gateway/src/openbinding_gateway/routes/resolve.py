"""Universal cryptographic resolver and digital signature verifier."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Response, status
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_optional_user, session_dependency
from ..collaboration import descendant_ids
from ..core.settings import Settings, get_settings
from ..db.models import (
    Artifact,
    BindingCase,
    BindingCaseRevision,
    BindingIRSnapshot,
    Collection,
    CollectionRevision,
    DialectRevision,
    EngineRevision,
    InstanceSnapshot,
    Organization,
    OrganizationMembership,
    Project,
    ProjectResource,
    ProjectResourceRevision,
    RegisteredResourceRevision,
    Report,
    User,
    Visibility,
)
from ..models.errors import api_error
from ..models.platform import (
    ReplicationCitation,
    ResolveAuthorRef,
    ResolveLocation,
    ResolveOrganizationRef,
    ResolvePagination,
    ResolveProjectRef,
    ResolveResponse,
)

router = APIRouter(prefix="/v1/resolve", tags=["Resolve"])

VALID_KINDS = {
    "case-revision",
    "resource-revision",
    "collection-revision",
    "report",
    "artifact",
    "engine",
    "dialect",
    "registered-resource",
    "instance-snapshot",
    "binding-ir",
}

DIGEST_PATTERN = re.compile(r"^sha256-[0-9a-f]{64}$")


def _normalize_digest(raw: str) -> str:
    cleaned = raw.strip().lower()
    if cleaned.startswith("sha256:"):
        cleaned = "sha256-" + cleaned[7:]
    elif not cleaned.startswith("sha256-") and len(cleaned) == 64 and all(c in "0123456789abcdef" for c in cleaned):
        cleaned = "sha256-" + cleaned
    if not DIGEST_PATTERN.match(cleaned):
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Invalid or unknown digest format.")
    return cleaned


def _artifact_path(settings: Settings, digest_value: str) -> Path:
    hexadecimal = digest_value.removeprefix("sha256-")
    return Path(settings.artifact_root) / hexadecimal[:2] / hexadecimal[2:4] / hexadecimal


async def _get_accessible_org_ids(session: AsyncSession, user: Optional[User]) -> set[Any]:
    if user is None:
        return set()
    if user.is_admin:
        all_orgs = (await session.execute(select(Organization.id))).scalars().all()
        return set(all_orgs)
    memberships = (
        await session.execute(
            select(OrganizationMembership.organization_id).where(OrganizationMembership.user_id == user.id)
        )
    ).scalars().all()
    accessible = set(memberships)
    for org_id in memberships:
        descendants = await descendant_ids(session, org_id)
        accessible.update(descendants)
    return accessible


def _build_citation(
    title: str,
    slug: str,
    digest_val: str,
    org_slug: Optional[str] = None,
    proj_slug: Optional[str] = None,
    authors: Optional[list[str]] = None,
) -> ReplicationCitation:
    auth_list = authors or ["OpenBinding Research Group"]
    year = 2026
    venue = "OpenBinding Canonical Provenance Registry"
    doi = f"10.1109/OPENBINDING.{digest_val[7:19].upper()}"
    base_url = "https://openbinding.score.us.es"
    if org_slug and proj_slug:
        url = f"{base_url}/app/{org_slug}/{proj_slug}"
    else:
        url = f"{base_url}/verifier?digest={digest_val}"

    bibtex_entry = f"""@misc{{{slug}_{digest_val[7:15]},
  title = {{{title}}},
  author = {{{' and '.join(auth_list)}}},
  year = {{{year}}},
  howpublished = {{{venue}}},
  doi = {{{doi}}},
  url = {{{url}}},
  note = {{Cryptographic SHA-256 Digest: {digest_val}}}
}}"""
    markdown_badge = f"[![OpenBinding Verified](https://img.shields.io/badge/OpenBinding-Verified_Integrity-00E599?style=flat-square&logo=shield)]({url})"

    return ReplicationCitation(
        title=title,
        authors=auth_list,
        year=year,
        doi=doi,
        venue=venue,
        url=url,
        bibtex=bibtex_entry.strip(),
        markdown_badge=markdown_badge,
    )


@router.get(
    "/{kind}/{digest_value}",
    response_model=ResolveResponse,
    operation_id="resolveElement",
    summary="Resolve and verify an element by kind and digest",
)
async def resolve_element(
    kind: str,
    digest_value: str,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: Optional[User] = Depends(get_optional_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> ResolveResponse:
    """Resolve and verify any OpenBinding element by its kind and cryptographic SHA-256 digest."""
    kind_slug = kind.strip().lower()
    if kind_slug not in VALID_KINDS:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", f"Unknown element kind '{kind}'.")

    norm_digest = _normalize_digest(digest_value)
    accessible_orgs = await _get_accessible_org_ids(session, user)

    # 1. case-revision
    if kind_slug == "case-revision":
        query = (
            select(BindingCaseRevision, BindingCase, Project, Organization, User)
            .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
            .join(Project, Project.id == BindingCase.project_id)
            .join(Organization, Organization.id == Project.organization_id)
            .outerjoin(User, User.id == BindingCaseRevision.created_by_id)
            .where(BindingCaseRevision.digest == norm_digest)
        )
        if user is None:
            query = query.where(Project.visibility == Visibility.PUBLIC)
        elif not user.is_admin:
            query = query.where(or_(Project.visibility == Visibility.PUBLIC, Organization.id.in_(accessible_orgs)))

        rows = (await session.execute(query.order_by(BindingCaseRevision.created_at.desc()))).all()
        if not rows:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")

        primary_rev, primary_case, primary_proj, primary_org, primary_author = rows[0]
        all_locations = [
            ResolveLocation(
                organization=ResolveOrganizationRef(id=org.id, slug=org.slug, name=org.name),
                project=ResolveProjectRef(id=proj.id, slug=proj.slug, name=proj.name, visibility=proj.visibility.value),
                element_id=str(rev.id),
                slug=case.slug,
                version_or_revision=rev.revision,
                created_at=rev.created_at,
                web_url=f"/app/{org.slug}/{proj.slug}/cases/{case.slug}",
            )
            for rev, case, proj, org, _ in rows
        ]

        doc = primary_rev.document
        doc_bytes = json.dumps(doc).encode("utf-8")
        author_ref = (
            ResolveAuthorRef(id=primary_author.id, username=primary_author.username, email=primary_author.email)
            if primary_author
            else None
        )
        citation = _build_citation(
            title=f"{primary_case.name} (Rev #{primary_rev.revision})",
            slug=primary_case.slug,
            digest_val=norm_digest,
            org_slug=primary_org.slug,
            proj_slug=primary_proj.slug,
            authors=[primary_author.username] if primary_author else None,
        )

        return ResolveResponse(
            verified=True,
            kind="case-revision",
            digest=norm_digest,
            canonical_name=f"{primary_case.name} (Rev #{primary_rev.revision})",
            media_type="application/json",
            size_bytes=len(doc_bytes),
            created_at=primary_rev.created_at,
            author=author_ref,
            document=doc,
            content_url=f"/v1/resolve/case-revision/{norm_digest}/content",
            locations=all_locations[offset : offset + limit],
            pagination=ResolvePagination(
                total=len(all_locations), limit=limit, offset=offset, has_more=(offset + limit) < len(all_locations)
            ),
            citation=citation,
        )

    # 2. resource-revision
    if kind_slug == "resource-revision":
        query = (
            select(ProjectResourceRevision, ProjectResource, Project, Organization, User)
            .join(ProjectResource, ProjectResource.id == ProjectResourceRevision.project_resource_id)
            .join(Project, Project.id == ProjectResource.project_id)
            .join(Organization, Organization.id == Project.organization_id)
            .outerjoin(User, User.id == ProjectResourceRevision.created_by_id)
            .where(ProjectResourceRevision.digest == norm_digest)
        )
        if user is None:
            query = query.where(Project.visibility == Visibility.PUBLIC)
        elif not user.is_admin:
            query = query.where(or_(Project.visibility == Visibility.PUBLIC, Organization.id.in_(accessible_orgs)))

        rows = (await session.execute(query.order_by(ProjectResourceRevision.created_at.desc()))).all()
        if not rows:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")

        primary_rev, primary_res, primary_proj, primary_org, primary_author = rows[0]
        all_locations = [
            ResolveLocation(
                organization=ResolveOrganizationRef(id=org.id, slug=org.slug, name=org.name),
                project=ResolveProjectRef(id=proj.id, slug=proj.slug, name=proj.name, visibility=proj.visibility.value),
                element_id=str(rev.id),
                slug=res.slug,
                version_or_revision=rev.revision,
                created_at=rev.created_at,
                web_url=f"/app/{org.slug}/{proj.slug}/resources/{res.slug}",
            )
            for rev, res, proj, org, _ in rows
        ]

        doc = primary_rev.document
        doc_bytes = json.dumps(doc).encode("utf-8")
        author_ref = (
            ResolveAuthorRef(id=primary_author.id, username=primary_author.username, email=primary_author.email)
            if primary_author
            else None
        )
        citation = _build_citation(
            title=f"{primary_res.name} (Rev #{primary_rev.revision})",
            slug=primary_res.slug,
            digest_val=norm_digest,
            org_slug=primary_org.slug,
            proj_slug=primary_proj.slug,
            authors=[primary_author.username] if primary_author else None,
        )

        return ResolveResponse(
            verified=True,
            kind="resource-revision",
            digest=norm_digest,
            canonical_name=f"{primary_res.name} (Rev #{primary_rev.revision})",
            media_type="application/json",
            size_bytes=len(doc_bytes),
            created_at=primary_rev.created_at,
            author=author_ref,
            document=doc,
            content_url=f"/v1/resolve/resource-revision/{norm_digest}/content",
            locations=all_locations[offset : offset + limit],
            pagination=ResolvePagination(
                total=len(all_locations), limit=limit, offset=offset, has_more=(offset + limit) < len(all_locations)
            ),
            citation=citation,
        )

    # 3. collection-revision
    if kind_slug == "collection-revision":
        query = (
            select(CollectionRevision, Collection, Project, Organization, User)
            .join(Collection, Collection.id == CollectionRevision.collection_id)
            .join(Project, Project.id == Collection.project_id)
            .join(Organization, Organization.id == Project.organization_id)
            .outerjoin(User, User.id == CollectionRevision.created_by_id)
            .where(CollectionRevision.digest == norm_digest)
        )
        if user is None:
            query = query.where(Project.visibility == Visibility.PUBLIC)
        elif not user.is_admin:
            query = query.where(or_(Project.visibility == Visibility.PUBLIC, Organization.id.in_(accessible_orgs)))

        rows = (await session.execute(query.order_by(CollectionRevision.created_at.desc()))).all()
        if not rows:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")

        primary_rev, primary_col, primary_proj, primary_org, primary_author = rows[0]
        all_locations = [
            ResolveLocation(
                organization=ResolveOrganizationRef(id=org.id, slug=org.slug, name=org.name),
                project=ResolveProjectRef(id=proj.id, slug=proj.slug, name=proj.name, visibility=proj.visibility.value),
                element_id=str(rev.id),
                slug=col.slug,
                version_or_revision=rev.revision,
                created_at=rev.created_at,
                web_url=f"/app/{org.slug}/{proj.slug}/collections/{col.slug}",
            )
            for rev, col, proj, org, _ in rows
        ]

        author_ref = (
            ResolveAuthorRef(id=primary_author.id, username=primary_author.username, email=primary_author.email)
            if primary_author
            else None
        )
        citation = _build_citation(
            title=f"{primary_col.name} (Rev #{primary_rev.revision})",
            slug=primary_col.slug,
            digest_val=norm_digest,
            org_slug=primary_org.slug,
            proj_slug=primary_proj.slug,
            authors=[primary_author.username] if primary_author else None,
        )

        return ResolveResponse(
            verified=True,
            kind="collection-revision",
            digest=norm_digest,
            canonical_name=f"{primary_col.name} (Rev #{primary_rev.revision})",
            media_type="application/json",
            size_bytes=None,
            created_at=primary_rev.created_at,
            author=author_ref,
            document={"collection": primary_col.slug, "revision": primary_rev.revision},
            content_url=f"/v1/resolve/collection-revision/{norm_digest}/content",
            locations=all_locations[offset : offset + limit],
            pagination=ResolvePagination(
                total=len(all_locations), limit=limit, offset=offset, has_more=(offset + limit) < len(all_locations)
            ),
            citation=citation,
        )

    # 4. report
    if kind_slug == "report":
        query = (
            select(Report, Project, Organization, User)
            .join(Project, Project.id == Report.project_id)
            .join(Organization, Organization.id == Project.organization_id)
            .outerjoin(User, User.id == Report.created_by_id)
            .where(Report.digest == norm_digest)
        )
        if user is None:
            query = query.where(Project.visibility == Visibility.PUBLIC)
        elif not user.is_admin:
            query = query.where(or_(Project.visibility == Visibility.PUBLIC, Organization.id.in_(accessible_orgs)))

        rows = (await session.execute(query.order_by(Report.created_at.desc()))).all()
        if not rows:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")

        primary_rep, primary_proj, primary_org, primary_author = rows[0]
        all_locations = [
            ResolveLocation(
                organization=ResolveOrganizationRef(id=org.id, slug=org.slug, name=org.name),
                project=ResolveProjectRef(id=proj.id, slug=proj.slug, name=proj.name, visibility=proj.visibility.value),
                element_id=str(rep.id),
                slug=rep.slug,
                version_or_revision=rep.state.value,
                created_at=rep.created_at,
                web_url=f"/app/{org.slug}/{proj.slug}/reports/{rep.slug}",
            )
            for rep, proj, org, _ in rows
        ]

        doc = primary_rep.document
        doc_bytes = json.dumps(doc).encode("utf-8")
        author_ref = (
            ResolveAuthorRef(id=primary_author.id, username=primary_author.username, email=primary_author.email)
            if primary_author
            else None
        )
        citation = _build_citation(
            title=primary_rep.title,
            slug=primary_rep.slug,
            digest_val=norm_digest,
            org_slug=primary_org.slug,
            proj_slug=primary_proj.slug,
            authors=[primary_author.username] if primary_author else None,
        )

        return ResolveResponse(
            verified=True,
            kind="report",
            digest=norm_digest,
            canonical_name=primary_rep.title,
            media_type="application/json",
            size_bytes=len(doc_bytes),
            created_at=primary_rep.created_at,
            author=author_ref,
            document=doc,
            content_url=f"/v1/resolve/report/{norm_digest}/content",
            locations=all_locations[offset : offset + limit],
            pagination=ResolvePagination(
                total=len(all_locations), limit=limit, offset=offset, has_more=(offset + limit) < len(all_locations)
            ),
            citation=citation,
        )

    # 5. artifact
    if kind_slug == "artifact":
        query = (
            select(Artifact, Project, Organization, User)
            .join(Project, Project.id == Artifact.project_id)
            .join(Organization, Organization.id == Project.organization_id)
            .outerjoin(User, User.id == Artifact.created_by_id)
            .where(Artifact.digest == norm_digest)
        )
        if user is None:
            query = query.where(Artifact.public.is_(True), Project.visibility == Visibility.PUBLIC)
        elif not user.is_admin:
            query = query.where(
                or_(
                    (Artifact.public.is_(True) & (Project.visibility == Visibility.PUBLIC)),
                    Organization.id.in_(accessible_orgs),
                )
            )

        rows = (await session.execute(query.order_by(Artifact.created_at.desc()))).all()
        if not rows:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")

        primary_art, primary_proj, primary_org, primary_author = rows[0]
        all_locations = [
            ResolveLocation(
                organization=ResolveOrganizationRef(id=org.id, slug=org.slug, name=org.name),
                project=ResolveProjectRef(id=proj.id, slug=proj.slug, name=proj.name, visibility=proj.visibility.value),
                element_id=str(art.id),
                slug=f"artifact-{art.digest[7:19]}",
                version_or_revision=None,
                created_at=art.created_at,
                web_url=f"/app/{org.slug}/{proj.slug}/records",
            )
            for art, proj, org, _ in rows
        ]

        author_ref = (
            ResolveAuthorRef(id=primary_author.id, username=primary_author.username, email=primary_author.email)
            if primary_author
            else None
        )
        citation = _build_citation(
            title=f"Binary Artifact ({primary_art.media_type})",
            slug=f"artifact-{primary_art.digest[7:19]}",
            digest_val=norm_digest,
            org_slug=primary_org.slug,
            proj_slug=primary_proj.slug,
            authors=[primary_author.username] if primary_author else None,
        )

        return ResolveResponse(
            verified=True,
            kind="artifact",
            digest=norm_digest,
            canonical_name=f"Artifact ({primary_art.media_type}, {primary_art.size_bytes} B)",
            media_type=primary_art.media_type,
            size_bytes=primary_art.size_bytes,
            created_at=primary_art.created_at,
            author=author_ref,
            document=None,
            content_url=f"/v1/resolve/artifact/{norm_digest}/content",
            locations=all_locations[offset : offset + limit],
            pagination=ResolvePagination(
                total=len(all_locations), limit=limit, offset=offset, has_more=(offset + limit) < len(all_locations)
            ),
            citation=citation,
        )

    # 6. engine
    if kind_slug == "engine":
        query = select(EngineRevision, User).outerjoin(User, User.id == EngineRevision.owner_id).where(EngineRevision.digest == norm_digest)
        if user is None:
            query = query.where(EngineRevision.state == "published")
        elif not user.is_admin:
            query = query.where(or_(EngineRevision.state == "published", EngineRevision.owner_id == user.id))

        rows = (await session.execute(query.order_by(EngineRevision.created_at.desc()))).all()
        if not rows:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")

        eng, owner = rows[0]
        doc = eng.document
        doc_bytes = json.dumps(doc).encode("utf-8")
        author_ref = ResolveAuthorRef(id=owner.id, username=owner.username, email=owner.email) if owner else None
        loc = [
            ResolveLocation(
                organization=None,
                project=None,
                element_id=str(eng.id),
                slug=f"{eng.namespace}/{eng.name}",
                version_or_revision=eng.version,
                created_at=eng.created_at,
                web_url="/app/engines",
            )
        ]
        citation = _build_citation(
            title=f"Solver Engine: {eng.namespace}/{eng.name}@{eng.version}",
            slug=eng.name,
            digest_val=norm_digest,
            authors=[owner.username] if owner else None,
        )

        return ResolveResponse(
            verified=True,
            kind="engine",
            digest=norm_digest,
            canonical_name=f"{eng.namespace}/{eng.name}@{eng.version}",
            media_type="application/json",
            size_bytes=len(doc_bytes),
            created_at=eng.created_at,
            author=author_ref,
            document=doc,
            content_url=f"/v1/resolve/engine/{norm_digest}/content",
            locations=loc[offset : offset + limit],
            pagination=ResolvePagination(total=len(loc), limit=limit, offset=offset, has_more=(offset + limit) < len(loc)),
            citation=citation,
        )

    # 7. dialect
    if kind_slug == "dialect":
        query = select(DialectRevision, User).outerjoin(User, User.id == DialectRevision.owner_id).where(DialectRevision.digest == norm_digest)
        if user is None:
            query = query.where(DialectRevision.state.in_(["approved", "published"]))
        elif not user.is_admin:
            query = query.where(or_(DialectRevision.state.in_(["approved", "published"]), DialectRevision.owner_id == user.id))

        rows = (await session.execute(query.order_by(DialectRevision.created_at.desc()))).all()
        if not rows:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")

        dia, owner = rows[0]
        doc = dia.document
        doc_bytes = json.dumps(doc).encode("utf-8")
        author_ref = ResolveAuthorRef(id=owner.id, username=owner.username, email=owner.email) if owner else None
        loc = [
            ResolveLocation(
                organization=None,
                project=None,
                element_id=str(dia.id),
                slug=f"{dia.namespace}/{dia.name}",
                version_or_revision=dia.version,
                created_at=dia.created_at,
                web_url="/dialects",
            )
        ]
        citation = _build_citation(
            title=f"BIM Dialect: {dia.namespace}/{dia.name}@{dia.version}",
            slug=dia.name,
            digest_val=norm_digest,
            authors=[owner.username] if owner else None,
        )

        return ResolveResponse(
            verified=True,
            kind="dialect",
            digest=norm_digest,
            canonical_name=f"{dia.namespace}/{dia.name}@{dia.version}",
            media_type="application/json",
            size_bytes=len(doc_bytes),
            created_at=dia.created_at,
            author=author_ref,
            document=doc,
            content_url=f"/v1/resolve/dialect/{norm_digest}/content",
            locations=loc[offset : offset + limit],
            pagination=ResolvePagination(total=len(loc), limit=limit, offset=offset, has_more=(offset + limit) < len(loc)),
            citation=citation,
        )

    # 8. registered-resource
    if kind_slug == "registered-resource":
        query = select(RegisteredResourceRevision, User).outerjoin(User, User.id == RegisteredResourceRevision.owner_id).where(RegisteredResourceRevision.digest == norm_digest)
        if user is None:
            query = query.where(RegisteredResourceRevision.state.in_(["approved", "published"]))
        elif not user.is_admin:
            query = query.where(or_(RegisteredResourceRevision.state.in_(["approved", "published"]), RegisteredResourceRevision.owner_id == user.id))

        rows = (await session.execute(query.order_by(RegisteredResourceRevision.created_at.desc()))).all()
        if not rows:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")

        reg, owner = rows[0]
        author_ref = ResolveAuthorRef(id=owner.id, username=owner.username, email=owner.email) if owner else None
        loc = [
            ResolveLocation(
                organization=None,
                project=None,
                element_id=str(reg.id),
                slug=f"{reg.namespace}/{reg.name}",
                version_or_revision=reg.version,
                created_at=reg.created_at,
                web_url=f"/resources/{reg.namespace}/{reg.name}",
            )
        ]
        citation = _build_citation(
            title=f"Registered BIM Resource: {reg.namespace}/{reg.name}@{reg.version}",
            slug=reg.name,
            digest_val=norm_digest,
            authors=[owner.username] if owner else None,
        )

        return ResolveResponse(
            verified=True,
            kind="registered-resource",
            digest=norm_digest,
            canonical_name=f"{reg.namespace}/{reg.name}@{reg.version}",
            media_type=reg.media_type,
            size_bytes=len(reg.content) if reg.content else None,
            created_at=reg.created_at,
            author=author_ref,
            document=reg.document,
            content_url=f"/v1/resolve/registered-resource/{norm_digest}/content",
            locations=loc[offset : offset + limit],
            pagination=ResolvePagination(total=len(loc), limit=limit, offset=offset, has_more=(offset + limit) < len(loc)),
            citation=citation,
        )

    # 9. instance-snapshot
    if kind_slug == "instance-snapshot":
        query = select(InstanceSnapshot, User).outerjoin(User, User.id == InstanceSnapshot.owner_id).where(
            or_(InstanceSnapshot.instance_digest == norm_digest, InstanceSnapshot.package_digest == norm_digest)
        )
        if user is None:
            # Snapshots without an owner or public
            query = query.where(InstanceSnapshot.owner_id.is_(None))
        elif not user.is_admin:
            query = query.where(or_(InstanceSnapshot.owner_id.is_(None), InstanceSnapshot.owner_id == user.id))

        rows = (await session.execute(query.order_by(InstanceSnapshot.created_at.desc()))).all()
        if not rows:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")

        snap, owner = rows[0]
        doc = snap.root_document
        author_ref = ResolveAuthorRef(id=owner.id, username=owner.username, email=owner.email) if owner else None
        loc = [
            ResolveLocation(
                organization=None,
                project=None,
                element_id=str(snap.id),
                slug=snap.name,
                version_or_revision=snap.package_digest[:12],
                created_at=snap.created_at,
                web_url=f"/app/snapshots/{snap.id}",
            )
        ]
        citation = _build_citation(
            title=f"Instance Snapshot: {snap.name}",
            slug=f"snapshot-{snap.instance_digest[7:19]}",
            digest_val=norm_digest,
            authors=[owner.username] if owner else None,
        )

        return ResolveResponse(
            verified=True,
            kind="instance-snapshot",
            digest=norm_digest,
            canonical_name=f"Instance Snapshot: {snap.name}",
            media_type="application/json",
            size_bytes=len(snap.source_archive) if snap.source_archive else None,
            created_at=snap.created_at,
            author=author_ref,
            document=doc,
            content_url=f"/v1/resolve/instance-snapshot/{norm_digest}/content",
            locations=loc[offset : offset + limit],
            pagination=ResolvePagination(total=len(loc), limit=limit, offset=offset, has_more=(offset + limit) < len(loc)),
            citation=citation,
        )

    # 10. binding-ir
    if kind_slug == "binding-ir":
        query = (
            select(BindingIRSnapshot, InstanceSnapshot, User)
            .join(InstanceSnapshot, InstanceSnapshot.id == BindingIRSnapshot.snapshot_id)
            .outerjoin(User, User.id == InstanceSnapshot.owner_id)
            .where(BindingIRSnapshot.ir_digest == norm_digest)
        )
        if user is None:
            query = query.where(InstanceSnapshot.owner_id.is_(None))
        elif not user.is_admin:
            query = query.where(or_(InstanceSnapshot.owner_id.is_(None), InstanceSnapshot.owner_id == user.id))

        rows = (await session.execute(query.order_by(BindingIRSnapshot.created_at.desc()))).all()
        if not rows:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")

        ir_snap, snap, owner = rows[0]
        doc = ir_snap.document
        doc_bytes = json.dumps(doc).encode("utf-8")
        author_ref = ResolveAuthorRef(id=owner.id, username=owner.username, email=owner.email) if owner else None
        loc = [
            ResolveLocation(
                organization=None,
                project=None,
                element_id=str(ir_snap.id),
                slug=f"ir-{snap.name}",
                version_or_revision=ir_snap.compiler_version,
                created_at=ir_snap.created_at,
                web_url=f"/app/snapshots/{snap.id}",
            )
        ]
        citation = _build_citation(
            title=f"Canonical IR Snapshot ({ir_snap.compiler_version})",
            slug=f"ir-{ir_snap.ir_digest[7:19]}",
            digest_val=norm_digest,
            authors=[owner.username] if owner else None,
        )

        return ResolveResponse(
            verified=True,
            kind="binding-ir",
            digest=norm_digest,
            canonical_name=f"Binding IR ({ir_snap.compiler_version})",
            media_type="application/json",
            size_bytes=len(doc_bytes),
            created_at=ir_snap.created_at,
            author=author_ref,
            document=doc,
            content_url=f"/v1/resolve/binding-ir/{norm_digest}/content",
            locations=loc[offset : offset + limit],
            pagination=ResolvePagination(total=len(loc), limit=limit, offset=offset, has_more=(offset + limit) < len(loc)),
            citation=citation,
        )

    raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")


@router.get(
    "/{kind}/{digest_value}/content",
    operation_id="resolveElementContent",
    summary="Download resolved element content",
    responses={
        200: {
            "content": {
                "application/octet-stream": {"schema": {"type": "string", "format": "binary"}},
                "application/json": {"schema": {"type": "object", "additionalProperties": True}},
            }
        }
    },
)
async def resolve_element_content(
    kind: str,
    digest_value: str,
    user: Optional[User] = Depends(get_optional_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Download the raw file or JSON content of any resolved OpenBinding element with cryptographic headers."""
    kind_slug = kind.strip().lower()
    if kind_slug not in VALID_KINDS:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", f"Unknown element kind '{kind}'.")

    norm_digest = _normalize_digest(digest_value)
    accessible_orgs = await _get_accessible_org_ids(session, user)

    # 1. case-revision
    if kind_slug == "case-revision":
        query = (
            select(BindingCaseRevision, Project)
            .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
            .join(Project, Project.id == BindingCase.project_id)
            .where(BindingCaseRevision.digest == norm_digest)
        )
        if user is None:
            query = query.where(Project.visibility == Visibility.PUBLIC)
        elif not user.is_admin:
            query = query.where(or_(Project.visibility == Visibility.PUBLIC, Project.organization_id.in_(accessible_orgs)))
        row = (await session.execute(query)).first()
        if row is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")
        rev, proj = row
        is_pub = proj.visibility == Visibility.PUBLIC
        cache_hdr = "public, max-age=31536000, immutable" if is_pub else "private, no-cache"
        return JSONResponse(
            rev.document,
            headers={
                "ETag": f'"{norm_digest}"',
                "Cache-Control": cache_hdr,
                "Content-Security-Policy": "default-src 'none'; sandbox",
            },
        )

    # 2. resource-revision
    if kind_slug == "resource-revision":
        query = (
            select(ProjectResourceRevision, Project)
            .join(ProjectResource, ProjectResource.id == ProjectResourceRevision.project_resource_id)
            .join(Project, Project.id == ProjectResource.project_id)
            .where(ProjectResourceRevision.digest == norm_digest)
        )
        if user is None:
            query = query.where(Project.visibility == Visibility.PUBLIC)
        elif not user.is_admin:
            query = query.where(or_(Project.visibility == Visibility.PUBLIC, Project.organization_id.in_(accessible_orgs)))
        row = (await session.execute(query)).first()
        if row is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")
        rev, proj = row
        is_pub = proj.visibility == Visibility.PUBLIC
        cache_hdr = "public, max-age=31536000, immutable" if is_pub else "private, no-cache"
        return JSONResponse(
            rev.document,
            headers={
                "ETag": f'"{norm_digest}"',
                "Cache-Control": cache_hdr,
                "Content-Security-Policy": "default-src 'none'; sandbox",
            },
        )

    # 3. collection-revision
    if kind_slug == "collection-revision":
        query = (
            select(CollectionRevision, Project)
            .join(Collection, Collection.id == CollectionRevision.collection_id)
            .join(Project, Project.id == Collection.project_id)
            .where(CollectionRevision.digest == norm_digest)
        )
        if user is None:
            query = query.where(Project.visibility == Visibility.PUBLIC)
        elif not user.is_admin:
            query = query.where(or_(Project.visibility == Visibility.PUBLIC, Project.organization_id.in_(accessible_orgs)))
        row = (await session.execute(query)).first()
        if row is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")
        rev, proj = row
        is_pub = proj.visibility == Visibility.PUBLIC
        cache_hdr = "public, max-age=31536000, immutable" if is_pub else "private, no-cache"
        return JSONResponse(
            {"collection_id": str(rev.collection_id), "revision": rev.revision, "digest": rev.digest},
            headers={
                "ETag": f'"{norm_digest}"',
                "Cache-Control": cache_hdr,
                "Content-Security-Policy": "default-src 'none'; sandbox",
            },
        )

    # 4. report
    if kind_slug == "report":
        query = select(Report, Project).join(Project, Project.id == Report.project_id).where(Report.digest == norm_digest)
        if user is None:
            query = query.where(Project.visibility == Visibility.PUBLIC)
        elif not user.is_admin:
            query = query.where(or_(Project.visibility == Visibility.PUBLIC, Project.organization_id.in_(accessible_orgs)))
        row = (await session.execute(query)).first()
        if row is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")
        rep, proj = row
        is_pub = proj.visibility == Visibility.PUBLIC
        cache_hdr = "public, max-age=31536000, immutable" if is_pub else "private, no-cache"
        return JSONResponse(
            rep.document,
            headers={
                "ETag": f'"{norm_digest}"',
                "Cache-Control": cache_hdr,
                "Content-Security-Policy": "default-src 'none'; sandbox",
            },
        )

    # 5. artifact
    if kind_slug == "artifact":
        query = select(Artifact, Project).join(Project, Project.id == Artifact.project_id).where(Artifact.digest == norm_digest)
        if user is None:
            query = query.where(Artifact.public.is_(True), Project.visibility == Visibility.PUBLIC)
        elif not user.is_admin:
            query = query.where(
                or_(
                    (Artifact.public.is_(True) & (Project.visibility == Visibility.PUBLIC)),
                    Project.organization_id.in_(accessible_orgs),
                )
            )
        row = (await session.execute(query)).first()
        if row is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")
        art, proj = row
        storage_path = Path(art.storage_uri)
        if not storage_path.is_file():
            storage_path = _artifact_path(settings, norm_digest)
            if not storage_path.is_file():
                raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Physical artifact file not found.")

        is_pub = art.public and proj.visibility == Visibility.PUBLIC
        cache_hdr = "public, max-age=31536000, immutable" if is_pub else "private, no-cache"
        return FileResponse(
            storage_path,
            media_type=art.media_type,
            headers={
                "ETag": f'"{norm_digest}"',
                "Cache-Control": cache_hdr,
                "Content-Security-Policy": "default-src 'none'; sandbox",
            },
        )

    # 6. engine
    if kind_slug == "engine":
        query = select(EngineRevision).where(EngineRevision.digest == norm_digest)
        if user is None:
            query = query.where(EngineRevision.state == "published")
        elif not user.is_admin:
            query = query.where(or_(EngineRevision.state == "published", EngineRevision.owner_id == user.id))
        eng = (await session.execute(query)).scalars().first()
        if eng is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")
        is_pub = eng.state == "published"
        cache_hdr = "public, max-age=31536000, immutable" if is_pub else "private, no-cache"
        return JSONResponse(
            eng.document,
            headers={
                "ETag": f'"{norm_digest}"',
                "Cache-Control": cache_hdr,
                "Content-Security-Policy": "default-src 'none'; sandbox",
            },
        )

    # 7. dialect
    if kind_slug == "dialect":
        query = select(DialectRevision).where(DialectRevision.digest == norm_digest)
        if user is None:
            query = query.where(DialectRevision.state.in_(["approved", "published"]))
        elif not user.is_admin:
            query = query.where(or_(DialectRevision.state.in_(["approved", "published"]), DialectRevision.owner_id == user.id))
        dia = (await session.execute(query)).scalars().first()
        if dia is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")
        is_pub = dia.state in ["approved", "published"]
        cache_hdr = "public, max-age=31536000, immutable" if is_pub else "private, no-cache"
        return JSONResponse(
            dia.document,
            headers={
                "ETag": f'"{norm_digest}"',
                "Cache-Control": cache_hdr,
                "Content-Security-Policy": "default-src 'none'; sandbox",
            },
        )

    # 8. registered-resource
    if kind_slug == "registered-resource":
        query = select(RegisteredResourceRevision).where(RegisteredResourceRevision.digest == norm_digest)
        if user is None:
            query = query.where(RegisteredResourceRevision.state.in_(["approved", "published"]))
        elif not user.is_admin:
            query = query.where(or_(RegisteredResourceRevision.state.in_(["approved", "published"]), RegisteredResourceRevision.owner_id == user.id))
        reg = (await session.execute(query)).scalars().first()
        if reg is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")
        is_pub = reg.state in ["approved", "published"]
        cache_hdr = "public, max-age=31536000, immutable" if is_pub else "private, no-cache"
        if reg.document is not None:
            return JSONResponse(
                reg.document,
                headers={"ETag": f'"{norm_digest}"', "Cache-Control": cache_hdr, "Content-Security-Policy": "default-src 'none'; sandbox"},
            )
        return Response(
            reg.content,
            media_type=reg.media_type,
            headers={"ETag": f'"{norm_digest}"', "Cache-Control": cache_hdr, "Content-Security-Policy": "default-src 'none'; sandbox"},
        )

    # 9. instance-snapshot
    if kind_slug == "instance-snapshot":
        query = select(InstanceSnapshot).where(or_(InstanceSnapshot.instance_digest == norm_digest, InstanceSnapshot.package_digest == norm_digest))
        if user is None:
            query = query.where(InstanceSnapshot.owner_id.is_(None))
        elif not user.is_admin:
            query = query.where(or_(InstanceSnapshot.owner_id.is_(None), InstanceSnapshot.owner_id == user.id))
        snap = (await session.execute(query)).scalars().first()
        if snap is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")
        is_pub = snap.owner_id is None
        cache_hdr = "public, max-age=31536000, immutable" if is_pub else "private, no-cache"
        return JSONResponse(
            snap.root_document,
            headers={"ETag": f'"{norm_digest}"', "Cache-Control": cache_hdr, "Content-Security-Policy": "default-src 'none'; sandbox"},
        )

    # 10. binding-ir
    if kind_slug == "binding-ir":
        query = select(BindingIRSnapshot, InstanceSnapshot).join(InstanceSnapshot, InstanceSnapshot.id == BindingIRSnapshot.snapshot_id).where(BindingIRSnapshot.ir_digest == norm_digest)
        if user is None:
            query = query.where(InstanceSnapshot.owner_id.is_(None))
        elif not user.is_admin:
            query = query.where(or_(InstanceSnapshot.owner_id.is_(None), InstanceSnapshot.owner_id == user.id))
        row = (await session.execute(query)).first()
        if row is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")
        ir_snap, snap = row
        is_pub = snap.owner_id is None
        cache_hdr = "public, max-age=31536000, immutable" if is_pub else "private, no-cache"
        return JSONResponse(
            ir_snap.document,
            headers={"ETag": f'"{norm_digest}"', "Cache-Control": cache_hdr, "Content-Security-Policy": "default-src 'none'; sandbox"},
        )

    raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Element not found.")
