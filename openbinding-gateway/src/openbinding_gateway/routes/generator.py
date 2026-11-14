"""API routes for BIM v1 QACO problem generation, corpus synthesis and legacy conversion.

Who may call what: ``POST /instances``, ``/corpus`` and ``/convert-legacy`` are
pure functions of their request and touch no shared state, so any caller, even
anonymous, may use them. Persisting (``persist=true``) needs an account, and
attaching the result to a project needs MEMBER access to that project.

Each compiles what it generates, so all three are counted against the caller's
``compile`` budget (``access/work_limits.py``), and a corpus is charged per instance.
"""

from __future__ import annotations

import asyncio
import base64
import io
import uuid
import zipfile
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import (
    get_optional_user,
    session_dependency,
)
from ..access.work_limits import enforce_work_rate_limit, limit_work
from ..collaboration import require_role
from ..db.models import (
    BindingCase,
    BindingCaseRevision,
    Organization,
    OrganizationRole,
    Project,
    User,
)
from ..generator.compatibility import (
    IncompatibleTargetEnginesError,
)
from ..generator.config import FeatureDefinition, GenerationDistributions, StrictModel, expand_features
from ..generator.legacy_parser import LegacyParseError, parse_legacy_file
from ..generator.postprocessor import BIMPostprocessor
from ..generator.synthesizer import generate_instance_package
from ..generator.package import GeneratedPackage
from ..integrations import bim
from ..models.errors import api_error
from ..services.snapshots import Compilation, persist_snapshot

router = APIRouter(prefix="/v1/generator", tags=["generator"])


