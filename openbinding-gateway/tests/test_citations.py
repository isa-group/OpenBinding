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
import json
import os
import re
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
import pytest_asyncio
from sqlalchemy import select

from openbinding_gateway import space_client
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db import platform_models
from openbinding_gateway.db.models import (
    Artifact,
    ArtifactPublication,
    ArtifactVersion,
    BindingCaseRevision,
    BindingIRSnapshot,
    Blob,
    Collection,
    CollectionRevision,
    DialectRevision,
    EngineRevision,
    InstanceSnapshot,
    Project,
    RegisteredResourceRevision,
)
from openbinding_gateway.db.platform_models import Report, ReportState
from _pricing import fake_pricing_gate
import _m96_seed as seed
from test_architecture_layers import gateway_imports, module_level_mutables, routes_imports
from test_b2_resolve_urls import account, assert_is_a_frontend_screen, seal

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


#: Unicode format characters (category Cf): bidi embeddings, overrides and isolates, zero-width characters, BOM.
FORMAT_CHARACTERS = [
    *(chr(code) for code in range(0x202A, 0x202F)),
    *(chr(code) for code in range(0x2066, 0x206A)),
    *(chr(code) for code in range(0x200B, 0x2010)),
    "\N{ZERO WIDTH NO-BREAK SPACE}",
    "\N{SOFT HYPHEN}",
]


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("character", FORMAT_CHARACTERS, ids=lambda character: f"U+{ord(character):04X}")
def test_bibtex_text_drops_unicode_format_characters(character):
    assert citations().bibtex_text(f"a{character}b") == "ab"


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
def test_a_bidi_override_in_a_recorded_value_never_reaches_the_bibtex():
    venue = "Proc.\N{RIGHT-TO-LEFT OVERRIDE} V\N{POP DIRECTIONAL FORMATTING}\N{ZERO WIDTH SPACE}"
    citation = build(publication=published({"venue": venue, "authors": ["A\N{RIGHT-TO-LEFT ISOLATE}lice"]}))

    entry = fields(citation)
    assert entry["howpublished"] == "Proc. V"
    assert entry["author"] == "{Alice}"
    assert not any(character in citation.bibtex for character in FORMAT_CHARACTERS)
    assert citation.venue == venue


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
@pytest.mark.parametrize("year", [1000, 9999])
def test_a_four_digit_year_is_kept(year):
    assert citations().valid_year(year) == year


# [utest->req~resolver-verifier-citation-year~1]
@pytest.mark.parametrize("year", [0, -5, 999, 10000, 10**4000], ids=["0", "-5", "999", "10000", "10**4000"])
def test_a_year_outside_four_digits_is_not_a_year(year):
    assert citations().valid_year(year) is None


# [utest->req~resolver-verifier-citation-year~1]
@pytest.mark.parametrize("year", [0, -5, 999, 10000, 10**4000], ids=["0", "-5", "999", "10000", "10**4000"])
def test_an_out_of_range_recorded_year_falls_through_to_the_publication_date(year):
    citation = build(publication=published({"year": year}))

    assert citation.year == PUBLISHED.year
    assert fields(citation)["year"] == str(PUBLISHED.year)


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
def test_the_resolvable_kinds_are_exactly_the_kinds_the_resolver_accepts():
    from openbinding_gateway.routes.resolve import VALID_KINDS

    assert set(VALID_KINDS) == set(citations().RESOLVABLE_KINDS)


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


ALLOWED_IMPORTS = {"__future__", "collections", "datetime", "re", "types", "typing", "unicodedata", "urllib"}
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


# -- through the endpoint: GET /v1/resolve/{kind}/{digest} ------------------------

#: The creation date of every seeded element; a year that no constant can match by chance.
OLD = datetime(2021, 3, 4, 5, 6, tzinfo=timezone.utc)
#: The gateway origin (``PUBLIC_BASE_URL``) and the test client's host: neither is the frontend's.
GATEWAY = "https://api.ob.example"
CLIENT_ORIGIN = "http://gateway"
CITED = {"doi": "10.5281/zenodo.123", "venue": "V", "year": 2025, "authors": ["A. Researcher"]}
HOSTILE_VENUE = "Proc. }, title = {X"
COLLECTION_API = "openbinding/collection/v1"
UNKNOWN = "sha256-" + "9" * 64
CASE_DOCUMENT = {
    "apiVersion": "bim/v1",
    "kind": "Instance",
    "metadata": {"name": "c"},
    "spec": {"profile": "qos-binding/v1", "resources": {"application": {"app": "a.json"}}},
}
#: The kinds whose element is an ``ArtifactVersion`` that can carry an ``ArtifactPublication``.
LIBRARY_KINDS = ("resource-revision", "collection-revision", "report")


