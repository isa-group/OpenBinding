"""B3 #6: a public project is readable (GET only) by people who are not members.

The matrix lives in ``openbinding_gateway.access.public_read``; these tests walk the
real FastAPI route table, so a project route added later without being classified
fails here instead of silently becoming reachable.
"""

from __future__ import annotations

import re
import uuid
from types import SimpleNamespace

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import func, select

from _b1_helpers import (  # noqa: F401
    add_case_revision,
    add_version,
    gate,
    make_account,
    make_key,
    make_org,
    put_member,
    random_digest,
)
from _repo import REPO_ROOT
from openbinding_gateway.access import public_read
from openbinding_gateway.access.public_read import (
    PROJECT,
    PUBLIC_READ_ALLOWED,
    PUBLIC_READ_DENIED_GET,
    eligible,
)
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import (
    Artifact,
    ArtifactDraft,
    ArtifactPublication,
    BindingCase,
    Blob,
    Job,
    Project,
    ProjectArtifact,
    Publication,
    Report,
    ReportState,
    Visibility,
)
from openbinding_gateway.main import app


def project_routes() -> list[tuple[str, str]]:
    found = set()
    for included in app.routes:
        original = getattr(included, "original_router", None)
        for route in original.routes if original is not None else [included]:
            if isinstance(route, APIRoute) and route.path.startswith(PROJECT):
                found.update((method, route.path) for method in route.methods - {"HEAD", "OPTIONS"})
    return sorted(found)


ROUTES = project_routes()


def concrete(template: str, org: str, project: str) -> str:
    values = {"org": org, "project": project, "revision": "1", "digest_value": "sha256-" + "0" * 64}

    def fill(match: re.Match) -> str:
        name = match.group(1)
        if name in values:
            return values[name]
        return str(uuid.uuid4()) if name.endswith("_id") else "nothing-here"

    return re.sub(r"{(\w+)}", fill, template)


@pytest.fixture(autouse=True)
def fresh_rate_limits():
    public_read.reset_rate_limits()
    yield
    public_read.reset_rate_limits()


