"""Report project contexts use the same editorial library as other resources."""
import uuid
from sqlalchemy import select
from .artifacts import seal_draft, reference
from .db.models import Artifact, ArtifactDraft, ProjectArtifact, Report, ReportState, StudyRun
from .models.artifacts import DraftContent
from .models.errors import api_error
from .v1.canonical import digest


async def create_report_context(session, project, user, *, slug, title, document, study_run_id=None):
    artifact = Artifact(organization_id=project.organization_id, namespace=str(project.organization_id),
        name='report-' + uuid.uuid4().hex, display_name=title, kind='Report', created_by_id=user.id)
    session.add(artifact)
    await session.flush()
    draft = ArtifactDraft(artifact_id=artifact.id, created_by_id=user.id,
        payload=DraftContent(content=document).model_dump(mode='json'))
    session.add(draft)
    await session.flush()
    value = Report(project_id=project.id, artifact_id=artifact.id, draft=draft,
        study_run_id=study_run_id, slug=slug, title=title,
        state=ReportState.DRAFT, created_by_id=user.id)
    session.add(value)
    session.add(ProjectArtifact(project_id=project.id, artifact_id=artifact.id))
    await session.flush()
    return value


async def seal_report(session, value, user):
    if value.state is ReportState.FROZEN:
        return value.version
    version = await seal_draft(session, await session.get(Artifact, value.artifact_id),
        value.draft, value.draft.revision, None, user)
    value.version = version
    value.state = ReportState.FROZEN
    await session.flush()
    return version


async def new_report_draft(session, value, user):
    await session.execute(select(Artifact.id).where(Artifact.id == value.artifact_id).with_for_update())
    await session.refresh(value)
    if value.draft is not None and value.draft.sealed_version_id is None:
        return value.draft
    draft = ArtifactDraft(artifact_id=value.artifact_id, based_on_id=value.version_id,
        payload=DraftContent(content=value.document, dependencies=value.version.manifest['dependencies'],
            contracts=value.version.manifest['contracts']).model_dump(mode='json'), created_by_id=user.id)
    session.add(draft)
    await session.flush()
    value.draft = draft
    value.state = ReportState.DRAFT
    await session.flush()
    return draft


async def report_evidence(session, artifact, document, user):
    """Validate referenced terminal sources and return typed retention edges."""
    from types import SimpleNamespace
    from .db.models import Job, Project, Study
    from .routes.studies import _validate_report_provenance
    from .routes.v1 import _owned_job
    evidence = []
    if document.get('kind') == 'binding-decision':
        sources = document.get('sources')
        if not isinstance(sources, list) or not sources:
            raise api_error(422, 'incomplete_evidence', 'A decision receipt requires exact job sources.')
        for source in sources:
            try:
                identity = uuid.UUID(source['id'])
            except (KeyError, ValueError, TypeError) as exc:
                raise api_error(422, 'invalid_evidence', 'Invalid job evidence reference.') from exc
            job = await _owned_job(str(identity), user, session)
            if job is None or job.state.value not in {'completed', 'failed', 'cancelled'} or job.result is None:
                raise api_error(422, 'nonterminal_evidence', 'Report evidence must have a stored terminal result.')
            from .v1.archive import safe
            result_digest = digest(safe(job.result))
            if source.get('resultDigestKind') == 'stored-json':
                from sqlalchemy import Text, cast, func
                if session.bind.dialect.name != 'postgresql':
                    raise api_error(409, 'evidence_encoding_unavailable', 'The receipt pins PostgreSQL storage bytes; verify it at its original source.')
                result_digest = 'sha256-' + await session.scalar(select(func.encode(func.sha256(func.convert_to(cast(Job.result, Text), 'UTF8')), 'hex')).where(Job.id == job.id))
            if source.get('resultDigest') != result_digest:
                raise api_error(422, 'evidence_digest_mismatch', 'The source result differs from the analysis receipt.')
            evidence.append(dict(job_id=job.id, digest=result_digest))
        return evidence
    provenance = document.get('provenance', {})
    raw_run = provenance.get('study', {}).get('runId') if isinstance(provenance, dict) and isinstance(provenance.get('study'), dict) else None
    run_id = None
    project_id = None
    if raw_run:
        try:
            run_id = uuid.UUID(raw_run)
        except (TypeError, ValueError) as exc:
            raise api_error(422, 'invalid_evidence', 'Invalid study run reference.') from exc
        row = (await session.execute(select(StudyRun, Study.project_id, Project.organization_id)
            .join(Study, Study.id == StudyRun.study_id).join(Project, Project.id == Study.project_id)
            .where(StudyRun.id == run_id))).first()
        if row is None or row[2] != artifact.organization_id:
            raise api_error(422, 'foreign_evidence', 'Study evidence must belong to the artifact organization.')
        run, project_id, _ = row
        if run.state.value not in {'completed', 'partial', 'failed', 'cancelled'}:
            raise api_error(422, 'nonterminal_evidence', 'Seal a report only after its run finishes.')
        evidence.append(dict(study_run_id=run.id, digest=run.matrix_digest))
        from .db.models import StudyCell
        for cell in await session.scalars(select(StudyCell).where(StudyCell.study_run_id == run.id)):
            if cell.state.value in {'queued', 'running'}:
                raise api_error(422, 'nonterminal_evidence', 'Every source cell must be terminal.')
            if cell.job_id:
                job = await session.get(Job, cell.job_id)
                if job is None or job.state.value not in {'completed', 'failed', 'cancelled'}:
                    raise api_error(422, 'nonterminal_evidence', 'Every source job must be terminal.')
                evidence.append(dict(job_id=job.id, digest=digest(job.result)))
    await _validate_report_provenance(SimpleNamespace(study_run_id=run_id), project_id, provenance, session)
    return evidence


async def adopt_sealed_report_draft(session, draft, version):
    for report in await session.scalars(select(Report).where(Report.draft_id == draft.id)):
        report.version = version
        report.state = ReportState.FROZEN