@dataclass(frozen=True)
class Seeded:
    kind: str
    digest: str
    headers: dict
    username: str
    user_id: str
    org: str = ""
    artifact_kind: str = ""
    artifact_id: str = ""
    version_id: str = ""


def random_digest() -> str:
    return "sha256-" + uuid.uuid4().hex + uuid.uuid4().hex


@pytest_asyncio.fixture
async def platform_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


@pytest.fixture
def world(api_client, registration, platform_gate, db_session, monkeypatch):
    """The gateway over HTTP with ``FRONTEND_URL`` and ``PUBLIC_BASE_URL`` set to two different origins."""
    settings = get_settings()
    monkeypatch.setattr(settings, "frontend_url", ORIGIN)
    monkeypatch.setattr(settings, "public_base_url", GATEWAY)
    return SimpleNamespace(client=api_client, registration=registration, gate=platform_gate, db=db_session)


async def member(world) -> tuple[dict, dict]:
    return await account(world.client, world.registration, world.gate)


async def project_of(world, headers, visibility: str) -> tuple[str, str]:
    org = f"org-{uuid.uuid4().hex[:8]}"
    created = await world.client.post("/v1/organizations", headers=headers, json={"slug": org, "name": "Org"})
    assert created.status_code == 201, created.text
    slug = f"proj-{uuid.uuid4().hex[:8]}"
    created = await world.client.post(
        f"/v1/organizations/{org}/projects",
        headers=headers,
        json={"slug": slug, "name": "Project", "visibility": visibility},
    )
    assert created.status_code == 201, created.text
    return org, slug


async def project_row(world, slug: str) -> Project:
    return (await world.db.execute(select(Project).where(Project.slug == slug))).scalars().one()


class Then(datetime):
    """A ``datetime`` whose ``now`` is ``OLD``."""

    @classmethod
    def now(cls, tz=None):
        return OLD.astimezone(tz) if tz else OLD.replace(tzinfo=None)


async def sealed_in_the_past(awaitable):
    """Await ``awaitable`` with the clock of the database defaults at ``OLD``.

    A sealed version is immutable (a trigger refuses every update), so its creation date is set when it is sealed.
    """
    original = platform_models.datetime
    platform_models.datetime = Then
    try:
        return await awaitable
    finally:
        platform_models.datetime = original


async def assert_sealed_in_the_past(world, version_id: str) -> None:
    assert (await world.db.get(ArtifactVersion, uuid.UUID(version_id))).created_at.year == OLD.year


def visibility(public: bool) -> str:
    return "public" if public else "private"


async def seed_case_revision(world, public: bool) -> Seeded:
    user, headers = await member(world)
    org, proj = await project_of(world, headers, visibility(public))
    case = await world.client.post(
        f"/v1/organizations/{org}/projects/{proj}/cases", headers=headers, json={"slug": "baseline", "name": "Baseline"}
    )
    assert case.status_code == 201, case.text
    revision = await sealed_in_the_past(world.client.post(
        f"/v1/organizations/{org}/projects/{proj}/cases/baseline/revisions",
        headers=headers,
        json={"document": CASE_DOCUMENT},
    ))
    assert revision.status_code == 201, revision.text
    digest = revision.json()["digest"]
    row = (await world.db.execute(select(BindingCaseRevision).where(BindingCaseRevision.digest == digest))).scalars().one()
    assert row.created_at.year == OLD.year
    return Seeded("case-revision", digest, headers, user["username"], user["id"], org)


async def seed_library_version(world, kind: str, artifact_kind: str) -> Seeded:
    """A sealed version of an organization's library, readable by its members only until it is published."""
    user, headers = await member(world)
    org, _ = await project_of(world, headers, "public")
    content = {"apiVersion": COLLECTION_API, "members": []} if artifact_kind == "Collection" else {"value": 1}
    sealed = await sealed_in_the_past(seal(world.client, headers, org, artifact_kind, content, db=world.db))
    await assert_sealed_in_the_past(world, sealed["version"]["id"])
    return Seeded(
        kind, sealed["version"]["contentDigest"], headers, user["username"], user["id"], org, artifact_kind,
        sealed["artifact"]["id"], sealed["version"]["id"],
    )


