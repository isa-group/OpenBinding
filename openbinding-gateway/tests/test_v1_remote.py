import httpx
import pytest

from openbinding_gateway.v1 import remote


def _result(termination: str = "FEASIBLE") -> dict:
    return {
        "termination": termination,
        "solutions": [
            {
                "decision": {"kind": "binding", "binding": {}},
                "metrics": {},
                "objectives": {
                    "mode": "satisfy",
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
        transport=httpx.MockTransport(handler),
    )
    assert result["termination"] == "FEASIBLE"
    assert seen["auth"] == "Bearer secret"
    assert b'"kind":"BindingProblemRequest"' in seen["body"]
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
        transport=httpx.MockTransport(handler),
    )

    assert resolutions == 1
    assert seen[0].url.host == "93.184.216.34"
    assert seen[0].headers["host"] == "solver.example:8443"
    assert seen[0].extensions["sni_hostname"] == "solver.example"


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


def test_remote_result_must_satisfy_the_complete_binding_result_contract() -> None:
    with pytest.raises(remote.RemoteEngineError, match="canonical binding decision"):
        remote._validate_result(
            {
                "termination": "FEASIBLE",
                "solutions": [{"decision": {"kind": "binding", "binding": {}}}],
            }
        )
    assert remote._validate_result(_result())["termination"] == "FEASIBLE"
