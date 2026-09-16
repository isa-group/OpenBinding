"""Owner-scoped analysis of immutable stored evidence; no evaluator or engine calls."""
from __future__ import annotations

import asyncio
import csv
import io
import json
import uuid
from threading import Lock
from collections import OrderedDict
from dataclasses import replace

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response, StreamingResponse
from sqlalchemy import Text, cast, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only
from starlette.concurrency import run_in_threadpool

from ..access.dependencies import get_current_user, session_dependency
from ..db.models import AnalysisTask, BindingIRSnapshot, Job, User, utcnow
from ..models.analysis import (
    AnalysisCandidateResponse, AnalysisExport, AnalysisQuery, AnalysisReport, AnalysisResponse,
    AnalysisSource, AnalysisSources, AnalysisTaskView,
)
from ..models.platform import ReportCreate, ReportView
from ..security.apikeys import allows_engine, allows_request, authenticated_api_key
from ..v1.archive import VERSION, build_archive, candidate_detail, compact_archive, decide, query_archive, record, row_view, safe
from ..v1.canonical import digest
from .v1 import _owned_job

router = APIRouter(prefix="/v1/analysis", tags=["Binding analysis"])
_SLOTS = asyncio.Semaphore(2)
# ponytail: two immutable archives per process; replace with shared cache only if replica reuse warrants it.
_CACHE: OrderedDict = OrderedDict()
_CACHE_LOCK = Lock()


def source_info(job, result_digest=None):
    provenance = record(job.provenance)
    return AnalysisSource(id=str(job.id), engine=job.engine_id, state=job.state.value,
        createdAt=job.created_at.isoformat(), projectId=str(job.project_id) if job.project_id else None,
        irDigest=provenance.get("irDigest"), evaluatorDigest=provenance.get("evaluatorDigest"),
        resultDigest=result_digest, legacy=not (provenance.get("irDigest") and provenance.get("evaluatorDigest")),
        diagnostic=bool(provenance.get("analysisFixture")))


def enforce_boundary(caller, job, *, project=None, organization=None, path="/v1/jobs/{job_id}", method="GET"):
    api_key = authenticated_api_key(caller)
    if api_key is not None:
        parameters = {"job_id": str(job.id)} if job is not None else {}
        if project is not None:
            parameters["project"] = str(project)
        if organization is not None:
            parameters["org"] = str(organization)
        if not allows_request(api_key, method=method, path_params=parameters, path=path):
            raise HTTPException(403, "The API key boundary excludes this resource")