@pytest.fixture
async def ctx(api_client, registration, db_session, gate):  # noqa: F811
    owner, owner_h = await make_account(api_client, registration, db_session, gate)
    vera, vera_h = await make_account(api_client, registration, db_session, gate)
    mike, mike_h = await make_account(api_client, registration, db_session, gate)
    carol, carol_h = await make_account(api_client, registration, db_session, gate)
    organization = await make_org(api_client, owner_h)
    slug = organization["slug"]
    assert (await put_member(api_client, owner_h, slug, vera["id"], "VIEWER")).status_code == 200
    assert (await put_member(api_client, owner_h, slug, mike["id"], "MEMBER")).status_code == 200
    projects = {}
    for name, visibility in (("open", "public"), ("closed", "private")):
        created = await api_client.post(
            f"/v1/organizations/{slug}/projects", headers=owner_h,
            json={"slug": name, "name": name.title(), "description": f"The {name} one", "visibility": visibility},
        )
        assert created.status_code == 201, created.text
        projects[name] = uuid.UUID(created.json()["id"])
    read_perms = ["projects:read", "studies:read", "reports:read", "artifacts:read"]
    write_perms = ["projects:write", "studies:write", "reports:write", "artifacts:write"]
    c = SimpleNamespace(
        client=api_client, db=db_session, gate=gate, slug=slug, org_id=uuid.UUID(organization["id"]),
        owner=owner, user_id=uuid.UUID(owner["id"]), vera=vera, mike=mike, carol=carol,
        project_id=projects["open"], closed_id=projects["closed"],
        url=f"/v1/organizations/{slug}/projects/open",
        closed_url=f"/v1/organizations/{slug}/projects/closed",
        callers={
            "anonymous": {},
            "outsider": carol_h,
            "api_key": await make_key(api_client, carol_h, read_perms),
            "viewer": vera_h,
            "member": mike_h,
            "owner": owner_h,
        },
        write_key=await make_key(api_client, carol_h, read_perms + write_perms),
    )

    # Content of the public project.
    revision = await add_case_revision(db_session, c, digest=random_digest())
    case = await db_session.get(BindingCase, revision.binding_case_id)
    c.case, c.revision_digest = case.slug, revision.digest
    resource = await api_client.post(
        f"{c.url}/resources", headers=owner_h,
        json={"slug": "providers", "name": "Providers", "kind": "qos-offerings"},
    )
    assert resource.status_code == 201, resource.text
    assert (await api_client.post(
        f"{c.url}/resources/providers/revisions", headers=owner_h,
        json={"document": {"apiVersion": "openbinding.dev/qos-binding/v1", "providers": ["alpha"]}},
    )).status_code == 201
    assert (await api_client.post(
        f"{c.url}/collections", headers=owner_h, json={"slug": "coll", "name": "Collection"},
    )).status_code == 201
    octets = {"Content-Type": "application/octet-stream"}
    c.public_blob = (await api_client.post(
        f"{c.url}/blobs?public=true", headers={**owner_h, **octets}, content=b"public bytes"
    )).json()["digest"]
    c.private_blob = (await api_client.post(
        f"{c.url}/blobs", headers={**owner_h, **octets}, content=b"private bytes"
    )).json()["digest"]

    async def report(slug_: str, state: ReportState, *, publication: str | None = None):
        artifact, version = await add_version(db_session, c, kind="Report", content_digest=random_digest())
        draft = ArtifactDraft(
            artifact_id=artifact.id, created_by_id=c.user_id, payload={"content": {"note": slug_}}
        )
        db_session.add(draft)
        await db_session.flush()
        row = Report(
            project_id=c.project_id, artifact_id=artifact.id, draft=draft, slug=slug_,
            title=slug_, state=state, created_by_id=c.user_id,
        )
        db_session.add(row)
        await db_session.flush()
        if publication:
            db_session.add(Publication(
                project_id=c.project_id, report_id=row.id, version_id=version.id, slug=publication,
                citation={"title": slug_}, published_by_id=c.user_id, withdrawn=publication == "gone",
            ))
            await db_session.flush()

    await report("the-draft", ReportState.DRAFT)
    await report("frozen-private", ReportState.FROZEN)
    await report("frozen-public", ReportState.FROZEN, publication="live")
    await report("frozen-withdrawn", ReportState.FROZEN, publication="gone")

    published, published_version = await add_version(
        db_session, c, kind="Dataset", content_digest=random_digest(), project_id=c.project_id
    )
    db_session.add(ArtifactPublication(version_id=published_version.id, published_by_id=c.user_id, citation={}))
    hidden, _ = await add_version(
        db_session, c, kind="Dataset", content_digest=random_digest(), project_id=c.project_id
    )
    await db_session.flush()
    c.published_artifact, c.hidden_artifact = published.name, hidden.name
    return c


async def get(c, who: str, url: str, **kwargs):
    return await c.client.get(url, headers=c.callers[who], **kwargs)


VISITORS = ("anonymous", "outsider", "api_key")


# --- the matrix ------------------------------------------------------------------


def test_the_route_table_has_the_project_surface():
    methods = {method for method, _ in ROUTES}
    assert len(ROUTES) > 40
    assert {"GET", "POST", "PUT", "PATCH", "DELETE"} <= methods


def test_every_get_route_is_classified_exactly_once():
    gets = {path for method, path in ROUTES if method == "GET"}
    assert gets == set(PUBLIC_READ_ALLOWED) | set(PUBLIC_READ_DENIED_GET), (
        "classify new project routes in access/public_read.py (and docs/ACCESS_POLICY.md)"
    )
    assert not set(PUBLIC_READ_ALLOWED) & set(PUBLIC_READ_DENIED_GET)