class GenerateInstanceRequest(StrictModel):
    tasks: int = Field(default=10, ge=2, le=1000, description="Total number of tasks/activities.")
    candidates: int = Field(default=5, ge=2, le=100, description="Candidate services per task.")
    control_flow: int = Field(default=50, ge=0, le=90, description="Percentage of activities that are control flow.")
    loops: float = Field(default=30.0, ge=0.0, le=100.0, allow_inf_nan=False, description="Relative percentage of loops.")
    branches: float = Field(default=30.0, ge=0.0, le=100.0, allow_inf_nan=False, description="Relative percentage of branches.")
    parallel: float = Field(default=20.0, ge=0.0, le=100.0, allow_inf_nan=False, description="Relative percentage of parallel flows.")
    max_nesting: int = Field(default=3, ge=1, le=10, description="Maximum control structure nesting level.")
    iterations_per_loop: int = Field(default=5, ge=1, le=50, description="Average iterations per loop.")
    features: list[FeatureDefinition] = Field(min_length=1, description="Explicit candidate feature definitions.")
    distributions: GenerationDistributions = Field(default_factory=GenerationDistributions)
    constraints: int = Field(default=1, ge=0, le=100, description="Exact or expected number of distinct feature constraints.")
    constraint_count_mode: str = Field(default="exact", pattern="^(exact|expected)$")
    target_engines: list[str] = Field(default_factory=list, description="Target solver engines.")
    optimization_mode: Optional[str] = Field(default=None, description="Optimization mode: 'weighted' or 'pareto'.")
    guarantee_feasibility: bool = Field(default=True, description="Guarantee feasibility using witness solution.")
    tension: float = Field(default=0.7, ge=0.0, le=1.0, allow_inf_nan=False, description="Constraint tightness factor in [0, 1].")
    name: str = Field(default="generated_instance", description="Instance name.")
    profile: str = Field(default="qos-binding/v1", description="BIM container profile.")
    dialects: list[str] = Field(default_factory=lambda: ["qos-binding/v1"], description="Allowed dialects.")
    seed: Optional[int] = Field(default=None, ge=-(2**63), le=2**63 - 1, description="Random seed for reproducibility.")
    persist: bool = Field(default=False, description="Whether to persist as InstanceSnapshot in DB.")
    include_file_bytes: bool = Field(default=False, description="Include exact generated file bytes as base64 for reproducible exports.")
    project_id: Optional[uuid.UUID] = Field(default=None, description="Project ID to persist a BindingCase.")
    case_name: Optional[str] = Field(default=None, description="Custom name for the BindingCase if persisted.")
    use_legacy_engine: bool = Field(default=False, description="Run the legacy Java CLI generator.")

    @model_validator(mode="before")
    @classmethod
    def reject_removed_fields(cls, value: Any) -> Any:
        if isinstance(value, dict):
            corrections = {
                "qos_properties": "define explicit features instead",
                "templates": "define each feature directly in features",
                "template": "define the feature directly in features",
                "weights": "provide optional weights when executing a job, not when generating",
            }
            for field, correction in corrections.items():
                if field in value:
                    raise ValueError(f"{field}: unsupported generator input; {correction}")
        return value

    @model_validator(mode="after")
    def check_generation(self) -> "GenerateInstanceRequest":
        expanded = expand_features(self.features)
        if not any(item["objective"] for item in expanded):
            raise ValueError("features: at least one objective=true is required")
        if self.constraints > len(expanded):
            raise ValueError("constraints: cannot exceed expanded features; reduce constraints or add features")
        abstract_count = max(2, self.tasks * (100 - self.control_flow) // 100)
        max_candidates = (self.distributions.candidate_count.maximum if self.distributions.candidate_count else self.candidates)
        if abstract_count * max_candidates * len(expanded) > 1_000_000:
            raise ValueError("features/candidates/tasks: at most 1,000,000 candidate-feature values; reduce the size")
        if self.distributions.candidate_count and "candidates" in self.model_fields_set:
            raise ValueError("candidates: remove it when distributions.candidate_count is set")
        if self.distributions.loop_iterations and "iterations_per_loop" in self.model_fields_set:
            raise ValueError("iterations_per_loop: remove it when distributions.loop_iterations is set")
        possible_cf = min(round(self.tasks * self.control_flow / 100), self.tasks - abstract_count)
        if possible_cf == 0 and self.control_flow > 0 and "control_flow" in self.model_fields_set:
            raise ValueError("control_flow: task count leaves no room for control nodes; increase tasks or set control_flow=0")
        if possible_cf == 0 and self.model_fields_set.intersection({"loops", "branches", "parallel", "max_nesting", "iterations_per_loop"}):
            raise ValueError("control_flow: no control nodes can be generated; remove loops, branches, parallel, max_nesting and iterations_per_loop")
        if possible_cf == 0 and (self.distributions.loop_iterations or self.distributions.branches_per_decision):
            raise ValueError("distributions: control_flow creates no control nodes; increase it or remove structural distributions")
        if possible_cf and self.loops + self.branches + self.parallel == 0:
            raise ValueError("loops/branches/parallel: at least one percentage must be positive when control_flow creates nodes")
        if self.distributions.loop_iterations and self.loops == 0:
            raise ValueError("distributions.loop_iterations: loops is zero; increase loops or remove the distribution")
        if self.loops == 0 and "iterations_per_loop" in self.model_fields_set:
            raise ValueError("iterations_per_loop: loops is zero; remove iterations_per_loop or increase loops")
        if self.distributions.branches_per_decision and self.branches == 0:
            raise ValueError("distributions.branches_per_decision: branches is zero; increase branches or remove the distribution")
        if self.distributions.constraint_optimality_percent:
            if self.guarantee_feasibility:
                raise ValueError("guarantee_feasibility: set false to use distributions.constraint_optimality_percent")
            if self.constraints == 0:
                raise ValueError("distributions.constraint_optimality_percent: constraints is zero; increase constraints or remove it")
        if not self.guarantee_feasibility and "tension" in self.model_fields_set:
            raise ValueError("tension: remove it when guarantee_feasibility is false")
        if self.constraints == 0 and "tension" in self.model_fields_set:
            raise ValueError("tension: remove it when constraints is zero")
        if self.constraints == 0 and "constraint_count_mode" in self.model_fields_set:
            raise ValueError("constraint_count_mode: remove it when constraints is zero")
        if self.project_id is not None and not self.persist:
            raise ValueError("project_id: set persist=true or remove project_id")
        if self.case_name is not None and (not self.persist or self.project_id is None):
            raise ValueError("case_name: set persist=true and project_id, or remove case_name")
        return self


# Why `compilation_digest` was re-valued instead of renamed to `ir_digest`.
#
# The field carried the IR digest while being named for the compilation digest,
# and both readings were defensible: the value was right and the name wrong, or
# the name right and the value wrong. The name won, because it is not free to
# choose here - `compilation_digest` already means the compilation digest
# everywhere else in the platform. It is the `InstanceSnapshot` column that,
# together with `package_digest`, forms a snapshot's identity; it is what
# `services/snapshots.py` looks a compilation up by; and it is what the artifact
# routes publish as `compilationDigest` in provenance. Renaming it here would
# have left one API name meaning the lowered problem on three endpoints and the
# toolchain's output everywhere else, which is the harder mistake to notice.
#
# So the equivalence claim took the new field. The pairing guarantee in
# `docs/BIM_GENERATOR.md` is about the lowered problem, and it now names
# `ir_digest`; that document says which digest each claim is about.
class InstanceGeneratedResponse(BaseModel):
    """One generated package and both of the digests the platform computes over it.

    The two are not interchangeable. `ir_digest` covers the lowered problem with
    `metadata`, `spec.instance`, `spec.dialects` and `spec.sourceMap` stripped,
    so it answers "is this the same lowered problem?" - a JSON workflow and its
    paired BPMN workflow share it although their bytes differ - and it is the
    key to cache a problem under. `compilation_digest` covers the portable
    package digest together with the profile, the dialects and the compiler
    bundle digest, so it answers "does this toolchain reproduce this
    compilation?" and it moves when the toolchain moves. Those paired packages
    do not share it.
    """

    name: str
    package_digest: str
    instance_digest: str
    ir_digest: str
    compilation_digest: str
    snapshot_id: Optional[str] = None
    case_id: Optional[str] = None
    target_engines: list[str]
    files: dict[str, Any]
    file_bytes_base64: dict[str, str] | None = None
    actual_constraint_count: int | None = None


class GenerateCorpusRequest(StrictModel):
    count: int = Field(default=5, ge=1, le=100, description="Number of instances to generate.")
    base_config: GenerateInstanceRequest
    name: str = Field(default="corpus", description="Corpus identifier.")
    persist: bool = Field(default=False, description="Whether to persist instances to DB.")
    as_archive: bool = Field(default=False, description="Return instances as a zip archive.")

    @model_validator(mode="after")
    def check_seed_range(self) -> "GenerateCorpusRequest":
        ignored = self.base_config.model_fields_set.intersection({"persist", "project_id", "case_name", "name"})
        if ignored:
            raise ValueError(f"base_config.{sorted(ignored)[0]}: corpus controls persistence and names; remove this field from base_config")
        if self.base_config.seed is not None and self.base_config.seed + self.count - 1 > 2**63 - 1:
            raise ValueError("base_config.seed: corpus increment exceeds the supported 64-bit seed range; use a smaller seed")
        return self


class CorpusGeneratedResponse(BaseModel):
    name: str
    count: int
    instances: list[dict[str, Any]]


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


async def _compile(package: GeneratedPackage) -> Compilation:
    """Compile a generated package with the toolchain."""
    archive = package.to_zip()
    return Compilation.from_result(archive, await bim.abim().compile(archive))


async def _verify_project_member(session: AsyncSession, project_id: uuid.UUID, caller: User) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    org = await session.get(Organization, project.organization_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    await require_role(session, org, caller, OrganizationRole.MEMBER)
    return project


@router.post("/instances", response_model=InstanceGeneratedResponse, dependencies=[Depends(limit_work)])
async def generate_instance(
    request: GenerateInstanceRequest,
    session: AsyncSession = Depends(session_dependency),
    caller: Optional[User] = Depends(get_optional_user),
) -> Any:
    """Synthesize a single valid BIM v1 QACO instance."""
    try:
        # Synthesis is synchronous (and asks the toolchain to compile and evaluate): off the event loop.
        package = await asyncio.to_thread(
            generate_instance_package,
            tasks=request.tasks,
            candidates=request.candidates,
            control_flow=request.control_flow,
            loops=request.loops,
            branches=request.branches,
            parallel=request.parallel,
            max_nesting=request.max_nesting,
            iterations_per_loop=request.iterations_per_loop,
            features=expand_features(request.features),
            distributions=request.distributions.model_dump(exclude_none=True),
            constraints=request.constraints,
            constraint_count_mode=request.constraint_count_mode,
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
        compiled = await _compile(package)
    except IncompatibleTargetEnginesError as exc:
        raise api_error(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            code="incompatible_target_engines",
            message=exc.message,
            conflicts=exc.conflicts,
        ) from exc
    except (ValueError, OverflowError) as exc:
        raise api_error(status_code=422, code="invalid_generation_config",
                        message=f"features/distributions: {exc}; adjust bounds or aggregation") from exc

    snapshot_id: Optional[str] = None
    case_id: Optional[str] = None

    if request.persist:
        if caller is None:
            raise HTTPException(status_code=401, detail="Authentication required to persist instances")
        snapshot_id = await persist_snapshot(compiled, caller, session)
        if request.project_id is not None:
            await _verify_project_member(session, request.project_id, caller)
            case_slug = f"case-{uuid.uuid4().hex[:8]}"
            case_obj = BindingCase(
                project_id=request.project_id,
                slug=case_slug,
                name=request.case_name or request.name,
                description=f"Generated QACO instance {compiled.package_digest[:12]}",
                created_by_id=caller.id,
            )
            session.add(case_obj)
            await session.flush()
            case_rev = BindingCaseRevision(
                binding_case_id=case_obj.id,
                revision=1,
                digest=compiled.package_digest,
                document=package.instance(),
                source_snapshot_id=uuid.UUID(snapshot_id),
                created_by_id=caller.id,
            )
            session.add(case_rev)
            await session.flush()
            case_id = str(case_obj.id)

    files_json = {
        name: package.json(name) if name.endswith(".json") else content.decode("utf-8")
        for name, content in sorted(package.files.items())
    }

    return InstanceGeneratedResponse(
        name=request.name,
        package_digest=compiled.package_digest,
        instance_digest=package.instance()["metadata"].get("name", request.name),
        ir_digest=compiled.ir_digest,
        compilation_digest=compiled.compilation_digest,
        snapshot_id=snapshot_id,
        case_id=case_id,
        target_engines=request.target_engines,
        files=files_json,
        file_bytes_base64={name: base64.b64encode(content).decode("ascii") for name, content in sorted(package.files.items())} if request.include_file_bytes else None,
        actual_constraint_count=len(package.json("constraints.json")["spec"]["constraints"]),
    )


@router.post("/corpus", response_model=CorpusGeneratedResponse)
async def generate_corpus(
    request: GenerateCorpusRequest,
    raw: Request,
    session: AsyncSession = Depends(session_dependency),
    caller: Optional[User] = Depends(get_optional_user),
) -> Any:
    """Generate a corpus of problem instances, optionally persisting their snapshots."""
    # A corpus is ``count`` generations, which only the validated body can say; counted as
    # one it would be a hundred times cheaper than the same instances asked for singly.
    await enforce_work_rate_limit(raw, "compile", caller, units=request.count)
    base = request.base_config
    instances: list[dict[str, Any]] = []
    archives: list[bytes] = []

    if request.persist and caller is None:
        raise HTTPException(status_code=401, detail="Authentication required to persist corpus")

    for idx in range(request.count):
        seed_val = (base.seed + idx) if base.seed is not None else None
        inst_name = f"{request.name}_{idx + 1}"
        try:
            pkg = await asyncio.to_thread(
                generate_instance_package,
                tasks=base.tasks,
                candidates=base.candidates,
                control_flow=base.control_flow,
                loops=base.loops,
                branches=base.branches,
                parallel=base.parallel,
                max_nesting=base.max_nesting,
                iterations_per_loop=base.iterations_per_loop,
                features=expand_features(base.features),
                distributions=base.distributions.model_dump(exclude_none=True),
                constraints=base.constraints,
                constraint_count_mode=base.constraint_count_mode,
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
            compiled = await _compile(pkg)
        except IncompatibleTargetEnginesError as exc:
            raise api_error(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                code="incompatible_target_engines",
                message=exc.message,
                conflicts=exc.conflicts,
            ) from exc
        except (ValueError, OverflowError) as exc:
            raise api_error(status_code=422, code="invalid_generation_config",
                            message=f"base_config.features/distributions: {exc}; adjust bounds or aggregation") from exc
        archives.append(compiled.archive)

        snap_id: Optional[str] = None
        if request.persist:
            snap_id = await persist_snapshot(compiled, caller, session)

        instances.append({
            "name": inst_name,
            "package_digest": compiled.package_digest,
            "ir_digest": compiled.ir_digest,
            "compilation_digest": compiled.compilation_digest,
            "snapshot_id": snap_id,
            "actual_constraint_count": len(pkg.json("constraints.json")["spec"]["constraints"]),
        })

    if request.as_archive:
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for idx, archive in enumerate(archives):
                zf.writestr(f"{instances[idx]['name']}.bim.zip", archive)
        return Response(
            content=zip_buffer.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{request.name}.zip"'},
        )

    return CorpusGeneratedResponse(
        name=request.name,
        count=len(instances),
        instances=instances,
    )


@router.post("/convert-legacy", response_model=InstanceGeneratedResponse, dependencies=[Depends(limit_work)])
async def convert_legacy(
    request: ConvertLegacyRequest,
    session: AsyncSession = Depends(session_dependency),
    caller: Optional[User] = Depends(get_optional_user),
) -> Any:
    """Parse and convert raw legacy text into a strict BIM v1 package."""
    # raw_text is content, never a path: parse_legacy_file does not touch the
    # filesystem, so an unauthenticated body cannot name a file on the host.
    # A document the grammar does not accept is the caller's mistake, which is a
    # 422 and not the 500 an uncaught parse failure used to produce.
    try:
        problem = parse_legacy_file(request.raw_text)
    except LegacyParseError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid legacy QACO text: {exc}") from exc
    postprocessor = BIMPostprocessor(
        name=request.name,
        profile=request.profile,
        dialects=request.dialects,
        guarantee_feasibility=request.guarantee_feasibility,
        tension=request.tension,
        repair_empty_branches=request.repair_empty_branches,
    )
    package = await asyncio.to_thread(postprocessor.process, problem)
    compiled = await _compile(package)

    snapshot_id: Optional[str] = None
    case_id: Optional[str] = None

    if request.persist:
        if caller is None:
            raise HTTPException(status_code=401, detail="Authentication required to persist instances")
        snapshot_id = await persist_snapshot(compiled, caller, session)

        if request.project_id is not None:
            await _verify_project_member(session, request.project_id, caller)
            case_slug = f"case-{uuid.uuid4().hex[:8]}"
            case_obj = BindingCase(
                project_id=request.project_id,
                slug=case_slug,
                name=request.case_name or request.name,
                description=f"Converted QACO instance {compiled.package_digest[:12]}",
                created_by_id=caller.id,
            )
            session.add(case_obj)
            await session.flush()
            case_rev = BindingCaseRevision(
                binding_case_id=case_obj.id,
                revision=1,
                digest=compiled.package_digest,
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
        package_digest=compiled.package_digest,
        instance_digest=package.instance()["metadata"].get("name", request.name),
        ir_digest=compiled.ir_digest,
        compilation_digest=compiled.compilation_digest,
        snapshot_id=snapshot_id,
        case_id=case_id,
        target_engines=[],
        files=files_json,
    )
