"""The stateless Composition2Yaml services over HTTP: ``/v1/compositions/{validate,parse,serialise,diff,schema}``.

What the library decides is pinned by ``tests/composition``; these pin what the routes add on
top of it: the media types and byte limits, the 200 lint against the 422 refusals, the
diagnostics on the wire (severity, path, pointer, span), the deployment's SPHERE registries
as the only context, the language slots, and who may call.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from _b1_helpers import gate, make_account, make_key  # noqa: F401
from _paths import TESTS_DIR
from openbinding_gateway.composition import diff as composition_diff
from openbinding_gateway.composition import text
from openbinding_gateway.core.settings import SphereRegistry, get_settings
from openbinding_gateway.modules.compositions.application import language_slot

GOLDEN = TESTS_DIR / "composition" / "golden"
LANGUAGE = "/v1/compositions"
YAML = {"content-type": "application/yaml"}
PROBLEM_JSON = "application/problem+json"
LIMIT = text.MAX_SOURCE_BYTES

MINIMAL = (GOLDEN / "valid" / "01_declared_minimal.yaml").read_text(encoding="utf-8")


def golden(kind: str, name: str) -> str:
    return (GOLDEN / kind / f"{name}.yaml").read_text(encoding="utf-8")


def sibling(source: Path, suffix: str) -> Path:
    return source.with_name(source.name.removesuffix(".yaml") + suffix)


def wire_span(span: list[int] | None) -> dict | None:
    if span is None:
        return None
    line, column, end_line, end_column = span
    return {"line": line, "column": column, "end_line": end_line, "end_column": end_column}


def listed(diagnostics: list[dict]) -> list[dict]:
    """The wire diagnostics as a golden's ``.expected.json`` lists them (no message)."""
    return [
        {
            "code": item["code"], "severity": item["severity"], "path": item["path"], "pointer": item["pointer"],
            "span": None if item["span"] is None else [
                item["span"]["line"], item["span"]["column"], item["span"]["end_line"], item["span"]["end_column"],
            ],
        }
        for item in diagnostics
    ]


#: The valid goldens that read the same in a deployment with no registries and no entity.
PLAIN_VALID = sorted(
    path for path in (GOLDEN / "valid").glob("*.yaml")
    if not path.name.endswith(".canonical.yaml") and not sibling(path, ".context.json").is_file()
)
PLAIN_INVALID = sorted(
    path for path in (GOLDEN / "invalid").glob("*.yaml") if not sibling(path, ".context.json").is_file()
)


@pytest.fixture
def registries(monkeypatch):
    """Set the deployment's ``SPHERE_REGISTRIES`` for one test."""

    def apply(**defined: str) -> None:
        monkeypatch.setattr(
            get_settings(), "sphere_registries", {alias: SphereRegistry(url=url) for alias, url in defined.items()},
        )

    apply()
    return apply


async def lint(client, document: str | bytes, headers: dict | None = None):
    body = document.encode("utf-8") if isinstance(document, str) else document
    return await client.post(f"{LANGUAGE}/validate", content=body, headers={**YAML, **(headers or {})})


# ------------------------------------------------------------------- validate


@pytest.mark.parametrize("source", PLAIN_VALID, ids=lambda path: path.stem)
async def test_a_valid_golden_lints_clean_or_with_its_notes(api_client, registries, source):
    response = await lint(api_client, source.read_text(encoding="utf-8"))

    assert response.status_code == 200, response.text
    body = response.json()
    notes = sibling(source, ".notes.json")
    assert body["valid"] is True
    assert listed(body["diagnostics"]) == (json.loads(notes.read_text(encoding="utf-8")) if notes.is_file() else [])


@pytest.mark.parametrize("source", PLAIN_INVALID, ids=lambda path: path.stem)
async def test_an_invalid_golden_lints_200_with_its_codes_and_spans(api_client, registries, source):
    response = await lint(api_client, source.read_text(encoding="utf-8"))

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["valid"] is False
    assert listed(body["diagnostics"]) == json.loads(sibling(source, ".expected.json").read_text(encoding="utf-8"))
    for item in body["diagnostics"]:
        assert set(item) == {"code", "message", "severity", "path", "pointer", "span"}
        assert item["message"]


