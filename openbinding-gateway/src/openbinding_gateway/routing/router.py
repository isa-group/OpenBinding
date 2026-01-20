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
                # Forward to Engine's /solve
                response = await client.post(
                    f"{service_url.rstrip('/')}/solve",
                    json={
                        "instance": request.instance,
                        "options": {} 
                    },
                    timeout=10.0
                )
                response.raise_for_status()
                data = response.json()
                engine_job_id = data["job_id"]
                
                # Create Gateway Job
                job = JobManager.create_job(request.engine_id, engine_job_id, service_url)
                
                return JobResponse(
                    job_id=job.id,
                    status=JobStatus.QUEUED
                )
                
            except httpx.RequestError as e:
                # If engine is down, fail immediately
                raise RuntimeError(f"Failed to contact engine: {str(e)}")

    async def get_job_status(self, job_id: str) -> Optional[JobResponse]:
        job = JobManager.get_job(job_id)
        if not job:
            return None
            
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
                if engine_status == "completed":
                    # Transform result back to SolveResponse
                    # The engine result structure depends on engine implementation
                    # Assuming engine returns 'result' which is what we need
                    # But wait, our SolveResponse expects engine_id, solution etc.
                    # Let's assume the engine result matches expected structure or close to it
                     result = SolveResponse(
                        engine_id=job.engine_id,
                        solution=data.get("result", {}).get("solution"),
                        provenance=data.get("result", {}).get("provenance"),
                        diagnostics=data.get("result", {}).get("diagnostics"),
                        errors=data.get("result", {}).get("errors")
                    )

                return JobResponse(
                    job_id=job.id,
                    status=JobStatus(engine_status),
                    result=result,
                    error=data.get("error")
                )
                
            except Exception as e:
                return JobResponse(
                    job_id=job.id, 
                    status=JobStatus.FAILED, 
                    error=f"Failed to poll engine: {str(e)}"
                )
