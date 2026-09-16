"""Deterministic, reference-evaluated development archives, never engine benchmark claims."""
from __future__ import annotations

import json
import math
import uuid
from pathlib import Path

from sqlalchemy import select

from openbinding_gateway.db.models import InstanceSnapshot, Job, JobProvenance, JobState, utcnow
from openbinding_gateway.db.platform_models import BindingCase, BindingCaseRevision, RunState, Study, StudyCell, StudyRun, StudyState
from openbinding_gateway.routes import v1 as routes_v1
from openbinding_gateway.models.platform import StudyDefinition
from openbinding_gateway.studies import expand_study
from openbinding_gateway.v1.canonical import digest
from openbinding_gateway.v1.package import InstancePackage, load_package
from openbinding_gateway.v1.compiler import compiler_bundle_digest
from openbinding_gateway.v1.archive import VERSION as ANALYSIS_VERSION

GENERATOR_VERSION = 3

GALLERY = [
    ("tradeoffs", "17_analysis_tradeoffs", "All 36 bindings: fronts, weights, Voronoi, dual, hull, hypervolume and neighbors"),
    ("constraints", "18_analysis_constraints", "Three objectives, maximized quality, hard violations and soft penalties"),
    ("journey", "19_analysis_journey", "Actual deterministic enumeration incumbents; use the event replay slider"),
    ("collinear", "17_analysis_tradeoffs", "Four bindings with three collinear objective sites"),
    ("singleton", "17_analysis_tradeoffs", "One binding: a single clipped influence cell"),
    ("empty", "17_analysis_tradeoffs", "Empty returned subset: no inferred optimum or geometry"),
    ("large", "17_analysis_tradeoffs", "1,296 evaluated four-task bindings: full rankings and explicit geometry limits"),
    ("pooled-overlap", "17_analysis_tradeoffs", "Compatible repeated evaluations: pooled occurrences preserve the same binding identity"),
    ("decision-rules", "17_analysis_tradeoffs", "Unsupported compromise, dominated runner-up, tied assignments, and achieved / unknown / excluded budgets"),
    ("power-slice", "18_analysis_constraints", "Three priorities with a fixed hidden fourth objective and multiple soft penalties"),
    ("geometry-limit", "17_analysis_tradeoffs", "350 genuinely distinct objective sites: exact selected preference cell against every competitor"),
    ("background", "17_analysis_tradeoffs", "3,000 explicitly generated and evaluated bindings with four objectives: exact background Pareto"),
]


