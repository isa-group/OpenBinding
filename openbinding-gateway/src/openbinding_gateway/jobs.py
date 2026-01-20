import uuid
from typing import Dict, Optional
from .models.api import JobStatus

class GatewayJob:
    def __init__(self, engine_id: str, engine_job_id: str, service_url: str):
        self.id = str(uuid.uuid4())
        self.engine_id = engine_id
        self.engine_job_id = engine_job_id
        self.service_url = service_url
        self.status = JobStatus.QUEUED
        self.created_at = None 

class JobManager:
    _jobs: Dict[str, GatewayJob] = {}

    @classmethod
    def create_job(cls, engine_id: str, engine_job_id: str, service_url: str) -> GatewayJob:
        job = GatewayJob(engine_id, engine_job_id, service_url)
        cls._jobs[job.id] = job
        return job

    @classmethod
    def get_job(cls, job_id: str) -> Optional[GatewayJob]:
        return cls._jobs.get(job_id)
