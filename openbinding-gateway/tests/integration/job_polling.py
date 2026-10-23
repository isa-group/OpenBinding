"""Poll a gateway job to a terminal state, and say where it stayed if it never gets there."""

from __future__ import annotations

import json
import time

import httpx
import pytest


TERMINAL_JOB_STATES = {"completed", "failed"}


def describe_job(job_id: str, latest: dict) -> str:
    """The id, the state and what the gateway said about it; never the provenance.

    ``GET /v1/jobs/{id}`` answers with the full provenance (file digests,
    dialects, limits), which pushed ``status`` out of the printed line. A job
    that is still ``queued`` has no ``result``; one that is ``running`` may
    already carry an ``error`` or a result ``code``.
    """

    seen: dict = {"id": job_id, "status": latest.get("status")}
    if "error" in latest:
        seen["error"] = latest["error"]
    result = latest.get("result")
    if isinstance(result, dict):
        for key in ("code", "termination"):
            if key in result:
                seen[f"result.{key}"] = result[key]
    return json.dumps(seen, sort_keys=True, default=str)


def wait_for_job(
    client: httpx.Client,
    job_id: str,
    headers: dict[str, str],
    *,
    timeout_s: float,
    label: str = "job",
) -> dict:
    deadline = time.monotonic() + timeout_s
    latest: dict = {}
    polls = 0
    while time.monotonic() < deadline:
        response = client.get(f"/v1/jobs/{job_id}", headers=headers)
        assert response.status_code == 200, response.text
        latest = response.json()
        polls += 1
        if latest.get("status") in TERMINAL_JOB_STATES:
            return latest
        time.sleep(0.1)
    pytest.fail(
        f"{label} {job_id} did not terminate within {timeout_s:g}s "
        f"({polls} polls): {describe_job(job_id, latest)}"
    )