async def seed_resource_revision(world, public: bool) -> Seeded:
    return await seed_library_version(world, "resource-revision", "Dataset")


async def seed_collection_revision(world, public: bool) -> Seeded:
    return await seed_library_version(world, "collection-revision", "Collection")


async def seed_report(world, public: bool) -> Seeded:
    seeded = await seed_library_version(world, "report", "Dataset")
    _, proj = await project_of(world, seeded.headers, "public")
    world.db.add(Report(
        project_id=(await project_row(world, proj)).id, slug="decision-1", title="Decision", state=ReportState.FROZEN,
        artifact_id=uuid.UUID(seeded.artifact_id), version_id=uuid.UUID(seeded.version_id),
        created_by_id=uuid.UUID(seeded.user_id), created_at=OLD,
    ))
    await world.db.flush()
    return seeded


async def seed_project_collection_revision(world, public: bool) -> Seeded:
    """A revision of a project collection, the resolver's second source of ``collection-revision``."""
    user, headers = await member(world)
    org, proj = await project_of(world, headers, visibility(public))
    collection = Collection(
        project_id=(await project_row(world, proj)).id, slug="set-a", name="Set A", created_by_id=uuid.UUID(user["id"])
    )
    world.db.add(collection)
    await world.db.flush()
    digest = random_digest()
    world.db.add(CollectionRevision(
        collection_id=collection.id, revision=1, digest=digest, created_by_id=uuid.UUID(user["id"]), created_at=OLD
    ))
    await world.db.flush()
    return Seeded("collection-revision", digest, headers, user["username"], user["id"], org)


async def seed_artifact(world, public: bool) -> Seeded:
    user, headers = await member(world)
    org, proj = await project_of(world, headers, visibility(public))
    uploaded = await world.client.post(
        f"/v1/organizations/{org}/projects/{proj}/blobs?public={str(public).lower()}",
        headers={**headers, "Content-Type": "text/plain"},
        content=f"reproducible bytes {uuid.uuid4().hex}\n".encode(),
    )
    assert uploaded.status_code == 201, uploaded.text
    digest = uploaded.json()["digest"]
    row = (await world.db.execute(select(Blob).where(Blob.digest == digest))).scalars().one()
    row.created_at = OLD
    await world.db.flush()
    return Seeded("artifact", digest, headers, user["username"], user["id"], org)


async def seed_engine(world, public: bool, owner: str | None = None) -> Seeded:
    user, headers = await member(world)
    digest = random_digest()
    world.db.add(EngineRevision(
        owner_id=uuid.UUID(owner or user["id"]), namespace="acme", name="solver", version="1.2.0", digest=digest,
        document={"metadata": {"name": "solver"}}, state="published" if public else "private", created_at=OLD,
    ))
    await world.db.flush()
    return Seeded("engine", digest, headers, user["username"], user["id"])


async def seed_dialect(world, public: bool, owner: str | None = None) -> Seeded:
    user, headers = await member(world)
    digest = random_digest()
    world.db.add(DialectRevision(
        owner_id=uuid.UUID(owner or user["id"]), namespace="acme", name="dialect", version="1", digest=digest,
        adapter_digest=random_digest(), document={"kind": "Dialect"},
        state="published" if public else "pending_review", created_at=OLD,
    ))
    await world.db.flush()
    return Seeded("dialect", digest, headers, user["username"], user["id"])


async def seed_registered_resource(world, public: bool, owner: str | None = None) -> Seeded:
    user, headers = await member(world)
    digest = random_digest()
    world.db.add(RegisteredResourceRevision(
        owner_id=uuid.UUID(owner or user["id"]), namespace="acme", name="res", version="1", digest=digest,
        role="application", api_version="bim/v1", kind="Application", dialect_id="acme/dialect@1",
        media_type="application/json", document={"a": 1}, content=b'{"a": 1}',
        state="published" if public else "pending_review", created_at=OLD,
    ))
    await world.db.flush()
    return Seeded("registered-resource", digest, headers, user["username"], user["id"])


async def snapshot_of(world, user: dict) -> InstanceSnapshot:
    snapshot = InstanceSnapshot(
        owner_id=uuid.UUID(user["id"]), name="snapshot", instance_digest=random_digest(),
        package_digest=random_digest(), root_document={"kind": "Instance"}, source_archive=b"zip", created_at=OLD,
    )
    world.db.add(snapshot)
    await world.db.flush()
    return snapshot


