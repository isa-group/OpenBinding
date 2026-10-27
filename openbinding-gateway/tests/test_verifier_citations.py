"""The verifier's citation holds recorded facts of the visible match it cites, or is null.

``POST /v1/verifier/inspect`` and ``POST /v1/verifier/inspect-file`` cite the first match the caller may see, with
``services/citations.py``: no made-up DOI, venue, author or year, and a link to the element's public permanent link
on ``FRONTEND_URL`` (``/resolve/<kind>/<digest>``), or to the verifier screen when the match has no resolvable kind.
Without a visible match there is nothing to cite, so a hidden digest answers exactly like an unknown one.
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Awaitable, Callable, Optional
from urllib.parse import urlsplit

import pytest
import pytest_asyncio
from sqlalchemy import select

from bim_core.canonical import digest as canonical_digest
from openbinding_gateway import space_client
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import Blob, Study, StudyRun
from openbinding_gateway.db.platform_models import Report, ReportState
from _pricing import fake_pricing_gate
from test_b2_resolve_urls import assert_is_a_frontend_screen, seal
from test_citations import (
    BUILDER_FIELDS,
    CITED,
    CLIENT_ORIGIN,
    GATEWAY,
    HOSTILE_VENUE,
    INVENTED,
    KEY,
    OLD,
    ORIGIN,
    Seeded,
    assert_cites,
    badge_link,
    member,
    parse_entry,
    project_of,
    project_row,
    publish,
    random_digest,
    seed_artifact,
    seed_case_revision,
    seed_collection_revision,
    seed_engine,
    seed_library_version,
    seed_project_collection_revision,
    seed_report,
    sibling,
    snapshot_of,
    visibility,
    withdraw,
)

INSPECT = "/v1/verifier/inspect"
INSPECT_FILE = "/v1/verifier/inspect-file"


@pytest_asyncio.fixture
async def verifier_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


@pytest.fixture
def world(api_client, registration, verifier_gate, db_session, monkeypatch):
    """The gateway over HTTP with ``FRONTEND_URL`` and ``PUBLIC_BASE_URL`` set to two different origins."""
    settings = get_settings()
    monkeypatch.setattr(settings, "frontend_url", ORIGIN)
    monkeypatch.setattr(settings, "public_base_url", GATEWAY)
    return SimpleNamespace(client=api_client, registration=registration, gate=verifier_gate, db=db_session)


async def seed_instance_snapshot(world, public: bool) -> Seeded:
    """A snapshot is visible to its owner only (or through a visible case revision, not seeded here)."""
    user, headers = await member(world)
    snapshot = await snapshot_of(world, user)
    return Seeded("instance-snapshot", snapshot.instance_digest, headers, user["username"], user["id"])


async def seed_study_run(world, public: bool) -> Seeded:
    user, headers = await member(world)
    org, proj = await project_of(world, headers, visibility(public))
    definition = await seal(world.client, headers, org, "Dataset", {"value": uuid.uuid4().hex}, db=world.db)
    study = Study(
        project_id=(await project_row(world, proj)).id, slug="study-a", name="Study A",
        definition_version_id=uuid.UUID(definition["version"]["id"]), created_by_id=uuid.UUID(user["id"]),
    )
    world.db.add(study)
    await world.db.flush()
    digest = random_digest()
    world.db.add(StudyRun(
        study_id=study.id, definition_version_id=study.definition_version_id, run_number=1, matrix_digest=digest,
        created_by_id=uuid.UUID(user["id"]), created_at=OLD,
    ))
    await world.db.flush()
    return Seeded("study_run", digest, headers, user["username"], user["id"], org)


@dataclass(frozen=True)
class Source:
    seeder: Callable[..., Awaitable[Seeded]]
    entity_type: str
    #: The resolve kind of the match, or ``None`` when the citation links to the verifier screen.
    kind: Optional[str]


#: Every source of a verifier match, with the entity type it reports and the kind its citation links to.
SOURCES = {
    "case": Source(seed_case_revision, "case", "case-revision"),
    "collection (library version)": Source(seed_collection_revision, "collection", "collection-revision"),
    "collection (historical revision)": Source(seed_project_collection_revision, "collection", "collection-revision"),
    "report": Source(seed_report, "report", "report"),
    "artifact": Source(seed_artifact, "artifact", "artifact"),
    "engine": Source(seed_engine, "engine", "engine"),
    # The resolver answers a snapshot to its owner only; the verifier answers anyone who sees the match.
    "snapshot": Source(seed_instance_snapshot, "snapshot", None),
    "study_run": Source(seed_study_run, "study_run", None),
}
#: The matches that are a library version which can carry an ``ArtifactPublication``.
PUBLISHABLE = ("collection (library version)", "report")


def expected_url(kind: Optional[str], digest: str) -> str:
    if kind is None:
        return f"{ORIGIN}/app/verifier?digest={digest}"
    return f"{ORIGIN}/resolve/{kind}/{digest}"


async def inspected(world, headers: dict, **payload) -> dict:
    response = await world.client.post(INSPECT, headers=headers, json=payload)
    assert response.status_code == 200, response.text
    return response.json()


async def inspected_file(world, headers: dict, content: bytes) -> dict:
    response = await world.client.post(
        INSPECT_FILE,
        headers={**headers, "x-filename": "f.bin", "content-type": "application/octet-stream"},
        content=content,
    )
    assert response.status_code == 200, response.text
    return response.json()


def assert_links_to(citation: dict, url: str) -> None:
    assert citation["url"] == url
    assert badge_link(citation["markdown_badge"]) == url
    assert dict(parse_entry(citation["bibtex"])[1])["url"] == url
    # Last: without the frontend route table in the checkout this skips.
    assert_is_a_frontend_screen(url.removeprefix(ORIGIN))


def assert_nothing_foreign(body: dict) -> None:
    """No made-up value, no gateway origin and no retired or dead route (``/reports/``, ``/verifier?``)."""
    text = json.dumps(body).replace("/app/verifier?", "/app/<verifier>?")
    for literal in (*INVENTED, GATEWAY, CLIENT_ORIGIN, "/reports/", "/verifier?"):
        assert literal not in text


def assert_cites_recorded_facts_only(body: dict, url: str, authors: list[str]) -> None:
    """``authors`` is the username of the match's recorded author or owner, or ``[]`` when none is recorded."""
    citation = body["citation"]
    assert citation is not None
    assert citation["doi"] is None
    assert citation["venue"] is None
    assert citation["authors"] == authors
    assert citation["year"] == OLD.year
    assert "doi =" not in citation["bibtex"]
    entry = dict(parse_entry(citation["bibtex"])[1])
    assert "doi" not in entry and "howpublished" not in entry
    assert entry["year"] == str(OLD.year)
    assert entry["author"] == " and ".join("{" + name + "}" for name in authors)
    assert_nothing_foreign(body)
    assert_links_to(citation, url)


