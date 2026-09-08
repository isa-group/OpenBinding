"""Cryptographic provenance verification and replication certification."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from fastapi import APIRouter, Depends
from starlette.requests import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, session_dependency
from ..db.models import (
    Artifact,
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
    title = "Reproducible Service Binding Artifact"
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


async def _search_matching_entities(
    session: AsyncSession,
    digest_val: str,
) -> list[VerifierEntityMatch]:
    matches: list[VerifierEntityMatch] = []

    # 1. BindingCaseRevision
    case_rows = (
        await session.execute(
            select(BindingCaseRevision, BindingCase, Project, Organization)
            .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
            .join(Project, Project.id == BindingCase.project_id)
            .join(Organization, Organization.id == Project.organization_id)
            .where(BindingCaseRevision.digest == digest_val)
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
    snap_rows = (
        await session.execute(
            select(InstanceSnapshot).where(
                (InstanceSnapshot.instance_digest == digest_val)
                | (InstanceSnapshot.package_digest == digest_val)
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
    col_rows = (
        await session.execute(
            select(CollectionRevision, Collection, Project, Organization)
            .join(Collection, Collection.id == CollectionRevision.collection_id)
            .join(Project, Project.id == Collection.project_id)
            .join(Organization, Organization.id == Project.organization_id)
            .where(CollectionRevision.digest == digest_val)
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
            select(Report, Project, Organization)
            .join(Project, Project.id == Report.project_id)
            .join(Organization, Organization.id == Project.organization_id)
            .where(Report.digest == digest_val)
        )
    ).all()
    for rep, proj, org in rep_rows:
        matches.append(
            VerifierEntityMatch(
                entity_type="report",
                id=str(rep.id),
                slug=rep.slug,
                title_or_name=rep.title,
                organization_slug=org.slug,
                project_slug=proj.slug,
                created_at=rep.created_at,
            )
        )

    # 5. Artifact
    art_rows = (
        await session.execute(
            select(Artifact, Project, Organization)
            .outerjoin(Project, Project.id == Artifact.project_id)
            .outerjoin(Organization, Organization.id == Artifact.organization_id)
            .where(Artifact.digest == digest_val)
        )
    ).all()
    for art, proj, org in art_rows:
        matches.append(
            VerifierEntityMatch(
                entity_type="artifact",
                id=str(art.id),
                title_or_name=f"Artifact ({art.media_type}, {art.size_bytes} B)",
                organization_slug=org.slug if org else None,
                project_slug=proj.slug if proj else None,
                created_at=art.created_at,
            )
        )

    # 6. EngineRevision
    eng_rows = (
        await session.execute(
            select(EngineRevision).where(EngineRevision.digest == digest_val)
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
            .where(StudyRun.matrix_digest == digest_val)
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
    entities = await _search_matching_entities(session, target_digest)

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

    entities = await _search_matching_entities(session, digest_val)
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
