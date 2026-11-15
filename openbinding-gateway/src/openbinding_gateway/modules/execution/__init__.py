"""Execution: runs of an organization's problem revisions on an engine (``/v1/organizations/{org}/runs``).

The submission, dispatch, worker and lease code it drives still lives in the legacy layers
(``services.job_submission``, ``job_dispatch``, ``jobs/*``); moving it here is a later phase.
Layout and dependency rules: docs/ARCHITECTURE.md §4.2.
"""