async def load_archive(query, caller, session):
    ids = sorted(set(query.sources))
    cache_key = None
    storage_hashes = {}
    loaded_jobs = {}
    if session.bind.dialect.name == "postgresql":
        try:
            parsed = [uuid.UUID(source) for source in ids]
        except ValueError as exc:
            raise HTTPException(404, "Analysis source unavailable") from exc
        # PostgreSQL hashes stored JSON without transferring or parsing assignments on cache hits.
        result_checksum = func.encode(func.sha256(func.convert_to(cast(Job.result, Text), "UTF8")), "hex")
        metadata = (await session.execute(select(Job, result_checksum,
            func.encode(func.sha256(func.convert_to(cast(Job.original_request, Text), "UTF8")), "hex")).options(load_only(Job.id, Job.owner_id, Job.engine_id,
                Job.state, Job.project_id, Job.organization_id, Job.created_at, Job.provenance, Job.instance_snapshot_id))
            .where(Job.id.in_(parsed), Job.owner_id == caller.id).order_by(Job.id))).all()
        if len(metadata) != len(ids):
            raise HTTPException(404, "One or more analysis sources are unavailable")
        storage_hashes = {str(job.id): "sha256-" + result_hash for job, result_hash, _ in metadata if result_hash}
        for job, _, _ in metadata:
            if not allows_engine(caller, record(job.provenance).get("engine", {})):
                raise HTTPException(404, "Analysis source unavailable")
            enforce_boundary(caller, job, project=job.project_id, organization=job.organization_id)
            if job.state.value not in ("completed", "failed", "cancelled"):
                raise HTTPException(409, "Analysis requires a terminal stored result")
        snapshot_ids = {job.instance_snapshot_id for job, _, _ in metadata if job.instance_snapshot_id}
        snapshot_versions = (await session.execute(select(BindingIRSnapshot.snapshot_id, BindingIRSnapshot.ir_digest,
            func.encode(func.sha256(func.convert_to(cast(BindingIRSnapshot.document, Text), "UTF8")), "hex")).where(BindingIRSnapshot.snapshot_id.in_(snapshot_ids)))).all()
        cache_key = (str(caller.id), VERSION, tuple((str(job.id), result_hash, request_hash, digest(record(job.provenance)), str(job.instance_snapshot_id))
                     for job, result_hash, request_hash in metadata), tuple(sorted(tuple(str(v) for v in row) for row in snapshot_versions)))
        with _CACHE_LOCK:
            cached = _CACHE.get(cache_key)
            if cached is not None:
                _CACHE.move_to_end(cache_key)
        if cached is not None:
            if query.revision and query.revision != cached.revision:
                raise HTTPException(409, "The source archive has changed; reload before making this decision")
            return cached
        # One bulk fetch on a miss, rather than one round trip per source.
        loaded = (await session.execute(select(Job, result_checksum).where(Job.id.in_(parsed), Job.owner_id == caller.id)
            .execution_options(populate_existing=True))).all()
        if any(storage_hashes.get(str(job.id)) != "sha256-" + checksum for job, checksum in loaded):
            raise HTTPException(409, "An analysis source changed while loading; reload its evidence")
        loaded_jobs = {str(job.id): job for job, _ in loaded}
    records, snapshots = [], {}
    for job_id in ids:
        job = loaded_jobs.get(job_id) if loaded_jobs else await _owned_job(job_id, caller, session)
        if job is None:
            raise HTTPException(404, "One or more analysis sources are unavailable")
        enforce_boundary(caller, job, project=job.project_id, organization=job.organization_id)
        if job.state.value not in ("completed", "failed", "cancelled"):
            raise HTTPException(409, "Analysis requires a terminal stored result")
        document = record(job.original_request).get("bindingProblem")
        provenance = record(job.provenance)
        if not isinstance(document, dict) and job.instance_snapshot_id:
            if job.instance_snapshot_id not in snapshots:
                snapshots[job.instance_snapshot_id] = (await session.execute(select(BindingIRSnapshot).where(
                    BindingIRSnapshot.snapshot_id == job.instance_snapshot_id))).scalars().first()
            snapshot = snapshots[job.instance_snapshot_id]
            if snapshot:
                if provenance.get("irDigest") not in (None, snapshot.ir_digest):
                    raise HTTPException(409, "Source and snapshot identities disagree")
                document = snapshot.document
        if not isinstance(document, dict) or document.get("kind") != "BindingProblem":
            raise HTTPException(409, "The pinned model is unavailable for this source")
        records.append((job, document))
    # Database and authorization stay on the event loop; hashing and mathematics do not.
    def prepare():
        sources = []
        for job, document in records:
            semantic = {k: v for k, v in document.items() if k != "metadata"}
            semantic["spec"] = {k: v for k, v in document["spec"].items() if k not in ("instance", "dialects", "sourceMap")}
            actual = digest(semantic)
            info = source_info(job, storage_hashes.get(str(job.id)) or digest(safe(job.result)))
            if str(job.id) in storage_hashes:
                info.resultDigestKind = "stored-json"
            if info.irDigest and info.irDigest != actual:
                raise HTTPException(409, "The pinned model does not match its stored identity")
            info.irDigest = actual
            sources.append((info, document, record(job.result)))
        key = cache_key or (str(caller.id), VERSION, tuple((s.id, s.resultDigest, s.irDigest, s.evaluatorDigest) for s, _, _ in sources))
        with _CACHE_LOCK:
            archive = _CACHE.get(key)
            if archive is not None:
                _CACHE.move_to_end(key)
        if archive is None:
            archive = compact_archive(build_archive(sources))
            with _CACHE_LOCK:
                _CACHE[key] = archive
                while len(_CACHE) > 2:
                    _CACHE.popitem(last=False)
        if query.revision and query.revision != archive.revision:
            raise HTTPException(409, "The source archive has changed; reload before making this decision")
        return archive
    try:
        async with _SLOTS:
            return await run_in_threadpool(prepare)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


