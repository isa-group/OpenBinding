"""Speaking to an engine that never heard of our contract.

The engine in these tests is deliberately awkward: its solve operation is
``POST /v1/optimize``, it wants the instance under ``problem``, it returns its
answers under ``results``, it calls a binding an ``assignment`` and an objective
a ``score``, and it authenticates with a header of its own choosing. None of
that is negotiable from our side, and none of it should require a line of code
per engine.

The other half of these tests is that the seam cost the built-in engines
nothing: ``BuiltinTransport`` has to make byte-for-byte the requests the router
made before it existed.
"""

from __future__ import annotations

import json
from typing import Any, Dict
from unittest.mock import patch

import httpx
import pytest

from openbinding_gateway.federation.transport import (
    BuiltinTransport,
    FederatedTransport,
    TransportError,
    fill_path,
    find_operation,
    set_pointer,
)
from openbinding_gateway.models.manifest import EngineManifest

THEIR_OPENAPI: Dict[str, Any] = {
    "openapi": "3.1.0",
    "servers": [{"url": "https://acme.example/api"}],
    "paths": {
        "/v1/optimize": {"post": {"operationId": "postOptimize"}},
        "/v1/optimize/{runId}": {"get": {"operationId": "getOptimizeRun"}},
        "/status": {"get": {"operationId": "getHealth"}},
    },
}


def a_manifest(**transport_overrides) -> EngineManifest:
    transport = {
        "openapi": {"document": THEIR_OPENAPI},
        "operations": {"solve": {"operationId": "postOptimize"}},
        "request_mapping": {"instance": "/problem", "options": "/params"},
        "response_mapping": {
            "solutions": "/results",
            "binding": "/assignment",
            "objective": "/score",
        },
    }
    transport.update(transport_overrides)
    return EngineManifest.model_validate(
        {
            "manifest_version": "1",
            "engine_id": "tabu",
            "display_name": "ACME Tabu",
            "type": "HEURISTIC",
            "capabilities": {
                "composition_nodes_supported": ["TASK", "SEQ"],
                "objective_types_supported": ["MONO"],
            },
            "instance_schema": {"type": "object"},
            "transport": transport,
        }
    )


def a_transport(**kwargs) -> FederatedTransport:
    manifest = kwargs.pop("manifest", None) or a_manifest()
    kwargs.setdefault("require_https", True)
    return FederatedTransport(manifest, THEIR_OPENAPI, **kwargs)


class Recorder:
    """Captures the request instead of sending it."""

    def __init__(self, status: int = 200, body: Any = None, headers=None):
        self.status = status
        self.body = body if body is not None else {"results": []}
        self.headers = headers or {}
        self.request: httpx.Request | None = None

    async def __call__(self, request: httpx.Request, **kwargs):
        self.request = request
        self.kwargs = kwargs
        return httpx.Response(
            status_code=self.status,
            content=json.dumps(self.body).encode(),
            headers={"content-type": "application/json", **self.headers},
            request=request,
        )


async def send_through(transport: FederatedTransport, recorder: Recorder, **kw):
    async with httpx.AsyncClient() as client:
        with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]):
            with patch.object(httpx.AsyncClient, "send", new=recorder):
                return await transport.solve(client, kw.pop("payload", {"instance": {"a": 1}}), timeout=5)


# -- The built-in transport changed nothing ---------------------------------


@pytest.mark.asyncio
async def test_a_built_in_engine_is_asked_exactly_what_it_used_to_be():
    calls = {}

    class Client:
        async def post(self, url, json=None, timeout=None):
            calls.update(url=url, json=json, timeout=timeout)

        async def get(self, url, timeout=None):
            calls.update(url=url, timeout=timeout)

    await BuiltinTransport("http://engine-minizinc:3000").solve(
        Client(), {"instance": {}, "options": {}}, timeout=1800
    )
    assert calls["url"] == "http://engine-minizinc:3000/solve"
    assert calls["json"] == {"instance": {}, "options": {}}
    assert calls["timeout"] == 1800

    await BuiltinTransport("http://engine-minizinc:3000/").poll(Client(), "job-7", timeout=30)
    assert calls["url"] == "http://engine-minizinc:3000/jobs/job-7"


def test_a_built_in_engine_is_not_federated():
    assert BuiltinTransport("http://x").is_federated is False
    assert a_transport().is_federated is True


# -- Finding their operations ----------------------------------------------


def test_an_operation_is_found_by_id_not_by_path():
    assert find_operation(THEIR_OPENAPI, "postOptimize") == ("POST", "/v1/optimize")
    assert find_operation(THEIR_OPENAPI, "getOptimizeRun") == ("GET", "/v1/optimize/{runId}")


