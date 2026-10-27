"""Dramatiq import target: ``dramatiq openbinding_gateway.worker``.

The worker serves only the ``default`` queue.
"""

# [impl->req~job-execution-default-queue-only~1]
from .job_dispatch import configure_broker, run_persisted_job_message

configure_broker()

__all__ = ["run_persisted_job_message"]