def test_nothing_but_get_is_ever_eligible():
    for method, path in ROUTES:
        assert eligible(method, path) is (method == "GET" and path in PUBLIC_READ_ALLOWED), (method, path)
    for method in ("POST", "PUT", "PATCH", "DELETE", "HEAD"):
        assert not eligible(method, PROJECT)


@pytest.mark.parametrize("who", VISITORS)
async def test_every_route_follows_the_matrix_for_non_members(ctx, who):
    """Walk the whole route table as a visitor, on a public and on a private project."""
    c = ctx
    refusal = 401 if who == "anonymous" else 403
    checked = 0
    for method, template in ROUTES:
        headers = c.write_key if (who == "api_key" and method != "GET") else c.callers[who]
        label = f"{method} {template}"
        public = await c.client.request(method, concrete(template, c.slug, "open"), headers=headers, json={})
        private = await c.client.request(method, concrete(template, c.slug, "closed"), headers=headers, json={})
        if eligible(method, template):
            # It reached the handler: data or a plain "not found", never an access refusal.
            assert public.status_code in (200, 404), (label, public.status_code, public.text)
        else:
            # A write with an invalid body may fail validation first; it never succeeds.
            allowed = {refusal} | ({422} if who != "anonymous" and method != "GET" else set())
            assert public.status_code in allowed, (label, public.status_code, public.text)
        # A private project refuses every route the way it always did.
        allowed = {refusal} | ({422} if who != "anonymous" and method != "GET" else set())
        assert private.status_code in allowed, (label, private.status_code, private.text)
        checked += 1
    assert checked == len(ROUTES)


async def test_denied_reads_look_exactly_like_a_private_project(ctx):
    c = ctx
    for who, status in (("outsider", 403), ("api_key", 403), ("anonymous", 401)):
        for suffix in ("/jobs", "/package"):
            public = await get(c, who, f"{c.url}{suffix}")
            private = await get(c, who, f"{c.closed_url}{suffix}")
            ghost = await get(c, who, f"/v1/organizations/{c.slug}/projects/ghost{suffix}")
            assert public.status_code == private.status_code == ghost.status_code == status
            assert public.json() == private.json() == ghost.json()
            if status == 403:
                assert public.json()["detail"]["code"] == "organization_forbidden"


# --- the project, by role --------------------------------------------------------------


async def test_the_project_says_how_the_caller_reaches_it(ctx):
    c = ctx
    expected = {
        "anonymous": ("public_read", None),
        "outsider": ("public_read", None),
        "api_key": ("public_read", None),
        "viewer": ("member", "VIEWER"),
        "member": ("member", "MEMBER"),
        "owner": ("member", "OWNER"),
    }
    for who, (access, role) in expected.items():
        response = await get(c, who, c.url)

        assert response.status_code == 200, (who, response.text)
        body = response.json()
        assert body["access"] == access, who
        assert body["effective_role"] == role, who
        assert body["slug"] == "open" and body["visibility"] == "public"
        assert body["description"] == "The open one"
        for field in ("id", "organization_id", "name", "created_at", "updated_at"):
            assert field in body
        if access == "public_read":
            assert body["created_by_id"] is None  # not disclosed to visitors
        else:
            assert body["created_by_id"] == str(c.user_id)  # members see what they always saw


async def test_the_project_list_and_create_report_the_members_role(ctx):
    c = ctx
    listed = await get(c, "viewer", f"/v1/organizations/{c.slug}/projects")
    assert {(item["slug"], item["access"], item["effective_role"]) for item in listed.json()} == {
        ("open", "member", "VIEWER"), ("closed", "member", "VIEWER"),
    }
    created = await c.client.post(
        f"/v1/organizations/{c.slug}/projects", headers=c.callers["owner"],
        json={"slug": "third", "name": "Third", "visibility": "private"},
    )
    assert created.status_code == 201
    assert created.json()["access"] == "member" and created.json()["effective_role"] == "OWNER"


