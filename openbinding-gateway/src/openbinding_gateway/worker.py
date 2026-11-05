"""Dramatiq import target: ``dramatiq openbinding_gateway.worker``.

The worker serves only the ``default`` queue. The compose files start it with ``--queues default`` and no
service consumes ``analysis`` (``compose.lab*.json`` cannot carry comments; tests/test_compose_worker_secrets.py
checks them all).
"""

from .job_dispatch import configure_broker, run_persisted_job_message

configure_broker()

__all__ = ["run_persisted_job_message"]
