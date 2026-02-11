import asyncio
import httpx
from typing import Optional, Any
from ..registry.engine import EngineRegistry
from ..models.api import SolveRequest, SolveResponse, ValidationViolation
from ..models.api import JobResponse, JobStatus
from ..jobs import JobManager

class Router:
    async def route_solve(self, request: SolveRequest, binding_space: Optional[Any] = None, warnings: Optional[list] = None) -> JobResponse:
        plugin = EngineRegistry.get_plugin(request.engine_id)
        if not plugin:
            raise ValueError(f"Engine {request.engine_id} not found")
            
        service_url = EngineRegistry.get_url(request.engine_id)
        
        async with httpx.AsyncClient() as client:
            try:
                # Apply Plugin Transformation
                payload, plugin_warnings = plugin.transform_request(request.instance, request.options)
                
                # Merge warnings
                all_warnings = (warnings or []) + (plugin_warnings or [])

                # Forward to Engine's /solve
                data = None
                for attempt in range(2 + 1):
                    try:
                        response = await client.post(
                            f"{service_url.rstrip('/')}/solve",
                            json=payload,
                            timeout=900
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
                if "job_id" not in data and "selection" in data:
                     # It's a synchronous result
                     result_data = plugin.transform_response(data, request.instance)
                     
                     job = JobManager.create_job(request.engine_id, "sync", service_url)
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
                            solutions=result_data.get("solutions", []),
                            provenance=result_data.get("provenance"),
                            diagnostics=diagnostics if diagnostics else None
                         )
                     )
                     
                     job.result = response_model.result
                     return response_model

                engine_job_id = data.get("job_id")
                
                # Create Gateway Job
                job = JobManager.create_job(request.engine_id, engine_job_id, service_url)
                job.metadata["warnings"] = all_warnings
                job.metadata["verbose"] = request.verbose
                if binding_space:
                    job.metadata["binding_space"] = binding_space
                
                return JobResponse(
                    job_id=job.id,
                    status=JobStatus.QUEUED
                )
                
            except httpx.HTTPStatusError as e:
                # Handle 422 from Random Search as No Solution
                if e.response.status_code == 422:
                     try:
                         err_data = e.response.json()
                         if "No feasible solution" in err_data.get("error", ""):
                             # Create Sync Job Response with empty solutions
                             # Need to generate a job ID (use placeholder or create one)
                             # Since it failed, no job was created in Engine probably?
                             # Or we just return a sync completion.
                             
                             # We need a job ID for the response
                             import uuid
                             job_id = str(uuid.uuid4())
                             
                             result = SolveResponse(
                                 solutions=[],
                                 provenance={
                                     "engine_id": request.engine_id,
                                     "execution_time_ms": 0,
                                     "metadata": {"error": err_data.get("error")}
                                 },
                                 diagnostics={"warnings": all_warnings} if all_warnings else None
                             )
                             
                             return JobResponse(
                                 job_id=job_id,
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

    async def get_job_status(self, job_id: str) -> Optional[JobResponse]:
        job = JobManager.get_job(job_id)
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
                    result_data = plugin.transform_response(data, {}) 
                    
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
