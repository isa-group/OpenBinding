"""The citation of the resolver and the verifier holds recorded facts only.

``services/citations.py`` builds it from what the route passes in: the title, the digest, the resolvable kind (or
none), the element's created date, the recorded usernames and the live publication record of the exact version.
Nothing is made up: no DOI, venue, author or year that is not recorded, and the link is the frontend's public
permanent link. The module is loaded inside each test, so a checkout without it fails the tests instead of their
collection.
"""

from __future__ import annotations

import ast
import copy
import importlib
import importlib.util
import inspect
import re
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

from openbinding_gateway.core.settings import get_settings
from test_architecture_layers import gateway_imports, module_level_mutables, routes_imports
from test_b2_resolve_urls import assert_is_a_frontend_screen

MODULE = "openbinding_gateway.services.citations"

HEX = "0123456789abcdef" * 4
DIGEST = f"sha256-{HEX}"
ORIGIN = "https://ob.example"
CREATED = datetime(2023, 5, 10, 12, 0, tzinfo=timezone.utc)
PUBLISHED = datetime(2024, 11, 30, 9, 30, tzinfo=timezone.utc)

RESOLVABLE = (
    "case-revision",
    "resource-revision",
    "collection-revision",
    "report",
    "artifact",
    "engine",
    "dialect",
    "registered-resource",
    "instance-snapshot",
    "binding-ir",
)

#: What the old builders made up; none of it may reach a citation again.
INVENTED = (
    "OpenBinding Research Group",
    "OpenBinding Canonical Provenance Registry",
    "10.1109/OPENBINDING",
    "openbinding.score.us.es",
)

BADGE_IMAGE = (
    "[![OpenBinding Verified](https://img.shields.io/badge/OpenBinding-Verified_Integrity-00E599"
    "?style=flat-square&logo=shield)]"
)

BUILDER_FIELDS = ["title", "author", "year", "howpublished", "doi", "url", "note"]
KEY = re.compile(r"[A-Za-z0-9_.:-]+")


def citations() -> ModuleType:
    """The builder module; a missing one fails the calling test, never the collection."""
    if importlib.util.find_spec(MODULE) is None:
        pytest.fail(f"{MODULE} does not exist yet")
    return importlib.import_module(MODULE)


def published(citation=None, published_at=PUBLISHED, **extra) -> SimpleNamespace:
    """A live publication record as the routes pass it: its recorded ``citation`` and ``published_at``."""
    return SimpleNamespace(citation=citation, published_at=published_at, **extra)


def build(**overrides):
    arguments = {
        "frontend_url": ORIGIN,
        "kind": "case-revision",
        "created_at": CREATED,
        "title": "Routing case",
        "slug": "routing-case",
        "digest": DIGEST,
    }
    arguments.update(overrides)
    return citations().build_citation(**arguments)


def parse_entry(bibtex: str) -> tuple[str, list[tuple[str, str]]]:
    """The key and the ``(name, value)`` fields of the single ``@misc`` entry that is the whole of ``bibtex``.

    Every brace counts, escaped or not, as classic BibTeX counts them. The entry must close at the very end, and
    its top level may hold nothing but ``name = {value}`` fields separated by commas.
    """
    head, brace, body = bibtex.partition("{")
    assert head == "@misc" and brace, bibtex
    depth, top, values, current, end = 1, [], [], [], None
    for index, char in enumerate(body):
        if char == "{":
            depth += 1
            if depth == 2:
                current = []
                continue
        elif char == "}":
            depth -= 1
            if depth == 0:
                end = index
                break
            if depth == 1:
                values.append("".join(current))
                top.append("\0")
                continue
        if depth == 1:
            top.append(char)
        else:
            current.append(char)
    assert end is not None, f"the entry never closes:\n{bibtex}"
    assert body[end + 1 :] == "", f"text after the entry:\n{bibtex}"
    key, *parts = "".join(top).split(",")
    names = []
    for part in parts:
        match = re.fullmatch(r"\s*([a-z]+) = \0\s*", part)
        assert match, f"not a single field at the top level: {part!r}\n{bibtex}"
        names.append(match.group(1))
    return key, list(zip(names, values, strict=True))


