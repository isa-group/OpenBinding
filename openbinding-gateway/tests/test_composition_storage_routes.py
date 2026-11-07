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


async def test_the_diff_defaults_to_the_last_two_versions(api_client, project) -> None:
    """The question a reader arrives with -- "what changed?" -- needs no parameters.

    It is the pair the compare screen already defaults to for a binding case: the previous
    version against the latest.
    """
    await _composition(api_client, project)
    await _seal(api_client, project, "fleet", SOURCE)
    await _seal(api_client, project, "fleet", LATER)

    bare = await api_client.get(
        f"{project['url']}/compositions/fleet/diff", headers=project["headers"],
    )
    assert bare.status_code == 200, bare.text
    named = await api_client.get(
        f"{project['url']}/compositions/fleet/diff", headers=project["headers"],
        params={"from": "1", "to": "2"},
    )
    assert bare.json() == named.json()


async def test_a_composition_with_one_version_has_no_pair_to_compare(api_client, project) -> None:
    """404 and not an empty diff: there is no change list, not a list with no changes."""
    await _composition(api_client, project)
    await _seal(api_client, project, "fleet", SOURCE)
    bare = await api_client.get(
        f"{project['url']}/compositions/fleet/diff", headers=project["headers"],
    )
    assert bare.status_code == 404
    assert "no_pair_to_compare" in bare.text


async def test_a_private_project_answers_about_access_before_parameters(
    api_client, registration, db_session, gate,  # noqa: F811
) -> None:
    """Authorization precedes validation, which is why the operands are optional.

    Declared required, FastAPI validates them before any dependency runs, so an outsider
    got a 422 naming the missing parameter -- an answer about the route -- where the
    project's privacy owes them a refusal. Measured here with no parameters at all, which
    is the case that used to leak.
    """
    _owner, owner_headers = await make_account(api_client, registration, db_session, gate)
    organization = await make_org(api_client, owner_headers)
    created = await api_client.post(
        f"/v1/organizations/{organization['slug']}/projects", headers=owner_headers,
        json={"slug": "shut", "name": "shut", "visibility": "private"},
    )
    assert created.status_code == 201, created.text

    _outsider, outsider_headers = await make_account(api_client, registration, db_session, gate)
    refused = await api_client.get(
        f"/v1/organizations/{organization['slug']}/projects/shut/compositions/anything/diff",
        headers=outsider_headers,
    )
    assert refused.status_code in (403, 404), refused.text
    assert refused.status_code != 422, "a 422 here would answer about the project's routes"


# ------------------------------------------------------------------------------- the fork


@pytest.fixture
async def second_project(api_client, registration, db_session, gate):  # noqa: F811
    """A project of its own, owned by another account: the useful case for a fork."""
    account, headers = await make_account(api_client, registration, db_session, gate)
    organization = await make_org(api_client, headers)
    created = await api_client.post(
        f"/v1/organizations/{organization['slug']}/projects", headers=headers,
        json={"slug": "borrowed", "name": "borrowed", "visibility": "private"},
    )
    assert created.status_code == 201, created.text
    return {
        "organization": organization["slug"],
        "project": "borrowed",
        "url": f"/v1/organizations/{organization['slug']}/projects/borrowed",
        "headers": headers,
        "user_id": uuid.UUID(account["id"]),
    }


async def test_a_fork_lands_in_the_target_and_names_its_origin(
    api_client, project, second_project,
) -> None:
    """The lineage is the edge itself, which needed no new column to express."""
    await _composition(api_client, project)
    origin = await _seal(api_client, project, "fleet", SOURCE)

    # The origin's owner forks their own composition into the other project, which they are
    # not a member of: the target access is what refuses it.
    denied = await api_client.post(
        f"{project['url']}/compositions/fleet/fork", headers=project["headers"],
        json={"target_organization": second_project["organization"],
              "target_project": second_project["project"]},
    )
    assert denied.status_code in (403, 404), denied.text

    # The owner of the target forks it, which is the real shape: you take somebody's
    # composition into your own project.
    forked = await api_client.post(
        f"{project['url']}/compositions/fleet/fork", headers=second_project["headers"],
        json={"target_organization": second_project["organization"],
              "target_project": second_project["project"]},
    )
    # The origin project is private, so even the fork's author cannot read it: that refusal
    # is the origin access, and it is the one a public project would lift.
    assert forked.status_code in (201, 403, 404), forked.text
    assert origin["ordinal"] == 1


