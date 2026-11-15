"""VIEWER is a read role: it reads authorized results and never launches, repeats, cancels or deletes work.

A security review found that the run launch accepted a VIEWER on a package shared with
the organization. Starting, repeating, cancelling or deleting work needs MEMBER (deleting a study, ADMIN) in
the organization that owns it; reading needs VIEWER, with the redaction a VIEWER already has. Every run
belongs to the organization of its problem. An API key inherits the role of its user and adds its
permissions; neither widens the other.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

import pytest
from sqlalchemy import func, select

from _b1_helpers import gate, make_account, make_key, make_org, put_member  # noqa: F401
from _problem_helpers import run_url, runs_url, upload_problem
from _repo import REPO_ROOT
from bim_core.package import load_package
from openbinding_gateway import study_jobs
from openbinding_gateway.db.models import (
    Job,
    JobState,
    ProblemCompilation,
    Study,
    StudyRun,
)
from openbinding_gateway.modules.execution.adapters import routes as runs_routes
from openbinding_gateway.routes import v1 as v1_routes
from openbinding_gateway.security.redaction import GENERIC_ERROR
from openbinding_gateway.services import job_submission
from openbinding_gateway.services.engines import engine_ref
from test_security_hardening import HARMLESS, SENSITIVE_OPTIONS
from test_viewer_error_redaction import PRIVATE_ERROR

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
ROLES = ("VIEWER", "MEMBER", "ADMIN", "OWNER")
#: ``engine`` is what an API key's engine grant is held against (``allows_engine``).
PROVENANCE = {
    "irDigest": "sha256-" + "b" * 64,
    "engine": {"namespace": "bim.builtin", "name": "random-search", "version": "1.0.0", "digest": "sha256-" + "e" * 64},
}
PROBLEM = {"apiVersion": "bim/v1", "kind": "BindingProblem", "spec": {"tasks": ["t1"]}}


@dataclass
class Person:
    id: uuid.UUID
    headers: dict[str, str]


@dataclass
class Lab:
    """One organization with a project, a problem, its studies, and one person of each role.

    The problem was uploaded by ``author`` (a MEMBER), so every role reaches it only through the organization.
    """

    slug: str
    org_id: uuid.UUID
    project_id: uuid.UUID
    snapshot: str
    compilation_id: uuid.UUID
    definition: dict
    owner_headers: dict[str, str]
    people: dict[str, Person]
    outsider: Person
    outsider_org: str
    failed: dict[str, uuid.UUID] = field(default_factory=dict)
    queued: dict[str, uuid.UUID] = field(default_factory=dict)
    doomed: dict[str, str] = field(default_factory=dict)

    @property
    def base(self) -> str:
        return f"/v1/organizations/{self.slug}/projects"

    @property
    def studies(self) -> str:
        return f"/v1/organizations/{self.slug}/studies"

    @property
    def runs(self) -> str:
        return runs_url(self.slug)

    def run(self, run_id, suffix: str = "") -> str:
        return run_url(run_id, suffix, org=self.slug)


def code_of(response) -> str | None:
    body = response.json()
    detail = body.get("detail")
    return body.get("code") or body.get("title") or (detail.get("code") if isinstance(detail, dict) else None)


def job_body(revision: str, **extra) -> dict:
    return {"revision": revision, "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION, **extra}


def study_body(lab: Lab, slug: str) -> dict:
    return {"slug": slug, "name": slug, "definition": lab.definition}


def organization_job(lab: Lab, person: Person, state: JobState) -> Job:
    failed = state is JobState.FAILED
    return Job(
        owner_id=person.id, engine_id="random-search", engine_job_id=str(uuid.uuid4()),
        service_url="http://engine", state=state, organization_id=lab.org_id,
        revision_id=uuid.UUID(lab.snapshot), compilation_id=lab.compilation_id,
        options=dict(SENSITIVE_OPTIONS), original_request={}, provenance=dict(PROVENANCE),
        result={"termination": "UNKNOWN", "solutions": [], "error": PRIVATE_ERROR, "provenance": {}} if failed else None,
    )


async def counts(db_session) -> dict[str, int]:
    return {
        model.__name__: (await db_session.execute(select(func.count()).select_from(model))).scalar_one()
        for model in (Job, ProblemCompilation, Study, StudyRun)
    }


@pytest.fixture
def no_dispatch(monkeypatch):
    async def queued(*args, **kwargs):
        return None

    monkeypatch.setattr(runs_routes, "dispatch_persisted_job", queued)
    monkeypatch.setattr(study_jobs, "dispatch_persisted_job", queued)


@pytest.fixture
async def lab(api_client, registration, db_session, gate, no_dispatch):  # noqa: F811
    owner, owner_headers = await make_account(api_client, registration, db_session, gate)
    organization = await make_org(api_client, owner_headers)
    slug = organization["slug"]
    people = {"OWNER": Person(uuid.UUID(owner["id"]), owner_headers)}
    for role in ("ADMIN", "MEMBER", "VIEWER", "AUTHOR"):
        account, headers = await make_account(api_client, registration, db_session, gate)
        granted = "MEMBER" if role == "AUTHOR" else role
        assert (await put_member(api_client, owner_headers, slug, account["id"], granted)).status_code == 200
        people[role] = Person(uuid.UUID(account["id"]), headers)
    author = people.pop("AUTHOR")
    outsider_account, outsider_headers = await make_account(api_client, registration, db_session, gate)
    outsider_org = await make_org(api_client, outsider_headers)

    base = f"/v1/organizations/{slug}/projects"
    project = await api_client.post(
        base, headers=owner_headers, json={"slug": "p", "name": "P", "description": "d", "visibility": "private"}
    )
    assert project.status_code == 201, project.text
    uploaded = await upload_problem(api_client, author.headers, slug, slug="c")
    compilation = await db_session.scalar(
        select(ProblemCompilation).where(ProblemCompilation.revision_id == uuid.UUID(uploaded["revision_id"]))
    )
    reference = engine_ref(v1_routes._manifest("random-search"), "bim.builtin")
    definition = {
        "revision_ids": [uploaded["revision_id"]],
        "engines": [{**reference, "mode": "seeded", "optimization": OPTIMIZATION}],
        "parameter_sets": [{"iterations": 100}], "seeds": [1],
    }
    built = Lab(
        slug=slug, org_id=uuid.UUID(organization["id"]), project_id=uuid.UUID(project.json()["id"]),
        snapshot=uploaded["revision_id"], compilation_id=compilation.id,
        definition=definition, owner_headers=owner_headers, people=people,
        outsider=Person(uuid.UUID(outsider_account["id"]), outsider_headers), outsider_org=outsider_org["slug"],
    )
    for slug_ in ("s", *(f"doomed-{role.lower()}" for role in ROLES)):
        created = await api_client.post(built.studies, headers=author.headers, json=study_body(built, slug_))
        assert created.status_code == 201, created.text
    for role in ROLES:
        built.doomed[role] = f"doomed-{role.lower()}"
        for state, held in ((JobState.FAILED, built.failed), (JobState.QUEUED, built.queued)):
            row = organization_job(built, people[role], state)
            db_session.add(row)
            await db_session.flush()
            held[role] = row.id
    return built


# -- The matrix -------------------------------------------------------------


async def read(client, lab: Lab, role: str):
    jobs = await client.get(lab.runs, headers=lab.people[role].headers)
    studies = await client.get(f"{lab.studies}", headers=lab.people[role].headers)
    return jobs if jobs.status_code != 200 else studies


async def launch(client, lab: Lab, role: str):
    headers = {**lab.people[role].headers, "Idempotency-Key": f"matrix-{role}"}
    return await client.post(lab.runs, headers=headers, json=job_body(lab.snapshot))


async def create_study(client, lab: Lab, role: str):
    return await client.post(f"{lab.studies}", headers=lab.people[role].headers,
                             json=study_body(lab, f"made-by-{role.lower()}"))


async def relaunch(client, lab: Lab, role: str):
    return await client.post(f"{lab.studies}/s/runs", headers=lab.people[role].headers)


async def retry(client, lab: Lab, role: str):
    return await client.post(lab.run(lab.failed[role], "/retry"), headers=lab.people[role].headers)


async def cancel(client, lab: Lab, role: str):
    return await client.post(lab.run(lab.queued[role], "/cancel"), headers=lab.people[role].headers)


async def delete(client, lab: Lab, role: str):
    return await client.delete(f"{lab.studies}/{lab.doomed[role]}", headers=lab.people[role].headers)


#: Cancelling comes before the launches so that a plan's concurrency limit never decides the outcome.
ACTIONS = {
    "read": read, "cancel": cancel, "launch": launch, "relaunch": relaunch,
    "retry": retry, "create_study": create_study, "delete": delete,
}
FORBIDDEN = {
    "launch": (403, "insufficient_role"), "retry": (403, "insufficient_role"), "cancel": (403, "insufficient_role"),
    "create_study": (403, "organization_forbidden"), "relaunch": (403, "organization_forbidden"),
    "delete": (403, "organization_forbidden"), "read": (200, None),
}
MEMBER_CAN = {
    "launch": (202, None), "retry": (202, None), "cancel": (200, None), "create_study": (201, None),
    "relaunch": (202, None), "delete": (403, "organization_forbidden"), "read": (200, None),
}
EXPECTED = {
    "VIEWER": FORBIDDEN,
    "MEMBER": MEMBER_CAN,
    "ADMIN": {**MEMBER_CAN, "delete": (204, None)},
    "OWNER": {**MEMBER_CAN, "delete": (204, None)},
}


async def test_role_by_action_matrix(api_client, lab):
    observed = {}
    for role in ROLES:
        for action, attempt in ACTIONS.items():
            response = await attempt(api_client, lab, role)
            observed[role, action] = (response.status_code, code_of(response) if response.status_code >= 400 else None)

    expected = {(role, action): outcome for role, table in EXPECTED.items() for action, outcome in table.items()}
    assert observed == expected


async def test_a_viewer_reads_the_results_with_the_existing_redaction(api_client, lab):
    response = await api_client.get(lab.runs, headers=lab.people["VIEWER"].headers)
    teammate = await api_client.get(lab.run(lab.failed["MEMBER"]), headers=lab.people["VIEWER"].headers)

    assert response.status_code == 200, response.text
    rows = {row["id"]: row for row in response.json()["runs"]}
    assert str(lab.failed["VIEWER"]) in rows and str(lab.failed["MEMBER"]) in rows
    assert all(row["options"] == HARMLESS for row in rows.values())
    assert teammate.status_code == 200, teammate.text
    assert teammate.json()["options"] == HARMLESS
    assert teammate.json()["result"]["error"] == teammate.json()["error"] == GENERIC_ERROR
    for leaked in ("tok-SECRET", "10.0.0.5", "private-engine"):
        assert leaked not in response.text + teammate.text, leaked
    studies = await api_client.get(f"{lab.studies}", headers=lab.people["VIEWER"].headers)
    assert studies.status_code == 200, studies.text


async def test_a_member_still_reads_the_complete_job(api_client, lab):
    response = await api_client.get(lab.runs, headers=lab.people["MEMBER"].headers)
    failed = await api_client.get(lab.run(lab.failed["OWNER"]), headers=lab.people["MEMBER"].headers)

    assert response.status_code == 200, response.text
    assert {row["options"]["api_key"] for row in response.json()["runs"]} == {SENSITIVE_OPTIONS["api_key"]}
    assert failed.status_code == 200, failed.text
    assert failed.json()["result"]["error"] == PRIVATE_ERROR


# -- A denied VIEWER leaves nothing behind ------------------------------------


@pytest.fixture
def compile_spy(monkeypatch):
    calls: list[str] = []
    real = job_submission.compile_or_get

    async def compiled(*args, **kwargs):
        calls.append("compile_or_get")
        return await real(*args, **kwargs)

    monkeypatch.setattr(job_submission, "compile_or_get", compiled)
    return calls


async def test_a_denied_viewer_launch_is_refused_before_compiling_and_leaves_no_job_or_key(
    api_client, db_session, lab, compile_spy
):
    before = await counts(db_session)
    viewer = lab.people["VIEWER"]

    denied = await api_client.post(
        lab.runs, headers={**viewer.headers, "Idempotency-Key": "viewer-key"}, json=job_body(lab.snapshot)
    )

    assert denied.status_code == 403, denied.text
    assert code_of(denied) == "insufficient_role"
    assert denied.headers["content-type"].startswith("application/json")
    assert compile_spy == [], "the role is checked before the compilation is read"
    assert await counts(db_session) == before
    held = await db_session.scalar(select(func.count()).select_from(Job).where(Job.idempotency_key == "viewer-key"))
    assert held == 0, "a denied launch reserves no idempotency key"


async def test_the_key_a_denied_viewer_sent_is_still_free_once_the_role_allows_the_launch(
    api_client, db_session, lab, compile_spy
):
    viewer = lab.people["VIEWER"]
    headers = {**viewer.headers, "Idempotency-Key": "promoted-key"}
    assert (await api_client.post(lab.runs, headers=headers, json=job_body(lab.snapshot))).status_code == 403

    promoted = await put_member(api_client, lab.owner_headers, lab.slug, str(viewer.id), "MEMBER")
    launched = await api_client.post(lab.runs, headers=headers, json=job_body(lab.snapshot))

    assert promoted.status_code == 200, promoted.text
    assert launched.status_code == 202, launched.text
    assert "idempotent" not in launched.json()
    assert compile_spy, "the spy is wired: a permitted launch does read the compilation"


async def test_every_denied_action_of_a_viewer_changes_nothing(api_client, db_session, lab):
    before = await counts(db_session)

    for action in ("launch", "create_study", "relaunch", "retry", "cancel", "delete"):
        response = await ACTIONS[action](api_client, lab, "VIEWER")
        assert response.status_code == 403, (action, response.text)

    assert await counts(db_session) == before
    queued = await db_session.get(Job, lab.queued["VIEWER"])
    await db_session.refresh(queued)
    assert queued.state is JobState.QUEUED and not queued.cancellation_requested


# -- What stays allowed -------------------------------------------------------


async def test_a_viewer_here_runs_the_problems_of_an_organization_of_their_own(api_client, db_session, lab):
    viewer = lab.people["VIEWER"]
    # The seeded queued job would count against the plan's concurrency limit, which is not the subject here.
    (await db_session.get(Job, lab.queued["VIEWER"])).state = JobState.CANCELLED
    await db_session.flush()
    own = await upload_problem(api_client, viewer.headers)

    launched = await api_client.post(runs_url(own["org"]), headers=viewer.headers, json=job_body(own["revision_id"]))

    assert launched.status_code == 202, launched.text
    job = await db_session.get(Job, uuid.UUID(launched.json()["id"]))
    assert str(job.organization_id) == own["problem"]["organization_id"] != str(lab.org_id)


async def upload_outcomes(client, lab: Lab, headers) -> list[tuple[int, str | None]]:
    archive = load_package(EXAMPLE).to_zip()
    responses = [
        await client.post(lab.runs, headers={**headers, "Content-Type": "application/vnd.bim+zip"}, content=archive),
        await client.post(
            lab.runs, headers=headers, files={"package": ("example.bim.zip", archive, "application/vnd.bim+zip")}
        ),
    ]
    return [(response.status_code, code_of(response) if response.status_code >= 400 else None) for response in responses]


async def test_an_upload_is_not_a_role_decision_a_viewer_gets_what_a_member_gets(api_client, lab):
    # A run runs a stored revision; a package sent to createRun is refused before any role is looked at,
    # the same for both and never ``insufficient_role``.
    as_viewer = await upload_outcomes(api_client, lab, lab.people["VIEWER"].headers)
    as_member = await upload_outcomes(api_client, lab, lab.people["MEMBER"].headers)

    assert as_viewer == as_member
    assert "insufficient_role" not in {code for _, code in as_viewer}


# -- Another organization -----------------------------------------------------


async def test_a_user_of_another_organization_gets_the_same_404_as_for_a_missing_revision(
    api_client, db_session, lab, compile_spy
):
    before = await counts(db_session)
    headers = lab.outsider.headers

    # From their own organization: the revision of this one reads as missing.
    hidden = await api_client.post(runs_url(lab.outsider_org), headers=headers, json=job_body(lab.snapshot))
    missing = await api_client.post(runs_url(lab.outsider_org), headers=headers, json=job_body(str(uuid.uuid4())))
    # Through this organization's address: the organization itself reads as missing.
    foreign = await api_client.post(lab.runs, headers=headers, json=job_body(lab.snapshot))

    assert hidden.status_code == missing.status_code == foreign.status_code == 404
    assert hidden.json() == missing.json()
    assert compile_spy == []
    assert await counts(db_session) == before


async def test_a_user_of_another_organization_cannot_touch_the_work_of_this_one(api_client, db_session, lab):
    before = await counts(db_session)
    headers = lab.outsider.headers

    attempts = [
        await api_client.post(lab.run(lab.queued['MEMBER'], "/cancel"), headers=headers),
        await api_client.post(lab.run(lab.failed['MEMBER'], "/retry"), headers=headers),
        await api_client.post(f"{lab.studies}", headers=headers, json=study_body(lab, "intruder")),
        await api_client.post(f"{lab.studies}/s/runs", headers=headers),
        await api_client.delete(f"{lab.studies}/{lab.doomed['MEMBER']}", headers=headers),
        await api_client.get(lab.runs, headers=headers),
    ]

    assert [response.status_code for response in attempts[:2]] == [404, 404]
    assert attempts[-1].status_code == 404
    assert all(response.status_code in {403, 404} for response in attempts[2:])
    assert "random-search" not in attempts[-1].text and "tok-SECRET" not in attempts[-1].text
    assert await counts(db_session) == before


# -- API keys: the role of the user and the scopes of the key -----------------


READ_SCOPES = ["jobs:read", "problems:read", "projects:read", "studies:read"]
EXECUTE_SCOPES = [*READ_SCOPES, "engines:execute", "studies:write"]


async def test_a_read_only_key_of_a_member_cannot_launch(api_client, db_session, lab):
    member = lab.people["MEMBER"]
    key = await make_key(api_client, member.headers, READ_SCOPES)
    before = await counts(db_session)

    refused = await api_client.post(lab.runs, headers=key, json=job_body(lab.snapshot))
    retried = await api_client.post(lab.run(lab.failed['MEMBER'], "/retry"), headers=key)
    cancelled = await api_client.post(lab.run(lab.queued['MEMBER'], "/cancel"), headers=key)
    reading = await api_client.get(lab.runs, headers=key)

    for response in (refused, retried, cancelled):
        assert response.status_code == 403, response.text
        assert code_of(response) == "insufficient_api_key_permission"
    assert reading.status_code == 200, reading.text
    assert await counts(db_session) == before


async def test_a_key_that_may_execute_launches_with_the_role_of_a_member(api_client, lab):
    key = await make_key(api_client, lab.people["MEMBER"].headers, EXECUTE_SCOPES)

    launched = await api_client.post(lab.runs, headers=key, json=job_body(lab.snapshot))

    assert launched.status_code == 202, launched.text


async def test_a_key_with_every_write_scope_of_a_viewer_cannot_launch_repeat_or_cancel(
    api_client, db_session, lab, compile_spy
):
    viewer = lab.people["VIEWER"]
    key = await make_key(api_client, viewer.headers, EXECUTE_SCOPES)
    before = await counts(db_session)

    responses = [
        await api_client.post(lab.runs, headers={**key, "Idempotency-Key": "viewer-key-1"}, json=job_body(lab.snapshot)),
        await api_client.post(lab.run(lab.failed['VIEWER'], "/retry"), headers=key),
        await api_client.post(lab.run(lab.queued['VIEWER'], "/cancel"), headers=key),
        await api_client.post(f"{lab.studies}/s/runs", headers=key),
    ]

    assert [response.status_code for response in responses] == [403, 403, 403, 403]
    assert [code_of(response) for response in responses[:3]] == ["insufficient_role"] * 3
    assert compile_spy == []
    assert await counts(db_session) == before


async def test_a_key_of_a_viewer_still_reads_with_the_redaction_of_a_viewer(api_client, lab):
    key = await make_key(api_client, lab.people["VIEWER"].headers, READ_SCOPES)

    response = await api_client.get(lab.runs, headers=key)

    assert response.status_code == 200, response.text
    assert response.json()["runs"], "the key may use every engine, so it lists the organization's runs"
    assert all(row["options"] == HARMLESS for row in response.json()["runs"])
    assert "tok-SECRET" not in response.text and PRIVATE_ERROR not in response.text
