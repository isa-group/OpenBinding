"""The authoring surface, served: what the Studio's editor asks of a document, over the wire.

The editor has no YAML parser of its own, by decision, so everything it needs to know about a
document is an endpoint: read it into the canonical document a form edits, write a form's
document back as text, compile it and see the digests that identify it, download it as a
package, import one, and read the tables of the language a form shows as defaults.

Most of these answer 200 whatever the document says, as ``/validate`` does, because the
question always has an answer; ``/package`` and ``/import`` answer 422 when there is nothing
to hand back, and the tests below pin which is which.

The compile and import tests run the container's compiler through the BIM port, so they need
the toolchain installed -- they run where the gateway runs.
"""

from __future__ import annotations

import hashlib
import io
import json
import threading
import zipfile

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.composition.model import TEMPLATES
from openbinding_gateway.integrations import bim, packages
from openbinding_gateway.routes import compositions as routes
from openbinding_gateway.routes.compositions import MAX_DOCUMENT_BYTES, MAX_SOURCE_CHARS

FIXTURES = REPO_ROOT / "openbinding-gateway" / "tests" / "composition" / "fixtures"
EXAMPLES = REPO_ROOT / "examples"

#: A draft: valid, and incomplete because task ``pay`` has no market yet.
DRAFT = """\
composition: fleet
version: "1.0.0"
properties:
  cost:
    unit: USD/month
    direction: minimize
    domain: {min: 0, max: 10000}
    aggregate:
      sequence: sum
      parallel: sum
      exclusive: weightedSum
      repeat: scale
      selection: sum
  availability: {template: availability}
tasks:
  pick: {open: true, requires: service/pick}
  pay: {open: true, requires: service/pay}
workflow:
  sequence:
    - {task: pick}
    - {task: pay}
candidates:
  rows:
    - id: c_pick
      provides: service/pick
      properties: {cost: 10, availability: 0.99}
goals:
  - property: cost
    normalize: {min: 0, max: 10000}
"""

#: The same composition, finished.
COMPLETE = DRAFT.replace(
    "      properties: {cost: 10, availability: 0.99}",
    "      properties: {cost: 10, availability: 0.99}\n"
    "    - id: c_pay\n"
    "      provides: service/pay\n"
    "      properties: {cost: 20, availability: 0.999}",
)

#: Probabilities that do not sum to one: not a draft, an error.
INCOHERENT = DRAFT.replace(
    "  sequence:\n    - {task: pick}\n    - {task: pay}",
    "  sequence:\n    - exclusive:\n        id: choice\n        branches:\n"
    "          - {probability: 0.7, flow: {task: pick}}\n"
    "          - {probability: 0.2, flow: {task: pay}}",
)


def _toolchain() -> None:
    try:
        import bim_core  # noqa: F401, PLC0415
    except ImportError:
        pytest.skip("the BIM toolchain is not installed in this environment")


def _package(directory: str) -> bytes:
    path = EXAMPLES / directory
    if not path.is_dir():
        pytest.skip(f"{path} is not mounted in this environment")
    return packages.zip_directory(path)


def _zip(files: dict[str, bytes]) -> bytes:
    return packages.zip_files(files)


# ---------------------------------------------------------------------------- parse


async def test_parse_returns_the_document_as_written_and_as_canonical(api_client) -> None:
    response = await api_client.post("/v1/compositions/parse", json={"source": COMPLETE})
    assert response.status_code == 200
    body = response.json()
    assert (body["valid"], body["complete"], body["diagnostics"]) == (True, True, [])
    # As written: the template is still a template, and the key order is the author's.
    assert body["written"]["properties"]["availability"] == {"template": "availability"}
    assert list(body["written"]) == ["composition", "version", "properties", "tasks",
                                     "workflow", "candidates", "goals"]
    # Canonical: the template expanded into the policy it stands for.
    document = body["document"]
    assert document["composition"] == "fleet"
    assert "template" not in document["properties"]["availability"]
    assert document["properties"]["availability"]["aggregate"]["sequence"] == "product"


