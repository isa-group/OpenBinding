"""Public failures: a fixed 500, a ``correlationId`` on every 5xx, and 4xx left alone.

Nothing here reaches a database, an engine, SPACE or SPHERE: the routes under test are
added to a fresh app and raise on purpose.
"""

from __future__ import annotations

import logging
import re

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse, PlainTextResponse
from httpx import ASGITransport, AsyncClient

from openbinding_gateway.core.public_errors import INTERNAL_ERROR
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.main import create_app

LOGGER = "openbinding_gateway.core.public_errors"
SECRET_TEXT = "db-internal.corp:5432 password=hunter2 /srv/gateway/private.py"
HEX32 = re.compile(r"^[0-9a-f]{32}$")
TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
TRACEPARENT = f"00-{TRACE_ID}-00f067aa0ba902b7-01"


@pytest.fixture
def gateway():
    app = create_app(get_settings())

    @app.get("/boom")
    async def boom():
        raise RuntimeError(SECRET_TEXT)

    @app.get("/v1/catalog/boom")
    async def bim_boom():
        raise RuntimeError(SECRET_TEXT)

    @app.get("/refuse/{status}")
    async def refuse(status: int):
        raise HTTPException(status_code=status, detail={"code": "refused", "error": "refused here"})

    @app.get("/refuse-text/{status}")
    async def refuse_text(status: int):
        raise HTTPException(status_code=status, detail="plain reason")

    @app.get("/v1/catalog/refuse/{status}")
    async def bim_refuse(status: int):
        raise HTTPException(status_code=status, detail={"code": "refused", "message": "refused here"})

    @app.get("/returned")
    async def returned():
        return JSONResponse({"code": "upstream_down"}, status_code=502, headers={"X-Kept": "yes"})

    @app.get("/returned-own-id")
    async def returned_own_id():
        return JSONResponse({"code": "x", "correlationId": "mine"}, status_code=503)

    @app.get("/returned-text")
    async def returned_text():
        return PlainTextResponse("not json", status_code=502)

    return app


