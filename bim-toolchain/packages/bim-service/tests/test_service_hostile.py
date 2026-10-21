"""Unexpected failures and hostile input: a generic 500 with a correlation id, and controlled 4xx answers."""

from __future__ import annotations

import base64
import logging

import pytest
from service_support import BASE_URL, bearer
from starlette.testclient import TestClient

import consumer_fixtures as demo
from bim_service import operations

JSON = {"Content-Type": "application/json"}
TRACE = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
CORRELATION_ID = "0af7651916cd43dd8448eb211c80319c"


def package_body(data: bytes) -> dict:
    return {"package": base64.b64encode(data).decode(), "registeredResources": []}


# --- unexpected failures -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "operation", "body"),
    [
        ("/bim/v1/evaluate", "evaluate", {"ir": {}, "bindings": [{}]}),
        ("/bim/v1/compile", "compile_package", {"package": ""}),
        ("/bim/v1/validate", "validate_package", {"package": ""}),
        ("/bim/v1/validate-result", "check_result", {"result": {}}),
        ("/bim/v1/engines/validate", "validate_engine", {"document": {}}),
    ],
)
def test_an_unexpected_failure_is_a_generic_500_with_a_correlation_id_and_no_detail(
    client, monkeypatch, caplog, path, operation, body
) -> None:
    def failing(*args):
        raise ValueError("SECRET-MESSAGE /srv/private/path.json")

    monkeypatch.setattr(operations, operation, failing)
    caplog.set_level(logging.DEBUG)
    response = client.post(path, json=body, headers={"traceparent": TRACE})
    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/problem+json")
    problem = response.json()
    assert problem["code"] == "internal_error" and problem["status"] == 500
    assert problem["type"] == "urn:bim-toolchain:problem:internal_error"
    assert problem["detail"] == "the service failed to process the request"
    assert problem["correlationId"] == CORRELATION_ID == response.headers["traceparent"].split("-")[1]
    assert set(problem) == {"type", "title", "status", "detail", "code", "diagnostics", "correlationId"}
    for leaked in ("SECRET", "/srv", "Traceback", "ValueError", ".py"):
        assert leaked not in response.text, leaked
    # The server log has the class, the frames and the id; not the message.
    assert "ValueError" in caplog.text and f"correlation_id={CORRELATION_ID}" in caplog.text
    assert "failing" in caplog.text and "SECRET" not in caplog.text and "/srv" not in caplog.text


def test_each_unexpected_failure_without_a_traceparent_gets_its_own_correlation_id(client, monkeypatch) -> None:
    def failing(*args):
        raise RuntimeError("boom")

    monkeypatch.setattr(operations, "evaluate", failing)
    body = {"ir": {}, "bindings": [{}]}
    first = client.post("/bim/v1/evaluate", json=body).json()["correlationId"]
    second = client.post("/bim/v1/evaluate", json=body).json()["correlationId"]
    assert first != second and len(first) == len(second) == 32


def test_the_service_keeps_serving_after_an_unexpected_failure(client, monkeypatch) -> None:
    def failing(*args):
        raise RuntimeError("boom")

    with monkeypatch.context() as patch:
        patch.setattr(operations, "evaluate", failing)
        assert client.post("/bim/v1/evaluate", json={"ir": {}, "bindings": [{}]}).status_code == 500
    assert client.get("/healthz").status_code == 200
    assert client.post("/bim/v1/compile", json=package_body(demo.demo_zip())).status_code == 200


# --- the size of the body ----------------------------------------------------------------------------


def test_an_oversized_body_is_413_on_every_kind_of_endpoint(make_app) -> None:
    small = TestClient(make_app(max_body_bytes=512), base_url=BASE_URL, headers=bearer())
    big = "A" * 4096
    for path, body in (
        ("/bim/v1/compile", {"package": big}),
        ("/bim/v1/evaluate", {"ir": {"x": big}, "bindings": []}),
        ("/bim/v1/resources/xml/root", {"contentBase64": big}),
    ):
        response = small.post(path, json=body)
        assert response.status_code == 413, path
        assert response.json()["code"] == "payload_too_large"
        assert big not in response.text
    multipart = small.post("/bim/v1/compile", files={"package": ("x.bim.zip", big.encode(), "application/zip")})
    assert multipart.status_code == 413


