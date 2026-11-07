"""A stored composition, over the wire: the identity, its sealed versions, and the diff.

Phase F2. ``routes/compositions.py`` was written when nothing stored a composition, and it
made a promise in its own docstring: that the stored-version diff would be *"an addition
here, not a rewrite: the response body does not change"*. The last test is that promise,
measured -- the same pair of documents compared through the two-body ``POST`` and through
two sealed versions returns byte-identical JSON.

The surface lives under a project because every other artifact kind does. A composition at
the root would have been the one artifact that reimplemented the organization scoping and
the role checks ``require_project`` already gives.
"""

from __future__ import annotations

import uuid

import pytest

from _b1_helpers import gate, make_account, make_org  # noqa: F401,F811

SOURCE = """\
# The guiding case, cut down to what section 2 makes mandatory.
composition: fleet
version: "1.0.0"
properties:
  cost:
    unit: USD/month
    direction: minimize
    domain: {min: 0, max: 100}
    aggregate:
      sequence: sum
      parallel: sum
      exclusive: weightedSum
      repeat: scale
      selection: sum
tasks:
  pick: {open: true, requires: service/pick}
workflow:
  sequence: [{task: pick}]
candidates:
  rows:
    - {id: c_pick, provides: service/pick, properties: {cost: 10}}
goals:
  - property: cost
"""

#: The same composition with the goal's range moved -- the change the old compare screen
#: rendered as "Same", which is why the typed diff exists at all.
LATER = SOURCE.replace("  - property: cost", "  - property: cost\n    normalize: {min: 0, max: 50}")


@pytest.fixture
async def project(api_client, registration, db_session, gate):  # noqa: F811
    account, headers = await make_account(api_client, registration, db_session, gate)
    organization = await make_org(api_client, headers)
    created = await api_client.post(
        f"/v1/organizations/{organization['slug']}/projects", headers=headers,
        json={"slug": "studio", "name": "studio", "visibility": "private"},
    )
    assert created.status_code == 201, created.text
    return {
        "url": f"/v1/organizations/{organization['slug']}/projects/studio",
        "headers": headers,
        "user_id": uuid.UUID(account["id"]),
    }


async def _composition(api_client, project, slug: str = "fleet") -> dict:
    created = await api_client.post(
        f"{project['url']}/compositions", headers=project["headers"],
        json={"slug": slug, "name": "Fleet management", "description": "The guiding case."},
    )
    assert created.status_code == 201, created.text
    return created.json()


async def _seal(api_client, project, slug: str, source: str, **extra) -> dict:
    created = await api_client.post(
        f"{project['url']}/compositions/{slug}/versions", headers=project["headers"],
        json={"source": source, **extra},
    )
    assert created.status_code == 201, created.text
    return created.json()


async def test_an_identity_exists_before_it_holds_a_version(api_client, project) -> None:
    """A name to cite before there is anything to cite, which is what a new document needs."""
    created = await _composition(api_client, project)
    assert created["slug"] == "fleet"
    assert created["latest_version"] is None

    listed = await api_client.get(f"{project['url']}/compositions", headers=project["headers"])
    assert listed.status_code == 200
    assert [row["slug"] for row in listed.json()] == ["fleet"]


async def test_a_sealed_version_comes_back_byte_for_byte(api_client, project) -> None:
    """Including the comment, which is the whole reason the source is what is stored."""
    await _composition(api_client, project)
    sealed = await _seal(api_client, project, "fleet", SOURCE)
    assert sealed["ordinal"] == 1
    assert sealed["version"] == "1"

    content = await api_client.get(
        f"{project['url']}/compositions/fleet/versions/1/content", headers=project["headers"],
    )
    assert content.status_code == 200
    assert content.text == SOURCE
    assert "The guiding case, cut down" in content.text, "a comment the model cannot hold"
    assert content.headers["etag"] == f'"{sealed["content_digest"]}"'


async def test_resealing_an_unchanged_document_seals_nothing_new(api_client, project) -> None:
    """The content digest is over the exact bytes, so "unchanged" is measurable.

    SPHERE refuses a *changed* published version; this refuses an *unchanged* new one. Both
    are the same property seen from opposite sides: a version identifies its bytes.
    """
    await _composition(api_client, project)
    first = await _seal(api_client, project, "fleet", SOURCE)
    again = await _seal(api_client, project, "fleet", SOURCE)
    assert again["id"] == first["id"]
    assert again["ordinal"] == 1

    versions = await api_client.get(
        f"{project['url']}/compositions/fleet/versions", headers=project["headers"],
    )
    assert len(versions.json()) == 1, "one version, not two of the same document"