async def test_bytes_that_are_not_utf8_are_a_syntax_error_on_their_line(api_client):
    response = await lint(api_client, b'syntaxVersion: "1.0"\ncomposition: caf\xe9\n')

    assert response.status_code == 200, response.text
    [diagnostic] = response.json()["diagnostics"]
    assert diagnostic["code"] == "c2y_syntax"
    assert diagnostic["span"] == {"line": 2, "column": 17, "end_line": 2, "end_column": 18}
    assert response.json()["valid"] is False


# ------------------------------------------------------------------- parse


async def test_parse_answers_the_canonical_json_model(api_client):
    source = golden("valid", "02_tomatometer")

    response = await api_client.post(f"{LANGUAGE}/parse", content=source.encode(), headers=YAML)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {"document": text.document(text.parse(source)), "diagnostics": []}
    assert list(body["document"])[:4] == ["syntaxVersion", "composition", "version", "kind"]
    assert body["document"]["binding"]["login"] == {"local": True}


async def test_parse_keeps_the_warnings_of_a_valid_document(api_client, registries):
    response = await api_client.post(
        f"{LANGUAGE}/parse", content=golden("valid", "17_offering_registry_unknown").encode(), headers=YAML,
    )

    assert response.status_code == 200, response.text
    [warning] = response.json()["diagnostics"]
    assert (warning["code"], warning["severity"], warning["pointer"]) == (
        "c2y_offering_registry_unknown", "warning", "/offering/registry",
    )


async def test_parse_refuses_a_document_with_errors_as_a_located_problem(api_client):
    response = await api_client.post(
        f"{LANGUAGE}/parse", content=golden("invalid", "offering_plans").encode(), headers=YAML,
    )

    assert response.status_code == 422, response.text
    assert response.headers["content-type"].split(";")[0] == PROBLEM_JSON
    body = response.json()
    assert body["code"] == "composition_invalid"
    assert body["status"] == 422
    [diagnostic] = body["diagnostics"]
    assert diagnostic["code"] == "c2y_offering_shape"
    assert diagnostic["pointer"] == "/offering/plans"
    assert diagnostic["span"] == {"line": 12, "column": 3, "end_line": 14, "end_column": 1}


# ------------------------------------------------------------------- serialise


@pytest.mark.parametrize("source", PLAIN_VALID, ids=lambda path: path.stem)
async def test_the_parsed_model_serialises_to_the_golden_canonical_bytes(api_client, registries, source):
    parsed = await api_client.post(f"{LANGUAGE}/parse", content=source.read_bytes(), headers=YAML)
    assert parsed.status_code == 200, parsed.text

    response = await api_client.post(
        f"{LANGUAGE}/serialise", content=json.dumps(parsed.json()["document"]).encode(),
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].split(";")[0] == "application/yaml"
    assert response.content == sibling(source, ".canonical.yaml").read_bytes()


async def test_serialise_refuses_a_bad_offering_by_pointer_and_without_a_span(api_client):
    document = text.document(text.parse(MINIMAL)) | {"offering": {}}

    response = await api_client.post(
        f"{LANGUAGE}/serialise", content=json.dumps(document).encode(), headers={"content-type": "application/json"},
    )

    assert response.status_code == 422, response.text
    assert response.headers["content-type"].split(";")[0] == PROBLEM_JSON
    body = response.json()
    assert body["code"] == "composition_invalid"
    [diagnostic] = body["diagnostics"]
    assert diagnostic["code"] == "c2y_offering_sources"
    assert (diagnostic["path"], diagnostic["pointer"], diagnostic["span"]) == ("offering", "/offering", None)


@pytest.mark.parametrize("body", [b"{", b'{"composition": "a", "composition": "b"}', b'{"x": NaN}'])
async def test_serialise_refuses_json_it_cannot_read(api_client, body):
    response = await api_client.post(f"{LANGUAGE}/serialise", content=body, headers={"content-type": "application/json"})

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "composition_invalid"
    assert response.json()["diagnostics"][0]["code"] == "c2y_syntax"


# ------------------------------------------------------------------- diff


async def diff(client, before: str, after: str):
    return await client.post(f"{LANGUAGE}/diff", json={"before": before, "after": after})