def test_a_missing_operation_says_so_by_name():
    with pytest.raises(TransportError) as error:
        find_operation(THEIR_OPENAPI, "postSolve")

    assert "postSolve" in str(error.value)


def test_a_document_with_no_paths_is_refused():
    with pytest.raises(TransportError):
        find_operation({"openapi": "3.1.0"}, "postOptimize")


# -- Filling their paths ----------------------------------------------------


@pytest.mark.parametrize(
    "path,expected",
    [
        ("/jobs/{id}", "/jobs/abc"),
        ("/v1/optimize/{runId}", "/v1/optimize/abc"),
        ("/runs/{run_id}/status", "/runs/abc/status"),
        ("/jobs", "/jobs"),
    ],
)
def test_the_job_identifier_fills_whatever_the_parameter_is_called(path, expected):
    assert fill_path(path, "abc") == expected


def test_a_path_with_several_parameters_is_refused_rather_than_guessed():
    # Filling the wrong one produces a request that looks right and asks about
    # something else.
    with pytest.raises(TransportError) as error:
        fill_path("/orgs/{org}/jobs/{id}", "abc")

    assert "org" in str(error.value)


# -- Building their request body -------------------------------------------


def test_the_instance_goes_where_their_mapping_says():
    body = a_transport().build_solve_body({"instance": {"tasks": []}, "options": {"seed": 1}})

    assert body == {"problem": {"tasks": []}, "params": {"seed": 1}}


def test_an_engine_whose_body_is_the_instance_is_describable():
    manifest = a_manifest(request_mapping={"instance": "", "options": None})

    body = FederatedTransport(manifest, THEIR_OPENAPI).build_solve_body(
        {"instance": {"tasks": []}, "options": {"seed": 1}}
    )

    assert body == {"tasks": []}


def test_a_nested_pointer_creates_the_objects_on_the_way():
    assert set_pointer({}, "/a/b/c", 1) == {"a": {"b": {"c": 1}}}


def test_setting_a_pointer_keeps_what_is_already_there():
    assert set_pointer({"a": {"x": 0}}, "/a/b", 1) == {"a": {"x": 0, "b": 1}}


def test_options_are_omitted_when_there_are_none():
    body = a_transport().build_solve_body({"instance": {}, "options": None})

    assert "params" not in body


# -- Where they live --------------------------------------------------------


def test_the_base_url_comes_from_their_document():
    assert a_transport().base_url() == "https://acme.example/api"


def test_the_manifest_overrides_their_document():
    # For a servers[] entry left pointing at somebody's laptop.
    manifest = a_manifest(base_url="https://tabu.acme.example")

    assert FederatedTransport(manifest, THEIR_OPENAPI).base_url() == "https://tabu.acme.example"


def test_an_engine_that_says_nowhere_is_refused():
    with pytest.raises(TransportError) as error:
        FederatedTransport(a_manifest(), {"openapi": "3.1.0", "paths": {}}).base_url()

    assert "base_url" in str(error.value)


# -- Authentication ---------------------------------------------------------


@pytest.mark.asyncio
async def test_an_api_key_travels_in_the_header_they_named():
    transport = a_transport(
        manifest=a_manifest(auth={"type": "api_key", "header": "X-Acme-Key"}),
        credential="sk-live-1234",
    )
    recorder = Recorder()

    await send_through(transport, recorder)

    assert recorder.request.headers["X-Acme-Key"] == "sk-live-1234"


@pytest.mark.asyncio
async def test_a_bearer_token_travels_in_authorization():
    transport = a_transport(manifest=a_manifest(auth={"type": "bearer"}), credential="tok")
    recorder = Recorder()

    await send_through(transport, recorder)

    assert recorder.request.headers["Authorization"] == "Bearer tok"


@pytest.mark.asyncio
async def test_an_engine_needing_a_credential_it_has_not_got_says_so():
    transport = a_transport(manifest=a_manifest(auth={"type": "bearer"}), credential=None)

    with pytest.raises(TransportError) as error:
        await send_through(transport, Recorder())

    assert "credential" in str(error.value)


@pytest.mark.asyncio
async def test_an_open_engine_carries_no_authorization():
    recorder = Recorder()

    await send_through(a_transport(), recorder)

    assert "Authorization" not in recorder.request.headers


# -- Safety at request time -------------------------------------------------


@pytest.mark.asyncio
async def test_the_request_goes_to_the_address_that_was_checked():
    # Not to the name: re-resolving would be a second chance for the name's
    # owner to answer with something else.
    recorder = Recorder()

    await send_through(a_transport(), recorder)

    assert recorder.request.url.host == "93.184.216.34"
    assert recorder.request.headers["Host"] == "acme.example"
    assert recorder.request.extensions["sni_hostname"] == "acme.example"