def comparable(body: dict) -> str:
    """The answer without its clock, with the digest it reports abstracted away."""
    kept = {key: value for key, value in body.items() if key != "verified_at"}
    return json.dumps(kept, sort_keys=True).replace(body["digest"], "<digest>")


# -- a visible match is cited ---------------------------------------------------------


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-year~1]
# [utest->req~resolver-verifier-citation-url~1]
@pytest.mark.parametrize("name", SOURCES)
async def test_every_match_cites_recorded_facts_and_its_link(name, world):
    source = SOURCES[name]
    seeded = await source.seeder(world, public=True)

    body = await inspected(world, seeded.headers, digest=seeded.digest)

    assert body["status"] == "verified"
    assert body["entities"][0]["entity_type"] == source.entity_type
    assert int(body["entities"][0]["created_at"][:4]) == OLD.year
    # Every seeder records its author or owner, so the citation names that user.
    assert_cites_recorded_facts_only(body, expected_url(source.kind, seeded.digest), authors=[seeded.username])


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.skipif(
    bool(os.environ.get("TEST_DATABASE_URL")), reason="an owner that is not recorded needs unenforced foreign keys"
)
async def test_without_a_recorded_owner_the_authors_are_empty(world):
    seeded = await seed_engine(world, public=True, owner=str(uuid.uuid4()))

    body = await inspected(world, seeded.headers, digest=seeded.digest)

    assert body["entities"][0]["entity_type"] == "engine"
    assert_cites_recorded_facts_only(body, expected_url("engine", seeded.digest), authors=[])