async def test_parse_gives_each_property_its_neutral_and_where_it_came_from(api_client) -> None:
    """What a form shows where the author left the neutral blank."""
    body = (await api_client.post("/v1/compositions/parse", json={"source": COMPLETE})).json()
    assert body["neutrals"] == {
        "cost": {"value": 0.0, "source": "inferred"},
        "availability": {"value": 1.0, "source": "inferred"},
    }


async def test_parse_reads_a_draft_and_still_hands_back_its_document(api_client) -> None:
    """A draft is something to keep editing, so a form needs its document too."""
    body = (await api_client.post("/v1/compositions/parse", json={"source": DRAFT})).json()
    assert (body["valid"], body["complete"]) == (True, False)
    assert body["document"]["tasks"]["pay"] == {"open": True, "requires": "service/pay"}
    assert {item["severity"] for item in body["diagnostics"]} == {"incomplete"}


async def test_parse_of_an_error_hands_back_the_written_document_to_fix(api_client) -> None:
    """A form can open a broken document; only the canonical one needs it to be valid."""
    response = await api_client.post("/v1/compositions/parse", json={"source": INCOHERENT})
    assert response.status_code == 200
    body = response.json()
    assert (body["valid"], body["document"], body["neutrals"]) == (False, None, None)
    assert body["written"]["workflow"]["sequence"][0]["exclusive"]["id"] == "choice"
    assert body["diagnostics"][0]["code"] == "c2y_exclusive_probabilities"


async def test_an_empty_buffer_is_a_document_like_any_other(api_client) -> None:
    """Not a malformed request: the editor sends what it holds, and the answer says what it is."""
    for route in ("validate", "parse", "compile"):
        response = await api_client.post(f"/v1/compositions/{route}", json={"source": ""})
        assert response.status_code == 200, route
        assert response.json()["valid"] is False


async def test_an_alias_bomb_is_refused_where_it_starts(api_client) -> None:
    """Refused at the first alias, with nothing expanded.

    The reader this replaced accepted this document, and paid for the expansion in its span
    locator -- seconds of it -- as soon as anything else in the text was refused.
    """
    bomb = COMPLETE + (
        "studio:\n"
        "  a: &a [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]\n"
        "  b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\n"
        "  c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\n"
        "  d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]\n"
        "  e: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]\n"
    )
    for route in ("validate", "parse", "compile"):
        body = (await api_client.post(f"/v1/compositions/{route}", json={"source": bomb})).json()
        (found,) = body["diagnostics"]
        assert found["code"] == "c2y_syntax"
        assert "alias" in found["message"]
        assert found["span"] is not None


async def test_a_source_past_the_limit_is_a_malformed_request(api_client) -> None:
    padding = "#" * (MAX_SOURCE_CHARS + 1)
    for route in ("validate", "parse", "compile", "package"):
        response = await api_client.post(f"/v1/compositions/{route}", json={"source": padding})
        assert response.status_code == 422, route
        # The request's own refusal, not the document's: a comment is not a composition, and
        # /package would refuse it as one even with no limit at all.
        assert response.json()["code"] == "validation_error", route


async def test_a_draft_whose_neutral_has_no_bound_yet_still_parses(api_client) -> None:
    """The throughput template before its maximum is typed: incomplete, not unreadable."""
    draft = COMPLETE.replace(
        "  availability: {template: availability}",
        "  availability: {template: availability}\n  throughput: {template: throughput}",
    )
    body = (await api_client.post("/v1/compositions/parse", json={"source": draft})).json()
    assert (body["valid"], body["complete"]) == (True, False)
    assert body["neutrals"]["throughput"] == {"value": None, "source": "unbounded"}
    assert "c2y_property_neutral" in {item["code"] for item in body["diagnostics"]}


# ------------------------------------------------------------------------ serialise