async def seed_instance_snapshot(world, public: bool) -> Seeded:
    user, headers = await member(world)
    snapshot = await snapshot_of(world, user)
    return Seeded("instance-snapshot", snapshot.instance_digest, headers, user["username"], user["id"])


async def seed_binding_ir(world, public: bool) -> Seeded:
    user, headers = await member(world)
    snapshot = await snapshot_of(world, user)
    digest = random_digest()
    world.db.add(BindingIRSnapshot(
        snapshot_id=snapshot.id, ir_digest=digest, document={"ir": 1}, source_map={}, created_at=OLD
    ))
    await world.db.flush()
    return Seeded("binding-ir", digest, headers, user["username"], user["id"])


#: One seeder per source of a resolvable element; ``collection-revision`` has two.
SEEDERS = {
    "case-revision": seed_case_revision,
    "resource-revision": seed_resource_revision,
    "collection-revision": seed_collection_revision,
    "collection-revision (project collection)": seed_project_collection_revision,
    "report": seed_report,
    "artifact": seed_artifact,
    "engine": seed_engine,
    "dialect": seed_dialect,
    "registered-resource": seed_registered_resource,
    "instance-snapshot": seed_instance_snapshot,
    "binding-ir": seed_binding_ir,
}


async def resolved(world, seeded: Seeded, headers: dict | None = None) -> dict:
    response = await world.client.get(
        f"/v1/resolve/{seeded.kind}/{seeded.digest}", headers=seeded.headers if headers is None else headers
    )
    assert response.status_code == 200, response.text
    return response.json()


async def publish(world, seeded: Seeded, citation: dict) -> None:
    """The publication record of the version. The publish route is removed since M9.6, so it is seeded."""
    version = await world.db.get(ArtifactVersion, uuid.UUID(seeded.version_id))
    await seed.publish(world.db, version, seeded.user_id, citation)


async def withdraw(world, seeded: Seeded) -> None:
    """Withdraw the version's publication, as the removed withdraw route did."""
    publication = await world.db.get(ArtifactPublication, uuid.UUID(seeded.version_id))
    publication.withdrawn = True
    await world.db.flush()


async def sibling(world, seeded: Seeded) -> Seeded:
    """A second version of the same artifact, sealed at ``OLD``, with other content and so another digest."""
    dependencies = []
    if seeded.artifact_kind == "Collection":
        dataset = await seal(world.client, seeded.headers, seeded.org, "Dataset", {"value": "member"}, db=world.db)
        content = {"apiVersion": COLLECTION_API, "members": [dataset["version"]["ref"]]}
        dependencies = [dataset["version"]["ref"]]
    else:
        content = {"value": 2}
    artifact = await world.db.get(Artifact, uuid.UUID(seeded.artifact_id))
    sealed = await sealed_in_the_past(seed.seal(world.db, artifact, seeded.user_id, content, dependencies=dependencies))
    await assert_sealed_in_the_past(world, str(sealed.id))
    other = replace(seeded, digest=sealed.content_digest, version_id=str(sealed.id))
    assert other.digest != seeded.digest
    return other


def permanent_link(seeded: Seeded) -> str:
    return f"{ORIGIN}/resolve/{seeded.kind}/{seeded.digest}"


def assert_links_to_the_permanent_link(citation: dict, seeded: Seeded) -> None:
    url = permanent_link(seeded)
    assert citation["url"] == url
    assert badge_link(citation["markdown_badge"]) == url
    assert dict(parse_entry(citation["bibtex"])[1])["url"] == url
    text = json.dumps(citation)
    for literal in (*INVENTED, GATEWAY, CLIENT_ORIGIN):
        assert literal not in text
    # Last: without the frontend route table in the checkout this skips.
    assert_is_a_frontend_screen(url.removeprefix(ORIGIN))


def assert_cites_recorded_facts_only(body: dict, seeded: Seeded, authors: list[str]) -> None:
    citation = body["citation"]
    assert citation["doi"] is None
    assert citation["venue"] is None
    assert citation["authors"] == authors
    assert citation["year"] == int(body["created_at"][:4]) == OLD.year
    assert "doi =" not in citation["bibtex"]
    entry = dict(parse_entry(citation["bibtex"])[1])
    assert "doi" not in entry and "howpublished" not in entry
    assert entry["year"] == str(OLD.year)
    assert entry["author"] == " and ".join("{" + name + "}" for name in authors)
    assert_links_to_the_permanent_link(citation, seeded)


