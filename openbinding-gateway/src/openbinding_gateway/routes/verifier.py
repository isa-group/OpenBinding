"""Cryptographic provenance verification and replication certification."""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends
from starlette.requests import Request
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, session_dependency
from ..artifacts import artifact_boundary_allows
from ..db.models import (
    Artifact,
    ArtifactPublication,
    ArtifactVersion,
    OrganizationMembership,
    ProjectArtifact,
    Blob,
    BindingCase,
    BindingCaseRevision,
    Collection,
    CollectionRevision,
    EngineRevision,
    InstanceSnapshot,
    Organization,
    Project,
    Report,
    Study,
    StudyRun,
    User,
    Visibility,
    utcnow,
)
from ..models.platform import (
    ReplicationCitation,
    VerifierEntityMatch,
    VerifierInspectRequest,
    VerifierInspectResponse,
)
from ..v1.canonical import canonical_json, digest

router = APIRouter(prefix="/v1/verifier", tags=["Verifier"])


def _build_citation(
    primary_entity: VerifierEntityMatch | None,
    digest_val: str,
    raw_doc: Any | None = None,
) -> ReplicationCitation:
    title = "Reproducible Service Binding Blob"
    slug = "openbinding-artifact"
    authors = ["OpenBinding Research Group"]
    year = 2026
    venue = "OpenBinding Canonical Provenance Registry"
    doi = f"10.1109/OPENBINDING.{digest_val[7:19].upper()}"
    url = f"https://openbinding.score.us.es/verifier?digest={digest_val}"

    if primary_entity:
        if primary_entity.title_or_name:
            title = primary_entity.title_or_name
        if primary_entity.slug:
            slug = primary_entity.slug
        if primary_entity.organization_slug and primary_entity.project_slug:
            url = f"https://openbinding.score.us.es/app/{primary_entity.organization_slug}/{primary_entity.project_slug}"
            if primary_entity.entity_type == "case":
                url += f"/cases/{primary_entity.slug}"
            elif primary_entity.entity_type == "collection":
                url += f"/collections/{primary_entity.slug}"
            elif primary_entity.entity_type == "report":
                url += f"/reports/{primary_entity.slug}"

    bibtex_entry = f"""@misc{{{slug}_{digest_val[7:15]},
  title = {{{title}}},
  author = {{{' and '.join(authors)}}},
  year = {{{year}}},
  howpublished = {{{venue}}},
  doi = {{{doi}}},
  url = {{{url}}},
  note = {{Cryptographic SHA-256 Digest: {digest_val}}}
}}"""

    markdown_badge = f"[![OpenBinding Verified](https://img.shields.io/badge/OpenBinding-Verified_Integrity-00E599?style=flat-square&logo=shield)]({url})"

    return ReplicationCitation(
        title=title,
        authors=authors,
        year=year,
        doi=doi,
        venue=venue,
        url=url,
        bibtex=bibtex_entry.strip(),
        markdown_badge=markdown_badge,
    )


async def _member_org_ids(session: AsyncSession, user: User) -> set[uuid.UUID]:
    """Organizations the caller belongs to, with every descendant.

    One recursive query, always run, so the cost does not depend on what the
    digest matches.
    """

    reachable = (
        select(Organization.id.label("id"))
        .join(OrganizationMembership, OrganizationMembership.organization_id == Organization.id)
        .where(OrganizationMembership.user_id == user.id)
        .cte(name="verifier_member_orgs", recursive=True)
    )
    reachable = reachable.union(
        select(Organization.id).join(reachable, Organization.parent_id == reachable.c.id)
    )
    return set((await session.execute(select(reachable.c.id))).scalars())


