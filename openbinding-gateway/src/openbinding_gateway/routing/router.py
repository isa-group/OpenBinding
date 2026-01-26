import httpx
from typing import Optional
from ..registry.engine import EngineRegistry
from ..models.api import SolveRequest, SolveResponse, ValidationViolation
from ..models.api import JobResponse, JobStatus
from ..jobs import JobManager

class Router:
    async def route_solve(self, request: SolveRequest) -> JobResponse:
        plugin = EngineRegistry.get_plugin(request.engine_id)
        if not plugin:
            raise ValueError(f"Engine {request.engine_id} not found")
            
        service_url = EngineRegistry.get_url(request.engine_id)
        
        async with httpx.AsyncClient() as client:
            try:
                # Apply Plugin Transformation
                payload, warnings = plugin.transform_request(request.instance, request.options)

                # Forward to Engine's /solve
                response = await client.post(
                    f"{service_url.rstrip('/')}/solve",
                    json=payload, # Send transformed payload (or original if identity)
                    timeout=10.0
                )
                response.raise_for_status()
                data = response.json()
                engine_job_id = data.get("job_id")
                # Many-OBJ API might not return job_id if synchronous or different
                # But requirement said "async". Many-OBJ implementation I wrote returns "status": "optimized" immediately (sync).
                # If sync, it returns result immediately. I need to handle sync response too?
                # The generic Router assumes async "job_id".
                
                # If Many-OBJ is sync (which my Controller is), it returns solution directly.
                # Router expects {"job_id": ...}.
                # I should update Many-OBJ Controller to return a job_id (fake async) OR
                # Update Router to handle direct result.
                
                # Given user constraints ("async"), I should have implemented async in Java.
                # But "wrapper-only" constraint and lack of infrastructure makes sync easier.
                # If I want to keep Router as is, I need to wrap response in {job_id: "..."} and support polling.
                # But my Java Controller returns solution immediately.

                # Let's adapt Router to check if response contains solution.
                if "job_id" not in data and "selection" in data:
                     # It's a synchronous result
                     # Create a completed job immediately?
                     # Or just return result?
                     # Router.route_solve returns JobResponse.
                     # If I return JobResponse with status=COMPLETED and result, that works.
                     
                     # Transform response immediately
                     result_data = plugin.transform_response(data, request.instance)
                     
                     # Create a dummy job ID for accounting
                     job = JobManager.create_job(request.engine_id, "sync", service_url)
                     job.status = JobStatus.COMPLETED
                     
                     job.status = JobStatus.COMPLETED
                     
                     diagnostics = None
                     if request.verbose:
                         diagnostics = result_data.get("diagnostics") or {}
                         if warnings:
                             diagnostics["warnings"] = warnings
                     
                     response_model = JobResponse(
                         job_id=job.id,
                         status=JobStatus.COMPLETED,
                         result=SolveResponse(
                            solutions=result_data.get("solutions", []),
                            provenance=result_data.get("provenance"),
                            diagnostics=diagnostics
                         )
                     )
                     
                     # Store result for polling
                     job.result = response_model.result
                     
                     return response_model

                engine_job_id = data["job_id"]
                
                # Create Gateway Job
                job = JobManager.create_job(request.engine_id, engine_job_id, service_url)
                job.metadata["warnings"] = warnings
                job.metadata["verbose"] = request.verbose
                
                return JobResponse(
                    job_id=job.id,
                    status=JobStatus.QUEUED
                )
                
            except httpx.HTTPStatusError as e:
                error_msg = f"Engine returned error {e.response.status_code}"
                try:
                    # Try to get detailed error from engine response
                    details = e.response.text
                    if details:
                         # Truncate if too long
                         error_msg += f": {details[:200]}"
                except:
                    pass
                raise RuntimeError(error_msg)
            except httpx.RequestError as e:
                # If engine is down, fail immediately
                raise RuntimeError(f"Failed to contact engine: {str(e)}")

    async def get_job_status(self, job_id: str) -> Optional[JobResponse]:
        job = JobManager.get_job(job_id)
        if not job:
            return None
        
        # If job is already completed (sync), return it (though usually client polls)
        if job.status == JobStatus.COMPLETED and job.result:
             return JobResponse(
                 job_id=job.id,
                 status=JobStatus.COMPLETED,
                 result=job.result
             )
            
        async with httpx.AsyncClient() as client:
            try:
                # Poll Engine
                response = await client.get(
                    f"{job.service_url.rstrip('/')}/jobs/{job.engine_job_id}",
                    timeout=5.0
                )
                if response.status_code == 404:
                   # Engine lost the job?
                   return JobResponse(job_id=job.id, status=JobStatus.FAILED, error="Job not found on engine")
                   
                response.raise_for_status()
                data = response.json()
                
                # Map Engine Status to Gateway Status
                # Engine: queued, running, completed, failed
                engine_status = data["status"]
                
                result = None
                if engine_status == "completed" or engine_status == "optimized":
                    plugin = EngineRegistry.get_plugin(job.engine_id)
                    # We don't have original request here easily. Pass empty.
                    result_data = plugin.transform_response(data, {}) 
                    
                    diagnostics = None
                    verbose = job.metadata.get("verbose", False)
                    warnings = job.metadata.get("warnings", [])
                    if verbose:
                        diagnostics = result_data.get("diagnostics") or {}
                        if warnings:
                           diagnostics["warnings"] = warnings

                    result = SolveResponse(
                        solutions=result_data.get("solutions", []),
                        provenance=result_data.get("provenance"),
                        diagnostics=diagnostics
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