async def test_a_private_project_is_unchanged_for_non_members(ctx):
    c = ctx
    outsider = await get(c, "outsider", c.closed_url)
    key = await get(c, "api_key", c.closed_url)
    anonymous = await get(c, "anonymous", c.closed_url)
    ghost = await get(c, "outsider", f"/v1/organizations/{c.slug}/projects/ghost")
    member = await get(c, "viewer", c.closed_url)

    assert outsider.status_code == key.status_code == ghost.status_code == 403
    assert outsider.json() == ghost.json()  # no way to tell a private project from a missing one
    assert outsider.json()["detail"]["code"] == "organization_forbidden"
    assert anonymous.status_code == 401
    assert member.status_code == 200 and member.json()["access"] == "member"
    # The project list and the organization stay members-only, anonymous included.
    for url in (f"/v1/organizations/{c.slug}", f"/v1/organizations/{c.slug}/projects",
                f"/v1/organizations/{c.slug}/members"):
        assert (await get(c, "outsider", url)).status_code == 403
        assert (await get(c, "anonymous", url)).status_code == 401


async def test_flipping_the_visibility_takes_effect_at_once(ctx):
    c = ctx
    assert (await get(c, "outsider", f"{c.url}/cases")).status_code == 200
    made_private = await c.client.patch(c.url, headers=c.callers["owner"], json={"visibility": "private"})
    assert made_private.status_code == 200
    assert made_private.json()["access"] == "member" and made_private.json()["effective_role"] == "OWNER"
    assert (await get(c, "outsider", f"{c.url}/cases")).status_code == 403
    assert (await get(c, "anonymous", c.url)).status_code == 401
    await c.client.patch(c.url, headers=c.callers["owner"], json={"visibility": "public"})
    assert (await get(c, "outsider", c.url)).json()["access"] == "public_read"


# --- what a visitor reads ------------------------------------------------------------


async def test_the_allowed_reads_return_the_project_data(ctx):
    c = ctx
    for who in VISITORS:
        cases = await get(c, who, f"{c.url}/cases")
        case = await get(c, who, f"{c.url}/cases/{c.case}")
        revisions = await get(c, who, f"{c.url}/cases/{c.case}/revisions")
        revision = await get(c, who, f"{c.url}/cases/{c.case}/revisions/1")
        resources = await get(c, who, f"{c.url}/resources")
        resource = await get(c, who, f"{c.url}/resources/providers")
        resource_revisions = await get(c, who, f"{c.url}/resources/providers/revisions")
        resource_revision = await get(c, who, f"{c.url}/resources/providers/revisions/1")
        collections = await get(c, who, f"{c.url}/collections")
        collection = await get(c, who, f"{c.url}/collections/coll")
        collection_revisions = await get(c, who, f"{c.url}/collections/coll/revisions")
        studies = await get(c, who, f"{c.url}/studies")
        missing_run = await get(c, who, f"{c.url}/studies/nope/runs")

        for response in (cases, case, revisions, revision, resources, resource, resource_revisions,
                         resource_revision, collections, collection, collection_revisions, studies):
            assert response.status_code == 200, (who, str(response.url), response.text)
        assert [item["slug"] for item in cases.json()] == [c.case]
        assert revisions.json()[0]["digest"] == c.revision_digest
        assert revision.json()["digest"] == c.revision_digest
        assert "providers" in {item["slug"] for item in resources.json()}
        assert resource_revisions.json()[0]["document"]["providers"] == ["alpha"]
        assert [item["slug"] for item in collections.json()] == ["coll"]
        assert studies.json() == []
        assert missing_run.status_code == 404 and missing_run.json()["detail"]["code"] == "not_found"


