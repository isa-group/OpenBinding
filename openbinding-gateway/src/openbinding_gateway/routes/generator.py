"""API routes for BIM v1 QACO problem generation, corpus synthesis, legacy conversion and calibration."""

from __future__ import annotations

import io
import uuid
import zipfile
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import (
    get_optional_user,
    session_dependency,
)
from ..collaboration import require_role
from ..db.models import (
    BindingCase,
    BindingCaseRevision,
    Collection,
    CollectionItem,
    CollectionRevision,
    EngineProfileSurrogate,
    Organization,
    OrganizationRole,
    Project,
    Study,
    User,
    utcnow,
)
from ..engine_routing.calibration import (
    CalibrationObservation,
    fit_surrogate_model,
)
from ..engine_routing.features import extract_features
from ..engine_routing.profiler import get_engine_profiler
from ..engine_routing.confidence import get_confidence_estimator
from ..generator.compatibility import (
    IncompatibleTargetEnginesError,
)
from ..generator.legacy_parser import parse_legacy_file
from ..generator.postprocessor import BIMPostprocessor
from ..generator.synthesizer import generate_instance_package
from ..models.errors import api_error
from ..v1.compiler import compile_instance
from ..v1.package import InstancePackage
from .v1 import _persist_snapshot

router = APIRouter(prefix="/v1/generator", tags=["generator"])


class GenerateInstanceRequest(BaseModel):
    tasks: int = Field(default=10, ge=2, le=1000, description="Total number of tasks/activities.")
    candidates: int = Field(default=5, ge=2, le=100, description="Candidate services per task.")
    control_flow: int = Field(default=50, ge=0, le=90, description="Percentage of activities that are control flow.")
    loops: float = Field(default=30.0, ge=0.0, le=100.0, description="Relative percentage of loops.")
    branches: float = Field(default=30.0, ge=0.0, le=100.0, description="Relative percentage of branches.")
    parallel: float = Field(default=20.0, ge=0.0, le=100.0, description="Relative percentage of parallel flows.")
    max_nesting: int = Field(default=3, ge=1, le=10, description="Maximum control structure nesting level.")
    iterations_per_loop: int = Field(default=5, ge=1, le=50, description="Average iterations per loop.")
    qos_properties: int = Field(default=5, ge=1, le=5, description="Number of QoS properties.")
    constraints: int = Field(default=1, ge=0, le=10, description="Number of global constraints.")
    target_engines: list[str] = Field(default_factory=list, description="Target solver engines.")
    optimization_mode: Optional[str] = Field(default=None, description="Optimization mode: 'weighted' or 'pareto'.")
    guarantee_feasibility: bool = Field(default=True, description="Guarantee feasibility using witness solution.")
    tension: float = Field(default=0.7, ge=0.0, le=1.0, description="Constraint tightness factor in [0, 1].")
    name: str = Field(default="generated_instance", description="Instance name.")
    profile: str = Field(default="qos-binding/v1", description="BIM container profile.")
    dialects: list[str] = Field(default_factory=lambda: ["qos-binding/v1"], description="Allowed dialects.")
    seed: Optional[int] = Field(default=None, description="Random seed for reproducibility.")
    persist: bool = Field(default=False, description="Whether to persist as InstanceSnapshot in DB.")
    project_id: Optional[uuid.UUID] = Field(default=None, description="Project ID to persist a BindingCase.")
    case_name: Optional[str] = Field(default=None, description="Custom name for the BindingCase if persisted.")
    use_legacy_engine: bool = Field(default=False, description="Run the legacy Java CLI generator.")


class InstanceGeneratedResponse(BaseModel):
    name: str
    package_digest: str
    instance_digest: str
    compilation_digest: str
    snapshot_id: Optional[str] = None
    case_id: Optional[str] = None
    target_engines: list[str]
    workload_features: dict[str, Any]
    files: dict[str, Any]


class GenerateCorpusRequest(BaseModel):
    count: int = Field(default=5, ge=1, le=100, description="Number of instances to generate.")
    base_config: GenerateInstanceRequest = Field(default_factory=GenerateInstanceRequest)
    name: str = Field(default="corpus", description="Corpus identifier.")
    persist: bool = Field(default=False, description="Whether to persist instances to DB.")
    project_id: Optional[uuid.UUID] = Field(default=None, description="Project to create Collection and Study in.")
    collection_name: Optional[str] = Field(default=None, description="Name for the Collection.")
    create_study: bool = Field(default=False, description="Whether to create a benchmark Study.")
    as_archive: bool = Field(default=False, description="Return instances as a zip archive.")