async def test_the_written_document_round_trips_changing_nothing_but_the_edit(api_client) -> None:
    """The editor's Visual mode: edit ``written``, send it back, keep the template."""
    parsed = (await api_client.post("/v1/compositions/parse", json={"source": COMPLETE})).json()
    written = parsed["written"]
    written["properties"]["cost"]["unit"] = "EUR/month"
    response = await api_client.post("/v1/compositions/serialise", json={"document": written})
    assert response.status_code == 200
    body = response.json()
    assert (body["valid"], body["complete"], body["canonical"]) == (True, True, False)
    assert "template: availability" in body["source"]
    assert "EUR/month" in body["source"]
    again = (await api_client.post("/v1/compositions/parse", json={"source": body["source"]})).json()
    assert again["written"] == written
    assert body["document"] == again["document"]
    assert body["neutrals"] == parsed["neutrals"]


@pytest.mark.parametrize("form", ["written", "canonical"])
async def test_a_title_holding_u0085_comes_back_as_it_was_sent(api_client, form: str) -> None:
    """Written raw, U+0085 read back as a space; written escaped, it reads back as itself."""
    parsed = (await api_client.post("/v1/compositions/parse", json={"source": COMPLETE})).json()
    written = parsed["written"]
    written["title"] = "Fleet\u0085management"
    response = await api_client.post(
        "/v1/compositions/serialise", json={"document": written, "form": form},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True
    assert body["document"]["title"] == "Fleet\u0085management"


async def test_a_document_that_would_write_too_much_text_is_refused_before_writing(api_client) -> None:
    """Block YAML indents by depth: forty kilobytes of JSON nested deep write megabytes."""
    parsed = (await api_client.post("/v1/compositions/parse", json={"source": COMPLETE})).json()
    written = parsed["written"]
    node: object = [0] * 20_000
    for _ in range(55):
        node = {"a": node}
    written["studio"] = node
    response = await api_client.post("/v1/compositions/serialise", json={"document": written})
    assert response.status_code == 422
    assert response.json()["code"] == "composition_too_large"


async def test_a_long_string_deep_in_a_document_cannot_write_past_the_bound(api_client) -> None:
    """Folded at the line width, every word of it costs a line indented by its depth."""
    parsed = (await api_client.post("/v1/compositions/parse", json={"source": COMPLETE})).json()
    written = parsed["written"]
    node: object = " ".join(["a"] * 50_000)
    for _ in range(55):
        node = {"a": node}
    written["studio"] = node
    response = await api_client.post("/v1/compositions/serialise", json={"document": written})
    assert response.status_code == 422
    assert response.json()["code"] == "composition_too_large"


async def test_the_canonical_form_writes_the_composition_it_means(api_client) -> None:
    parsed = (await api_client.post("/v1/compositions/parse", json={"source": COMPLETE})).json()
    response = await api_client.post(
        "/v1/compositions/serialise", json={"document": parsed["written"], "form": "canonical"},
    )
    body = response.json()
    assert (body["valid"], body["canonical"]) == (True, True)
    assert "template" not in body["source"]
    again = (await api_client.post("/v1/compositions/parse", json={"source": body["source"]})).json()
    assert again["document"] == parsed["document"]


async def test_a_document_a_form_broke_still_comes_back_as_text_located(api_client) -> None:
    """So the editor can always switch from its form to its text, where the markers are."""
    parsed = (await api_client.post("/v1/compositions/parse", json={"source": COMPLETE})).json()
    written = parsed["written"]
    written["properties"]["cost"]["neutral"] = 50000
    response = await api_client.post("/v1/compositions/serialise", json={"document": written})
    assert response.status_code == 200
    body = response.json()
    assert (body["valid"], body["document"]) == (False, None)
    assert "neutral: 50000" in body["source"]
    (found,) = body["diagnostics"]
    assert (found["code"], found["path"]) == ("c2y_property_neutral", "properties.cost.neutral")
    line = body["source"].splitlines()[found["span"]["line"] - 1]
    assert "neutral" in line


@pytest.mark.parametrize(
    "text",
    ['{"document": {"composition": "a", "composition": "b"}}', '{"document": {"x": NaN}}'],
)
async def test_the_body_is_read_as_strict_json(api_client, text: str) -> None:
    """A duplicated member or a NaN is refused, not kept last or kept at all."""
    response = await api_client.post(
        "/v1/compositions/serialise", content=text, headers={"content-type": "application/json"},
    )
    assert response.status_code == 200
    (found,) = response.json()["diagnostics"]
    assert found["code"] == "c2y_syntax"


async def test_a_number_too_large_to_be_finite_is_refused_by_path(api_client) -> None:
    """``1e999`` is a JSON number that reads as infinity: the walk names it by path."""
    parsed = (await api_client.post("/v1/compositions/parse", json={"source": COMPLETE})).json()
    text = json.dumps({"document": parsed["written"]}).replace(
        '"availability": {"template": "availability"}',
        '"availability": {"template": "availability", "neutral": 1e999}',
    )
    response = await api_client.post(
        "/v1/compositions/serialise", content=text, headers={"content-type": "application/json"},
    )
    body = response.json()
    assert body["source"] is None
    (found,) = body["diagnostics"]
    assert (found["code"], found["path"]) == ("c2y_schema", "properties.availability.neutral")


async def test_a_body_past_the_document_limit_is_a_malformed_request(api_client) -> None:
    response = await api_client.post(
        "/v1/compositions/serialise",
        json={"document": {"composition": "x" * (MAX_DOCUMENT_BYTES + 1)}},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "document_too_large"


async def test_a_document_nested_past_the_bound_is_answered_not_crashed(api_client) -> None:
    """The walk that refuses it uses a stack, so the depth that would exhaust the readers is
    a diagnostic rather than a 500."""
    parsed = (await api_client.post("/v1/compositions/parse", json={"source": COMPLETE})).json()
    document = parsed["document"]
    node: dict = {"task": "pick"}
    for _ in range(200):
        node = {"sequence": [node]}
    document["workflow"] = node
    response = await api_client.post("/v1/compositions/serialise", json={"document": document})
    assert response.status_code == 200
    (found,) = response.json()["diagnostics"]
    assert found["code"] == "c2y_schema"
    assert "deeper than" in found["message"]


async def test_serialise_refuses_what_it_does_not_understand(api_client) -> None:
    response = await api_client.post(
        "/v1/compositions/serialise", json={"document": {}, "source": "x"},
    )
    assert response.status_code == 422


# -------------------------------------------------------------------------- compile


async def test_a_complete_composition_compiles_to_a_package_and_its_digests(api_client) -> None:
    _toolchain()
    response = await api_client.post("/v1/compositions/compile", json={"source": COMPLETE})
    assert response.status_code == 200
    body = response.json()
    assert body["compiled"] is True
    assert body["container_diagnostics"] == []
    package = body["package"]
    assert set(package["files"]) == {
        "application.json", "candidates.json", "instance.json", "optimization.json",
    }
    assert package["files"]["instance.json"]["kind"] == "Instance"
    for name in ("ir_digest", "compilation_digest", "package_digest"):
        assert package[name].startswith("sha256-")
    assert body["provenance"] == {"substitutions": []}


async def test_the_guiding_case_compiles_to_the_problem_the_corpus_package_is(api_client) -> None:
    """The F1 gate, end to end over HTTP: FMS v1 as text, and ``examples/demo/13_fms``.

    Two independent routes to the container -- the composition through this endpoint, the
    hand-written package straight through the BIM port -- give one IR digest.
    """
    _toolchain()
    source = (FIXTURES / "fleet-management-v1.c2y.yaml").read_text(encoding="utf-8")
    body = (await api_client.post("/v1/compositions/compile", json={"source": source})).json()
    assert body["compiled"] is True, body
    reference = await bim.abim().compile(_package("demo/13_fms"), [])
    assert body["package"]["ir_digest"] == reference["irDigest"]


def _with_classical_market(properties: int, candidates: int) -> str:
    """COMPLETE plus quantum-only properties no classical candidate states: substitutions."""
    extra = "".join(
        f"  q{index}: {{template: cost, applies_to: quantum}}\n" for index in range(properties)
    )
    rows = "".join(
        f"    - {{id: k{index}, provides: service/pay, domain: classical, properties: {{cost: 1, availability: 0.9}}}}\n"
        for index in range(candidates)
    )
    return COMPLETE.replace("tasks:\n", extra + "tasks:\n", 1).replace("goals:\n", rows + "goals:\n", 1)


async def test_compile_records_every_neutral_written_where_a_property_does_not_apply(api_client) -> None:
    _toolchain()
    source = _with_classical_market(properties=1, candidates=1)
    body = (await api_client.post("/v1/compositions/compile", json={"source": source})).json()
    assert body["compiled"] is True, body
    assert body["provenance"]["substitutions"] == [{
        "candidate": "k0", "property": "q0", "value": 0.0, "reason": "domain_mismatch",
        "candidateDomain": "classical", "propertyDomain": "quantum",
        "neutralSource": "inferred",
        "inferredFrom": {"sequence": "sum", "domain": {"kind": "real"}},
    }]
    assert body["package"]["files"]["candidates.json"]["spec"]["candidates"]["k0"]["features"]["q0"] == 0.0


async def test_a_composition_that_would_emit_past_the_bounds_is_refused_before_emitting(api_client) -> None:
    """Candidates times inapplicable properties: a short source, a long package."""
    source = _with_classical_market(properties=101, candidates=100)
    for route in ("compile", "package"):
        response = await api_client.post(f"/v1/compositions/{route}", json={"source": source})
        assert response.status_code == 422, route
        assert response.json()["code"] == "composition_too_large", route


async def test_a_draft_does_not_compile_and_says_why(api_client) -> None:
    body = (await api_client.post("/v1/compositions/compile", json={"source": DRAFT})).json()
    assert (body["compiled"], body["valid"], body["complete"]) == (False, True, False)
    assert body["package"] is None
    assert "c2y_candidate_unmatched" in {item["code"] for item in body["diagnostics"]}


async def test_what_only_the_container_refuses_comes_back_addressed_to_the_package(api_client) -> None:
    """A candidate missing the goal's property: no Studio check names it yet.

    The container refuses it as ``missing_feature``, against the generated catalog and a JSON
    pointer -- 200, not compiled, and the container's own diagnostics.
    """
    _toolchain()
    missing = COMPLETE.replace(
        "      properties: {cost: 20, availability: 0.999}",
        "      properties: {availability: 0.999}",
    )
    response = await api_client.post("/v1/compositions/compile", json={"source": missing})
    assert response.status_code == 200
    body = response.json()
    assert (body["compiled"], body["valid"], body["complete"]) == (False, True, True)
    assert body["container_diagnostics"], body
    assert all("code" in item and "message" in item for item in body["container_diagnostics"])


# -------------------------------------------------------------------------- package


async def test_the_package_is_the_canonical_archive_compile_reported(api_client) -> None:
    """Its SHA-256 is the ``package_digest`` of ``/compile``: anyone can check one against
    the other."""
    _toolchain()
    response = await api_client.post("/v1/compositions/package", json={"source": COMPLETE})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.bim+zip"
    assert response.headers["content-disposition"] == 'attachment; filename="fleet.bim.zip"'
    archive = response.content
    expected = hashlib.sha256(archive).hexdigest()
    assert response.headers["digest"] == f"sha-256={expected}"
    compiled = (await api_client.post("/v1/compositions/compile", json={"source": COMPLETE})).json()
    assert compiled["package"]["package_digest"] == f"sha256-{expected}"
    assert response.headers["etag"] == f'"sha256-{expected}"'
    with zipfile.ZipFile(io.BytesIO(archive)) as handle:
        names = sorted(handle.namelist())
        assert names == sorted(compiled["package"]["files"])
        assert "provenance.json" not in names
        for name in names:
            assert json.loads(handle.read(name)) == compiled["package"]["files"][name]


def test_a_filename_is_built_only_from_an_id_matched_whole() -> None:
    """The schema's pattern lets ``"fleet\\n"`` through (``$`` matches before a final
    newline); a header built from it would carry a line break."""
    from openbinding_gateway.composition.text import parse  # noqa: PLC0415

    composition = parse(COMPLETE)
    assert routes._filename(composition) == "fleet.bim.zip"
    from dataclasses import replace  # noqa: PLC0415

    assert routes._filename(replace(composition, composition="fleet\n")) == "composition.bim.zip"


async def test_the_same_source_downloads_as_the_same_bytes(api_client) -> None:
    _toolchain()
    first = await api_client.post("/v1/compositions/package", json={"source": COMPLETE})
    second = await api_client.post("/v1/compositions/package", json={"source": COMPLETE})
    assert first.content == second.content


@pytest.mark.parametrize(
    ("source", "code"),
    [(DRAFT, "incomplete_composition"), (INCOHERENT, "invalid_composition")],
)
async def test_there_is_no_package_to_download_and_the_answer_is_422(
    api_client, source: str, code: str,
) -> None:
    """A download has bytes or it has nothing; a 200 with no archive would save as a broken
    file."""
    response = await api_client.post("/v1/compositions/package", json={"source": source})
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == code
    assert body["diagnostics"]


# --------------------------------------------------------------------------- import


@pytest.mark.parametrize("example", ["demo/16_json_complete", "demo/15_bpmn_complete"])
async def test_a_corpus_package_imports_exactly(api_client, example: str) -> None:
    """The F1 gate for one uploaded package: it compiles back to the IR digest it was.

    The BPMN one is read by delegation, from the compilation the upload already had.
    """
    _toolchain()
    response = await api_client.post(
        "/v1/compositions/import", content=_package(example),
        headers={"content-type": "application/vnd.bim+zip"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["valid"], body["complete"]) == (True, True)
    assert body["round_trip"]["exact"] is True
    assert body["round_trip"]["ir_digest"] == body["ir_digest"]
    parsed = (await api_client.post("/v1/compositions/parse", json={"source": body["source"]})).json()
    assert parsed["document"] == body["document"]


async def test_the_bpmn_package_and_its_json_twin_import_as_one_problem(api_client) -> None:
    _toolchain()
    uploads, trips = set(), set()
    for example in ("demo/15_bpmn_complete", "demo/16_json_complete"):
        response = await api_client.post(
            "/v1/compositions/import", content=_package(example),
            headers={"content-type": "application/vnd.bim+zip"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["round_trip"]["exact"] is True
        assert body["round_trip"]["ir_digest"] is not None
        uploads.add(body["ir_digest"])
        trips.add(body["round_trip"]["ir_digest"])
    assert len(uploads) == 1 and uploads == trips


async def test_a_body_that_is_not_a_package_media_type_is_415(api_client) -> None:
    response = await api_client.post(
        "/v1/compositions/import", content=b"{}", headers={"content-type": "application/json"},
    )
    assert response.status_code == 415
    assert response.json()["code"] == "unsupported_media_type"


async def test_a_package_past_the_size_limit_is_413(api_client, monkeypatch) -> None:
    monkeypatch.setattr(routes, "_max_compressed", lambda: 64)
    response = await api_client.post(
        "/v1/compositions/import", content=b"x" * 65,
        headers={"content-type": "application/vnd.bim+zip"},
    )
    assert response.status_code == 413
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "payload_too_large"


async def test_an_import_that_is_valid_and_incomplete_is_a_200_with_no_round_trip(api_client) -> None:
    """A criterion with no range over an open domain: the container compiles it; the
    language calls it incomplete, and the emitter could not write it back."""
    _toolchain()
    files = packages.read_files(_package("demo/01_simple_seq"))
    optimization = json.loads(files["optimization.json"])
    optimization["spec"]["criteria"][0].pop("normalize")
    files["optimization.json"] = json.dumps(optimization).encode("utf-8")
    response = await api_client.post(
        "/v1/compositions/import", content=_zip(files),
        headers={"content-type": "application/vnd.bim+zip"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["valid"], body["complete"], body["round_trip"]) == (True, False, None)
    assert "c2y_goal_range" in {item["code"] for item in body["diagnostics"]}


async def test_an_import_with_an_unreached_task_still_says_whether_it_is_exact(api_client) -> None:
    """Incomplete, and still something the emitter can write: the round trip is attempted."""
    _toolchain()
    files = packages.read_files(_package("demo/01_simple_seq"))
    application = json.loads(files["application.json"])
    application["spec"]["tasks"]["t4"] = "service/t3"
    files["application.json"] = json.dumps(application).encode("utf-8")
    response = await api_client.post(
        "/v1/compositions/import", content=_zip(files),
        headers={"content-type": "application/vnd.bim+zip"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["valid"], body["complete"]) == (True, False)
    assert {item["code"] for item in body["diagnostics"]} == {"c2y_task_unreached"}
    assert body["round_trip"]["exact"] is True


def test_the_import_is_held_to_the_json_ceiling_not_an_upload_routes() -> None:
    """An upload route's ceiling is 512 MiB, buffered whole before the package limit is
    compared when no Content-Length is sent."""
    from openbinding_gateway.security.bodylimit import is_upload  # noqa: PLC0415

    assert not is_upload("POST", "/v1/compositions/import")


async def test_a_package_too_deep_for_the_toolchain_is_refused_not_crashed(api_client, monkeypatch) -> None:
    async def recursing(archive: bytes) -> dict:
        raise RecursionError

    monkeypatch.setattr(routes, "_port_compile", recursing)
    response = await api_client.post(
        "/v1/compositions/import", content=b"PK\x03\x04",
        headers={"content-type": "application/vnd.bim+zip"},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_package"


async def test_an_archive_that_is_not_a_package_is_refused_as_one(api_client) -> None:
    _toolchain()
    response = await api_client.post(
        "/v1/compositions/import", content=b"not a zip at all",
        headers={"content-type": "application/vnd.bim+zip"},
    )
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "invalid_package"


async def test_a_package_the_compiler_refuses_is_refused_with_its_diagnostics(api_client) -> None:
    """A README beside the documents: the compiler refuses any entry the manifest omits."""
    _toolchain()
    files = packages.read_files(_package("demo/01_simple_seq"))
    files["README.md"] = b"notes"
    response = await api_client.post(
        "/v1/compositions/import", content=_zip(files),
        headers={"content-type": "application/vnd.bim+zip"},
    )
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "invalid_instance"
    assert body["diagnostics"]


async def test_a_package_the_language_cannot_express_is_refused_by_name(api_client) -> None:
    """A criterion whose id is not its feature's: valid BIM, and not something this
    version of the language writes."""
    _toolchain()
    files = packages.read_files(_package("demo/01_simple_seq"))
    optimization = json.loads(files["optimization.json"])
    optimization["spec"]["criteria"][0]["id"] = "speed"
    files["optimization.json"] = json.dumps(optimization).encode("utf-8")
    response = await api_client.post(
        "/v1/compositions/import", content=_zip(files),
        headers={"content-type": "application/vnd.bim+zip"},
    )
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "inexpressible_package"
    assert "speed" in body["detail"]


async def test_an_import_that_reads_as_an_invalid_composition_hands_back_its_text(
    api_client, monkeypatch,
) -> None:
    """The author can open the text and fix it, so this is a 200 with located diagnostics,
    not a 422 whose spans point into a source it does not carry."""
    _toolchain()
    from openbinding_gateway.composition.text import parse  # noqa: PLC0415

    broken = INCOHERENT
    monkeypatch.setattr(routes, "_imported", lambda archive, ir: (parse(COMPLETE), broken))
    response = await api_client.post(
        "/v1/compositions/import", content=_package("demo/01_simple_seq"),
        headers={"content-type": "application/vnd.bim+zip"},
    )
    assert response.status_code == 200
    body = response.json()
    assert (body["valid"], body["source"], body["round_trip"]) == (False, broken, None)
    assert body["diagnostics"][0]["span"] is not None


# ------------------------------------------------------------------------ capacity


async def test_a_full_pool_answers_503_with_retry_after(api_client, monkeypatch) -> None:
    """A bounded wait, then an answer the client can act on -- not a queue without end."""
    full = threading.BoundedSemaphore(1)
    full.acquire()
    monkeypatch.setattr(routes, "_READING", full)
    response = await api_client.post("/v1/compositions/validate", json={"source": COMPLETE})
    assert response.status_code == 503
    assert response.headers["retry-after"] == "1"
    assert response.json()["code"] == "composition_busy"


# ------------------------------------------------------------------ language, schema


async def test_the_language_tables_come_from_the_code_that_applies_them(api_client) -> None:
    response = await api_client.get("/v1/compositions/language")
    assert response.status_code == 200
    body = response.json()
    assert body["language"] == "composition2yaml/v1"
    assert set(body["templates"]) == set(TEMPLATES)
    assert body["templates"]["cost"]["neutral"] == 0.0
    assert body["templates"]["availability"] == {
        "direction": "maximize",
        "aggregate": {
            "sequence": "product", "parallel": "product", "exclusive": "weightedProduct",
            "repeat": "power", "selection": "product",
        },
        "domain": "ratio", "neutral": 1.0, "neutral_from": None,
    }
    # throughput's neutral is its domain's maximum, so the template alone cannot give one.
    assert (body["templates"]["throughput"]["neutral"], body["templates"]["throughput"]["neutral_from"]) == (None, "max")
    assert body["blocks"]["exclusive"]["default"] == "weightedSum"
    assert body["property_defaults"]["unit"] == "1"
    rules = {rule["sequence"]: rule for rule in body["neutral_rules"]}
    assert rules["sum"]["value"] == 0.0
    assert (rules["min"]["bound"], rules["min"]["ratio"]) == ("max", 1.0)


async def test_the_schema_is_the_file_parse_consults(api_client) -> None:
    response = await api_client.get("/v1/compositions/schema")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/schema+json")
    shipped = (
        REPO_ROOT / "openbinding-gateway" / "src" / "openbinding_gateway" / "composition"
        / "resources" / "composition2yaml" / "v1" / "composition.schema.json"
    )
    assert response.json() == json.loads(shipped.read_text(encoding="utf-8"))


# ------------------------------------------------------------------------- the contract


async def test_every_authoring_operation_is_documented(api_client) -> None:
    document = (await api_client.get("/openapi.json")).json()
    operations = {
        ("post", "/v1/compositions/parse"): "parseComposition",
        ("post", "/v1/compositions/serialise"): "serialiseComposition",
        ("post", "/v1/compositions/compile"): "compileComposition",
        ("post", "/v1/compositions/package"): "packageComposition",
        ("post", "/v1/compositions/import"): "importComposition",
        ("get", "/v1/compositions/language"): "describeCompositionLanguage",
        ("get", "/v1/compositions/schema"): "getCompositionSchema",
    }
    for (method, path), operation_id in operations.items():
        assert document["paths"][path][method]["operationId"] == operation_id
    upload = document["paths"]["/v1/compositions/import"]["post"]
    assert "application/vnd.bim+zip" in upload["requestBody"]["content"]
    assert {"413", "415", "422"} <= set(upload["responses"])
    download = document["paths"]["/v1/compositions/package"]["post"]["responses"]["200"]
    assert "application/vnd.bim+zip" in download["content"]