async def test_reports_are_only_the_frozen_ones_with_a_live_publication(ctx):
    c = ctx
    for who in VISITORS:
        listed = await get(c, who, f"{c.url}/reports")
        assert [item["slug"] for item in listed.json()] == ["frozen-public"], who
        assert listed.json()[0]["state"] == "frozen"
        assert (await get(c, who, f"{c.url}/reports/frozen-public")).status_code == 200
        hidden = [await get(c, who, f"{c.url}/reports/{slug}") for slug in
                  ("the-draft", "frozen-private", "frozen-withdrawn", "no-such-report")]
        assert {response.status_code for response in hidden} == {404}
        assert len({str(response.json()) for response in hidden}) == 1  # indistinguishable from a missing one
    # Members keep seeing everything, drafts included.
    for who in ("viewer", "member", "owner"):
        slugs = {item["slug"] for item in (await get(c, who, f"{c.url}/reports")).json()}
        assert slugs == {"the-draft", "frozen-private", "frozen-public", "frozen-withdrawn"}
        assert (await get(c, who, f"{c.url}/reports/the-draft")).status_code == 200


async def test_publications_exclude_the_withdrawn_for_visitors_only(ctx):
    c = ctx
    for who in ("anonymous", "outsider"):
        assert [item["slug"] for item in (await get(c, who, f"{c.url}/publications")).json()] == ["live"]
    for who in ("viewer", "owner"):
        slugs = {item["slug"] for item in (await get(c, who, f"{c.url}/publications")).json()}
        assert slugs == {"live", "gone"}


async def test_files_are_listed_and_downloaded_only_when_public(ctx):
    c = ctx
    for who in VISITORS:
        listed = await get(c, who, f"{c.url}/blobs")
        assert [item["digest"] for item in listed.json()] == [c.public_blob], who
        assert listed.json()[0]["public"] is True
        download = await get(c, who, f"{c.url}/blobs/{c.public_blob}")
        assert download.status_code == 200 and download.content == b"public bytes"
        private = await get(c, who, f"{c.url}/blobs/{c.private_blob}")
        absent = await get(c, who, f"{c.url}/blobs/sha256-{'f' * 64}")
        assert private.status_code == absent.status_code == 404
        assert private.json() == absent.json()
    owner_view = {item["digest"] for item in (await get(c, "owner", f"{c.url}/blobs")).json()}
    assert owner_view == {c.public_blob, c.private_blob}
    assert (await get(c, "viewer", f"{c.url}/blobs/{c.private_blob}")).content == b"private bytes"


async def test_the_library_shows_only_published_artifacts_to_visitors(ctx):
    c = ctx
    for who in VISITORS:
        names = {item["name"] for item in (await get(c, who, f"{c.url}/library")).json()}
        assert names == {c.published_artifact}, who
    for who in ("viewer", "member", "owner"):
        names = {item["name"] for item in (await get(c, who, f"{c.url}/library")).json()}
        assert {c.published_artifact, c.hidden_artifact} <= names


async def test_a_foreign_artifact_that_is_not_published_does_not_show_through(ctx):
    c = ctx
    # Carol owns another organization whose artifact the project associated while it was
    # published. Once it is withdrawn, neither the library nor the resources show it to
    # visitors, and carol's membership of that organization does not make her one here.
    other = await make_org(c.client, c.callers["outsider"])
    foreign = SimpleNamespace(org_id=uuid.UUID(other["id"]), user_id=uuid.UUID(c.carol["id"]))
    artifact, version = await add_version(c.db, foreign, kind="Dataset", content_digest=random_digest())
    publication = ArtifactPublication(version_id=version.id, published_by_id=foreign.user_id, citation={})
    c.db.add_all([publication, ProjectArtifact(project_id=c.project_id, artifact_id=artifact.id)])
    await c.db.flush()

    for who in ("anonymous", "outsider"):
        assert artifact.name in {i["name"] for i in (await get(c, who, f"{c.url}/library")).json()}
        assert artifact.name in {i["slug"] for i in (await get(c, who, f"{c.url}/resources")).json()}

    publication.withdrawn = True
    await c.db.flush()
    for who in ("anonymous", "outsider", "api_key"):
        assert artifact.name not in {i["name"] for i in (await get(c, who, f"{c.url}/library")).json()}
        assert artifact.name not in {i["slug"] for i in (await get(c, who, f"{c.url}/resources")).json()}
        assert (await get(c, who, f"{c.url}/resources/{artifact.name}")).status_code == 404
        assert (await get(c, who, f"{c.url}/resources/{artifact.name}/revisions")).status_code == 404