class CorpusGeneratedResponse(BaseModel):
    name: str
    count: int
    instances: list[dict[str, Any]]
    collection_id: Optional[str] = None
    study_id: Optional[str] = None


class ConvertLegacyRequest(BaseModel):
    raw_text: str = Field(..., description="Legacy QACO problem text.")
    name: str = Field(default="converted_legacy", description="Instance name.")
    profile: str = Field(default="qos-binding/v1", description="BIM container profile.")
    dialects: list[str] = Field(default_factory=lambda: ["qos-binding/v1"], description="Allowed dialects.")
    repair_empty_branches: bool = Field(default=True, description="Repair empty sequences in branches.")
    guarantee_feasibility: bool = Field(default=True, description="Enforce witness feasibility.")
    tension: float = Field(default=0.7, ge=0.0, le=1.0, description="Constraint tightness factor.")
    persist: bool = Field(default=False, description="Whether to persist as InstanceSnapshot.")
    project_id: Optional[uuid.UUID] = Field(default=None, description="Project ID to create a BindingCase.")
    case_name: Optional[str] = Field(default=None, description="BindingCase name.")


class CalibrateEngineRequest(BaseModel):
    engine: str = Field(..., description="Target engine name.")
    mode: str = Field(default="default", description="Engine mode.")
    observations: list[dict[str, Any]] = Field(default_factory=list, description="Historical execution observations.")


class EngineCalibratedResponse(BaseModel):
    engine: str
    mode: str
    sample_count: int
    latency_coefficients: dict[str, float]
    quality_coefficients: dict[str, float]
    failure_risk_coefficients: dict[str, float]
    r2_score: float
    status: str = "calibrated"