def assert_cites(citation: dict, record: dict) -> None:
    assert (citation["doi"], citation["venue"], citation["year"]) == (record["doi"], record["venue"], record["year"])
    assert citation["authors"] == record["authors"]
    entry = dict(parse_entry(citation["bibtex"])[1])
    assert entry["doi"] == record["doi"]
    assert entry["howpublished"] == record["venue"]
    assert entry["year"] == str(record["year"])


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-year~1]
# [utest->req~resolver-verifier-citation-url~1]
@pytest.mark.parametrize("source", SEEDERS)
async def test_every_kind_cites_recorded_facts_and_its_permanent_link(source, world):
    seeded = await SEEDERS[source](world, public=True)

    body = await resolved(world, seeded)

    assert body["kind"] == seeded.kind
    assert_cites_recorded_facts_only(body, seeded, authors=[seeded.username])


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.skipif(
    bool(os.environ.get("TEST_DATABASE_URL")), reason="an owner that is not recorded needs unenforced foreign keys"
)
@pytest.mark.parametrize("seeder", [seed_engine, seed_dialect, seed_registered_resource])
async def test_without_a_recorded_owner_the_authors_are_empty(seeder, world):
    seeded = await seeder(world, public=True, owner=str(uuid.uuid4()))

    body = await resolved(world, seeded, headers={})

    assert body["author"] is None
    assert_cites_recorded_facts_only(body, seeded, authors=[])


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-year~1]
# [utest->req~resolver-verifier-citation-url~1]
@pytest.mark.parametrize("kind", LIBRARY_KINDS)
async def test_a_published_version_is_cited_as_its_publication_records_it(kind, world):
    seeded = await SEEDERS[kind](world, public=True)
    await publish(world, seeded, CITED)

    # The publication makes the version public: an anonymous caller gets the same citation.
    for headers in (seeded.headers, {}):
        citation = (await resolved(world, seeded, headers))["citation"]

        assert_cites(citation, CITED)
        assert_links_to_the_permanent_link(citation, seeded)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("kind", LIBRARY_KINDS)
async def test_a_malformed_recorded_doi_is_dropped_and_the_venue_kept(kind, world):
    seeded = await SEEDERS[kind](world, public=True)
    await publish(world, seeded, {"doi": "not-a-doi", "venue": "V"})

    citation = (await resolved(world, seeded))["citation"]

    assert citation["doi"] is None
    assert citation["venue"] == "V"
    assert "doi =" not in citation["bibtex"]
    assert dict(parse_entry(citation["bibtex"])[1])["howpublished"] == "V"
    assert_links_to_the_permanent_link(citation, seeded)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-year~1]
@pytest.mark.parametrize("kind", LIBRARY_KINDS)
async def test_a_publication_of_a_sibling_version_is_not_cited(kind, world):
    first = await SEEDERS[kind](world, public=True)
    second = await sibling(world, first)
    await publish(world, first, CITED)

    assert_cites((await resolved(world, first))["citation"], CITED)
    assert_cites_recorded_facts_only(await resolved(world, second), second, authors=[second.username])


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-year~1]
@pytest.mark.parametrize("kind", LIBRARY_KINDS)
async def test_a_withdrawn_publication_is_not_cited_by_the_endpoint(kind, world):
    seeded = await SEEDERS[kind](world, public=True)
    await publish(world, seeded, CITED)
    await withdraw(world, seeded)

    body = await resolved(world, seeded)

    assert_cites_recorded_facts_only(body, seeded, authors=[seeded.username])
    assert "zenodo" not in json.dumps(body)


async def assert_answers_like_an_unknown_digest(world, kind: str, digest: str) -> None:
    _, stranger = await member(world)
    unknown = await world.client.get(f"/v1/resolve/{kind}/{UNKNOWN}")
    assert unknown.status_code == 404, unknown.text
    for headers in ({}, stranger):
        hidden = await world.client.get(f"/v1/resolve/{kind}/{digest}", headers=headers)

        assert hidden.status_code == unknown.status_code
        assert hidden.json() == unknown.json()
        assert "citation" not in hidden.text and "zenodo" not in hidden.text


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("source", SEEDERS)
async def test_a_hidden_element_answers_exactly_like_an_unknown_digest(source, world):
    seeded = await SEEDERS[source](world, public=False)

    # The owner sees it; the anonymous caller and a stranger cannot tell it from a digest nobody recorded.
    assert (await resolved(world, seeded))["citation"]["doi"] is None
    await assert_answers_like_an_unknown_digest(world, seeded.kind, seeded.digest)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("kind", LIBRARY_KINDS)