# --- writes and members' endpoints -----------------------------------------------------


async def counts(c) -> dict[str, int]:
    c.db.expire_all()
    result = {}
    for model in (BindingCase, Blob, Report, Publication, Artifact, ProjectArtifact, Project):
        result[model.__name__] = int(await c.db.scalar(select(func.count()).select_from(model)))
    return result


# method, path suffix, JSON body (None: a raw body), exact refusal wanted (False: any non-success)
WRITES = [
    ("POST", "/cases", {"slug": "intruder", "name": "Intruder"}, True),
    ("POST", "/resources", {"slug": "intruder", "name": "Intruder", "kind": "qos-offerings"}, True),
    ("POST", "/collections", {"slug": "intruder", "name": "Intruder"}, True),
    ("POST", "/reports", {"slug": "intruder", "title": "Intruder", "document": {}}, True),
    ("PATCH", "", {"name": "Hijacked", "visibility": "private"}, True),
    ("PATCH", "/cases/{case}", {"name": "Hijacked"}, True),
    ("DELETE", "", None, True),
    ("DELETE", "/cases/{case}", None, True),
    ("DELETE", "/blobs/{public_blob}", None, True),
    ("DELETE", "/publications/live", None, True),
    ("DELETE", "/reports/frozen-public", None, True),
    ("POST", "/studies/nothing/runs", None, True),
    ("POST", "/blobs", None, False),
    ("POST", "/package", None, False),
]


@pytest.mark.parametrize("who", VISITORS)
async def test_no_write_works_for_a_visitor(ctx, who):
    c = ctx
    headers = c.write_key if who == "api_key" else c.callers[who]
    before = await counts(c)
    for method, suffix, body, exact in WRITES:
        url = c.url + suffix.format(case=c.case, public_blob=c.public_blob)
        kwargs = {"json": body} if body is not None else {"content": b"x"}

        response = await c.client.request(method, url, headers=headers, **kwargs)

        label = f"{method} {suffix or '/'}"
        if exact:
            assert response.status_code == (401 if who == "anonymous" else 403), (label, response.text)
            if who != "anonymous":
                assert response.json()["detail"]["code"] == "organization_forbidden", label
        else:
            assert not 200 <= response.status_code < 300, (label, response.status_code)
    assert await counts(c) == before
    project = await c.db.get(Project, c.project_id)
    assert project.visibility is Visibility.PUBLIC and project.name == "Open"


async def test_a_viewer_still_cannot_write_and_a_member_still_can(ctx):
    c = ctx
    viewer = await c.client.post(f"{c.url}/cases", headers=c.callers["viewer"], json={"slug": "v", "name": "V"})
    member = await c.client.post(f"{c.url}/cases", headers=c.callers["member"], json={"slug": "m", "name": "M"})
    assert viewer.status_code == 403 and viewer.json()["detail"]["code"] == "organization_forbidden"
    assert member.status_code == 201


async def test_members_only_endpoints_stay_closed_around_a_public_project(ctx):
    c = ctx
    closed_for_visitors = [
        f"/v1/organizations/{c.slug}/members",
        f"/v1/organizations/{c.slug}/audit",
        f"/v1/organizations/{c.slug}/sponsor-proposals",
        f"/v1/organizations/{c.slug}/library",
        f"{c.url}/jobs",
        f"{c.url}/package",
    ]
    for url in closed_for_visitors:
        outsider = await get(c, "outsider", url)
        anonymous = await get(c, "anonymous", url)
        assert outsider.status_code in (403, 404), (url, outsider.status_code)
        assert anonymous.status_code == 401, (url, anonymous.status_code)


