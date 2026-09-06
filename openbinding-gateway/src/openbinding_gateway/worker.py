"""Dramatiq import target: ``dramatiq openbinding_gateway.worker``."""

from .job_dispatch import configure_broker, run_persisted_job_message

configure_broker()

__all__ = ["run_persisted_job_message"]