async def test_the_publication_of_a_sibling_never_leaks_to_a_hidden_version(kind, world):
    published_version = await SEEDERS[kind](world, public=True)
    hidden = await sibling(world, published_version)
    await publish(world, published_version, CITED)

    assert_cites((await resolved(world, published_version, headers={}))["citation"], CITED)
    await assert_answers_like_an_unknown_digest(world, kind, hidden.digest)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("kind", LIBRARY_KINDS)
async def test_a_hostile_recorded_venue_cannot_break_the_bibtex_entry(kind, world):
    seeded = await SEEDERS[kind](world, public=True)
    await publish(world, seeded, {**CITED, "venue": HOSTILE_VENUE})

    citation = (await resolved(world, seeded))["citation"]

    key, entries = parse_entry(citation["bibtex"])
    assert [name for name, _ in entries] == BUILDER_FIELDS
    assert KEY.fullmatch(key), key
    assert dict(entries)["howpublished"] == "Proc. , title = X"
    assert citation["venue"] == HOSTILE_VENUE
    assert_links_to_the_permanent_link(citation, seeded)


# [utest->req~resolver-verifier-citation-year~1]
async def test_the_report_citation_year_is_the_cited_versions_not_the_report_rows(world):
    seeded = await seed_library_version(world, "report", "Dataset")
    _, proj = await project_of(world, seeded.headers, "public")
    filed = datetime(2024, 7, 8, 9, 10, tzinfo=timezone.utc)
    assert filed.year != OLD.year
    world.db.add(Report(
        project_id=(await project_row(world, proj)).id, slug="decision-1", title="Decision", state=ReportState.FROZEN,
        artifact_id=uuid.UUID(seeded.artifact_id), version_id=uuid.UUID(seeded.version_id),
        created_by_id=uuid.UUID(seeded.user_id), created_at=filed,
    ))
    await world.db.flush()

    body = await resolved(world, seeded)

    # The answer keeps the report's own date; the citation dates the version the digest identifies.
    assert int(body["created_at"][:4]) == filed.year
    assert body["citation"]["year"] == OLD.year
    assert dict(parse_entry(body["citation"]["bibtex"])[1])["year"] == str(OLD.year)


# [utest->req~resolver-verifier-citation-url~1]
@pytest.mark.parametrize("source", SEEDERS)
async def test_a_digest_without_its_prefix_links_to_the_normalised_permanent_link(source, world, monkeypatch):
    # The configured origin ends with "/", and the caller sends the bare hexadecimal digest.
    monkeypatch.setattr(get_settings(), "frontend_url", f"{ORIGIN}/")
    seeded = await SEEDERS[source](world, public=True)
    hexadecimal = seeded.digest.removeprefix("sha256-")
    assert len(hexadecimal) == 64

    response = await world.client.get(f"/v1/resolve/{seeded.kind}/{hexadecimal}", headers=seeded.headers)

    assert response.status_code == 200, response.text
    citation = response.json()["citation"]
    url = f"{ORIGIN}/resolve/{seeded.kind}/sha256-{hexadecimal}"
    assert citation["url"] == url
    assert badge_link(citation["markdown_badge"]) == url
    assert dict(parse_entry(citation["bibtex"])[1])["url"] == url
    assert "//resolve" not in json.dumps(citation)


# [utest->req~resolver-verifier-citation-year~1]
@pytest.mark.parametrize("kind", LIBRARY_KINDS)
async def test_a_recorded_publication_without_a_year_is_dated_by_its_publication(kind, world):
    seeded = await SEEDERS[kind](world, public=True)
    assert PUBLISHED.year not in {OLD.year, datetime.now(timezone.utc).year}
    # A publication row is immutable once written, so it is recorded with its date.
    world.db.add(ArtifactPublication(
        version_id=uuid.UUID(seeded.version_id), citation={}, published_by_id=uuid.UUID(seeded.user_id),
        published_at=PUBLISHED,
    ))
    await world.db.flush()

    citation = (await resolved(world, seeded, headers={}))["citation"]

    assert citation["year"] == PUBLISHED.year
    assert dict(parse_entry(citation["bibtex"])[1])["year"] == str(PUBLISHED.year)
    assert (citation["doi"], citation["venue"]) == (None, None)
    assert citation["authors"] == [seeded.username]
    assert_links_to_the_permanent_link(citation, seeded)
