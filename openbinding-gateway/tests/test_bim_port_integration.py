"""The gateway works the same whichever implementation of the BIM port it is given.

``BIM_MODE=inproc`` calls the installed ``bim-core``; ``BIM_MODE=http`` calls a ``bim-service``. These tests run the
flows that depend on BIM (a snapshot, a job and the re-evaluation of what the engine answered, the refusal of an
Engine mode, the list of compatible modes) with each implementation; the service is mounted in this process
(ASGI, no network) when ``bim_service`` can be imported and the http cases are skipped, with a warning, when it
cannot. The failures of the service (down, busy) are tested with a client that fails, which needs no service.
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
import uuid
import warnings

import httpx
import pytest

from _repo import REPO_ROOT
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.integrations import bim, packages
from openbinding_gateway.services import execution
from openbinding_gateway.services.snapshots import ir_analysis
from bim_client import HttpBim, InProcessBim
from bim_core import ContractError, PackageError
from bim_core.package import load_package

EXAMPLE = REPO_ROOT / "examples" / "demo" / "01_simple_seq"
SERVICE_SRC = REPO_ROOT / "bim-toolchain" / "packages" / "bim-service" / "src"
TOKEN = "gateway-test-token-" + "0123456789abcdef" * 2
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
ZIP = {"Content-Type": "application/vnd.bim+zip"}
BINDING = {
    "t1": {"resource": "catalog", "id": "c1a"},
    "t2": {"resource": "catalog", "id": "c2a"},
    "t3": {"resource": "catalog", "id": "c3a"},
}


# ----------------------------------------------------------------------------------------------- the ports


def mounted_service(tmp_path):
    """A ``bim-service`` application and its token file, or a skip (with a warning) if it cannot be imported."""
    try:
        import bim_service  # noqa: F401
    except ImportError:
        if SERVICE_SRC.is_dir() and str(SERVICE_SRC) not in sys.path:
            sys.path.insert(0, str(SERVICE_SRC))
        try:
            import bim_service  # noqa: F401
        except ImportError:
            message = "bim_service is not importable: the BIM_MODE=http cases are skipped"
            warnings.warn(message, stacklevel=2)
            pytest.skip(message)
    from bim_service.app import create_app
    from bim_service.settings import BimServiceSettings

    tokens = tmp_path / "bim-token"
    tokens.write_text(TOKEN + "\n", encoding="utf-8")
    tokens.chmod(0o600)
    return create_app(BimServiceSettings(tokens_file=str(tokens))), tokens


@pytest.fixture(params=["inproc", "http"])
def bim_port(request, tmp_path):
    """The port of the gateway: the installed ``bim-core``, or a ``bim-service`` mounted in this process."""
    if request.param == "inproc":
        yield bim.get_bim()
        return
    from starlette.testclient import TestClient

    application, tokens = mounted_service(tmp_path)
    client = TestClient(application, base_url="http://bim.test", raise_server_exceptions=False)
    port = HttpBim(client=client, token_file=tokens)
    with bim.bim_override(port):
        yield port
    port.close()


def failing_port(handler) -> HttpBim:
    """An ``HttpBim`` whose transport is ``handler``: a service that is down or answers badly."""
    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://bim.test")
    return HttpBim(client=client)


def refused(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused", request=request)


def busy(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        503,
        json={"type": "urn:bim-toolchain:problem:service_busy", "title": "Service busy", "status": 503,
              "code": "service_busy", "detail": "no slot became free"},
        headers={"Retry-After": "3", "Content-Type": "application/problem+json"},
    )


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


# ----------------------------------------------------------------------------------- flows, both ports


async def test_a_snapshot_a_job_and_the_reevaluation_of_its_answer(
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

    created = await api_client.post("/v1/instances", headers={**headers, **ZIP}, content=example_zip())
    assert created.status_code == 201, created.text
    snapshot = created.json()
    # The identities are the toolchain's, whichever way it was reached.
    reference = InProcessBim().compile(example_zip())
    assert snapshot["irDigest"] == reference["irDigest"]
    assert snapshot["packageDigest"] == reference["packageDigest"]
    assert snapshot["instanceDigest"] == reference["instanceDigest"]
    ir = (await api_client.get(f"/v1/instances/{snapshot['id']}/ir", headers=headers)).json()
    assert ir == reference["ir"]

    submitted = await api_client.post(
        "/v1/jobs",
        headers={**headers, "Idempotency-Key": f"port-{uuid.uuid4()}"},
        json={"snapshot": snapshot["id"], "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION},
    )
    assert submitted.status_code == 202, submitted.text
    finished = (await api_client.get(f"/v1/jobs/{submitted.json()['id']}", headers=headers)).json()
    assert finished["status"] == "completed", finished
    assert finished["provenance"]["irDigest"] == snapshot["irDigest"]
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
    created = await api_client.post(
        "/v1/instances", headers={**headers, **ZIP}, content=package_with_latency({"min": 100, "max": None})
    )
    assert created.status_code == 201, created.text

    refused_job = await api_client.post(
        "/v1/jobs",
        headers={**headers, "Idempotency-Key": f"port-{uuid.uuid4()}"},
        json={"snapshot": created.json()["id"], "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION},
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
    created = await api_client.post("/v1/instances", headers={**headers, **ZIP}, content=example_zip())

    response = await api_client.post(
        "/v1/jobs",
        headers={**headers, "Idempotency-Key": f"port-{uuid.uuid4()}"},
        json={"snapshot": created.json()["id"], "engine": "random-search", "mode": "seeded",
              "optimization": OPTIMIZATION, "options": {"bogus": 1}},
    )

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "unknown_option"


async def test_validate_lists_the_modes_that_can_run_the_instance(api_client, registration, bim_port) -> None:
    headers = await sign_in(api_client, registration)

    response = await api_client.post("/v1/validate", headers={**headers, **ZIP}, content=example_zip())

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

    created = await api_client.post("/v1/instances", headers={**headers, **ZIP}, content=package.to_zip())

    assert created.status_code == 201, created.text
    assert created.json()["fileDigests"] == load_package(package.to_zip()).resource_digests
    assert created.json()["packageDigest"] == package.package_digest


# ------------------------------------------------------------------------------------ failures of the service


async def test_a_service_that_is_down_is_a_clean_503(api_client) -> None:
    with bim.bim_override(failing_port(refused)):
        response = await api_client.post("/v1/instances/validate", content=example_zip(), headers=ZIP)

    assert response.status_code == 503, response.text
    body = response.json()
    assert body["code"] == "bim_unavailable"
    assert body["bimCode"] == "service_unavailable"
    assert "refused" not in response.text and "Traceback" not in response.text


async def test_a_busy_service_is_a_503_that_says_when_to_retry(api_client) -> None:
    with bim.bim_override(failing_port(busy)):
        response = await api_client.post("/v1/instances/validate", content=example_zip(), headers=ZIP)

    assert response.status_code == 503, response.text
    assert response.json()["bimCode"] == "service_busy"
    assert response.headers["Retry-After"] == "3"


async def test_a_service_that_answers_nonsense_is_a_502(api_client) -> None:
    def nonsense(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html>not json</html>")

    with bim.bim_override(failing_port(nonsense)):
        response = await api_client.post("/v1/instances/validate", content=example_zip(), headers=ZIP)

    assert response.status_code == 502, response.text
    assert response.json()["code"] == "bim_service_error"


# ------------------------------------------------------------------------------------------- the boundary


async def test_startup_accepts_the_toolchain_it_was_built_with_and_refuses_another(monkeypatch) -> None:
    accepted = await bim.startup_check()
    assert accepted["compilerDigest"] == accepted["expected"] == bim.toolchain_digest()

    monkeypatch.setattr(bim, "_local_compiler_digest", lambda: "sha256-" + "0" * 64)
    with pytest.raises(bim.BimStartupError, match="another toolchain"):
        await bim.startup_check()


async def test_startup_fails_when_the_service_cannot_be_reached() -> None:
    with bim.bim_override(failing_port(refused)), pytest.raises(bim.BimStartupError, match="cannot be reached"):
        await bim.startup_check()


def test_http_mode_needs_the_url_of_the_service() -> None:
    with pytest.raises(ValueError, match="BIM_SERVICE_URL"):
        Settings(_env_file=None, bim_mode="http")

    settings = Settings(_env_file=None, bim_mode="http", bim_service_url="https://bim.internal")
    assert settings.bim_mode == "http" and settings.bim_service_timeout_s == 30.0
    assert Settings(_env_file=None).bim_mode == "inproc"


def test_the_factory_builds_the_port_the_settings_ask_for(monkeypatch) -> None:
    assert isinstance(bim.build_bim(Settings(_env_file=None)), InProcessBim)

    port = bim.build_bim(Settings(_env_file=None, bim_mode="http", bim_service_url="https://bim.internal"))
    try:
        assert isinstance(port, HttpBim)
    finally:
        port.close()


def _http_settings(url: str, **extra) -> Settings:
    return Settings(
        _env_file=None, bim_mode="http", bim_service_url=url, bim_service_token_file="/tmp/bim-token", **extra
    )


def test_insecure_http_to_a_remote_host_needs_the_explicit_option() -> None:
    assert Settings(_env_file=None).bim_service_allow_insecure_http is False
    with pytest.raises(ValueError, match="plain http"):
        bim.build_bim(_http_settings("http://bim-service:8080"))

    port = bim.build_bim(_http_settings("http://bim-service:8080", bim_service_allow_insecure_http=True))
    try:
        assert isinstance(port, HttpBim)
    finally:
        port.close()


def test_loopback_http_is_always_allowed() -> None:
    port = bim.build_bim(_http_settings("http://127.0.0.1:8080"))
    port.close()


def test_the_insecure_option_warns_once_for_a_remote_host(monkeypatch, caplog) -> None:
    monkeypatch.setattr(bim, "_INSECURE_WARNED", False)
    settings = _http_settings("http://bim-service:8080", bim_service_allow_insecure_http=True)
    with caplog.at_level("WARNING", logger=bim.logger.name):
        bim.build_bim(settings).close()
        bim.build_bim(settings).close()
        bim.build_bim(_http_settings("http://localhost:8080", bim_service_allow_insecure_http=True)).close()
    warnings = [r for r in caplog.records if "BIM_SERVICE_ALLOW_INSECURE_HTTP" in r.getMessage()]
    assert len(warnings) == 1


async def test_startup_reports_a_refused_insecure_url_readably(monkeypatch) -> None:
    monkeypatch.setattr(bim, "get_settings", lambda: _http_settings("http://bim-service:8080"))
    bim.set_bim(None)
    try:
        with pytest.raises(bim.BimStartupError, match="BIM_SERVICE_ALLOW_INSECURE_HTTP"):
            await bim.startup_check()
    finally:
        bim.set_bim(None)


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