@pytest.fixture
async def client(gateway):
    # A real client sees the 500; the default transport would re-raise the application error.
    transport = ASGITransport(app=gateway, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://gateway") as http:
        yield http


def logged(caplog) -> str:
    return "\n".join(record.getMessage() for record in caplog.records if record.name == LOGGER)


async def test_an_unhandled_exception_is_a_generic_500(client, caplog):
    with caplog.at_level(logging.INFO, logger=LOGGER):
        response = await client.get("/boom")

    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["code"] == INTERNAL_ERROR.code == "internal_error"
    assert body["status"] == 500
    assert body["detail"] == INTERNAL_ERROR.detail == "the service failed to process the request"
    assert HEX32.match(body["correlationId"])
    for leaked in (SECRET_TEXT, "db-internal", "hunter2", "/srv", "private.py", "RuntimeError", "Traceback", "boom"):
        assert leaked not in response.text


async def test_the_correlation_id_of_the_500_is_the_one_in_the_log(client, caplog):
    with caplog.at_level(logging.INFO, logger=LOGGER):
        response = await client.get("/boom")

    correlation = response.json()["correlationId"]
    records = [r.getMessage() for r in caplog.records if r.name == LOGGER and f"correlation_id={correlation}" in r.getMessage()]
    assert len(records) == 1
    entry = records[0]
    assert "RuntimeError" in entry
    assert "test_public_errors.py:boom:" in entry  # file:function:line of the frame
    assert "/boom" in entry
    # The class and the frames are logged; the message of the exception, which may quote input or secrets, is not.
    assert SECRET_TEXT not in entry
    assert "hunter2" not in entry
    assert all(record.exc_info is None for record in caplog.records if record.name == LOGGER)


async def test_two_failures_have_two_correlation_ids(client):
    first = (await client.get("/boom")).json()["correlationId"]
    second = (await client.get("/boom")).json()["correlationId"]

    assert first != second


async def test_a_valid_traceparent_supplies_the_correlation_id(client, caplog):
    with caplog.at_level(logging.INFO, logger=LOGGER):
        response = await client.get("/boom", headers={"traceparent": TRACEPARENT})

    assert response.json()["correlationId"] == TRACE_ID
    assert f"correlation_id={TRACE_ID}" in logged(caplog)


@pytest.mark.parametrize(
    "traceparent",
    [
        "garbage",
        f"00-{'0' * 32}-00f067aa0ba902b7-01",
        f"ff-{TRACE_ID}-00f067aa0ba902b7-01",
        f"00-{TRACE_ID.upper()}-00f067aa0ba902b7-01",
        f"00-{TRACE_ID}-{'0' * 16}-01",
        f"00-{TRACE_ID} forged log line-00f067aa0ba902b7-01",
    ],
)
async def test_an_invalid_traceparent_is_not_reflected(client, traceparent):
    response = await client.get("/boom", headers={"traceparent": traceparent})

    correlation = response.json()["correlationId"]
    assert HEX32.match(correlation)
    assert correlation != TRACE_ID


@pytest.mark.parametrize("status", [500, 502, 503, 504])
async def test_a_5xx_http_exception_carries_a_correlation_id(client, caplog, status):
    with caplog.at_level(logging.INFO, logger=LOGGER):
        response = await client.get(f"/refuse/{status}", headers={"traceparent": TRACEPARENT})

    body = response.json()
    assert response.status_code == status
    assert body["correlationId"] == TRACE_ID
    # The shape the platform always answered is kept beside the new member.
    assert body["code"] == "refused"
    assert body["detail"] == {"code": "refused", "error": "refused here"}
    assert f"correlation_id={TRACE_ID}" in logged(caplog)


async def test_a_5xx_http_exception_with_a_text_detail_carries_a_correlation_id(client):
    response = await client.get("/refuse-text/503")

    body = response.json()
    assert response.status_code == 503
    assert body["detail"] == "plain reason"
    assert HEX32.match(body["correlationId"])


async def test_a_5xx_on_a_bim_route_is_a_problem_with_a_correlation_id(client):
    response = await client.get("/v1/catalog/refuse/502")

    body = response.json()
    assert response.status_code == 502
    assert response.headers["content-type"].startswith("application/problem+json")
    assert (body["code"], body["detail"]) == ("refused", "refused here")
    assert HEX32.match(body["correlationId"])


async def test_a_returned_5xx_response_carries_a_correlation_id_and_keeps_its_headers(client):
    response = await client.get("/returned")

    assert response.status_code == 502
    assert response.headers["x-kept"] == "yes"
    assert response.json()["code"] == "upstream_down"
    assert HEX32.match(response.json()["correlationId"])
    assert int(response.headers["content-length"]) == len(response.content)


async def test_a_correlation_id_already_in_the_document_is_kept(client):
    response = await client.get("/returned-own-id")

    assert response.json()["correlationId"] == "mine"


async def test_a_5xx_that_is_not_json_is_left_as_it_is(client):
    response = await client.get("/returned-text")

    assert response.status_code == 502
    assert response.text == "not json"


@pytest.mark.parametrize("path", ["/refuse/404", "/refuse/409", "/refuse/422", "/refuse/429", "/v1/catalog/refuse/404"])
async def test_a_4xx_gets_no_correlation_id(client, path):
    response = await client.get(path)

    assert 400 <= response.status_code < 500
    assert "correlationId" not in response.json()
    assert "correlationId" not in response.text


async def test_the_4xx_shapes_are_unchanged(client):
    platform = await client.get("/refuse/409")
    bim = await client.get("/v1/catalog/refuse/409")
    validation = await client.get("/refuse/not-a-number")

    assert platform.json() == {
        "type": "https://openbinding.dev/problems/refused",
        "title": "refused",
        "status": 409,
        "code": "refused",
        "detail": {"code": "refused", "error": "refused here"},
    }
    assert bim.json() == {
        "type": "https://openbinding.dev/problems/refused",
        "title": "refused",
        "status": 409,
        "code": "refused",
        "detail": "refused here",
    }
    assert validation.status_code == 422
    assert "correlationId" not in validation.json()


async def test_the_500_has_the_same_shape_on_every_route(client):
    platform = await client.get("/boom")
    bim = await client.get("/v1/catalog/boom")

    assert platform.status_code == bim.status_code == 500
    assert platform.headers["content-type"] == bim.headers["content-type"]
    first, second = platform.json(), bim.json()
    assert first.keys() == second.keys()
    assert {k: v for k, v in first.items() if k != "correlationId"} == {
        k: v for k, v in second.items() if k != "correlationId"
    }
    assert first["correlationId"] != second["correlationId"]


async def test_the_problem_schema_declares_the_correlation_id_as_optional(gateway):
    schema = gateway.openapi()["components"]["schemas"]["Problem"]

    assert schema["properties"]["correlationId"]["type"] == "string"
    assert "correlationId" not in schema["required"]
