import httpx
import pytest

from openbinding_gateway.services.engines import validate_engine_result
from openbinding_gateway.v1 import remote


OPTIMIZATION = {"type": "SINGLE", "scalarization": "feasibility"}


def _result(termination: str = "FEASIBLE") -> dict:
    return {
        "termination": termination,
        "solutions": [
            {
                "decision": {"kind": "binding", "binding": {}},
                "features": {},
                "objectives": {
                    "type": "SINGLE",
                    "scalarization": "feasibility",
                    "components": [],
                    "penalty": 0,
                    "score": 0,
                },
                "penalties": [],
                "violations": [],
            }
        ],
    }


def test_remote_endpoint_rejects_local_networks() -> None:
    with pytest.raises(remote.RemoteEngineError):
        remote.validate_endpoint("https://127.0.0.1:8443")
    with pytest.raises(remote.RemoteEngineError):
        remote.validate_endpoint("http://solver.example")


def test_remote_endpoint_rejects_mixed_public_and_private_dns(monkeypatch) -> None:
    monkeypatch.setattr(
        remote.socket,
        "getaddrinfo",
        lambda *args, **kwargs: [
            (2, 1, 6, "", ("93.184.216.34", 443)),
            (2, 1, 6, "", ("127.0.0.1", 443)),
        ],
    )
    with pytest.raises(remote.RemoteEngineError, match="permitted network class"):
        remote.validate_endpoint("https://solver.example")


@pytest.mark.asyncio
async def test_remote_transport_sends_only_binding_problem(monkeypatch) -> None:
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)
    seen = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = request.read()
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(
            200,
            json=_result(),
        )

    result = await remote.solve_remote(
        remote.RemoteRegistration("https://engine.example", {}, "bearer", "secret"),
        {"apiVersion": "bim/v1", "kind": "BindingProblem"},
        {"seed": 7},
        OPTIMIZATION,
        transport=httpx.MockTransport(handler),
    )
    assert result["termination"] == "FEASIBLE"
    assert seen["auth"] == "Bearer secret"
    assert b'"kind":"BindingProblemRequest"' in seen["body"]
    assert b'"optimization":{"type":"SINGLE","scalarization":"feasibility"}' in seen["body"]
    assert b'"zip"' not in seen["body"]


@pytest.mark.asyncio
async def test_remote_async_receipt_is_polled(monkeypatch) -> None:
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if request.method == "POST":
            return httpx.Response(202, json={"id": "job-1", "status": "queued"})
        if calls == 2:
            return httpx.Response(
                200,
                json={"id": "job-1", "status": "running", "created_at": 1},
            )
        return httpx.Response(
            200,
            json={
                "id": "job-1",
                "status": "completed",
                "created_at": 1,
                "result": _result("OPTIMAL"),
            },
        )

    result = await remote.solve_remote(
        remote.RemoteRegistration("https://engine.example", {"job": "/jobs/{id}"}),
        {},
        {},
        OPTIMIZATION,
        transport=httpx.MockTransport(handler),
    )
    assert result["termination"] == "OPTIMAL"
    assert calls == 3


@pytest.mark.asyncio
async def test_remote_async_receipt_must_match_the_published_contract(monkeypatch) -> None:
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json={"id": "job-1"})

    with pytest.raises(remote.RemoteEngineError, match="EngineJobAccepted"):
        await remote.solve_remote(
            remote.RemoteRegistration("https://engine.example", {"job": "/jobs/{id}"}),
            {},
            {},
            OPTIMIZATION,
            transport=httpx.MockTransport(handler),
        )


def test_remote_polled_job_must_match_its_receipt_and_schema() -> None:
    with pytest.raises(remote.RemoteEngineError, match="EngineJob"):
        remote._validate_job(
            {"id": "another-job", "status": "running", "created_at": 1},
            "job-1",
        )


@pytest.mark.asyncio
async def test_remote_transport_pins_validated_address_against_dns_rebinding(monkeypatch) -> None:
    resolutions = 0

    def resolve(host: str, port: int, **kwargs):
        nonlocal resolutions
        resolutions += 1
        # A second lookup would be attacker-controlled and target localhost.
        address = "93.184.216.34" if resolutions == 1 else "127.0.0.1"
        return [(2, 1, 6, "", (address, port))]

    monkeypatch.setattr(remote.socket, "getaddrinfo", resolve)
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json=_result(),
        )

    await remote.solve_remote(
        remote.RemoteRegistration("https://solver.example:8443", {}),
        {"apiVersion": "bim/v1", "kind": "BindingProblem"},
        {},
        OPTIMIZATION,
        transport=httpx.MockTransport(handler),
    )

    assert resolutions == 1
    assert seen[0].url.host == "93.184.216.34"
    assert seen[0].headers["host"] == "solver.example:8443"
    assert seen[0].extensions["sni_hostname"] == "solver.example"