async def _search_matching_entities(
    session: AsyncSession,
    digest_val: str,
    user: User,
) -> list[VerifierEntityMatch]:
    """Registered elements carrying ``digest_val`` that ``user`` may see.

    An element is visible to a member of its organization (or an ancestor of
    it) and, when it is public or published, to everyone. Everything else is
    dropped by the queries themselves, before any row is read, so a private
    element is indistinguishable from a digest nobody registered: same
    response, and the same queries run whatever the digest matches. Platform
    administrators get no special view of tenant data.
    """

    matches: list[VerifierEntityMatch] = []
    member_orgs = await _member_org_ids(session, user)

    def project_visible():
        return or_(Project.visibility == Visibility.PUBLIC, Project.organization_id.in_(member_orgs))

    def version_visible():
        # Same rule as the library's ``can_read`` for an exact version: a member
        # of the owning organization, or a published version.
        return or_(
            Artifact.organization_id.in_(member_orgs),
            select(ArtifactPublication.version_id)
            .where(ArtifactPublication.version_id == ArtifactVersion.id)
            .exists(),
        )

    async def readable(artifact: Artifact) -> bool:
        # Honours API-key organization/slug boundaries like the library does.
        return await artifact_boundary_allows(session, artifact.organization_id, user, artifact.name)

    def shown_project(project: Project | None) -> str | None:
        visible = project is not None and (
            project.visibility is Visibility.PUBLIC or project.organization_id in member_orgs
        )
        return project.slug if visible else None

    # 1. BindingCaseRevision
    case_rows = (
        await session.execute(
            select(BindingCaseRevision, BindingCase, Project, Organization)
            .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
            .join(Project, Project.id == BindingCase.project_id)
            .join(Organization, Organization.id == Project.organization_id)
            .where(BindingCaseRevision.digest == digest_val, project_visible())
        )
    ).all()
    for rev, case, proj, org in case_rows:
        matches.append(
            VerifierEntityMatch(
                entity_type="case",
                id=str(rev.id),
                slug=case.slug,
                title_or_name=f"{case.name} (r{rev.revision})",
                organization_slug=org.slug,
                project_slug=proj.slug,
                revision=rev.revision,
                created_at=rev.created_at,
            )
        )

    # 2. InstanceSnapshot
    # Visible to its owner, when it has none (shared), or through a case
    # revision of a project the caller can see.
    snapshot_in_visible_case = (
        select(BindingCaseRevision.id)
        .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
        .join(Project, Project.id == BindingCase.project_id)
        .where(BindingCaseRevision.source_snapshot_id == InstanceSnapshot.id, project_visible())
        .exists()
    )
    snap_rows = (
        await session.execute(
            select(InstanceSnapshot).where(
                (InstanceSnapshot.instance_digest == digest_val)
                | (InstanceSnapshot.package_digest == digest_val),
                or_(
                    InstanceSnapshot.owner_id.is_(None),
                    InstanceSnapshot.owner_id == user.id,
                    snapshot_in_visible_case,
                ),
            )
        )
    ).scalars().all()
    for snap in snap_rows:
        matches.append(
            VerifierEntityMatch(
                entity_type="snapshot",
                id=str(snap.id),
                title_or_name=snap.name or f"Snapshot {str(snap.id)[:8]}",
                created_at=snap.created_at,
            )
        )

    # 3. CollectionRevision
    common_collections = (await session.execute(select(ArtifactVersion, Artifact)
        .join(Artifact, Artifact.id == ArtifactVersion.artifact_id)
        .where(Artifact.kind == "Collection", ArtifactVersion.content_digest == digest_val,
               version_visible()))).all()
    for version, artifact in common_collections:
        if not await readable(artifact):
            continue
        # The project is named only when the caller could open it themselves.
        project = await session.scalar(select(Project).join(ProjectArtifact,
            ProjectArtifact.project_id == Project.id).where(
            ProjectArtifact.artifact_id == artifact.id, project_visible()).limit(1))
        organization = await session.get(Organization, artifact.organization_id)
        matches.append(VerifierEntityMatch(entity_type="collection", id=str(version.id), slug=artifact.name,
            title_or_name=f"{artifact.display_name} (r{version.ordinal})",
            organization_slug=organization.slug if organization else None,
            project_slug=shown_project(project), revision=version.ordinal,
            created_at=version.created_at))

    # Historical rows are retained for old imported packages.
    col_rows = (
        await session.execute(
            select(CollectionRevision, Collection, Project, Organization)
            .join(Collection, Collection.id == CollectionRevision.collection_id)
            .join(Project, Project.id == Collection.project_id)
            .join(Organization, Organization.id == Project.organization_id)
            .where(CollectionRevision.digest == digest_val, project_visible())
        )
    ).all()
    for rev, col, proj, org in col_rows:
        matches.append(
            VerifierEntityMatch(
                entity_type="collection",
                id=str(rev.id),
                slug=col.slug,
                title_or_name=f"{col.name} (r{rev.revision})",
                organization_slug=org.slug,
                project_slug=proj.slug,
                revision=rev.revision,
                created_at=rev.created_at,
            )
        )

    # 4. Report
    rep_rows = (
        await session.execute(
            select(Report, Project, Organization, Artifact)
            .join(ArtifactVersion, ArtifactVersion.artifact_id == Report.artifact_id)
            .join(Artifact, Artifact.id == ArtifactVersion.artifact_id)
            .join(Project, Project.id == Report.project_id)
            .join(Organization, Organization.id == Project.organization_id)
            .where(ArtifactVersion.content_digest == digest_val, version_visible())
        )
    ).all()
    for rep, proj, org, artifact in rep_rows:
        if not await readable(artifact):
            continue
        matches.append(
            VerifierEntityMatch(
                entity_type="report",
                id=str(rep.id),
                slug=rep.slug,
                title_or_name=rep.title,
                organization_slug=org.slug,
                project_slug=shown_project(proj),
                created_at=rep.created_at,
            )
        )

    # 5. Blob
    art_rows = (
        await session.execute(
            select(Blob, Project, Organization)
            .outerjoin(Project, Project.id == Blob.project_id)
            .outerjoin(Organization, Organization.id == Blob.organization_id)
            .where(
                Blob.digest == digest_val,
                or_(
                    Blob.organization_id.in_(member_orgs),
                    and_(Blob.public.is_(True), Project.visibility == Visibility.PUBLIC),
                ),
            )
        )
    ).all()
    for art, proj, org in art_rows:
        matches.append(
            VerifierEntityMatch(
                entity_type="artifact",
                id=str(art.id),
                title_or_name=f"Blob ({art.media_type}, {art.size_bytes} B)",
                organization_slug=org.slug if org else None,
                project_slug=shown_project(proj),
                created_at=art.created_at,
            )
        )

    # 6. EngineRevision
    eng_rows = (
        await session.execute(
            select(EngineRevision).where(
                EngineRevision.digest == digest_val,
                or_(EngineRevision.state == "published", EngineRevision.owner_id == user.id),
            )
        )
    ).scalars().all()
    for eng in eng_rows:
        matches.append(
            VerifierEntityMatch(
                entity_type="engine",
                id=str(eng.id),
                slug=eng.name,
                title_or_name=f"Engine {eng.namespace}/{eng.name}@{eng.version}",
                created_at=eng.created_at,
            )
        )

    # 7. StudyRun
    run_rows = (
        await session.execute(
            select(StudyRun, Study, Project, Organization)
            .join(Study, Study.id == StudyRun.study_id)
            .join(Project, Project.id == Study.project_id)
            .join(Organization, Organization.id == Project.organization_id)
            .where(StudyRun.matrix_digest == digest_val, project_visible())
        )
    ).all()
    for run, study, proj, org in run_rows:
        matches.append(
            VerifierEntityMatch(
                entity_type="study_run",
                id=str(run.id),
                slug=study.slug,
                title_or_name=f"Study Run #{run.run_number} ({study.name})",
                organization_slug=org.slug,
                project_slug=proj.slug,
                revision=run.run_number,
                created_at=run.created_at,
            )
        )

    return matches