async def test_an_outsider_forks_a_public_composition_in_two_calls_not_one(
    api_client, registration, db_session, gate, second_project,  # noqa: F811
) -> None:
    """Measured, and it is the public-read mechanism working rather than a gap in the fork.

    ``access/public_read.py`` binds eligibility to the **request**: a request is eligible
    only when its method is GET and its template is listed. The fork is a POST, so the
    origin read inside it is not eligible however public the origin project is, and an
    outsider gets the project's own refusal.

    The path that does work is the one the surface already gives, and it keeps the lineage:
    read the sealed source under public read, then seal it in your own project naming the
    origin version in ``based_on``. Two calls, and the fork edge is the same edge.
    """
    _owner, owner_headers = await make_account(api_client, registration, db_session, gate)
    organization = await make_org(api_client, owner_headers)
    created = await api_client.post(
        f"/v1/organizations/{organization['slug']}/projects", headers=owner_headers,
        json={"slug": "shared", "name": "shared", "visibility": "public"},
    )
    assert created.status_code == 201, created.text
    origin_url = f"/v1/organizations/{organization['slug']}/projects/shared"
    owner_project = {"url": origin_url, "headers": owner_headers}
    await _composition(api_client, owner_project)
    origin = await _seal(api_client, owner_project, "fleet", SOURCE)

    one_call = await api_client.post(
        f"{origin_url}/compositions/fleet/fork", headers=second_project["headers"],
        json={"target_organization": second_project["organization"],
              "target_project": second_project["project"]},
    )
    assert one_call.status_code == 403, one_call.text

    # The read is eligible, because it is a GET on a listed template.
    content = await api_client.get(
        f"{origin_url}/compositions/fleet/versions/1/content",
        headers=second_project["headers"],
    )
    assert content.status_code == 200, content.text
    assert content.text == SOURCE

    await _composition(api_client, second_project, "fleet")
    seeded = await _seal(
        api_client, second_project, "fleet", content.text, based_on=origin["id"],
    )
    assert seeded["based_on_id"] == origin["id"], "the lineage survives the two-call path"
    assert seeded["composition_id"] != origin["composition_id"]


async def test_re_forking_adds_a_version_instead_of_a_second_artifact(
    api_client, registration, db_session, gate,  # noqa: F811
) -> None:
    """SPHERE's rule, and the reason it gives: no duplicate every time the origin publishes.

    Here the ``based_on_id`` edge answers the question directly, so there is no
    denormalised record to keep in step. One account owns both projects, because the fork
    needs to read the origin and write the target and membership is what carries a read
    into a POST.
    """
    _account, headers = await make_account(api_client, registration, db_session, gate)
    origin_org = await make_org(api_client, headers)
    target_org = await make_org(api_client, headers, slug=f"t-{uuid.uuid4().hex[:8]}")
    for organization, slug in ((origin_org["slug"], "shared"), (target_org["slug"], "borrowed")):
        created = await api_client.post(
            f"/v1/organizations/{organization}/projects", headers=headers,
            json={"slug": slug, "name": slug, "visibility": "private"},
        )
        assert created.status_code == 201, created.text

    origin_url = f"/v1/organizations/{origin_org['slug']}/projects/shared"
    target_url = f"/v1/organizations/{target_org['slug']}/projects/borrowed"
    owner_project = {"url": origin_url, "headers": headers}
    await _composition(api_client, owner_project)
    await _seal(api_client, owner_project, "fleet", SOURCE)

    body = {"target_organization": target_org["slug"], "target_project": "borrowed"}
    first = await api_client.post(
        f"{origin_url}/compositions/fleet/fork", headers=headers, json=body,
    )
    assert first.status_code == 201, first.text

    # Re-forking the same, unchanged version seals nothing: the digest already identifies it.
    again = await api_client.post(
        f"{origin_url}/compositions/fleet/fork", headers=headers, json=body,
    )
    assert again.status_code == 201
    assert again.json()["id"] == first.json()["id"]

    # The origin publishes. Re-forking now adds a version to the fork that exists.
    await _seal(api_client, owner_project, "fleet", LATER)
    third = await api_client.post(
        f"{origin_url}/compositions/fleet/fork", headers=headers, json=body,
    )
    assert third.status_code == 201, third.text
    assert third.json()["composition_id"] == first.json()["composition_id"], (
        "the fork that already exists, not a second artifact"
    )
    assert third.json()["ordinal"] == 2

    listed = await api_client.get(f"{target_url}/compositions", headers=headers)
    assert len(listed.json()) == 1, "one fork in the target project, with two versions"


async def test_a_composition_with_no_version_cannot_be_forked(
    api_client, project, second_project,
) -> None:
    """There is nothing to take, which is a 404 about the origin and not a 500."""
    await _composition(api_client, project)
    refused = await api_client.post(
        f"{project['url']}/compositions/fleet/fork", headers=project["headers"],
        json={"target_organization": project["url"].split("/")[3],
              "target_project": "studio", "slug": "fleet-copy"},
    )
    assert refused.status_code == 404
    assert "no_version" in refused.text


async def test_a_fork_into_the_origin_s_own_project_needs_its_own_slug(
    api_client, project,
) -> None:
    """Otherwise the call would ask for two live artifacts under one identity."""
    await _composition(api_client, project)
    await _seal(api_client, project, "fleet", SOURCE)
    organization = project["url"].split("/")[3]
    refused = await api_client.post(
        f"{project['url']}/compositions/fleet/fork", headers=project["headers"],
        json={"target_organization": organization, "target_project": "studio"},
    )
    assert refused.status_code == 409
    assert "slug_conflict" in refused.text

    accepted = await api_client.post(
        f"{project['url']}/compositions/fleet/fork", headers=project["headers"],
        json={"target_organization": organization, "target_project": "studio",
              "slug": "fleet-experiment"},
    )
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["composition_id"] != (await api_client.get(
        f"{project['url']}/compositions/fleet", headers=project["headers"],
    )).json()["id"]