def gallery_package(examples_dir: Path, scenario: str, example: str) -> InstancePackage:
    package = load_package(examples_dir / "demo" / example)
    if scenario not in {"large", "decision-rules", "power-slice", "geometry-limit", "background", "scale", "cancel-background"}:
        return package
    files = dict(package.files)
    app = package.json("application.json")
    opt = package.json("optimization.json")
    catalog = package.json("candidates.json")
    instance = package.json("instance.json")
    constraints = package.json("constraints.json") if "constraints.json" in files else {
        "apiVersion": "qos-binding/v1", "kind": "ConstraintSet", "metadata": {"name": "analysis-bounds"}, "spec": {"constraints": {}}}
    if scenario == "large":
        app["spec"]["tasks"] = {task: "service/analysis" for task in ("ingest", "transform", "verify", "publish")}
    elif scenario == "decision-rules":
        app["spec"]["tasks"] = {"choice": "service/analysis"}
        values = {"cost-extreme": (0, 100), "balanced": (60, 60), "balanced-twin": (60, 60),
                  "latency-extreme": (100, 0), "runner-up": (85, 85), "infeasible-attractive": (20, 20)}
        catalog["spec"]["candidates"] = {name: {"provides": "service/analysis", "metrics": {"cost": cost, "latency": latency}}
                                           for name, (cost, latency) in values.items()}
        constraints["spec"]["constraints"] = {"necessary-total": {"assert": "metrics.cost + metrics.latency >= 100", "enforcement": "hard"}}
        instance["spec"]["resources"]["constraintSet"] = {"constraints": "constraints.json"}
    elif scenario == "geometry-limit":
        app["spec"]["tasks"] = {"choice": "service/analysis"}
        catalog["spec"]["candidates"] = {f"option-{i:03d}": {"provides": "service/analysis",
            "metrics": {"cost": i / 4, "latency": (349-i) / 4}} for i in range(350)}
    elif scenario == "power-slice":
        app["spec"]["metrics"]["energy"] = {"unit": "joule", "direction": "minimize", "scope": "invocation", "aggregation": "sum", "domain": {"kind": "real", "minimum": 0, "maximum": 100}}
        catalog["spec"]["metricBindings"]["energy"] = {"resource": "application", "id": "energy"}
        for i, candidate in enumerate(catalog["spec"]["candidates"].values()):
            candidate["metrics"]["energy"] = [15, 70, 20, 45, 80, 90][i % 6]
        opt["spec"]["terms"].append({"metric": {"resource": "application", "id": "energy"}, "weight": 1, "normalize": {"min": 0, "max": 200, "clamp": True}})
        constraints["spec"]["constraints"]["energy-sla"] = {"assert": "metrics.energy <= 90", "enforcement": "soft", "penalty": 2}
        opt["spec"]["penalties"].append({"constraint": {"resource": "constraints", "id": "energy-sla"}, "weight": .5})
    else:
        # Explicit radix-indexed assignments avoid enumerating an implicit universe for scale fixtures.
        app["spec"]["tasks"] = {f"stage-{t}": f"service/analysis-{t}" for t in range(5)}
        metrics = ["cost", "latency"] + (["energy", "quality"] if scenario != "scale" else [])
        app["spec"]["metrics"] = {name: {"unit": "unit", "direction": "maximize" if name == "quality" else "minimize",
            "scope": "invocation", "aggregation": "sum", "domain": {"kind": "real", "minimum": 0, "maximum": 2_000_000}} for name in metrics}
        catalog["spec"]["metricBindings"] = {name: {"resource": "application", "id": name} for name in metrics}
        catalog["spec"]["candidates"] = {f"stage-{t}-option-{i}": {"provides": f"service/analysis-{t}",
            "metrics": {name: {"cost": i*10**t, "latency": (9-i)*10**t, "energy": i*i*11**t, "quality": (9-i)*(t+1)}[name] for name in metrics}}
            for t in range(5) for i in range(10)}
        opt["spec"]["terms"] = [{"metric": {"resource": "application", "id": name}, "weight": 1,
            "normalize": {"min": 0, "max": 1_000_000, "clamp": False}} for name in metrics]
        opt["spec"]["type"] = "MANY" if len(metrics) > 2 else "MULTI"
    app["spec"]["workflow"] = {"sequence": [{"task": {"resource": "application", "id": task}} for task in app["spec"]["tasks"]]}
    for term in opt["spec"]["terms"]:
        if scenario == "large":
            term["normalize"]["max"] = 400
    instance["metadata"]["name"] = f"analysis-{scenario}"
    for name, document in [("application.json", app), ("optimization.json", opt), ("instance.json", instance), ("candidates.json", catalog)]:
        files[name] = json.dumps(document, sort_keys=True).encode()
    if "constraintSet" in instance["spec"]["resources"]:
        files["constraints.json"] = json.dumps(constraints, sort_keys=True).encode()
    return InstancePackage(files)