def fields(citation) -> dict[str, str]:
    _, entries = parse_entry(citation.bibtex)
    return dict(entries)


def badge_link(markdown_badge: str) -> str:
    assert markdown_badge.startswith(BADGE_IMAGE) and markdown_badge.endswith(")"), markdown_badge
    return markdown_badge[len(BADGE_IMAGE) + 1 : -1]


def assert_nothing_invented(citation) -> None:
    text = citation.model_dump_json()
    for literal in INVENTED:
        assert literal not in text


# -- DOI, venue and authors: typed recorded values only -----------------------


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("value", ["10.5281/zenodo.123", "10.1234/x", "10.123456789/a.b-c_d(1)", "10.1000/x}y"])
def test_a_well_formed_doi_is_kept(value):
    assert citations().valid_doi(value) == value


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
def test_the_doi_resolver_prefix_is_removed():
    assert citations().valid_doi("https://doi.org/10.5281/zenodo.456") == "10.5281/zenodo.456"


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize(
    "value",
    [
        None,
        1234,
        10.5281,
        True,
        ["10.5281/zenodo.1"],
        {"doi": "10.5281/zenodo.1"},
        "",
        "not-a-doi",
        "10.12/x",
        "10.123/x",
        "10.1234567890/x",
        "10.5281/",
        "10.5281/zen odo",
        "10.5281/zenodo\n",
        "10.5281/zenodo ",
        " 10.5281/zenodo",
        "10.5281/zen\todo",
        "10.5281/zen\x00odo",
        "10.5281/zen\x7fodo",
        "10.5281/zen\N{NO-BREAK SPACE}odo",
        "10.5281/zen\N{THIN SPACE}odo",
        "10.5281/zen\N{LINE SEPARATOR}odo",
        "10." + "\N{ARABIC-INDIC DIGIT FIVE}" * 4 + "/zenodo",
        "x10.5281/zenodo",
        "11.5281/zenodo",
        "doi:10.5281/zenodo",
        "http://doi.org/10.5281/zenodo",
        "https://doi.org/",
        "https://doi.org/https://doi.org/10.5281/zenodo",
    ],
)
def test_a_malformed_doi_is_dropped(value):
    assert citations().valid_doi(value) is None


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
def test_a_venue_is_a_non_empty_string():
    module = citations()

    assert module.valid_venue("V") == "V"
    assert module.valid_venue("Proc. }, title = {X") == "Proc. }, title = {X"
    for value in ("", "   ", 7, None, True, ["V"], {"name": "V"}):
        assert module.valid_venue(value) is None, value


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
def test_authors_are_a_list_of_names():
    module = citations()

    assert module.valid_authors(["A. Researcher"]) == ["A. Researcher"]
    assert module.valid_authors(["A", 3, "", "  ", None, "B"]) == ["A", "B"]
    for value in (None, "A. Researcher", [], [3], [""], {"A": 1}, 7):
        assert module.valid_authors(value) is None, value


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
def test_an_element_without_a_publication_has_no_doi_venue_or_author():
    citation = build()

    assert citation.doi is None
    assert citation.venue is None
    assert citation.authors == []
    assert "doi =" not in citation.bibtex
    assert "howpublished =" not in citation.bibtex
    assert fields(citation)["author"] == ""
    assert_nothing_invented(citation)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-year~1]
def test_a_recorded_publication_citation_is_reproduced():
    record = {"doi": "10.5281/zenodo.123", "venue": "V", "year": 2025, "authors": ["A. Researcher"]}

    citation = build(kind="report", publication=published(record), authors=["alice"])

    assert (citation.doi, citation.venue, citation.year) == ("10.5281/zenodo.123", "V", 2025)
    assert citation.authors == ["A. Researcher"]
    entry = fields(citation)
    assert entry["doi"] == "10.5281/zenodo.123"
    assert entry["howpublished"] == "V"
    assert entry["author"] == "{A. Researcher}"
    assert entry["year"] == "2025"


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
def test_the_bibtex_entry_keeps_its_layout():
    record = {"doi": "https://doi.org/10.5281/zenodo.123", "venue": "V", "year": 2025, "authors": ["A", "B"]}

    citation = build(kind="report", publication=published(record))

    url = f"{ORIGIN}/resolve/report/{DIGEST}"
    assert citation.bibtex == (
        "@misc{routing-case_01234567,\n"
        "  title = {Routing case},\n"
        "  author = {{A} and {B}},\n"
        "  year = {2025},\n"
        "  howpublished = {V},\n"
        "  doi = {10.5281/zenodo.123},\n"
        f"  url = {{{url}}},\n"
        f"  note = {{Cryptographic SHA-256 Digest: {DIGEST}}}\n"
        "}"
    )
    assert build().bibtex == (
        "@misc{routing-case_01234567,\n"
        "  title = {Routing case},\n"
        "  author = {},\n"
        "  year = {2023},\n"
        f"  url = {{{ORIGIN}/resolve/case-revision/{DIGEST}}},\n"
        f"  note = {{Cryptographic SHA-256 Digest: {DIGEST}}}\n"
        "}"
    )


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
def test_a_doi_with_the_resolver_prefix_is_returned_without_it():
    citation = build(publication=published({"doi": "https://doi.org/10.5281/zenodo.456"}))

    assert citation.doi == "10.5281/zenodo.456"
    assert fields(citation)["doi"] == "10.5281/zenodo.456"


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
def test_a_malformed_doi_is_dropped_and_the_venue_kept():
    citation = build(publication=published({"doi": "not-a-doi", "venue": "V"}))

    assert citation.doi is None
    assert citation.venue == "V"
    assert "doi =" not in citation.bibtex
    assert fields(citation)["howpublished"] == "V"


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize(
    "doi", [1234, "10.12/x", "10.1234567890/x", "10.5281/", "10.5281/zen odo", "10.5281/zenodo\n", None]
)
def test_a_doi_of_the_wrong_type_or_shape_never_reaches_the_citation(doi):
    citation = build(publication=published({"doi": doi}))

    assert citation.doi is None
    assert "doi =" not in citation.bibtex
    assert "doi" not in fields(citation)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("venue", ["", 7, None, "  "])
def test_an_empty_or_non_string_venue_is_dropped(venue):
    citation = build(publication=published({"venue": venue}))

    assert citation.venue is None
    assert "howpublished =" not in citation.bibtex


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("record", [None, {}, [], "10.5281/zenodo.1", 7])
def test_without_a_recorded_citation_object_there_is_no_doi_or_venue(record):
    citation = build(publication=published(record), title="10.5281/zenodo.123", slug="V")

    assert (citation.doi, citation.venue) == (None, None)
    assert citation.year == PUBLISHED.year
    assert_nothing_invented(citation)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-year~1]
def test_a_withdrawn_publication_is_not_cited():
    record = {"doi": "10.5281/zenodo.789", "venue": "V", "year": 2025, "authors": ["A. Researcher"]}
    withdrawn = published(record, withdrawn=True)

    citation = build(created_at=datetime(2022, 2, 2, tzinfo=timezone.utc), publication=withdrawn)

    assert (citation.doi, citation.venue, citation.authors, citation.year) == (None, None, [], 2022)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
def test_authors_fall_back_to_the_recorded_username():
    citation = build(authors=["alice"])

    assert citation.authors == ["alice"]
    assert fields(citation)["author"] == "{alice}"


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("recorded", ["A. Researcher", [1, 2], [], [""], None])
def test_unusable_recorded_authors_fall_back_to_the_usernames(recorded):
    citation = build(publication=published({"authors": recorded}), authors=["alice"])

    assert citation.authors == ["alice"]


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("authors", [None, [], [None], [""]])
def test_authors_are_empty_when_none_is_recorded(authors):
    citation = build(authors=authors, publication=published({"venue": "V"}))

    assert citation.authors == []
    assert fields(citation)["author"] == ""
    assert_nothing_invented(citation)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
def test_a_name_containing_and_stays_one_author():
    citation = build(publication=published({"authors": ["Smith and Jones", "Doe"]}))

    assert citation.authors == ["Smith and Jones", "Doe"]
    assert fields(citation)["author"] == "{Smith and Jones} and {Doe}"


# -- BibTeX: user-written text cannot leave its field ---------------------------


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize(
    "value,expected",
    [
        ("Proc. }, title = {X", "Proc. , title = X"),
        ("{{{", ""),
        ("}}}", ""),
        ("\\", r"\textbackslash{}"),
        ("\\}", r"\textbackslash{}"),
        ("A. \\ Researcher", r"A. \textbackslash{} Researcher"),
        ("&%$#_", r"\&\%\$\#\_"),
        ("^~", r"\textasciicircum{}\textasciitilde{}"),
        ("a\nb\r\tc\x00d", "a b  c d"),
        ("a\N{LINE SEPARATOR}b\N{PARAGRAPH SEPARATOR}c", "a b c"),
        ("Plain text, 1-2: ok.", "Plain text, 1-2: ok."),
    ],
)
def test_bibtex_text_removes_braces_and_escapes_the_specials(value, expected):
    assert citations().bibtex_text(value) == expected


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
def test_publisher_braces_cannot_break_out_of_a_field():
    citation = build(publication=published({"venue": "Proc. }, title = {X"}))

    _, entries = parse_entry(citation.bibtex)
    assert [name for name, _ in entries] == ["title", "author", "year", "howpublished", "url", "note"]
    assert dict(entries)["howpublished"] == "Proc. , title = X"
    assert citation.venue == "Proc. }, title = {X"


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
def test_a_backslash_in_an_author_is_escaped():
    citation = build(publication=published({"authors": ["A. \\ Researcher"]}))

    _, entries = parse_entry(citation.bibtex)
    assert [name for name, _ in entries] == ["title", "author", "year", "url", "note"]
    assert "A. \\ Researcher" not in citation.bibtex
    assert citation.authors == ["A. \\ Researcher"]


HOSTILE = [
    "}",
    "{",
    "}}}}",
    "{{{{",
    "}, title = {X",
    "X}, doi = {10.1234/evil",
    "\\",
    "\\}",
    "x\\",
    "@misc{evil, title = {x}}",
    "a\n}\n@misc{evil,\n  title = {x}\n}",
    "%&$#_^~",
    "a, b = c",
]


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("value", HOSTILE)
@pytest.mark.parametrize("slot", ["title", "slug", "venue", "author", "username", "doi"])
def test_a_hostile_value_leaves_one_entry_with_the_builders_fields_only(slot, value):
    record = {"venue": "V", "doi": "10.5281/zenodo.1", "authors": ["A"]}
    arguments = {}
    if slot in {"title", "slug"}:
        arguments[slot] = value
    elif slot == "venue":
        record["venue"] = value
    elif slot == "author":
        record["authors"] = ["A", value]
    elif slot == "username":
        del record["authors"]
        arguments["authors"] = [value]
    else:
        record["doi"] = "10.5281/" + value

    citation = build(publication=published(record), **arguments)

    key, entries = parse_entry(citation.bibtex)
    expected = [name for name in BUILDER_FIELDS if name != "doi" or citation.doi is not None]
    assert [name for name, _ in entries] == expected
    assert KEY.fullmatch(key), key
    for name, text in entries:
        assert "\n" not in text, (name, text)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize(
    "slug,expected",
    [
        ("routing-case", "routing-case_01234567"),
        ("my slug, {x}/\N{LATIN SMALL LETTER E WITH ACUTE}", "myslugx_01234567"),
        ("a.b:c_d-e", "a.b:c_d-e_01234567"),
        ("", "_01234567"),
    ],
)
def test_the_citation_key_is_reduced_to_safe_characters(slug, expected):
    key, _ = parse_entry(build(slug=slug).bibtex)

    assert key == expected
    assert KEY.fullmatch(key)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
def test_the_title_is_kept_as_given_outside_the_bibtex():
    citation = build(title="A {b} \\ c")

    assert citation.title == "A {b} \\ c"
    assert fields(citation)["title"] == r"A b \textbackslash{} c"


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("kind", [*RESOLVABLE, None])
@pytest.mark.parametrize("record", [None, {}, {"venue": "V", "doi": "10.5281/zenodo.1", "authors": ["A"]}])
def test_no_constant_author_venue_doi_or_host_in_any_output(kind, record):
    publication = None if record is None else published(record)

    assert_nothing_invented(build(kind=kind, publication=publication))


# -- year: the first recorded date ----------------------------------------------


# [utest->req~resolver-verifier-citation-year~1]
def test_valid_year_is_an_integer_and_not_a_boolean():
    module = citations()

    assert module.valid_year(2025) == 2025
    for value in (True, False, "2025", 2025.0, None, [2025]):
        assert module.valid_year(value) is None, value


# [utest->req~resolver-verifier-citation-year~1]
def test_the_recorded_year_comes_first():
    publication = published({"year": 2025}, published_at=datetime(2026, 3, 1, tzinfo=timezone.utc))

    citation = build(publication=publication)

    assert citation.year == 2025
    assert fields(citation)["year"] == "2025"
    assert "year = {2025}" in citation.bibtex
    assert citations().citation_year(CREATED, publication) == 2025


# [utest->req~resolver-verifier-citation-year~1]
def test_the_publication_date_gives_the_year_without_a_recorded_one():
    citation = build(publication=published({}))

    assert citation.year == 2024
    assert fields(citation)["year"] == "2024"
    assert citations().citation_year(CREATED, published({})) == 2024


# [utest->req~resolver-verifier-citation-year~1]
@pytest.mark.parametrize("publication", [None, published({}, published_at=None)])
def test_the_created_date_gives_the_year_without_a_publication_date(publication):
    citation = build(publication=publication)

    assert citation.year == 2023
    assert "year = {2023}" in citation.bibtex
    assert citations().citation_year(CREATED, publication) == 2023


# [utest->req~resolver-verifier-citation-year~1]
@pytest.mark.parametrize("year", ["2025", True, False, 2025.0, None, [2025]])
def test_a_non_integer_recorded_year_is_ignored(year):
    citation = build(publication=published({"year": year}))

    assert citation.year == 2024
    assert fields(citation)["year"] == "2024"


# [utest->req~resolver-verifier-citation-year~1]
@pytest.mark.parametrize("year", [1999, 2031])
def test_the_year_is_never_a_constant(year):
    citation = build(created_at=datetime(year, 1, 1, tzinfo=timezone.utc))

    assert citation.year == year
    assert fields(citation)["year"] == str(year)


# -- url: the public permanent link on the frontend origin -----------------------


# [utest->req~resolver-verifier-citation-url~1]
def test_the_resolvable_kinds_are_the_resolvers():
    kinds = citations().RESOLVABLE_KINDS

    assert isinstance(kinds, frozenset)
    assert kinds == frozenset(RESOLVABLE)


# [utest->req~resolver-verifier-citation-url~1]
@pytest.mark.parametrize("kind", RESOLVABLE)
def test_every_resolvable_kind_links_to_its_permanent_link(kind):
    citation = build(kind=kind)

    expected = f"{ORIGIN}/resolve/{kind}/{DIGEST}"
    assert citation.url == expected
    assert citations().citation_url(ORIGIN, kind, DIGEST) == expected
    assert badge_link(citation.markdown_badge) == expected
    assert fields(citation)["url"] == expected
    assert_is_a_frontend_screen(expected.removeprefix(ORIGIN))


# [utest->req~resolver-verifier-citation-url~1]
@pytest.mark.parametrize("origin", [f"{ORIGIN}/", ORIGIN])
def test_the_trailing_slash_of_the_frontend_origin_is_removed(origin):
    module = citations()

    assert module.citation_url(origin, "case-revision", DIGEST) == f"{ORIGIN}/resolve/case-revision/{DIGEST}"
    assert module.citation_url(origin, None, DIGEST) == f"{ORIGIN}/app/verifier?digest={DIGEST}"
    assert build(frontend_url=origin).url == f"{ORIGIN}/resolve/case-revision/{DIGEST}"


# [utest->req~resolver-verifier-citation-url~1]
def test_the_link_carries_the_normalised_digest():
    citation = build(kind="report")

    assert citation.url.endswith(f"/{DIGEST}")
    assert f"Digest: {DIGEST}" in fields(citation)["note"]


# [utest->req~resolver-verifier-citation-url~1]
def test_without_a_resolvable_kind_the_link_is_the_verifier():
    citation = build(kind=None)

    expected = f"{ORIGIN}/app/verifier?digest={DIGEST}"
    assert citation.url == expected
    assert badge_link(citation.markdown_badge) == expected
    assert fields(citation)["url"] == expected
    assert_is_a_frontend_screen(expected.removeprefix(ORIGIN))


# [utest->req~resolver-verifier-citation-url~1]
@pytest.mark.parametrize("kind", ["study_run", "reports", "", "Case-Revision"])
def test_an_unknown_kind_is_refused_rather_than_linked(kind):
    with pytest.raises(ValueError):
        citations().citation_url(ORIGIN, kind, DIGEST)


# [utest->req~resolver-verifier-citation-url~1]
def test_the_badge_keeps_its_image_and_links_to_the_url():
    citation = build(kind="engine")

    assert citation.markdown_badge == f"{BADGE_IMAGE}({ORIGIN}/resolve/engine/{DIGEST})"


# [utest->req~resolver-verifier-citation-url~1]
def test_the_gateway_origin_is_never_used(monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://api.ob.example")
    monkeypatch.setenv("FRONTEND_URL", "https://configured.example")
    get_settings.cache_clear()
    try:
        outputs = [build(kind=kind).model_dump_json() for kind in (*RESOLVABLE, None)]
    finally:
        get_settings.cache_clear()

    for text in outputs:
        assert "api.ob.example" not in text
        assert "configured.example" not in text
        assert ORIGIN in text
    parameters = inspect.signature(citations().build_citation).parameters
    assert set(parameters) == {"frontend_url", "kind", "created_at", "title", "slug", "digest", "authors", "publication"}


# -- purity ---------------------------------------------------------------------


ALLOWED_IMPORTS = {"__future__", "collections", "datetime", "re", "types", "typing", "urllib"}
ALLOWED_GATEWAY_IMPORTS = {"openbinding_gateway.models.platform"}
FORBIDDEN_CALLS = {"open", "print", "input", "eval", "exec", "__import__", "compile"}


def _imported_roots(tree: ast.AST) -> set[str]:
    roots = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and not node.level:
            roots.add((node.module or "").split(".")[0])
    return roots


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-url~1]
def test_the_builder_does_no_io_keeps_no_state_and_never_imports_routes():
    module = citations()
    source = Path(module.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)

    assert routes_imports(source, "openbinding_gateway.services") == []
    assert {name for _, name in gateway_imports(source, "openbinding_gateway.services")} <= ALLOWED_GATEWAY_IMPORTS
    assert _imported_roots(tree) - {"openbinding_gateway"} <= ALLOWED_IMPORTS
    assert module_level_mutables(source) == []
    calls = {
        node.func.id for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert not calls & FORBIDDEN_CALLS
    for literal in ("PUBLIC_BASE_URL", "public_base_url", "get_settings"):
        assert literal not in source
    mutable = [
        name
        for name, value in vars(module).items()
        if not name.startswith("__") and isinstance(value, (list, dict, set, bytearray))
    ]
    assert mutable == []


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-year~1]
def test_the_builder_is_deterministic_and_leaves_its_inputs_alone():
    record = {"doi": "10.5281/zenodo.1", "venue": "V", "year": 2025, "authors": ["A", 3]}
    usernames = ["alice"]
    before = copy.deepcopy((record, usernames))

    first = build(publication=published(record), authors=usernames)
    second = build(publication=published(record), authors=usernames)

    assert first == second
    assert (record, usernames) == before
    first.authors.append("mallory")
    assert build(publication=published(record), authors=usernames).authors == ["A"]
    build(authors=usernames).authors.append("mallory")
    assert usernames == ["alice"]