async def _verify_project_member(session: AsyncSession, project_id: uuid.UUID, caller: User) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    org = await session.get(Organization, project.organization_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    await require_role(session, org, caller, OrganizationRole.MEMBER)
    return project


@router.post("/instances", response_model=InstanceGeneratedResponse)
async def generate_instance(
    request: GenerateInstanceRequest,
    session: AsyncSession = Depends(session_dependency),
    caller: Optional[User] = Depends(get_optional_user),
) -> Any:
    """Synthesize a single valid BIM v1 QACO instance."""
    try:
        package = generate_instance_package(
            tasks=request.tasks,
            candidates=request.candidates,
            control_flow=request.control_flow,
            loops=request.loops,
            branches=request.branches,
            parallel=request.parallel,
            max_nesting=request.max_nesting,
            iterations_per_loop=request.iterations_per_loop,
            qos_properties=request.qos_properties,
            constraints=request.constraints,
            target_engines=request.target_engines,
            optimization_mode=request.optimization_mode,
            guarantee_feasibility=request.guarantee_feasibility,
            tension=request.tension,
            name=request.name,
            profile=request.profile,
            dialects=request.dialects,
            seed=request.seed,
            use_legacy_engine=request.use_legacy_engine,
        )
    except IncompatibleTargetEnginesError as exc:
        raise api_error(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            code="incompatible_target_engines",
            message=exc.message,
            conflicts=exc.conflicts,
        ) from exc

    compiled = compile_instance(package)
    features = extract_features(compiled)

    snapshot_id: Optional[str] = None
    case_id: Optional[str] = None

    if request.persist:
        if caller is None:
            raise HTTPException(status_code=401, detail="Authentication required to persist instances")
        snapshot_id = await _persist_snapshot(package, compiled, caller, session)
        if request.project_id is not None:
            await _verify_project_member(session, request.project_id, caller)
            case_slug = f"case-{uuid.uuid4().hex[:8]}"
            case_obj = BindingCase(
                project_id=request.project_id,
                slug=case_slug,
                name=request.case_name or request.name,
                description=f"Generated QACO instance {package.package_digest[:12]}",
                created_by_id=caller.id,
            )
            session.add(case_obj)
            await session.flush()
            case_rev = BindingCaseRevision(
                binding_case_id=case_obj.id,
                revision=1,
                digest=package.package_digest,
                document=package.instance(),
                source_snapshot_id=uuid.UUID(snapshot_id),
                created_by_id=caller.id,
            )
            session.add(case_rev)
            await session.flush()
            case_id = str(case_obj.id)

    files_json = {
        name: package.json(name)
        for name in sorted(package.files)
        if name.endswith(".json")
    }

    return InstanceGeneratedResponse(
        name=request.name,
        package_digest=package.package_digest,
        instance_digest=package.instance()["metadata"].get("name", request.name),
        compilation_digest=compiled.digest,
        snapshot_id=snapshot_id,
        case_id=case_id,
        target_engines=request.target_engines,
        workload_features=features.to_dict(),
        files=files_json,
    )


@router.post("/corpus", response_model=CorpusGeneratedResponse)
async def generate_corpus(
    request: GenerateCorpusRequest,
    session: AsyncSession = Depends(session_dependency),
    caller: Optional[User] = Depends(get_optional_user),
) -> Any:
    """Generate a corpus of problem instances with optional Collection & Study initialization."""
    base = request.base_config
    instances: list[dict[str, Any]] = []
    packages: list[InstancePackage] = []
    snapshot_ids: list[str] = []

    if request.persist and caller is None:
        raise HTTPException(status_code=401, detail="Authentication required to persist corpus")

    for idx in range(request.count):
        seed_val = (base.seed + idx) if base.seed is not None else None
        inst_name = f"{request.name}_{idx + 1}"
        try:
            pkg = generate_instance_package(
                tasks=base.tasks,
                candidates=base.candidates,
                control_flow=base.control_flow,
                loops=base.loops,
                branches=base.branches,
                parallel=base.parallel,
                max_nesting=base.max_nesting,
                iterations_per_loop=base.iterations_per_loop,
                qos_properties=base.qos_properties,
                constraints=base.constraints,
                target_engines=base.target_engines,
                optimization_mode=base.optimization_mode,
                guarantee_feasibility=base.guarantee_feasibility,
                tension=base.tension,
                name=inst_name,
                profile=base.profile,
                dialects=base.dialects,
                seed=seed_val,
                use_legacy_engine=base.use_legacy_engine,
            )
        except IncompatibleTargetEnginesError as exc:
            raise api_error(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                code="incompatible_target_engines",
                message=exc.message,
                conflicts=exc.conflicts,
            ) from exc

        compiled = compile_instance(pkg)
        features = extract_features(compiled)
        packages.append(pkg)

        snap_id: Optional[str] = None
        if request.persist:
            snap_id = await _persist_snapshot(pkg, compiled, caller, session)
            if snap_id:
                snapshot_ids.append(snap_id)

        instances.append({
            "name": inst_name,
            "package_digest": pkg.package_digest,
            "compilation_digest": compiled.digest,
            "snapshot_id": snap_id,
            "workload_features": features.to_dict(),
        })

    collection_id: Optional[str] = None
    study_id: Optional[str] = None

    if request.persist and request.project_id is not None:
        await _verify_project_member(session, request.project_id, caller)

        c_slug = f"col-{uuid.uuid4().hex[:8]}"
        collection = Collection(
            project_id=request.project_id,
            slug=c_slug,
            name=request.collection_name or f"{request.name}_collection",
            description=f"Generated corpus of {len(instances)} instances",
            created_by_id=caller.id,
        )
        session.add(collection)
        await session.flush()

        from ..v1.crypto import digest
        col_digest = digest({"snapshots": snapshot_ids})
        col_rev = CollectionRevision(
            collection_id=collection.id,
            revision=1,
            digest=col_digest,
            created_by_id=caller.id,
        )
        session.add(col_rev)
        await session.flush()

        for ord_idx, s_id in enumerate(snapshot_ids):
            session.add(
                CollectionItem(
                    collection_revision_id=col_rev.id,
                    target_kind="instance",
                    target_digest=s_id,
                    position=ord_idx,
                )
            )
        await session.flush()
        collection_id = str(collection.id)

        if request.create_study:
            study = Study(
                project_id=request.project_id,
                name=f"{request.name}_study",
                description=f"Automated benchmark study on {collection.name}",
                created_by_id=caller.id,
            )
            session.add(study)
            await session.flush()
            study_id = str(study.id)

    if request.as_archive:
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for idx, p in enumerate(packages):
                zf.writestr(f"{instances[idx]['name']}.bim.zip", p.to_zip())
        return Response(
            content=zip_buffer.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{request.name}.zip"'},
        )

    return CorpusGeneratedResponse(
        name=request.name,
        count=len(instances),
        instances=instances,
        collection_id=collection_id,
        study_id=study_id,
    )


@router.post("/convert-legacy", response_model=InstanceGeneratedResponse)
async def convert_legacy(
    request: ConvertLegacyRequest,
    session: AsyncSession = Depends(session_dependency),
    caller: Optional[User] = Depends(get_optional_user),
) -> Any:
    """Parse and convert raw legacy text into a strict BIM v1 package."""
    problem = parse_legacy_file(request.raw_text)
    postprocessor = BIMPostprocessor(
        name=request.name,
        profile=request.profile,
        dialects=request.dialects,
        guarantee_feasibility=request.guarantee_feasibility,
        tension=request.tension,
        repair_empty_branches=request.repair_empty_branches,
    )
    package = postprocessor.process(problem)
    compiled = compile_instance(package)
    features = extract_features(compiled)

    snapshot_id: Optional[str] = None
    case_id: Optional[str] = None

    if request.persist:
        if caller is None:
            raise HTTPException(status_code=401, detail="Authentication required to persist instances")
        snapshot_id = await _persist_snapshot(package, compiled, caller, session)

        if request.project_id is not None:
            await _verify_project_member(session, request.project_id, caller)
            case_slug = f"case-{uuid.uuid4().hex[:8]}"
            case_obj = BindingCase(
                project_id=request.project_id,
                slug=case_slug,
                name=request.case_name or request.name,
                description=f"Converted QACO instance {package.package_digest[:12]}",
                created_by_id=caller.id,
            )
            session.add(case_obj)
            await session.flush()
            case_rev = BindingCaseRevision(
                binding_case_id=case_obj.id,
                revision=1,
                digest=package.package_digest,
                document=package.instance(),
                source_snapshot_id=uuid.UUID(snapshot_id),
                created_by_id=caller.id,
            )
            session.add(case_rev)
            await session.flush()
            case_id = str(case_obj.id)

    files_json = {
        name: package.json(name)
        for name in sorted(package.files)
        if name.endswith(".json")
    }

    return InstanceGeneratedResponse(
        name=request.name,
        package_digest=package.package_digest,
        instance_digest=package.instance()["metadata"].get("name", request.name),
        compilation_digest=compiled.digest,
        snapshot_id=snapshot_id,
        case_id=case_id,
        target_engines=[],
        workload_features=features.to_dict(),
        files=files_json,
    )


@router.post("/calibrate-engine", response_model=EngineCalibratedResponse)
async def calibrate_engine(
    request: CalibrateEngineRequest,
    session: AsyncSession = Depends(session_dependency),
    caller: Optional[User] = Depends(get_optional_user),
) -> Any:
    """Calibrate surrogate performance models for a federated or black-box engine."""
    observations = [
        CalibrationObservation(
            workload_features=obs.get("workload_features", {}),
            latency=float(obs.get("latency", 1.0)),
            quality=float(obs.get("quality", 0.85)),
            success=bool(obs.get("success", True)),
        )
        for obs in request.observations
    ]

    surrogate = fit_surrogate_model(request.engine, request.mode, observations)

    # Register in in-memory profiler
    profiler = get_engine_profiler()
    profiler.register_surrogate(surrogate)

    # Register observation density in confidence estimator
    conf_estimator = get_confidence_estimator()
    for obs in observations:
        wf = obs.workload_features
        from ..engine_routing.features import WorkloadFeatures
        w_feat = WorkloadFeatures(
            S=float(wf.get("S", 0.0)),
            D_constr=float(wf.get("D_constr", 0.0)),
            N_tasks=int(wf.get("N_tasks", 1)),
            N_cap=int(wf.get("N_cap", 1)),
            opt_mode=str(wf.get("OptMode", "weighted")),
            D_obj=int(wf.get("D_obj", 1)),
            T_budget=float(wf.get("T_budget", 30.0)),
        )
        conf_estimator.record_observation(request.engine, w_feat)

    # Persist or update surrogate record in DB if session is available
    query = select(EngineProfileSurrogate).where(
        EngineProfileSurrogate.engine == request.engine,
        EngineProfileSurrogate.mode == request.mode,
    )
    existing = (await session.execute(query)).scalars().first()
    if existing is not None:
        existing.latency_coefficients = surrogate.latency_coefficients
        existing.quality_coefficients = surrogate.quality_coefficients
        existing.failure_risk_coefficients = surrogate.failure_risk_coefficients
        existing.sample_count = surrogate.sample_count
        existing.r2_score = surrogate.r2_score
        existing.last_calibrated_at = utcnow()
    else:
        new_row = EngineProfileSurrogate(
            engine=request.engine,
            mode=request.mode,
            latency_coefficients=surrogate.latency_coefficients,
            quality_coefficients=surrogate.quality_coefficients,
            failure_risk_coefficients=surrogate.failure_risk_coefficients,
            sample_count=surrogate.sample_count,
            r2_score=surrogate.r2_score,
            metadata_info={"calibrated_by": caller.email if caller else "anonymous"},
        )
        session.add(new_row)
    await session.flush()

    return EngineCalibratedResponse(
        engine=surrogate.engine,
        mode=surrogate.mode,
        sample_count=surrogate.sample_count,
        latency_coefficients=surrogate.latency_coefficients,
        quality_coefficients=surrogate.quality_coefficients,
        failure_risk_coefficients=surrogate.failure_risk_coefficients,
        r2_score=surrogate.r2_score,
    )