def enumerate_gallery(problem, scenario: str, description: str, *, limit: int | None = None, offset: int = 0) -> dict:
    """Retain actual evaluated candidates, including rejected ones, as a diagnostic archive."""
    spec = problem.document["spec"]
    tasks = sorted(problem.binding_space_breakdown)
    cardinality = problem.binding_space_cardinality
    if scenario == "background" and limit is None:
        limit = 3000
    if cardinality > 2000 and limit is None:
        raise ValueError("Development analysis enumeration is capped at 2,000 bindings")
    if limit is not None and (not 1 <= limit <= 100_000 or offset < 0 or offset + limit > cardinality):
        raise ValueError("Explicit development batches must fit the model and contain at most 100,000 bindings")
    choices = [sorted(spec["eligibility"][task], key=lambda ref: (ref["resource"], ref["id"]), reverse=True) for task in tasks]
    solutions, trace = [], []
    best = None
    count = cardinality if limit is None else limit
    for ordinal in range(offset, offset + count):
        index = ordinal + 1
        refs = [options[(ordinal // math.prod(len(other) for other in choices[j+1:])) % len(options)] for j, options in enumerate(choices)]
        binding = dict(zip(tasks, refs, strict=True))
        evaluation = problem.evaluate(binding)
        objectives = evaluation["objectives"]
        penalties = {tuple(v["constraint"][key] for key in ("resource", "id")): v["penalty"] for v in evaluation["violations"] if v["enforcement"] == "soft"}
        solution = {"decision": {"kind": "binding", "binding": binding}, **evaluation,
                    "penalties": [float(p["weight"]) * penalties.get(tuple(p["constraint"][key] for key in ("resource", "id")), 0) for p in spec["optimization"]["penalties"]]}
        solutions.append(solution)
        if scenario == "journey" and not any(v["enforcement"] == "hard" for v in evaluation["violations"]):
            score = objectives["score"]
            if isinstance(score, (int, float)) and (best is None or score < best):
                best = score
                # Evaluation index is real; no invented clock or generation is attached.
                trace.append({"eval_index": index, "best_objective": score, "feasible": True})
    if scenario == "collinear":
        solutions = [s for s in solutions if all(ref["id"] in {"budget", "fast"} for ref in s["decision"]["binding"].values())]
    elif scenario == "singleton":
        solutions = solutions[-1:]
    elif scenario == "empty":
        solutions = []
    elif scenario == "pooled-overlap":
        solutions = solutions[::2]
    return {
        "termination": "UNKNOWN",  # Diagnostic archive, not an optimization termination claim.
        "solutions": solutions,
        "provenance": {
            "analysisFixture": {"scenario": scenario, "description": description,
                "kind": "reference-evaluated-development-archive", "evaluatedBindings": count,
                "retainedBindings": len(solutions), "excludedFromArchive": count-len(solutions), "failedEvaluations": 0,
                "generatorVersion": GENERATOR_VERSION, "offset": offset,
                "includesRejectedCandidates": True, "notSolverBenchmark": True},
            "engineReported": {"algorithm": "deterministic-reference-enumeration", "trace": trace,
                "trace_kind": "strict-incumbent-improvements", "evaluations": count},
        },
    }


async def ensure_analysis_gallery(session, org, project, user, examples_dir: Path):
    """Add an immutable, content-addressed gallery without engine calls."""
    slug = "binding-analysis-gallery"
    study = (await session.execute(select(Study).where(Study.project_id == project.id, Study.slug == slug))).scalars().first()
    if study is None:
        study = Study(project_id=project.id, slug=slug, name="Binding Analysis Gallery · evaluated examples",
                      description="Development diagnostic archives evaluated by the canonical reference. Includes rejected bindings; not a solver benchmark.",
                      state=StudyState.DRAFT, created_by_id=user.id)
    # Content changes create a new immutable run; rerunning unchanged seeds creates nothing.
    packages = [(scenario, gallery_package(examples_dir, scenario, example), description) for scenario, example, description in GALLERY]
    evaluator_digest = compiler_bundle_digest()
    gallery_digest = digest({"version": GENERATOR_VERSION, "evaluator": evaluator_digest, "packages": [[s, p.package_digest, d] for s, p, d in packages]})
    runs = (await session.execute(select(StudyRun).where(StudyRun.study_id == study.id))).scalars().all() if study.id else []
    existing = next((run for run in runs if run.summary.get("galleryDigest") == gallery_digest), None)
    if existing:
        return study, existing
    run = StudyRun(id=uuid.uuid4(), study_id=study.id, run_number=max((r.run_number for r in runs), default=0) + 1,
                   state=RunState.COMPLETED, matrix_digest=gallery_digest,
                   summary={"cells": len(GALLERY), "analysisFixture": True, "galleryDigest": gallery_digest}, created_by_id=user.id, finished_at=utcnow())
    case_ids = []
    pending_cells = []
    for ordinal, (scenario, package, description) in enumerate(packages):
        problem = await routes_v1._compile_resolved(package, session)
        snapshot_id = await routes_v1._persist_snapshot(package, problem, user, session)
        if not snapshot_id:
            raise ValueError(f"Unable to persist analysis snapshot: {scenario}")
        case_slug = f"analysis-{scenario}"
        case = (await session.execute(select(BindingCase).where(BindingCase.project_id == project.id, BindingCase.slug == case_slug))).scalars().first()
        if case is None:
            case = BindingCase(project_id=project.id, slug=case_slug, name=f"Analysis · {scenario}", description=description, created_by_id=user.id)
            session.add(case)
            await session.flush()
        revisions = (await session.execute(select(BindingCaseRevision).where(BindingCaseRevision.binding_case_id == case.id))).scalars().all()
        from seed_dev import ensure_library_composition
        from openbinding_gateway.artifacts import case_composition_digest
        from openbinding_gateway.db.models import CaseArtifact
        document, materialized_id, uses = await ensure_library_composition(session, project, user, package, f'analysis-{scenario}')
        snapshot = await session.get(InstanceSnapshot, materialized_id)
        snapshot_id = str(materialized_id)
        package = load_package(snapshot.source_archive)
        problem = await routes_v1._compile_resolved(package, session, user)
        composition_digest = case_composition_digest(document, snapshot, [use.model_dump(mode='json') for use, _ in uses])
        revision = next((r for r in revisions if r.digest == composition_digest), None)
        if revision is None:
            revision = BindingCaseRevision(binding_case_id=case.id, revision=max((r.revision for r in revisions), default=0) + 1,
                                           digest=composition_digest, document=document, source_snapshot_id=materialized_id, created_by_id=user.id)
            session.add(revision)
            await session.flush()
            for use, version in uses:
                session.add(CaseArtifact(revision_id=revision.id, role=use.role, alias=use.alias, version_id=version.id, bindings=use.bindings))
        case_ids.append(revision.id)
        result = enumerate_gallery(problem, scenario, description)
        fixture_ref = {"namespace": "bim.dev", "name": "reference-enumeration", "version": "1", "digest": gallery_digest}
        provenance = {"engine": fixture_ref, "irDigest": problem.digest, "evaluatorDigest": evaluator_digest,
            "compilerDigest": evaluator_digest, "evaluator": "bim-reference-evaluator/v1", "profile": problem.document["spec"]["profile"],
            "packageDigest": package.package_digest, "instanceDigest": (await session.get(InstanceSnapshot, uuid.UUID(snapshot_id))).instance_digest,
            "analysisVersion": ANALYSIS_VERSION, "resultDigest": digest(result), **result["provenance"]}
        job = Job(owner_id=user.id, organization_id=org.id, project_id=project.id,
                  billing_sponsor_user_id=org.billing_sponsor_user_id,
                  engine_id=f"analysis-gallery/{scenario}", engine_job_id=f"gallery-{scenario}-{run.id}",
                  service_url="https://example.invalid/development-archive-not-an-engine",
                  state=JobState.COMPLETED, termination="UNKNOWN", result=result,
                  provenance=provenance,
                  instance_snapshot_id=uuid.UUID(snapshot_id), options={"analysisScenario": scenario},
                  metered=True, concurrency_released=True, finished_at=utcnow())
        session.add(job)
        await session.flush()
        session.add(JobProvenance(job_id=job.id, document=provenance, digest=digest(provenance)))
        pending_cells.append(StudyCell(study_run_id=run.id, ordinal=ordinal, binding_case_revision_id=revision.id,
                              engine_ref=fixture_ref, parameters={}, seed=0,
                              fingerprint=digest({"gallery": gallery_digest, "scenario": scenario}), job_id=job.id,
                              state=RunState.COMPLETED, metrics={"status": "completed", "analysisFixture": True,
                              "evaluatedBindings": result["provenance"]["analysisFixture"]["evaluatedBindings"], "analysisScenario": scenario}))
    from openbinding_gateway.studies import seal_study_definition
    definition = StudyDefinition(case_revision_ids=case_ids, engines=[fixture_ref], parameter_sets=[{}], seeds=[0])
    study.definition_version = await seal_study_definition(session, project, user, study.name, definition,
        current=study.definition_version if study.id else None, analysis_fixture=True)
    session.add(study)
    await session.flush()
    run.study_id = study.id
    run.definition_version_id = study.definition_version_id
    expanded = expand_study(definition)
    run.matrix_digest = digest([item["fingerprint"] for item in expanded])
    session.add(run)
    await session.flush()
    by_case = {str(cell.binding_case_revision_id): cell for cell in pending_cells}
    for item in expanded:
        cell = by_case[item["caseRevisionId"]]
        cell.ordinal = item["ordinal"]
        cell.fingerprint = item["fingerprint"]
        session.add(cell)
    run.matrix_digest = digest([item["fingerprint"] for item in expanded])
    study.state = StudyState.DRAFT
    await session.flush()
    return study, run


async def ensure_scale_archives(session, org, project, user, examples_dir: Path):
    """Opt-in unique assignments, evaluated in immutable batches of 500."""
    archives = {}
    for scenario, total in [("scale", 100_000), ("cancel-background", 10_000)]:
        package = gallery_package(examples_dir, scenario, "17_analysis_tradeoffs")
        problem = await routes_v1._compile_resolved(package, session)
        snapshot_id = uuid.UUID(await routes_v1._persist_snapshot(package, problem, user, session))
        snapshot = await session.get(InstanceSnapshot, snapshot_id)
        evaluator = compiler_bundle_digest()
        source_ids = []
        for offset in range(0, total, 500):
            identity = digest({"generator": GENERATOR_VERSION, "package": package.package_digest,
                               "evaluator": evaluator, "scenario": scenario, "offset": offset, "count": 500})
            key = f"analysis-diagnostic-{project.id}-{identity}"
            job = (await session.execute(select(Job).where(Job.owner_id == user.id, Job.idempotency_key == key))).scalars().first()
            if job is None:
                result = enumerate_gallery(problem, scenario, f"Canonical diagnostic batch {offset}–{offset+499}; not an engine benchmark", limit=500, offset=offset)
                provenance = {"engine": {"namespace": "bim.dev", "name": "reference-enumeration", "version": str(GENERATOR_VERSION), "digest": identity},
                    "irDigest": problem.digest, "evaluatorDigest": evaluator, "compilerDigest": evaluator,
                    "instanceDigest": snapshot.instance_digest, "packageDigest": package.package_digest,
                    "resultDigest": digest(result), "analysisVersion": ANALYSIS_VERSION, **result["provenance"]}
                job = Job(owner_id=user.id, organization_id=org.id, project_id=project.id,
                    billing_sponsor_user_id=org.billing_sponsor_user_id, engine_id=f"analysis-gallery/{scenario}",
                    engine_job_id=identity, service_url="https://example.invalid/development-archive-not-an-engine",
                    state=JobState.COMPLETED, termination="UNKNOWN", result=result, provenance=provenance,
                    instance_snapshot_id=snapshot_id, options={"analysisScenario": scenario, "offset": offset, "count": 500},
                    idempotency_key=key, idempotency_fingerprint=identity, metered=True, concurrency_released=True, finished_at=utcnow())
                session.add(job)
                await session.flush()
                session.add(JobProvenance(job_id=job.id, document=provenance, digest=digest(provenance)))
                await session.commit()
            source_ids.append(str(job.id))
        if scenario == "scale":
            for size in (1_000, 10_000, 100_000):
                archives[f"scale-{size}"] = source_ids[:size//500]
        else:
            archives[scenario] = source_ids
    return archives


async def prepare_analysis_workspace(session, org, project, user, examples_dir: Path, *, full=False, manifest_path: Path | None = None, live_jobs=None, study_runs=()):
    """Exercise production query/report/task services and record source links and failures."""
    import asyncio
    import platform
    import os
    import resource
    import time
    from openbinding_gateway.db.platform_models import Report
    from openbinding_gateway.models.analysis import AnalysisQuery, AnalysisReport
    from openbinding_gateway.routes import analysis

    study, run = await ensure_analysis_gallery(session, org, project, user, examples_dir)
    await session.commit()
    cells = (await session.execute(select(StudyCell).where(StudyCell.study_run_id == run.id).order_by(StudyCell.ordinal))).scalars().all()
    archives = {cell.metrics["analysisScenario"]: [str(cell.job_id)] for cell in cells}
    archives["compatible-pool"] = archives["tradeoffs"] + archives["pooled-overlap"]
    if live_jobs is None:
        # Engine-free population may inspect recorded history; live profiles pass their exact current scenarios.
        live_jobs = (await session.execute(select(Job).where(Job.project_id == project.id,
            Job.idempotency_key.like("development-live-%")))).scalars().all()
    for job in live_jobs:
        if job.state == JobState.COMPLETED:
            archives[f"live-{job.engine_id}-{str(job.id)[:8]}"] = [str(job.id)]
    if full:
        archives.update(await ensure_scale_archives(session, org, project, user, examples_dir))
    manifest = {"version": GENERATOR_VERSION, "analysisVersion": ANALYSIS_VERSION, "host": platform.platform(),
                "processor": platform.processor(), "logicalCpus": os.cpu_count(), "generatedAt": utcnow().isoformat(), "profile": "full" if full else "bounded",
                "scenarios": {}, "coverageGaps": []}
    for scenario, ids in archives.items():
        query = AnalysisQuery(sources=ids)
        started = time.perf_counter()
        response = await analysis.query_analysis(query, user, session)
        elapsed = time.perf_counter() - started
        response_json = json.dumps(analysis.jsonable_encoder(response), separators=(",", ":"))
        entry = {"jobIds": ids, "revision": response["revision"], "analysisLink": "/app/analysis?" + "&".join(f"job={sid}" for sid in ids),
                 "querySeconds": elapsed, "queryPayloadBytes": len(response_json.encode()), "counts": response["counts"],
                 "expected": next((d for s, _, d in GALLERY if s == scenario), "Complete compatible archive; exact rankings and unknown unexplored space"),
                 "reportLink": None}
        manifest["scenarios"][scenario] = entry
        if scenario != "cancel-background":
            slug = f"analysis-{scenario}-{response['revision'].removeprefix('sha256:')[:12]}"
            report = (await session.execute(select(Report).where(Report.project_id == project.id, Report.slug == slug))).scalars().first()
            if report is None:
                await analysis.save_report(AnalysisReport(sources=ids, organization=org.slug, project=project.slug,
                    title=f"Binding decision · {scenario}", slug=slug), user, session)
                await session.commit()
            entry["reportLink"] = f"/app/{org.slug}/{project.slug}/reports/{slug}"
            if len(ids) > 100:
                entry["analysisLink"] = f"/app/analysis?report={org.slug}/{project.slug}/{slug}"
        if scenario == "background":
            task = await analysis.start_pareto(query.model_copy(update={"layers": True}), user, session)
            deadline = time.monotonic() + 120
            while task.state in ("running", "queued") and time.monotonic() < deadline:
                await asyncio.sleep(1)
                task = await analysis.get_pareto(uuid.UUID(task.id), user, session)
            entry["task"] = task.model_dump(exclude={"result"})
            if task.state != "completed":
                manifest["coverageGaps"].append(f"Background completion: {task.state}: {task.error}")
        elif scenario == "cancel-background":
            task = await analysis.start_pareto(query.model_copy(update={"layers": True}), user, session)
            deadline = time.monotonic() + 30
            while task.state == "queued" and time.monotonic() < deadline:
                await asyncio.sleep(.2)
                task = await analysis.get_pareto(uuid.UUID(task.id), user, session)
            observed_running = task.state == "running"
            task = await analysis.cancel_pareto(uuid.UUID(task.id), user, session)
            entry["task"] = {**task.model_dump(exclude={"result"}), "observedRunning": observed_running}
            if task.state != "cancelled" or not observed_running:
                manifest["coverageGaps"].append("Cancellation did not interrupt an observed running calculation")
    manifest["studyRuns"] = [{"id": str(run.id), "state": run.state.value, "matrixDigest": run.matrix_digest} for _, run in study_runs]
    for study, run in study_runs:
        if run.state != RunState.COMPLETED:
            manifest["coverageGaps"].append(f"Live study {study.slug} run {run.run_number}: {run.state.value}")
    manifest["liveJobs"] = [{"id": str(job.id), "engine": job.engine_id, "state": job.state.value, "termination": job.termination,
                             "retained": len((job.result or {}).get("solutions", [])),
                             "evaluated": (job.result or {}).get("provenance", {}).get("engineReported", {}).get("evaluations")} for job in live_jobs]
    for engine in ("minizinc-csp", "random-search"):
        if not any(job.engine_id == engine and job.state == JobState.COMPLETED and (job.result or {}).get("solutions") for job in live_jobs):
            manifest["coverageGaps"].append(f"No successful persisted live-job coverage for {engine}")
    manifest["populationPeakRssBytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if platform.system() == "Darwin" else 1024)
    if manifest_path:
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest
