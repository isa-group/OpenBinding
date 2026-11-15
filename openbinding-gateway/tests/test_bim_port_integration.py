"""The gateway's flows that depend on BIM, through the port it is given (the installed ``bim-core``).

A problem upload, a job and the re-evaluation of what the engine answered, the refusal of an Engine mode, the
list of compatible modes; and the translation of the toolchain's errors into the platform's problems.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid

import pytest

from _problem_helpers import runs_url_for, upload_problem
from _repo import REPO_ROOT
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.integrations import bim, packages
from openbinding_gateway.modules.problems.application import ir_analysis
from openbinding_gateway.services import execution
from bim_client import InProcessBim
from bim_core import ContractError, PackageError
from bim_core.package import load_package

EXAMPLE = REPO_ROOT / "examples" / "demo" / "01_simple_seq"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
ZIP = {"Content-Type": "application/vnd.bim+zip"}
BINDING = {
    "t1": {"resource": "catalog", "id": "c1a"},
    "t2": {"resource": "catalog", "id": "c2a"},
    "t3": {"resource": "catalog", "id": "c3a"},
}


@pytest.fixture
def bim_port():
    """The port of the gateway: the installed ``bim-core``."""
    yield bim.get_bim()


# ---------------------------------------------------------------------------------------------- helpers


async def sign_in(api_client, registration) -> dict[str, str]:
    details = registration()
    created = await api_client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await api_client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]}
    )
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['access_token']}"}


def example_zip() -> bytes:
    return load_package(EXAMPLE).to_zip()


def package_with_latency(latency) -> bytes:
    package = load_package(EXAMPLE)
    catalog = json.loads(package.files["candidates.json"])
    catalog["spec"]["candidates"]["c1a"]["features"]["latency"] = latency
    package.files["candidates.json"] = json.dumps(catalog).encode()
    return package.to_zip()


# ----------------------------------------------------------------------------------------------- flows


async def test_a_problem_a_job_and_the_reevaluation_of_its_answer(
    api_client, db_session, registration, monkeypatch, bim_port
) -> None:
    monkeypatch.setattr(get_settings(), "job_dispatch_mode", "inline")

    async def solve(*args, **kwargs):
        # The engine claims a number it did not compute and a termination its mode does not guarantee.
        return {
            "termination": "OPTIMAL",
            "solutions": [{"decision": {"kind": "binding", "binding": BINDING}, "features": {"latency": -999}}],
        }

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers = await sign_in(api_client, registration)

    created = await upload_problem(api_client, headers, archive=example_zip(), slug="port")
    # The identities are the toolchain's.
    reference = InProcessBim().compile(example_zip())
    assert created["compilation"]["ir_digest"] == reference["irDigest"]
    assert created["revision"]["package_digest"] == reference["packageDigest"]
    assert created["revision"]["instance_digest"] == reference["instanceDigest"]
    base = f"/v1/organizations/{created['org']}/problems/port/revisions/1"
    ir = (await api_client.get(f"{base}/compilations/{created['compilation']['id']}/ir", headers=headers)).json()["ir"]
    assert ir == reference["ir"]

    submitted = await api_client.post(
        runs_url_for(created["revision_id"]),
        headers={**headers, "Idempotency-Key": f"port-{uuid.uuid4()}"},
        json={"revision": created["revision_id"], "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION},
    )
    assert submitted.status_code == 202, submitted.text
    finished = (await api_client.get(f"{runs_url_for(created['revision_id'])}/{submitted.json()['id']}", headers=headers)).json()
    assert finished["status"] == "completed", finished
    assert finished["provenance"]["irDigest"] == reference["irDigest"]
    assert finished["provenance"]["compilerDigest"] == bim.toolchain_digest()

    # Re-evaluated by the toolchain: the numbers are its own and the termination is the one the mode backs.
    solution = finished["result"]["solutions"][0]
    assert finished["result"]["termination"] == "UNKNOWN"
    assert solution["features"] == InProcessBim().evaluate(ir, BINDING)["features"]
    assert solution["features"]["latency"] != -999


async def test_an_engine_mode_that_cannot_run_the_instance_is_a_422(
    api_client, registration, bim_port
) -> None:
    headers = await sign_in(api_client, registration)
    created = await upload_problem(api_client, headers, archive=package_with_latency({"min": 100, "max": None}))

    refused_job = await api_client.post(
        runs_url_for(created["revision_id"]),
        headers={**headers, "Idempotency-Key": f"port-{uuid.uuid4()}"},
        json={"revision": created["revision_id"], "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION},
    )

    assert refused_job.status_code == 422, refused_job.text
    body = refused_job.json()
    assert body["code"] == "engine_mode_incompatible"
    refusal = next(item for item in body["diagnostics"] if item["code"] == "unsupported_capability_value")
    assert refusal["unsupported"] == ["interval"]
    assert refusal["pointer"] == "/spec/candidates/c1a/features/latency"


async def test_an_option_the_mode_does_not_have_is_a_422_with_the_toolchains_code(
    api_client, registration, bim_port
) -> None:
    headers = await sign_in(api_client, registration)
    created = await upload_problem(api_client, headers, archive=example_zip())

    response = await api_client.post(
        runs_url_for(created["revision_id"]),
        headers={**headers, "Idempotency-Key": f"port-{uuid.uuid4()}"},
        json={"revision": created["revision_id"], "engine": "random-search", "mode": "seeded",
              "optimization": OPTIMIZATION, "options": {"bogus": 1}},
    )

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "unknown_option"


async def test_validate_lists_the_modes_that_can_run_the_instance(api_client, registration, bim_port) -> None:
    headers = await sign_in(api_client, registration)

    response = await api_client.post("/v1/bim/validate", headers={**headers, **ZIP}, content=example_zip())

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["analysis"]["bindingSpace"] == "2"
    assert any(item["compatible"] and item["mode"] == "seeded" for item in payload["compatibleModes"])
    assert all("diagnostics" in item for item in payload["compatibleModes"])


async def test_the_digests_of_the_files_of_a_package_are_those_of_its_portable_form(
    api_client, registration, bim_port
) -> None:
    headers = await sign_in(api_client, registration)
    package = load_package(EXAMPLE)

    validated = await api_client.post("/v1/bim/validate", headers={**headers, **ZIP}, content=package.to_zip())
    created = await upload_problem(api_client, headers, archive=package.to_zip())

    assert validated.status_code == 200, validated.text
    assert validated.json()["fileDigests"] == load_package(package.to_zip()).resource_digests
    assert validated.json()["packageDigest"] == created["revision"]["package_digest"] == package.package_digest


# ------------------------------------------------------------------------------------------- the boundary


async def test_startup_accepts_the_toolchain_it_was_built_with_and_refuses_another(monkeypatch) -> None:
    accepted = await bim.startup_check()
    assert accepted["compilerDigest"] == accepted["expected"] == bim.toolchain_digest()

    monkeypatch.setattr(bim, "_local_compiler_digest", lambda: "sha256-" + "0" * 64)
    with pytest.raises(bim.BimStartupError, match="the installed bim-core is"):
        await bim.startup_check()


def test_the_factory_builds_the_in_process_port() -> None:
    assert isinstance(bim.build_bim(), InProcessBim)


async def test_a_blocking_port_does_not_stall_the_event_loop() -> None:
    loop_thread = threading.get_ident()
    calls: list[int] = []

    class Slow(InProcessBim):
        def compile(self, package, registered_resources=()):
            calls.append(threading.get_ident())
            time.sleep(0.3)
            return super().compile(package, registered_resources)

    ticks = 0

    async def heartbeat() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    beating = asyncio.create_task(heartbeat())
    try:
        with bim.bim_override(Slow()):
            result = await bim.abim().compile(example_zip())
    finally:
        beating.cancel()

    assert result["irDigest"].startswith("sha256-")
    assert calls and calls[0] != loop_thread
    assert ticks >= 10


def test_the_errors_of_the_toolchain_become_the_platforms_problems() -> None:
    from bim_client import BimServiceError

    for_input = ContractError("unknown_option", "unknown engine option 'x'", [{"code": "unknown_option"}], http_status=422)
    assert bim.problem_for(for_input)[:2] == (422, "unknown_option")
    assert bim.problem_for(ContractError("schema_not_found", "no such kind", http_status=404))[:2] == (404, "schema_not_found")
    assert bim.problem_for(ContractError("ir_digest_mismatch", "altered"))[:2] == (422, "ir_digest_mismatch")
    assert bim.problem_for(ContractError("invalid_limit", "bad limit"))[:2] == (500, "invalid_limit")
    assert bim.problem_for(PackageError("invalid ZIP archive"))[:2] == (422, "package_error")

    unavailable = bim.problem_for(BimServiceError("service_timeout", "slow"))
    assert unavailable[:2] == (503, "bim_unavailable")
    assert bim.problem_for(BimServiceError("service_busy", "busy", retry_after=2.0))[4] == {"Retry-After": "2"}
    assert bim.problem_for(BimServiceError("payload_too_large", "big", status=413))[:2] == (413, "payload_too_large")
    assert bim.problem_for(BimServiceError("limit_exceeded", "too many", status=422))[:2] == (422, "bim_limit_exceeded")
    assert bim.problem_for(BimServiceError("bad_response", "garbage"))[:2] == (502, "bim_service_error")
    assert bim.problem_for(BimServiceError("unauthorized", "no token", status=401))[:2] == (502, "bim_service_error")


def test_the_analysis_of_a_stored_ir_is_the_one_the_toolchain_reports() -> None:
    port = bim.get_bim()
    for name in ("01_simple_seq", "02_parallel", "05_multi_obj"):
        compiled = port.compile(packages.zip_directory(REPO_ROOT / "examples" / "demo" / name))
        assert ir_analysis(compiled["ir"]) == compiled["analysis"], name


def test_a_package_the_toolchain_refuses_is_the_toolchains_error() -> None:
    with pytest.raises(PackageError):
        bim.get_bim().compile(b"not a zip")