@pytest.mark.asyncio
async def test_a_slow_dns_lookup_does_not_stall_the_event_loop(monkeypatch) -> None:
    import asyncio
    import threading
    import time

    loop_thread = threading.get_ident()
    lookups: list[int] = []

    def slow_resolve(host: str, port: int, **kwargs):
        lookups.append(threading.get_ident())
        time.sleep(0.3)  # a resolver that takes its time
        return [(2, 1, 6, "", ("93.184.216.34", port))]

    monkeypatch.setattr(remote.socket, "getaddrinfo", slow_resolve)
    ticks = 0

    async def heartbeat() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_result())

    beating = asyncio.create_task(heartbeat())
    try:
        await remote.solve_remote(
            remote.RemoteRegistration("https://solver.example", {}),
            {"apiVersion": "bim/v1", "kind": "BindingProblem"},
            {},
            OPTIMIZATION,
            transport=httpx.MockTransport(handler),
        )
    finally:
        beating.cancel()

    assert lookups and lookups[0] != loop_thread  # resolved off the loop's thread
    assert ticks >= 10  # the loop kept running while the lookup was in flight


@pytest.mark.asyncio
async def test_the_private_range_rejection_survives_the_off_loop_resolution(monkeypatch) -> None:
    monkeypatch.setattr(
        remote.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("10.1.2.3", 443))]
    )
    with pytest.raises(remote.RemoteEngineError, match="permitted network class"):
        await remote.solve_remote(
            remote.RemoteRegistration("https://solver.example", {}),
            {},
            {},
            OPTIMIZATION,
            transport=httpx.MockTransport(lambda request: httpx.Response(500)),
        )


@pytest.mark.asyncio
async def test_remote_response_size_is_bounded_even_without_content_length(monkeypatch) -> None:
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)
    monkeypatch.setattr(remote, "MAX_REMOTE_RESPONSE", 32)

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"{" + b" " * 64 + b"}")

    with pytest.raises(remote.RemoteEngineError, match="size limit"):
        await remote.solve_remote(
            remote.RemoteRegistration("https://engine.example", {}),
            {"apiVersion": "bim/v1", "kind": "BindingProblem"},
            {},
            OPTIMIZATION,
            transport=httpx.MockTransport(handler),
        )


def test_remote_mapping_cannot_change_origin() -> None:
    with pytest.raises(remote.RemoteEngineError, match="registered origin|absolute path"):
        remote._path("https://engine.example", "https://attacker.example/solve", "/solve")


def test_basic_credentials_are_encoded_and_mtls_is_not_silently_ignored() -> None:
    headers = remote._headers(remote.RemoteRegistration("https://engine.example", {}, "basic", "alice:secret"))
    assert headers["authorization"] == "Basic YWxpY2U6c2VjcmV0"
    with pytest.raises(remote.RemoteEngineError, match="mTLS"):
        remote._headers(remote.RemoteRegistration("https://engine.example", {}, "mtls", "bundle"))


@pytest.mark.asyncio
async def test_remote_result_must_satisfy_the_complete_binding_result_contract(monkeypatch) -> None:
    # The transport only carries the answer; the shape is judged by the toolchain, through the hook.
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)
    registration = remote.RemoteRegistration("https://engine.example", {})
    incomplete = {"termination": "FEASIBLE", "solutions": [{"decision": {"kind": "binding", "binding": {}}}]}

    with pytest.raises(remote.RemoteEngineError, match="canonical binding decision"):
        await remote.solve_remote(
            registration, {}, {}, OPTIMIZATION,
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json=incomplete)),
            validate_result=validate_engine_result,
        )
    accepted = await remote.solve_remote(
        registration, {}, {}, OPTIMIZATION,
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=_result())),
        validate_result=validate_engine_result,
    )
    assert accepted["termination"] == "FEASIBLE"
    unjudged = await remote.solve_remote(
        registration, {}, {}, OPTIMIZATION,
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=incomplete)),
    )
    assert unjudged == incomplete


@pytest.mark.asyncio
async def test_the_result_of_a_polled_job_is_judged_too(monkeypatch) -> None:
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)
    incomplete = {"termination": "FEASIBLE", "solutions": [{"decision": {"kind": "binding", "binding": {}}}]}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"id": "job-1", "status": "queued"})
        return httpx.Response(200, json={"id": "job-1", "status": "completed", "created_at": 1, "result": incomplete})

    with pytest.raises(remote.RemoteEngineError, match="canonical binding decision"):
        await remote.solve_remote(
            remote.RemoteRegistration("https://engine.example", {"job": "/jobs/{id}"}), {}, {}, OPTIMIZATION,
            transport=httpx.MockTransport(handler),
            validate_result=validate_engine_result,
        )


# -- Idempotency hints, the remote id and cancellation -----------------------


