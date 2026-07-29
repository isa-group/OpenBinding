import asyncio
import httpx
import json
import uuid
from typing import Optional, Any

from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import get_settings
from ..registry.engine import EngineRegistry
from ..models.api import SolveRequest, SolveResponse
from ..models.api import JobResponse, JobStatus, Feasibility
from ..jobs import JobManager
from ..semantics import canonicalize_result_data

MAX_ENGINE_PAYLOAD_BYTES = 512 * 1024 * 1024
PAYLOAD_TOO_LARGE_MESSAGE = (
    f"Request body is too large. Maximum allowed size is {MAX_ENGINE_PAYLOAD_BYTES} bytes."
)


class PayloadTooLargeError(RuntimeError):
    pass

class Router:
    def _payload_size_bytes(self, payload: Any) -> int:
        return len(json.dumps(payload, separators=(",", ":")).encode("utf-8"))

    def _is_exact_engine(self, engine_id: str) -> bool:
        try:
            plugin = EngineRegistry.get_plugin(engine_id)
            capabilities = plugin.get_capabilities() or {}
            engine_type = str(capabilities.get("type", "")).upper()
            return engine_type == "EXACT"
        except Exception:
            return False

    @staticmethod
    def _is_sync_response(data: dict) -> bool:
        """True when an engine answered synchronously.

        Engines answer either with a job envelope ({"job_id": ...}) or with a
        finished result: a selection at the top level, a selection wrapped
        under result.solution, or an already-general "solutions" list.
        """
        if "job_id" in data:
            return False
        if data.get("selection") is not None:
            return True
        if ((data.get("result") or {}).get("solution") or {}).get("selection") is not None:
            return True
        return isinstance(data.get("solutions"), list)

    def _has_non_empty_binding_solution(self, result_data: dict) -> bool:
        solutions = result_data.get("solutions", []) or []
        for solution in solutions:
            if not isinstance(solution, dict):
                continue
            binding = solution.get("binding") or {}
            if isinstance(binding, dict) and len(binding) > 0:
                # Solutions flagged infeasible by the reference evaluator do
                # not make the response FEASIBLE (they are still reported).
                if solution.get("feasible") is False:
                    continue
                return True
        return False

    def _compute_feasibility(self, engine_id: str, result_data: dict) -> Feasibility:
        if self._has_non_empty_binding_solution(result_data):
            return Feasibility.FEASIBLE
        if self._is_exact_engine(engine_id):
            return Feasibility.INFEASIBLE
        return Feasibility.UNKNOWN

    async def route_solve(
        self,
        request: SolveRequest,
        binding_space: Optional[Any] = None,
        warnings: Optional[list] = None,
        *,
        owner_id: Optional[uuid.UUID] = None,
        session: Optional[AsyncSession] = None,
    ) -> JobResponse:
        plugin = EngineRegistry.get_plugin(request.engine_id)
        if not plugin:
            raise ValueError(f"Engine {request.engine_id} not found")
            
        service_url = EngineRegistry.get_url(request.engine_id)
        all_warnings = (warnings or [])
        
        async with httpx.AsyncClient() as client:
            try:
                # Apply Plugin Transformation
                payload, plugin_warnings = plugin.transform_request(request.instance, request.options)

                if self._payload_size_bytes(payload) > MAX_ENGINE_PAYLOAD_BYTES:
                    raise PayloadTooLargeError(PAYLOAD_TOO_LARGE_MESSAGE)
                
                # Merge warnings
                all_warnings = all_warnings + (plugin_warnings or [])

                # Forward to Engine's /solve
                data = None
                for attempt in range(2 + 1):
                    try:
                        response = await client.post(
                            f"{service_url.rstrip('/')}/solve",
                            json=payload,
                            timeout=get_settings().engine_solve_timeout_s,
                        )

                        if response.status_code in (502, 503, 504):
                            if attempt >= 2:
                                response.raise_for_status()
                            await asyncio.sleep(1)
                            continue

                        response.raise_for_status()
                        data = response.json()
                        break
                    except httpx.RequestError as e:
                        if attempt >= 2:
                            raise RuntimeError(f"Failed to contact engine: {str(e)}")
                        await asyncio.sleep(1)

                if data is None:
                    raise RuntimeError("Failed to contact engine")
                
                # Check for sync response
                if self._is_sync_response(data):
                     # It's a synchronous result
                     result_data = plugin.transform_response(data, request.instance)
                     result_data = canonicalize_result_data(result_data, request.instance)
                     feasibility = self._compute_feasibility(request.engine_id, result_data)
                     
                     job = await JobManager.create_job(
                         request.engine_id, "sync", service_url, owner_id=owner_id, session=session
                     )
                     job.status = JobStatus.COMPLETED
                     
                     diagnostics = {}
                     if request.verbose:
                         diagnostics = result_data.get("diagnostics") or {}
                         if all_warnings:
                             diagnostics["warnings"] = all_warnings
                         if binding_space:
                             diagnostics["binding_space"] = binding_space
                     
                     response_model = JobResponse(
                         job_id=job.id,
                         status=JobStatus.COMPLETED,
                         result=SolveResponse(
                                     feasibility=feasibility,
                            solutions=result_data.get("solutions", []),
                            provenance=result_data.get("provenance"),
                            diagnostics=diagnostics if diagnostics else None
                         )
                     )
                     
                     job.result = response_model.result
                     await JobManager.save_job(job, session=session)
                     return response_model

                engine_job_id = data.get("job_id")
                
                # Create Gateway Job
                job = await JobManager.create_job(
                    request.engine_id, engine_job_id, service_url, owner_id=owner_id, session=session
                )
                job.metadata["warnings"] = all_warnings
                job.metadata["verbose"] = request.verbose
                job.metadata["original_request"] = request.instance
                if binding_space:
                    job.metadata["binding_space"] = binding_space
                await JobManager.save_job(job, session=session)

                return JobResponse(
                    job_id=job.id,
                    status=JobStatus.QUEUED
                )
                
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 413:
                    raise PayloadTooLargeError(PAYLOAD_TOO_LARGE_MESSAGE)

                # Handle 422 from Random Search as No Solution
                if e.response.status_code == 422:
                     try:
                         err_data = e.response.json()
                         if "No feasible solution" in err_data.get("error", ""):
                             # Engine found no feasible solution: return sync completion with empty solutions
                             job = await JobManager.create_job(
                                 request.engine_id,
                                 "sync-no-solution",
                                 service_url,
                                 owner_id=owner_id,
                                 session=session,
                             )
                             job.status = JobStatus.COMPLETED
                             
                             result = SolveResponse(
                                 feasibility=Feasibility.INFEASIBLE if self._is_exact_engine(request.engine_id) else Feasibility.UNKNOWN,
                                 solutions=[],
                                 provenance={
                                     "engine_id": request.engine_id,
                                     "execution_time_ms": 0,
                                     "metadata": {"error": err_data.get("error")}
                                 },
                                 diagnostics={"warnings": all_warnings} if all_warnings else None
                             )
                             
                             job.result = result
                             await JobManager.save_job(job, session=session)

                             return JobResponse(
                                 job_id=job.id,
                                 status=JobStatus.COMPLETED,
                                 result=result
                             )
                     except:
                         pass

                error_msg = f"Engine returned error {e.response.status_code}"
                try:
                    details = e.response.text
                    if details:
                         error_msg += f": {details[:200]}"
                except:
                    pass
                raise RuntimeError(error_msg)
            except httpx.RequestError as e:
                raise RuntimeError(f"Failed to contact engine: {str(e)}")

    async def get_job_status(
        self, job_id: str, *, session: Optional[AsyncSession] = None
    ) -> Optional[JobResponse]:
        job = await JobManager.get_job(job_id, session=session)
        if not job:
            return None
        
        if job.status == JobStatus.COMPLETED and job.result:
             return JobResponse(
                 job_id=job.id,
                 status=JobStatus.COMPLETED,
                 result=job.result
             )
            
        async with httpx.AsyncClient() as client:
            try:
                response = await client.get(
                    f"{job.service_url.rstrip('/')}/jobs/{job.engine_job_id}",
                    timeout=30
                )
                if response.status_code == 404:
                   return JobResponse(job_id=job.id, status=JobStatus.FAILED, error="Job not found on engine")
                   
                response.raise_for_status()
                data = response.json()
                
                engine_status = data["status"]
                
                result = None
                if engine_status == "completed" or engine_status == "optimized":
                    plugin = EngineRegistry.get_plugin(job.engine_id)
                    original_request = job.metadata.get("original_request") or {}
                    result_data = plugin.transform_response(data, original_request)
                    result_data = canonicalize_result_data(result_data, original_request)
                    feasibility = self._compute_feasibility(job.engine_id, result_data)
                    
                    diagnostics = {}
                    verbose = job.metadata.get("verbose", False)
                    warnings = job.metadata.get("warnings", [])
                    binding_space = job.metadata.get("binding_space")

                    if verbose:
                        diagnostics = result_data.get("diagnostics") or {}
                        if warnings:
                           diagnostics["warnings"] = warnings
                        if binding_space:
                           diagnostics["binding_space"] = binding_space

                    result = SolveResponse(
                        feasibility=feasibility,
                        solutions=result_data.get("solutions", []),
                        provenance=result_data.get("provenance"),
                        diagnostics=diagnostics if diagnostics else None
                    )

                return JobResponse(
                    job_id=job.id,
                    status=JobStatus(engine_status) if engine_status != "optimized" else JobStatus.COMPLETED,
                    result=result,
                    error=data.get("error")
                )

                
            except Exception as e:
                return JobResponse(
                    job_id=job.id, 
                    status=JobStatus.FAILED, 
                    error=f"Failed to poll engine: {str(e)}"
                )