async def test_a_bad_credential_is_still_a_401_on_a_public_read(ctx):
    c = ctx
    response = await c.client.get(f"{c.url}/cases", headers={"Authorization": "Bearer not-a-token"})
    assert response.status_code == 401


# --- abuse limits -----------------------------------------------------------------------


async def test_reads_are_limited_per_caller_and_never_touch_the_sponsor(ctx, monkeypatch):
    c = ctx
    monkeypatch.setattr(get_settings(), "public_read_rate_per_minute", 3)
    sponsor_consumed = dict(c.gate.consumed.get(c.user_id, {}))
    evaluations = len(c.gate.evaluations)
    jobs = int(await c.db.scalar(select(func.count()).select_from(Job)))

    first = [await get(c, "outsider", f"{c.url}/cases") for _ in range(3)]
    limited = await get(c, "outsider", f"{c.url}/cases")
    same_account = await get(c, "api_key", f"{c.url}/cases")  # a key is the same caller as its account
    anonymous = await get(c, "anonymous", f"{c.url}/cases")  # counted by address, separately

    assert [response.status_code for response in first] == [200, 200, 200]
    assert limited.status_code == 429
    assert limited.json()["detail"]["code"] == "rate_limit_exceeded"
    assert 1 <= int(limited.headers["Retry-After"]) <= 60
    assert same_account.status_code == 429
    assert anonymous.status_code == 200
    # Members read freely: the limit is for visitors of other people's projects.
    for _ in range(8):
        assert (await get(c, "viewer", f"{c.url}/cases")).status_code == 200
        assert (await get(c, "owner", f"{c.url}/cases")).status_code == 200
    # Nothing was charged to the project's sponsor, and nothing was queued or evaluated.
    assert c.gate.consumed.get(c.user_id, {}) == sponsor_consumed
    assert len(c.gate.evaluations) == evaluations
    assert int(await c.db.scalar(select(func.count()).select_from(Job))) == jobs


async def test_the_limit_can_be_switched_off(ctx, monkeypatch):
    c = ctx
    monkeypatch.setattr(get_settings(), "public_read_rate_per_minute", 0)
    for _ in range(30):
        assert (await get(c, "outsider", f"{c.url}/cases")).status_code == 200


async def test_a_refused_read_does_not_spend_the_visitors_allowance(ctx, monkeypatch):
    c = ctx
    monkeypatch.setattr(get_settings(), "public_read_rate_per_minute", 2)
    for _ in range(5):  # denied routes and private projects are not public reads
        assert (await get(c, "outsider", f"{c.url}/jobs")).status_code == 403
        assert (await get(c, "outsider", f"{c.closed_url}/cases")).status_code == 403
    assert (await get(c, "outsider", f"{c.url}/cases")).status_code == 200
    assert (await get(c, "outsider", f"{c.url}/cases")).status_code == 200
    assert (await get(c, "outsider", f"{c.url}/cases")).status_code == 429


# --- the contract -----------------------------------------------------------------------


def test_the_openapi_document_marks_exactly_the_public_read_operations():
    document = app.openapi()
    marked = set()
    for path, item in document["paths"].items():
        for method, operation in item.items():
            if operation.get("x-public-read"):
                marked.add((method.upper(), path))
    assert marked == {("GET", path) for path in PUBLIC_READ_ALLOWED}
    project = document["components"]["schemas"]["ProjectView"]["properties"]
    assert project["access"]["enum"] == ["member", "public_read"]
    assert "effective_role" in project and "created_by_id" in project


def test_the_access_policy_document_lists_every_classified_route():
    text = (REPO_ROOT / "docs" / "ACCESS_POLICY.md").read_text(encoding="utf-8")
    for path in [*PUBLIC_READ_ALLOWED, *PUBLIC_READ_DENIED_GET]:
        assert path.removeprefix(PROJECT) in text or path == PROJECT, path
    for phrase in ("public_read", "deny-by-default", "Retry-After"):
        assert phrase in text