@pytest.mark.asyncio
async def test_the_gateway_job_and_attempt_travel_as_documented_hints(monkeypatch) -> None:
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_result())

    await remote.solve_remote(
        remote.RemoteRegistration("https://engine.example", {}),
        {},
        {},
        OPTIMIZATION,
        transport=httpx.MockTransport(handler),
        job_id="3f6a0c8e-0000-4000-8000-000000000001",
        attempt=2,
    )

    assert seen[0].headers["X-Openbinding-Job-Id"] == "3f6a0c8e-0000-4000-8000-000000000001"
    assert seen[0].headers["X-Openbinding-Attempt"] == "2"
    assert remote.JOB_ID_HEADER == "X-Openbinding-Job-Id" and remote.ATTEMPT_HEADER == "X-Openbinding-Attempt"


@pytest.mark.asyncio
async def test_without_a_job_the_hints_are_not_sent(monkeypatch) -> None:
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_result())

    await remote.solve_remote(
        remote.RemoteRegistration("https://engine.example", {}),
        {},
        {},
        OPTIMIZATION,
        transport=httpx.MockTransport(handler),
    )

    assert "x-openbinding-job-id" not in seen[0].headers and "x-openbinding-attempt" not in seen[0].headers


@pytest.mark.asyncio
async def test_the_remote_id_is_handed_over_before_the_first_poll(monkeypatch) -> None:
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)
    events: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            events.append("accepted")
            return httpx.Response(202, json={"id": "job-1", "status": "queued"})
        events.append("poll")
        return httpx.Response(
            200, json={"id": "job-1", "status": "completed", "created_at": 1, "result": _result("OPTIMAL")}
        )

    async def on_remote_id(engine_job_id: str) -> None:
        events.append(f"recorded {engine_job_id}")

    result = await remote.solve_remote(
        remote.RemoteRegistration("https://engine.example", {"job": "/jobs/{id}"}),
        {},
        {},
        OPTIMIZATION,
        transport=httpx.MockTransport(handler),
        on_remote_id=on_remote_id,
    )

    assert result["termination"] == "OPTIMAL"
    assert events == ["accepted", "recorded job-1", "poll"]


@pytest.mark.asyncio
async def test_a_synchronous_answer_has_no_remote_id_to_hand_over(monkeypatch) -> None:
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)
    handed: list[str] = []

    async def on_remote_id(engine_job_id: str) -> None:
        handed.append(engine_job_id)

    await remote.solve_remote(
        remote.RemoteRegistration("https://engine.example", {}),
        {},
        {},
        OPTIMIZATION,
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=_result())),
        on_remote_id=on_remote_id,
    )

    assert handed == []


@pytest.mark.asyncio
async def test_an_invalid_receipt_is_not_handed_over(monkeypatch) -> None:
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)
    handed: list[str] = []

    async def on_remote_id(engine_job_id: str) -> None:
        handed.append(engine_job_id)

    with pytest.raises(remote.RemoteEngineError, match="EngineJobAccepted"):
        await remote.solve_remote(
            remote.RemoteRegistration("https://engine.example", {"job": "/jobs/{id}"}),
            {},
            {},
            OPTIMIZATION,
            transport=httpx.MockTransport(lambda request: httpx.Response(202, json={"id": "job-1"})),
            on_remote_id=on_remote_id,
        )

    assert handed == []


@pytest.mark.asyncio
async def test_cancelling_a_remote_job_deletes_the_engine_job_resource(monkeypatch) -> None:
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(204)

    cancelled = await remote.cancel_remote(
        remote.RemoteRegistration("https://engine.example", {"job": "/jobs/{id}"}, "bearer", "secret"),
        "job/../1",
        transport=httpx.MockTransport(handler),
    )

    assert cancelled is True
    assert seen[0].method == "DELETE"
    assert seen[0].url.raw_path == b"/jobs/job%2F..%2F1"  # the id cannot change the path
    assert seen[0].headers["authorization"] == "Bearer secret"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [404, 405, 500])
async def test_an_engine_that_does_not_cancel_is_not_an_error(monkeypatch, status) -> None:
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)

    cancelled = await remote.cancel_remote(
        remote.RemoteRegistration("https://engine.example", {}),
        "job-1",
        transport=httpx.MockTransport(lambda request: httpx.Response(status)),
    )

    assert cancelled is False


@pytest.mark.asyncio
async def test_cancellation_swallows_every_failure_and_stays_short(monkeypatch) -> None:
    import asyncio
    import time

    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)

    async def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    async def stuck(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(30)
        return httpx.Response(204)

    registration = remote.RemoteRegistration("https://engine.example", {})
    assert await remote.cancel_remote(registration, "job-1", transport=httpx.MockTransport(unreachable)) is False

    started = time.monotonic()
    assert (
        await remote.cancel_remote(registration, "job-1", timeout_s=0.1, transport=httpx.MockTransport(stuck))
        is False
    )
    assert time.monotonic() - started < 5

    def refused(endpoint, **kwargs):
        raise remote.RemoteEngineError("engine endpoint targets an address outside its permitted network class")

    monkeypatch.setattr(remote, "validate_endpoint", refused)
    assert await remote.cancel_remote(registration, "job-1", transport=httpx.MockTransport(unreachable)) is False