@pytest.mark.asyncio
async def test_the_destination_is_rechecked_at_request_time():
    # Registration checked it once; DNS can change in between, and this is the
    # moment that matters.
    from openbinding_gateway.federation.ssrf import UnsafeUrl

    async with httpx.AsyncClient() as client:
        with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 443))]):
            with pytest.raises(UnsafeUrl):
                await a_transport().solve(client, {"instance": {}}, timeout=5)


@pytest.mark.asyncio
async def test_redirects_are_not_followed():
    # A 302 is a second destination that nothing has checked.
    recorder = Recorder()

    await send_through(a_transport(), recorder)

    assert recorder.kwargs["follow_redirects"] is False


@pytest.mark.asyncio
async def test_an_oversized_answer_is_refused_rather_than_buffered():
    recorder = Recorder(body={"results": [{"assignment": {"t": "c" * 5000}}]})
    transport = a_transport(max_response_bytes=256)

    with pytest.raises(TransportError) as error:
        await send_through(transport, recorder)

    assert "bytes" in str(error.value)


@pytest.mark.asyncio
async def test_their_response_headers_are_not_carried_onward():
    # Set-Cookie from a third party has no business reaching our caller.
    recorder = Recorder(headers={"set-cookie": "session=theirs", "x-acme": "1"})

    response = await send_through(a_transport(), recorder)

    assert "set-cookie" not in response.headers
    assert "x-acme" not in response.headers


@pytest.mark.asyncio
async def test_the_status_and_body_do_survive():
    recorder = Recorder(status=202, body={"results": [{"assignment": {"t1": "c1"}}]})

    response = await send_through(a_transport(), recorder)

    assert response.status_code == 202
    assert response.json()["results"][0]["assignment"] == {"t1": "c1"}


# -- Polling ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_polling_a_synchronous_engine_is_refused():
    async with httpx.AsyncClient() as client:
        with pytest.raises(TransportError) as error:
            await a_transport().poll(client, "job-1", timeout=5)

    assert "synchronously" in str(error.value)


@pytest.mark.asyncio
async def test_an_async_engine_is_polled_at_its_own_path():
    manifest = a_manifest(
        operations={
            "solve": {"operationId": "postOptimize"},
            "job": {"operationId": "getOptimizeRun"},
        },
        response_mapping={
            "solutions": "/results",
            "binding": "/assignment",
            "job_id": "/id",
            "job_status": {"pointer": "/state", "map": {"done": "completed"}},
        },
    )
    recorder = Recorder()

    async with httpx.AsyncClient() as client:
        with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]):
            with patch.object(httpx.AsyncClient, "send", new=recorder):
                await FederatedTransport(manifest, THEIR_OPENAPI).poll(client, "run-42", timeout=5)

    assert recorder.request.url.path == "/api/v1/optimize/run-42"
    assert recorder.request.method == "GET"


# -- Health -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_engine_declaring_no_health_operation_is_not_reported_down():
    # It has declined to offer a check, which is not the same as failing one.
    async with httpx.AsyncClient() as client:
        assert await a_transport().healthy(client) is True


@pytest.mark.asyncio
async def test_a_declared_health_operation_is_called():
    manifest = a_manifest(
        operations={
            "solve": {"operationId": "postOptimize"},
            "health": {"operationId": "getHealth"},
        }
    )
    recorder = Recorder(status=200)

    async with httpx.AsyncClient() as client:
        with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]):
            with patch.object(httpx.AsyncClient, "send", new=recorder):
                healthy = await FederatedTransport(manifest, THEIR_OPENAPI).healthy(client)

    assert healthy is True
    assert recorder.request.url.path == "/api/status"


@pytest.mark.asyncio
async def test_an_unreachable_engine_is_reported_unhealthy_rather_than_raising():
    manifest = a_manifest(
        operations={
            "solve": {"operationId": "postOptimize"},
            "health": {"operationId": "getHealth"},
        }
    )

    async with httpx.AsyncClient() as client:
        with patch("socket.getaddrinfo", side_effect=OSError("down")):
            assert await FederatedTransport(manifest, THEIR_OPENAPI).healthy(client) is False


# -- A manifest with no transport is not a federated engine -----------------


def test_an_in_tree_manifest_cannot_be_given_a_federated_transport():
    from openbinding_gateway.registry.engine import EngineRegistry

    manifest = EngineRegistry.get_plugin("random-search").get_manifest()

    with pytest.raises(TransportError) as error:
        FederatedTransport(manifest, {})

    assert "transport" in str(error.value)
