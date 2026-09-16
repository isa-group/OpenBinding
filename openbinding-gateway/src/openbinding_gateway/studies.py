"""Deterministic study expansion and small, inspectable aggregations."""

from __future__ import annotations

import itertools
from collections import defaultdict
from typing import Any

from .models.platform import StudyDefinition
from .v1.canonical import digest


def expand_study(definition: StudyDefinition) -> list[dict[str, Any]]:
    cells = []
    engines = sorted(
        definition.engines,
        key=lambda item: tuple(item[key] for key in ("namespace", "name", "version", "digest"))
        + (item.get("mode", ""),),
    )
    cases = sorted(definition.case_revision_ids, key=str)
    parameters = sorted(definition.parameter_sets, key=digest)
    seeds = sorted(definition.seeds)
    for ordinal, (case_id, engine, parameter_set, seed) in enumerate(
        itertools.product(cases, engines, parameters, seeds)
    ):
        frozen = {
            "caseRevisionId": str(case_id),
            "engine": engine,
            "parameters": parameter_set,
            "seed": seed,
        }
        cells.append({"ordinal": ordinal, "fingerprint": digest(frozen), **frozen})
    return cells


def nondominated(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a deterministic minimization Pareto front."""

    normalized = [point for point in points if point and all(isinstance(v, (int, float)) for v in point.values())]
    front = []
    for index, candidate in enumerate(normalized):
        dominated = False
        for other_index, other in enumerate(normalized):
            if index == other_index or set(other) != set(candidate):
                continue
            if all(other[key] <= candidate[key] for key in candidate) and any(
                other[key] < candidate[key] for key in candidate
            ):
                dominated = True
                break
        if not dominated:
            front.append(candidate)
    return sorted(front, key=lambda item: tuple(item[key] for key in sorted(item)))


def aggregate_metrics(metrics: list[dict[str, Any]]) -> dict[str, Any]:
    objectives: dict[str, list[float]] = defaultdict(list)
    runtimes = []
    feasible = infeasible = failed = 0
    by_engine: dict[str, list[tuple[float, ...]]] = defaultdict(list)
    for metric in metrics:
        status = metric.get("status")
        if status == "failed":
            failed += 1
            continue
        if metric.get("feasible") is True:
            feasible += 1
        elif metric.get("feasible") is False:
            infeasible += 1
        runtime = metric.get("runtimeSeconds")
        if isinstance(runtime, (int, float)):
            runtimes.append(float(runtime))
        values = metric.get("objectives")
        if isinstance(values, dict) and values:
            point = {str(key): float(value) for key, value in values.items() if isinstance(value, (int, float))}
            if point:
                for key, value in point.items():
                    objectives[key].append(value)
                engine = str(metric.get("engine", "unknown"))
                by_engine[engine].append(tuple(point[key] for key in sorted(point)))
    stability = {
        engine: {
            "samples": len(samples),
            "distinct": len(set(samples)),
            "repeatability": 0 if not samples else 1 - ((len(set(samples)) - 1) / len(samples)),
        }
        for engine, samples in sorted(by_engine.items())
    }
    return {
        "cells": len(metrics),
        "completed": len(metrics) - failed,
        "failed": failed,
        "feasible": feasible,
        "infeasible": infeasible,
        "objective_distributions": {key: sorted(values) for key, values in sorted(objectives.items())},
        "runtimes_s": sorted(runtimes),
        "pareto": [],
        "paretoStatus": "unavailable: study cells may use incompatible models; open a compatible binding archive",
        "stability": stability,
    }


async def seal_study_definition(session, project, user, name, definition, *, current=None, analysis_fixture=False):
    """Persist the sole authoritative definition in the organization library."""
    import uuid
    from sqlalchemy import select
    from .artifacts import seal_draft, reference
    from .db.models import Artifact, ArtifactDraft, ArtifactVersion, BindingCaseRevision, ProjectArtifact
    from .models.artifacts import DraftContent
    from .routes.v1 import _engine_mode
    from .v1.canonical import digest

    definition = StudyDefinition.model_validate(definition)
    dependencies = []
    if analysis_fixture:
        content = {'apiVersion': 'openbinding/analysis-gallery/v1', 'definition': definition.model_dump(mode='json')}
        kind = 'Dataset'
    else:
        cases = []
        for case_id in definition.case_revision_ids:
            case = await session.get(BindingCaseRevision, case_id)
            if case is None:
                from .models.errors import api_error
                raise api_error(422, 'missing_case_revision', 'The study case revision is unavailable.')
            cases.append({'caseRevisionId': str(case.id), 'compositionDigest': case.digest})
        engines = []
        for engine in definition.engines:
            _, mode, _ = await _engine_mode(engine['name'], engine.get('mode'), definition.parameter_sets[0], session, caller=user,
                namespace=engine['namespace'], version=engine['version'], manifest_digest=engine['digest'])
            engines.append({**engine, 'mode': mode['id']})
        content = {'apiVersion': 'openbinding/study/v1', 'cases': cases, 'engines': engines,
                   'parameter_sets': definition.parameter_sets, 'seeds': definition.seeds}
        kind = 'Study'
        if definition.collection_version_id:
            collection = await session.get(ArtifactVersion, definition.collection_version_id)
            source = await session.get(Artifact, collection.artifact_id)
            content['collection'] = reference(source, collection)
            dependencies.append(content['collection'])
    if current and current.content_digest == digest(content):
        return current
    artifact = await session.get(Artifact, current.artifact_id) if current else None
    if artifact is None:
        artifact = Artifact(organization_id=project.organization_id, namespace=str(project.organization_id),
            name='study-' + uuid.uuid4().hex, display_name=name, kind=kind, created_by_id=user.id)
        session.add(artifact)
        await session.flush()
    draft = ArtifactDraft(artifact_id=artifact.id, based_on_id=current.id if current else None,
        payload=DraftContent(content=content, dependencies=dependencies).model_dump(mode='json'), created_by_id=user.id)
    session.add(draft)
    await session.flush()
    version = await seal_draft(session, artifact, draft, 1, None, user)
    if await session.get(ProjectArtifact, (project.id, artifact.id)) is None:
        session.add(ProjectArtifact(project_id=project.id, artifact_id=artifact.id))
        await session.flush()
    return version


def definition_from_version(version) -> dict:
    from .artifacts import verified_version_content
    from .models.artifacts import StudyArtifactContent
    from .v1.package import strict_json_loads
    document = strict_json_loads(verified_version_content(version, version.blob)[0])
    if document.get('apiVersion') == 'openbinding/analysis-gallery/v1':
        return document['definition']
    return StudyArtifactContent.model_validate(document).definition().model_dump(mode='json')