async def compute(function, *args):
    try:
        async with _SLOTS:
            return await run_in_threadpool(function, *args)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


async def detail_evidence(archive, payload, session):
    """Hydrate only inspected/receipted rows, leaving the shared canonical matrix compact."""
    selected = {payload.selected, *payload.compare}
    if selected == {None} or not selected:
        decision = await compute(decide, archive, payload)
        if decision.ordered:
            selected.add(decision.ordered[0].id)
    candidates = [c for c in archive.candidates if c.id in selected]
    ids = {uuid.UUID(c.occurrences[0]["jobId"]) for c in candidates}
    results = dict((await session.execute(select(Job.id, Job.result).where(Job.id.in_(ids)))).all())
    hydrated = {}
    for candidate in candidates:
        occurrence = candidate.occurrences[0]
        solutions = record(results[uuid.UUID(occurrence["jobId"])]).get("solutions", [])
        if not isinstance(solutions, list):
            solutions = [solutions]
        hydrated[candidate.id] = replace(candidate, solution=record(solutions[occurrence["solutionIndex"]]))
    return replace(archive, candidates=[hydrated.get(c.id, c) for c in archive.candidates])


@router.get("/sources", response_model=AnalysisSources)
async def sources(
    cursor: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200), compatible_with: str | None = None,
    caller: User = Depends(get_current_user), session: AsyncSession = Depends(session_dependency, scope="function"),
):
    anchor = None
    if compatible_with:
        anchor_job = await _owned_job(compatible_with, caller, session)
        if anchor_job is None:
            raise HTTPException(404, "Analysis source unavailable")
        enforce_boundary(caller, anchor_job, project=anchor_job.project_id, organization=anchor_job.organization_id)
        anchor = source_info(anchor_job)
    jobs = (await session.execute(select(Job).options(load_only(Job.id, Job.owner_id, Job.engine_id, Job.state,
        Job.project_id, Job.organization_id, Job.created_at, Job.provenance)).where(
        Job.owner_id == caller.id, Job.result.is_not(None)).order_by(Job.created_at.desc(), Job.id).offset(cursor).limit(limit))).scalars().all()
    items = []
    for job in jobs:
        if not allows_engine(caller, record(job.provenance).get("engine", {})):
            continue
        try:
            enforce_boundary(caller, job, project=job.project_id, organization=job.organization_id)
        except HTTPException:
            continue
        info = source_info(job)
        if anchor:
            info.compatible = not (anchor.legacy or info.legacy) and (anchor.irDigest, anchor.evaluatorDigest) == (info.irDigest, info.evaluatorDigest)
        items.append(info)
    return AnalysisSources(items=items, nextCursor=str(cursor + len(jobs)) if len(jobs) == limit else None)


@router.post("/query", response_model=AnalysisResponse)
async def query_analysis(payload: AnalysisQuery, caller: User = Depends(get_current_user),
                         session: AsyncSession = Depends(session_dependency, scope="function")):
    archive = await load_archive(payload, caller, session)
    response = await compute(query_archive, archive, payload)
    task = (await session.execute(select(AnalysisTask).where(AnalysisTask.owner_id == caller.id,
        AnalysisTask.fingerprint == task_fingerprint(archive.revision, payload), AnalysisTask.state == "completed"))).scalars().first()
    if task and task.result:
        front = set(task.result["front"])
        ranks = task.result.get("ranks") or {cid: 1 for cid in front}
        response["pareto"].update(state="complete" if payload.layers else "front-complete", frontCount=len(front), taskId=str(task.id))
        for collection in ("rows", "winners", "next"):
            for row in response[collection]:
                row.paretoRank = ranks.get(row.id)
        for point in response["plot"]["points"]:
            point["paretoRank"] = ranks.get(point["id"])
    return response


@router.post("/candidate", response_model=AnalysisCandidateResponse)
async def get_candidate(payload: AnalysisQuery, caller: User = Depends(get_current_user),
                        session: AsyncSession = Depends(session_dependency, scope="function")):
    archive = await load_archive(payload, caller, session)
    archive = await detail_evidence(archive, payload, session)
    return await compute(candidate_detail, archive, payload)


def receipt(archive, payload):
    query = AnalysisQuery.model_validate({k: v for k, v in payload.model_dump().items() if k in AnalysisQuery.model_fields})
    query.revision = archive.revision
    decision = decide(archive, query)
    selected = list(dict.fromkeys([cid for cid in [query.selected, *query.compare] if cid]))
    if not selected and decision.ordered:
        selected = [decision.ordered[0].id]
    return jsonable_encoder({"kind": "binding-decision", "version": VERSION, "revision": archive.revision,
        "sources": archive.sources, "query": query, "dimensions": archive.dimensions,
        "scope": "Stored evaluated bindings only; unexplored space remains unknown",
        "selected": [candidate_detail(archive, query.model_copy(update={"selected": cid})) for cid in selected]})


@router.post("/export", response_class=Response, responses={200: {
    "description": "Analysis receipt, archive rows, or CSV selected by format.",
    "content": {"application/json": {"schema": {"type": "object", "additionalProperties": True}},
                "text/csv": {"schema": {"type": "string"}}},
}})
async def export_analysis(payload: AnalysisExport, caller: User = Depends(get_current_user),
                          session: AsyncSession = Depends(session_dependency, scope="function")):
    archive = await load_archive(payload, caller, session)
    if payload.format == "receipt":
        archive = await detail_evidence(archive, payload, session)
        return JSONResponse(await compute(receipt, archive, payload), headers={"Content-Disposition": 'attachment; filename="binding-decision.json"'})
    decision = await compute(decide, archive, payload)
    ordered = decision.ordered + [c for c in archive.candidates if c.id not in decision.scores]
    def chunks():
        if payload.format == "csv":
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(["id", "rank", "score_group", "eligible", "feasible", "score", "reasons", *[d.key for d in archive.dimensions]])
            yield output.getvalue()
            for c in ordered:
                output.seek(0)
                output.truncate()
                row = row_view(c, decision)
                writer.writerow([c.id, row.rank, row.scoreGroup, row.eligible, c.feasible,
                    json.dumps(row.score), json.dumps(row.reasons), *(c.values or [None] * len(archive.dimensions))])
                yield output.getvalue()
        else:
            yield '{"revision":' + json.dumps(archive.revision) + ',"rows":['
            for i, c in enumerate(ordered):
                yield ("," if i else "") + json.dumps({**row_view(c, decision).model_dump(), "binding": c.binding, "occurrences": c.occurrences})
            yield "]}"
    return StreamingResponse(chunks(), media_type="text/csv" if payload.format == "csv" else "application/json",
        headers={"Content-Disposition": f'attachment; filename="binding-archive.{payload.format}"'})


@router.post("/reports", response_model=ReportView, status_code=201)
async def save_report(payload: AnalysisReport, caller: User = Depends(get_current_user),
                      session: AsyncSession = Depends(session_dependency, scope="function")):
    from .studies import create_report
    enforce_boundary(caller, None, project=payload.project, organization=payload.organization,
                     path="/v1/organizations/{org}/projects/{project}/reports", method="POST")
    archive = await load_archive(payload, caller, session)
    archive = await detail_evidence(archive, payload, session)
    document = await compute(receipt, archive, payload)
    return await create_report(payload.organization, payload.project,
        ReportCreate(slug=payload.slug, title=payload.title, document=document), caller, session)