#: The matches whose citation links to a permanent link the resolver answers for the same caller.
RESOLVABLE_SOURCES = [name for name, source in SOURCES.items() if source.kind is not None]


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-year~1]
# [utest->req~resolver-verifier-citation-url~1]
@pytest.mark.parametrize("name", RESOLVABLE_SOURCES)
async def test_the_verifier_cites_a_digest_as_the_resolver_does(name, world):
    source = SOURCES[name]
    seeded = await source.seeder(world, public=True)

    verified = (await inspected(world, seeded.headers, digest=seeded.digest))["citation"]
    response = await world.client.get(f"/v1/resolve/{source.kind}/{seeded.digest}", headers=seeded.headers)
    assert response.status_code == 200, response.text
    resolved = response.json()["citation"]

    assert verified["authors"] == resolved["authors"] == [seeded.username]
    assert verified["year"] == resolved["year"] == OLD.year
    assert urlsplit(verified["url"]).path == urlsplit(resolved["url"]).path == f"/resolve/{source.kind}/{seeded.digest}"
    assert verified["url"] == resolved["url"]


# [utest->req~resolver-verifier-citation-url~1]
@pytest.mark.parametrize("name", SOURCES)
async def test_the_trailing_slash_of_the_frontend_origin_is_removed(name, world, monkeypatch):
    # The verifier looks the digest up as sent, so only the configured origin varies here.
    monkeypatch.setattr(get_settings(), "frontend_url", f"{ORIGIN}/")
    source = SOURCES[name]
    seeded = await source.seeder(world, public=True)

    citation = (await inspected(world, seeded.headers, digest=seeded.digest))["citation"]

    assert_links_to(citation, expected_url(source.kind, seeded.digest))
    assert "//resolve" not in json.dumps(citation) and "//app" not in json.dumps(citation)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
async def test_a_mismatch_has_no_citation_even_when_the_claimed_digest_is_visible(world):
    seeded = await seed_case_revision(world, public=True)
    document = {"apiVersion": "bim/v1", "kind": "BindingCase", "title": uuid.uuid4().hex}
    assert canonical_digest(document) != seeded.digest

    body = await inspected(world, seeded.headers, digest=seeded.digest, document=document)

    assert body["status"] == "mismatch" and body["matches"] is False
    assert [entity["entity_type"] for entity in body["entities"]] == ["case"]
    assert body["citation"] is None


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-year~1]
# [utest->req~resolver-verifier-citation-url~1]
@pytest.mark.parametrize("name", PUBLISHABLE)
async def test_a_published_version_is_cited_as_its_publication_records_it(name, world):
    source = SOURCES[name]
    seeded = await source.seeder(world, public=True)
    await publish(world, seeded, CITED)
    _, stranger = await member(world)

    # The publication makes the version visible to anyone with an account: the same citation for both.
    for headers in (seeded.headers, stranger):
        body = await inspected(world, headers, digest=seeded.digest)

        assert body["entities"][0]["entity_type"] == source.entity_type
        assert_cites(body["citation"], CITED)
        assert body["citation"]["authors"] == CITED["authors"]
        assert_nothing_foreign(body)
        assert_links_to(body["citation"], expected_url(source.kind, seeded.digest))


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("name", PUBLISHABLE)
async def test_a_malformed_recorded_doi_is_dropped_and_the_venue_kept(name, world):
    seeded = await SOURCES[name].seeder(world, public=True)
    await publish(world, seeded, {"doi": "not-a-doi", "venue": "V"})

    citation = (await inspected(world, seeded.headers, digest=seeded.digest))["citation"]

    assert citation["doi"] is None
    assert citation["venue"] == "V"
    assert "doi =" not in citation["bibtex"]
    assert dict(parse_entry(citation["bibtex"])[1])["howpublished"] == "V"


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-year~1]
@pytest.mark.parametrize("name", PUBLISHABLE)
async def test_a_publication_of_a_sibling_version_is_not_cited(name, world):
    source = SOURCES[name]
    first = await source.seeder(world, public=True)
    second = await sibling(world, first)
    await publish(world, first, CITED)

    assert_cites((await inspected(world, first.headers, digest=first.digest))["citation"], CITED)
    body = await inspected(world, second.headers, digest=second.digest)
    assert body["entities"][0]["entity_type"] == source.entity_type
    assert_cites_recorded_facts_only(body, expected_url(source.kind, second.digest), authors=[second.username])
    assert "zenodo" not in json.dumps(body)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-year~1]