async def test_diff_of_two_goldens_lists_their_changes(api_client, registries):
    before, after = golden("valid", "16_offering_url"), golden("valid", "17_offering_registry_unknown")

    response = await diff(api_client, before, after)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "general": [],
        "sections": [
            {"key": "binding", "label": "Binding", "entries": []},
            {"key": "values", "label": "Values", "entries": []},
            {"key": "offering", "label": "Offering", "entries": [{
                "name": "source", "kind": "changed", "changes": [
                    {"path": "url", "before": "https://pricings.example.org/shop/pricing.yml", "after": None},
                    {"path": "sphere", "before": None, "after": "isa/shop"},
                    {"path": "registry", "before": None, "after": "lab"},
                ],
            }]},
        ],
        "totals": {"added": 0, "removed": 0, "changed": 1},
        "isEmpty": False,
        "comparison": {
            "comparable": True, "problemRefChanged": False, "compilationChanged": False,
            "valueStatus": {"before": "declared", "after": "declared"},
        },
    }


async def test_diff_answers_what_the_library_finds(api_client):
    before = MINIMAL
    after = MINIMAL.replace("version: 0.1.0", "version: 0.2.0").replace("candidate: greeter", "candidate: welcomer")

    response = await diff(api_client, before, after)

    assert response.status_code == 200, response.text
    found = response.json()
    assert found == composition_diff.diff(text.parse(before), text.parse(after))
    # The label differs between versions by definition and is not reported.
    assert found["general"] == []
    assert found["sections"][0]["entries"] == [{
        "name": "greet", "kind": "changed",
        "changes": [{"path": "candidate", "before": "greeter", "after": "welcomer"}],
    }]


async def test_diff_refuses_an_invalid_side_naming_the_document(api_client):
    response = await diff(api_client, MINIMAL, golden("invalid", "task_unbound"))

    assert response.status_code == 422, response.text
    assert response.headers["content-type"].split(";")[0] == PROBLEM_JSON
    body = response.json()
    assert body["code"] == "composition_invalid"
    assert body["diagnostics"]
    assert {item["document"] for item in body["diagnostics"]} == {"after"}
    assert body["diagnostics"][0]["code"] == "c2y_task_unbound"


@pytest.mark.parametrize("payload", [{"before": "a: 1"}, {"before": "a", "after": "b", "extra": 1}, {"before": 1, "after": "b"}, []])
async def test_diff_refuses_a_request_of_the_wrong_shape(api_client, payload):
    response = await api_client.post(f"{LANGUAGE}/diff", json=payload)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "validation_error"


async def test_diff_refuses_a_side_longer_than_a_document(api_client):
    response = await diff(api_client, MINIMAL, MINIMAL + "#" * LIMIT)

    assert response.status_code == 413, response.text
    assert response.json()["limitBytes"] == LIMIT


# ------------------------------------------------------------------- schema


async def test_the_schema_is_the_shipped_one_with_an_etag(api_client):
    response = await api_client.get(f"{LANGUAGE}/schema")

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].split(";")[0] == "application/schema+json"
    assert response.json() == text.schema()
    assert response.content == text.schema_text().encode("utf-8")
    assert response.headers["etag"].startswith('"sha256-')
    assert response.headers["cache-control"] == "public, max-age=3600"

    by_version = await api_client.get(f"{LANGUAGE}/schema", params={"syntaxVersion": "1.0"})
    assert by_version.content == response.content
    again = await api_client.get(f"{LANGUAGE}/schema", headers={"If-None-Match": response.headers["etag"]})
    assert again.status_code == 304
    unknown = await api_client.get(f"{LANGUAGE}/schema", params={"syntaxVersion": "9.9"})
    assert unknown.status_code == 422


# ------------------------------------------------------------------- limits


def padded(size: int) -> bytes:
    """The minimal document, padded with a comment to exactly ``size`` bytes."""
    body = MINIMAL.encode("utf-8")
    filler = size - len(body) - 2
    return body + b"#" + b"x" * filler + b"\n"


async def test_a_document_of_the_limit_is_read_and_one_byte_more_is_413(api_client):
    at_limit, past = padded(LIMIT), padded(LIMIT + 1)
    assert (len(at_limit), len(past)) == (LIMIT, LIMIT + 1)

    accepted = await lint(api_client, at_limit)
    refused = await lint(api_client, past)

    assert accepted.status_code == 200, accepted.text
    assert accepted.json() == {"valid": True, "diagnostics": []}
    assert refused.status_code == 413, refused.text
    assert refused.headers["content-type"].split(";")[0] == PROBLEM_JSON
    assert refused.json()["code"] == "payload_too_large"
    assert refused.json()["limitBytes"] == LIMIT