def task_fingerprint(revision, payload):
    return digest({"revision": revision, "scope": payload.paretoScope, "layers": payload.layers,
        "requirements": sorted([r.model_dump() for r in payload.requirements], key=lambda r: r["dimension"]) if payload.paretoScope == "eligible" else []})


def task_view(task):
    return AnalysisTaskView(id=str(task.id), revision=task.revision, state=task.state, progress=task.progress,
        scope=task.request["paretoScope"], layers=task.request["layers"], error=task.error, result=task.result)


@router.post("/pareto", response_model=AnalysisTaskView, status_code=202)
async def start_pareto(payload: AnalysisQuery, caller: User = Depends(get_current_user),
                       session: AsyncSession = Depends(session_dependency, scope="function")):
    from ..analysis_jobs import dispatch_analysis
    archive = await load_archive(payload, caller, session)
    await compute(decide, archive, payload)
    fingerprint = task_fingerprint(archive.revision, payload)
    task = (await session.execute(select(AnalysisTask).where(AnalysisTask.owner_id == caller.id,
        AnalysisTask.fingerprint == fingerprint))).scalars().first()
    if task is None:
        try:
            async with session.begin_nested():
                task = AnalysisTask(owner_id=caller.id, fingerprint=fingerprint, revision=archive.revision,
                    request=payload.model_copy(update={"revision": archive.revision}).model_dump())
                session.add(task)
                await session.flush()
        except IntegrityError:
            task = (await session.execute(select(AnalysisTask).where(AnalysisTask.owner_id == caller.id,
                AnalysisTask.fingerprint == fingerprint))).scalars().one()
    elif task.state in ("failed", "cancelled"):
        task.state, task.progress, task.result, task.error = "queued", 0, None, None
        task.cancellation_requested, task.lease_token, task.lease_until = False, None, None
        task.updated_at = utcnow()
    await session.commit()
    if task.state == "queued":
        await dispatch_analysis(str(task.id))
    return task_view(task)


async def owned_task(task_id, caller, session, *, cancelling=False):
    task = (await session.execute(select(AnalysisTask).where(AnalysisTask.id == task_id,
        AnalysisTask.owner_id == caller.id).execution_options(populate_existing=True))).scalars().first()
    if task is None:
        raise HTTPException(404, "Analysis task unavailable")
    if cancelling and task.state in ("queued", "running"):
        for source_id in task.request["sources"]:
            job = await _owned_job(source_id, caller, session)
            if job is None:
                if authenticated_api_key(caller) is not None:
                    raise HTTPException(404, "Analysis source unavailable")
                continue
            enforce_boundary(caller, job, project=job.project_id, organization=job.organization_id)
    else:
        await load_archive(AnalysisQuery.model_validate(task.request), caller, session)
    return task


@router.get("/pareto/{task_id}", response_model=AnalysisTaskView)
async def get_pareto(task_id: uuid.UUID, caller: User = Depends(get_current_user),
                     session: AsyncSession = Depends(session_dependency, scope="function")):
    return task_view(await owned_task(task_id, caller, session))


@router.post("/pareto/{task_id}/cancel", response_model=AnalysisTaskView)
async def cancel_pareto(task_id: uuid.UUID, caller: User = Depends(get_current_user),
                        session: AsyncSession = Depends(session_dependency, scope="function")):
    task = await owned_task(task_id, caller, session, cancelling=True)
    await session.execute(update(AnalysisTask).where(AnalysisTask.id == task.id,
        AnalysisTask.state.in_(["queued", "running"])).values(state="cancelled", cancellation_requested=True,
            lease_token=None, lease_until=None, result=None, updated_at=utcnow()))
    await session.commit()
    await session.refresh(task)
    return task_view(task)