@pytest.mark.parametrize("name", PUBLISHABLE)
async def test_a_withdrawn_publication_is_not_cited(name, world):
    source = SOURCES[name]
    seeded = await source.seeder(world, public=True)
    await publish(world, seeded, CITED)
    await withdraw(world, seeded)

    body = await inspected(world, seeded.headers, digest=seeded.digest)

    assert_cites_recorded_facts_only(body, expected_url(source.kind, seeded.digest), authors=[seeded.username])
    assert "zenodo" not in json.dumps(body)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("name", PUBLISHABLE)
async def test_a_hostile_recorded_venue_cannot_break_the_bibtex_entry(name, world):
    seeded = await SOURCES[name].seeder(world, public=True)
    await publish(world, seeded, {**CITED, "venue": HOSTILE_VENUE})

    citation = (await inspected(world, seeded.headers, digest=seeded.digest))["citation"]

    key, entries = parse_entry(citation["bibtex"])
    assert [name for name, _ in entries] == BUILDER_FIELDS
    assert KEY.fullmatch(key), key
    assert dict(entries)["howpublished"] == "Proc. , title = X"
    assert citation["venue"] == HOSTILE_VENUE


# [utest->req~resolver-verifier-citation-year~1]
async def test_a_report_citation_is_dated_by_its_version_like_the_resolver_does(world):
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

    body = await inspected(world, seeded.headers, digest=seeded.digest)

    # The match keeps the report row's date; the citation dates the version the digest identifies.
    assert body["entities"][0]["entity_type"] == "report"
    assert int(body["entities"][0]["created_at"][:4]) == filed.year
    assert_cites_recorded_facts_only(body, expected_url("report", seeded.digest), authors=[seeded.username])


# [utest->req~resolver-verifier-citation-url~1]
async def test_a_file_outside_any_project_links_to_the_verifier_screen(world):
    # The resolver finds blobs through their project only, so a project-less blob has no permanent link.
    user, headers = await member(world)
    org, proj = await project_of(world, headers, "private")
    content = f"organization bytes {uuid.uuid4().hex}".encode()
    digest = "sha256-" + hashlib.sha256(content).hexdigest()
    world.db.add(Blob(
        organization_id=(await project_row(world, proj)).organization_id, project_id=None, digest=digest,
        public=False, media_type="application/octet-stream", size_bytes=len(content),
        storage_uri=f"/nonexistent/{uuid.uuid4().hex}", created_by_id=uuid.UUID(user["id"]), created_at=OLD,
    ))
    await world.db.flush()

    body = await inspected(world, headers, digest=digest)

    assert [entity["entity_type"] for entity in body["entities"]] == ["artifact"]
    assert_cites_recorded_facts_only(body, expected_url(None, digest), authors=[user["username"]])