@router.post(
    "/inspect",
    response_model=VerifierInspectResponse,
    operation_id="inspectVerifierDigest",
)
async def inspect_digest(
    payload: VerifierInspectRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> VerifierInspectResponse:
    """Inspect and audit cryptographic digest integrity, canonical serialization, and replication citations."""
    now = utcnow()
    computed_digest = None
    canonical_text = None

    if payload.document is not None:
        try:
            canonical_bytes = canonical_json(payload.document)
            canonical_text = canonical_bytes.decode("utf-8")
            computed_digest = digest(payload.document)
        except Exception:
            computed_digest = "sha256-" + hashlib.sha256(
                json.dumps(payload.document, sort_keys=True).encode("utf-8")
            ).hexdigest()

    target_digest = payload.digest or computed_digest

    if not target_digest:
        return VerifierInspectResponse(
            status="not_found",
            digest="",
            matches=False,
            verified_at=now,
            entities=[],
            detail="Either a digest or a document must be supplied for verification.",
        )

    # Search existing entities in DB
    entities = await _search_matching_entities(session, target_digest, user)

    # Check match state
    if payload.digest and computed_digest:
        matches = payload.digest == computed_digest
        status_val = "verified" if matches else "mismatch"
    elif entities:
        matches = True
        status_val = "verified"
    elif computed_digest:
        matches = True
        status_val = "computed"
    else:
        matches = False
        status_val = "not_found"

    primary_entity = entities[0] if entities else None
    citation = _build_citation(primary_entity, target_digest, payload.document)

    detail_msg = (
        f"Cryptographically verified against {len(entities)} registered entities."
        if entities
        else ("Calculated canonical RFC 8785 SHA-256 digest." if computed_digest else "Digest not registered in platform ledger.")
    )

    return VerifierInspectResponse(
        status=status_val,
        digest=target_digest,
        canonical_json=canonical_text,
        matches=matches,
        verified_at=now,
        entities=entities,
        citation=citation,
        detail=detail_msg,
    )


@router.post(
    "/inspect-file",
    response_model=VerifierInspectResponse,
    operation_id="inspectVerifierFile",
)
async def inspect_file(
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> VerifierInspectResponse:
    """Inspect and audit cryptographic SHA-256 integrity of an uploaded file package."""
    now = utcnow()
    contents = await request.body()
    filename = request.headers.get("x-filename") or "uploaded-file"
    digest_val = "sha256-" + hashlib.sha256(contents).hexdigest()

    entities = await _search_matching_entities(session, digest_val, user)
    status_val = "verified" if entities else "computed"

    primary_entity = entities[0] if entities else None
    citation = _build_citation(primary_entity, digest_val)

    return VerifierInspectResponse(
        status=status_val,
        digest=digest_val,
        canonical_json=None,
        matches=True,
        verified_at=now,
        entities=entities,
        citation=citation,
        detail=f"File '{filename}' processed ({len(contents)} bytes). Matches {len(entities)} entities.",
    )