# --- hostile input -----------------------------------------------------------------------------------


def _is_controlled(response) -> bool:
    return (
        400 <= response.status_code < 500
        and response.headers["content-type"].startswith("application/problem+json")
        and response.json()["code"] != "internal_error"
    )


@pytest.mark.parametrize("opening, closing", [("[", "]"), ('{"a":', "}")])
@pytest.mark.parametrize(
    "path",
    ["/bim/v1/compile", "/bim/v1/validate", "/bim/v1/evaluate", "/bim/v1/validate-result", "/bim/v1/resources/validate"],
)
def test_deeply_nested_json_is_a_controlled_client_error(client, path, opening, closing) -> None:
    depth = 200_000
    body = (opening * depth + "1" + closing * depth).encode()
    response = client.post(path, content=body, headers=JSON)
    assert _is_controlled(response), (response.status_code, response.text[:200])
    assert client.get("/healthz").status_code == 200


def test_deeply_nested_json_inside_a_member_is_a_controlled_client_error(client) -> None:
    depth = 100_000
    nested = "[" * depth + "]" * depth
    for path, body in (
        ("/bim/v1/validate-result", f'{{"result": {nested}}}'),
        ("/bim/v1/evaluate", f'{{"ir": {nested}, "bindings": []}}'),
    ):
        response = client.post(path, content=body, headers=JSON)
        assert _is_controlled(response) or response.status_code == 200, (path, response.status_code, response.text[:200])
        assert response.status_code != 500


def _corrupt_zips() -> dict[str, bytes]:
    good = bytearray(demo.demo_zip())
    flipped = bytearray(good)
    for offset in range(40, min(len(flipped), 400), 7):
        flipped[offset] ^= 0xFF
    return {
        "empty": b"",
        "signature only": b"PK\x03\x04",
        "end of central directory only": b"PK\x05\x06" + b"\x00" * 18,
        "truncated": bytes(good[: len(good) // 2]),
        "missing central directory": bytes(good[:-30]),
        "flipped bytes": bytes(flipped),
        "garbage after the signature": b"PK\x03\x04" + b"\xff" * 200,
        "text": b"this is not a zip" * 100,
    }


@pytest.mark.parametrize("name", sorted(_corrupt_zips()))
@pytest.mark.parametrize("path", ["/bim/v1/compile", "/bim/v1/validate"])
def test_a_corrupt_zip_is_a_controlled_client_error(client, name, path) -> None:
    response = client.post(path, json=package_body(_corrupt_zips()[name]))
    assert _is_controlled(response), (name, response.status_code, response.text[:200])
    # A package that cannot even be read is an error, never a 200 with valid=false and never a 5xx.
    assert response.status_code == 422


def test_a_corrupt_zip_in_a_multipart_upload_is_a_controlled_client_error(client) -> None:
    response = client.post(
        "/bim/v1/compile", files={"package": ("broken.bim.zip", _corrupt_zips()["truncated"], "application/zip")}
    )
    assert _is_controlled(response) and response.status_code == 422


@pytest.mark.parametrize(
    ("content_type", "body"),
    [
        ("multipart/form-data", b"--x\r\n"),
        ("multipart/form-data; boundary=x", b"--x\r\nContent-Disposition: form-data; name=package"),
        ("multipart/form-data; boundary=x", b"--x\r\n\r\n\r\nbody\r\n--x--\r\n"),
        ("multipart/form-data; boundary=x", b"\xff" * 64),
        ("multipart/form-data; boundary=" + "x" * 5000, b"--x--"),
    ],
)
def test_a_malformed_multipart_body_is_a_controlled_client_error(client, content_type, body) -> None:
    response = client.post("/bim/v1/compile", content=body, headers={"Content-Type": content_type})
    assert _is_controlled(response), (response.status_code, response.text[:200])


def test_invalid_base64_and_invalid_utf8_are_controlled_client_errors(client) -> None:
    assert _is_controlled(client.post("/bim/v1/compile", json={"package": "@@@not-base64@@@"}))
    assert _is_controlled(client.post("/bim/v1/compile", content=b'{"package": "\xff\xfe"}', headers=JSON))
    assert _is_controlled(client.post("/bim/v1/resources/xml/root", json={"contentBase64": "@@@"}))