# -- nothing visible, nothing cited ---------------------------------------------------


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("name", SOURCES)
async def test_a_hidden_match_answers_exactly_like_an_unknown_digest(name, world):
    seeded = await SOURCES[name].seeder(world, public=False)
    _, stranger = await member(world)

    # The owner sees it and gets a citation; a stranger cannot tell it from a digest nobody recorded.
    assert (await inspected(world, seeded.headers, digest=seeded.digest))["citation"] is not None
    hidden = await inspected(world, stranger, digest=seeded.digest)
    unknown = await inspected(world, stranger, digest=random_digest())

    assert hidden["citation"] is None and unknown["citation"] is None
    assert hidden["entities"] == [] and hidden["status"] == "not_found"
    assert comparable(hidden) == comparable(unknown)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
@pytest.mark.parametrize("name", PUBLISHABLE)
async def test_the_publication_of_a_sibling_never_leaks_to_a_hidden_version(name, world):
    published_version = await SOURCES[name].seeder(world, public=True)
    hidden = await sibling(world, published_version)
    await publish(world, published_version, CITED)
    _, stranger = await member(world)

    assert_cites((await inspected(world, stranger, digest=published_version.digest))["citation"], CITED)
    answer = await inspected(world, stranger, digest=hidden.digest)
    unknown = await inspected(world, stranger, digest=random_digest())
    assert answer["citation"] is None
    assert comparable(answer) == comparable(unknown)


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
async def test_an_unregistered_digest_or_document_has_no_citation(world):
    _, headers = await member(world)
    document = {"apiVersion": "bim/v1", "kind": "BindingCase", "title": uuid.uuid4().hex}
    computed = canonical_digest(document)

    answers = {
        "not_found": await inspected(world, headers, digest=random_digest()),
        "computed": await inspected(world, headers, document=document),
        "mismatch": await inspected(world, headers, digest=random_digest(), document=document),
        "verified": await inspected(world, headers, digest=computed, document=document),
    }

    for status, body in answers.items():
        assert body["status"] == status, body
        assert body["entities"] == []
        assert body["citation"] is None, status


# -- inspect-file ---------------------------------------------------------------------


async def uploaded_blob(world, public: bool) -> tuple[Seeded, bytes]:
    user, headers = await member(world)
    org, proj = await project_of(world, headers, visibility(public))
    content = f"reproducible bytes {uuid.uuid4().hex}\n".encode()
    uploaded = await world.client.post(
        f"/v1/organizations/{org}/projects/{proj}/blobs?public={str(public).lower()}",
        headers={**headers, "Content-Type": "text/plain"},
        content=content,
    )
    assert uploaded.status_code == 201, uploaded.text
    digest = uploaded.json()["digest"]
    assert digest == "sha256-" + hashlib.sha256(content).hexdigest()
    row = (await world.db.execute(select(Blob).where(Blob.digest == digest))).scalars().one()
    row.created_at = OLD
    await world.db.flush()
    return Seeded("artifact", digest, headers, user["username"], user["id"], org), content


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
# [utest->req~resolver-verifier-citation-year~1]
# [utest->req~resolver-verifier-citation-url~1]
async def test_an_uploaded_file_cites_its_visible_match(world):
    seeded, content = await uploaded_blob(world, public=True)

    body = await inspected_file(world, seeded.headers, content)

    assert body["status"] == "verified" and body["digest"] == seeded.digest
    assert body["entities"][0]["entity_type"] == "artifact"
    assert_cites_recorded_facts_only(body, expected_url("artifact", seeded.digest), authors=[seeded.username])


# [utest->req~resolver-verifier-citation-no-invented-metadata~1]
async def test_a_hidden_file_answers_exactly_like_an_unknown_one(world):
    seeded, content = await uploaded_blob(world, public=False)
    _, stranger = await member(world)

    assert (await inspected_file(world, seeded.headers, content))["citation"] is not None
    # The detail names the size of the upload, so the unknown file has the same length.
    other = f"reproducible bytes {uuid.uuid4().hex}\n".encode()
    assert len(other) == len(content)
    hidden = await inspected_file(world, stranger, content)
    unknown = await inspected_file(world, stranger, other)

    assert hidden["citation"] is None and unknown["citation"] is None
    assert hidden["entities"] == [] and hidden["status"] == unknown["status"] == "computed"
    assert comparable(hidden) == comparable(unknown)