@pytest.mark.parametrize("operation", ["validate", "parse"])
async def test_a_yaml_service_refuses_another_media_type(api_client, operation):
    response = await api_client.post(f"{LANGUAGE}/{operation}", json={"composition": "x"})

    assert response.status_code == 415, response.text
    assert response.json()["code"] == "unsupported_media_type"


@pytest.mark.parametrize("media_type", ["text/yaml", "application/x-yaml", "application/yaml; charset=utf-8"])
async def test_every_yaml_media_type_is_read(api_client, media_type):
    response = await api_client.post(f"{LANGUAGE}/validate", content=MINIMAL.encode(), headers={"content-type": media_type})

    assert response.status_code == 200, response.text


async def test_serialise_refuses_yaml(api_client):
    response = await api_client.post(f"{LANGUAGE}/serialise", content=MINIMAL.encode(), headers=YAML)

    assert response.status_code == 415, response.text


async def test_a_request_that_finds_every_language_slot_taken_is_429_busy(api_client, monkeypatch):
    monkeypatch.setattr(get_settings(), "composition_language_slots", 1)

    async with language_slot():
        refused = await lint(api_client, MINIMAL)
    served = await lint(api_client, MINIMAL)

    assert refused.status_code == 429, refused.text
    assert refused.headers["content-type"].split(";")[0] == PROBLEM_JSON
    assert refused.json()["code"] == "composition_busy"
    assert refused.headers["Retry-After"] == "1"
    assert served.status_code == 200, served.text


# ------------------------------------------------------------------- the deployment's registries


def on_registry(document: str, registry: str) -> str:
    return document.replace("values: {}", f"values: {{}}\noffering: {{sphere: isa/shop, registry: {registry}}}")


async def test_an_offering_on_a_configured_registry_is_valid_and_on_another_a_warning(api_client, registries):
    source = on_registry(MINIMAL, "onprem")

    without = await lint(api_client, source)
    registries(onprem="https://sphere.example")
    configured = await lint(api_client, source)

    assert without.status_code == configured.status_code == 200
    assert without.json()["valid"] is True
    assert [(item["code"], item["severity"]) for item in without.json()["diagnostics"]] == [
        ("c2y_offering_registry_unknown", "warning"),
    ]
    assert configured.json() == {"valid": True, "diagnostics": []}
    assert "sphere.example" not in without.text + configured.text


async def test_a_from_on_an_unconfigured_registry_is_an_error(api_client, registries):
    source = MINIMAL.replace(
        "greet: {candidate: greeter}",
        "greet: {candidate: greeter, from: {sphere: acme/greeting, registry: onprem, version: v1, plan: Basic}}",
    )

    without = await lint(api_client, source)
    registries(onprem="https://sphere.example")
    configured = await lint(api_client, source)
    parsed = await api_client.post(f"{LANGUAGE}/parse", content=source.encode(), headers=YAML)

    assert without.json()["valid"] is False
    assert [item["code"] for item in without.json()["diagnostics"]] == ["c2y_from_registry_unknown"]
    assert configured.json() == {"valid": True, "diagnostics": []}
    assert parsed.status_code == 200, parsed.text
    for response in (without, configured, parsed):
        assert "sphere.example" not in response.text


# ------------------------------------------------------------------- who may call


async def test_anybody_and_any_account_are_served(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)

    anonymous = await lint(api_client, MINIMAL)
    signed_in = await lint(api_client, MINIMAL, headers)

    assert anonymous.status_code == signed_in.status_code == 200
    assert anonymous.json() == signed_in.json() == {"valid": True, "diagnostics": []}


async def test_an_api_key_needs_compositions_read(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    without = await make_key(api_client, headers, ["problems:read"])
    with_it = await make_key(api_client, headers, ["compositions:read"])

    refused = await lint(api_client, MINIMAL, without)
    served = await lint(api_client, MINIMAL, with_it)
    schema = await api_client.get(f"{LANGUAGE}/schema", headers=without)

    assert refused.status_code == 403, refused.text
    assert refused.json()["code"] == "insufficient_api_key_permission"
    assert refused.json()["missing_permissions"] == ["compositions:read"]
    assert served.status_code == 200, served.text
    assert schema.status_code == 200, schema.text