async def test_versions_are_ordered_by_ordinal_newest_first(api_client, project) -> None:
    """The server's order, not the document's. Two sealed in one second would tie on a date."""
    await _composition(api_client, project)
    await _seal(api_client, project, "fleet", SOURCE)
    await _seal(api_client, project, "fleet", LATER)

    listed = await api_client.get(
        f"{project['url']}/compositions/fleet/versions", headers=project["headers"],
    )
    assert [row["ordinal"] for row in listed.json()] == [2, 1]

    identity = await api_client.get(
        f"{project['url']}/compositions/fleet", headers=project["headers"],
    )
    assert identity.json()["latest_version"] == 2


async def test_a_label_that_names_different_content_is_refused(api_client, project) -> None:
    """Otherwise one name would answer for two compositions."""
    await _composition(api_client, project)
    await _seal(api_client, project, "fleet", SOURCE, version="1.0.0")
    clash = await api_client.post(
        f"{project['url']}/compositions/fleet/versions", headers=project["headers"],
        json={"source": LATER, "version": "1.0.0"},
    )
    assert clash.status_code == 409
    assert "immutable_version" in clash.text


async def test_a_document_that_is_not_a_composition_is_refused(api_client, project) -> None:
    """Refused before anything is sealed, and by name."""
    await _composition(api_client, project)
    refused = await api_client.post(
        f"{project['url']}/compositions/fleet/versions", headers=project["headers"],
        json={"source": "composition: fleet\n"},
    )
    assert refused.status_code == 422
    assert "invalid_composition" in refused.text


async def test_a_version_may_be_based_on_another_composition_s_version(api_client, project) -> None:
    """A fork is this edge crossing artifacts, and it needs no new column to express."""
    await _composition(api_client, project, "fleet")
    origin = await _seal(api_client, project, "fleet", SOURCE)

    await _composition(api_client, project, "fleet-fork")
    forked = await _seal(api_client, project, "fleet-fork", LATER, based_on=origin["id"])
    assert forked["based_on_id"] == origin["id"]
    assert forked["composition_id"] != origin["composition_id"]


async def test_an_unknown_origin_is_the_caller_s_mistake(api_client, project) -> None:
    await _composition(api_client, project)
    refused = await api_client.post(
        f"{project['url']}/compositions/fleet/versions", headers=project["headers"],
        json={"source": SOURCE, "based_on": str(uuid.uuid4())},
    )
    assert refused.status_code == 422
    assert "unknown_origin" in refused.text


async def test_the_two_diff_forms_return_the_same_body(api_client, project) -> None:
    """The promise the module made before any of this existed, measured.

    ``routes/compositions.py`` said the stored-version form would be "an addition here, not
    a rewrite: the response body does not change". Both forms build their response through
    one helper, so this compares the JSON rather than trusting that two handlers agree.
    """
    await _composition(api_client, project)
    await _seal(api_client, project, "fleet", SOURCE)
    await _seal(api_client, project, "fleet", LATER)

    stored = await api_client.get(
        f"{project['url']}/compositions/fleet/diff", headers=project["headers"],
        params={"from": "1", "to": "2"},
    )
    assert stored.status_code == 200, stored.text
    bodies = await api_client.post(
        "/v1/compositions/diff", headers=project["headers"],
        json={"before": SOURCE, "after": LATER},
    )
    assert bodies.status_code == 200, bodies.text
    assert stored.json() == bodies.json()

    changes = stored.json()
    assert changes["identical"] is False
    assert ("goals", "cost.normalize") in {
        (row["section"], row["subject"]) for row in changes["changes"]
    }, "the change the old compare screen rendered as Same"


async def test_a_version_the_composition_does_not_have_is_a_404(api_client, project) -> None:
    await _composition(api_client, project)
    await _seal(api_client, project, "fleet", SOURCE)
    missing = await api_client.get(
        f"{project['url']}/compositions/fleet/diff", headers=project["headers"],
        params={"from": "1", "to": "9"},
    )
    assert missing.status_code == 404
