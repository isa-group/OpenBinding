"""Resolving upstream events on seal (F6 A11): only a person's seal resolves, by rule (a) or (b), in its transaction.

(a) the sealed version pins, in a ``from`` of the watched family, the event's new version or a newer one;
(b) it links a revision whose value origins read the family at that version or newer, whatever it bound.
"""

from __future__ import annotations

import json

import pytest
import yaml
from sqlalchemy import select, update

from _b1_helpers import gate  # noqa: F401
from _repo import REPO_ROOT
from openbinding_gateway.db.models import AuditEvent, CompositionUpstreamEvent, utcnow
from openbinding_gateway.modules.compositions.domain.upstream import at_least_as_new

from ._tomatometer import BREVO, BREVO_2026_10, fresh, seeded
from ._watching import cycle

pytestmark = pytest.mark.asyncio
YAML = {"content-type": "application/yaml"}
UP, RETIRED = "6fff00000000000000000001", "6fff00000000000000000002"
EMAIL = json.loads((REPO_ROOT / "examples" / "tomatometer" / "email-recipe.json").read_text())


async def _events(db_session, **where):
    query = select(CompositionUpstreamEvent).execution_options(populate_existing=True)
    for name, value in where.items():
        query = query.where(getattr(CompositionUpstreamEvent, name) == value)
    return list((await db_session.scalars(query.order_by(CompositionUpstreamEvent.detected_at))).all())


async def _with_events(api_client, registration, db_session, gate, sphere, source, clocks, *scenarios):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate)
    await cycle(db_session, source)
    for scenario in scenarios:
        sphere.publish(scenario)
        clocks.advance(30)
        await cycle(db_session, source)
    sphere.source._cache.clear()
    return found


async def _seal_declared(api_client, found, label: str, pinned: str):
    """A declared version (no problem) whose e-mail ``from`` pins ``pinned`` (rule a)."""
    base = f"/v1/organizations/{found.org}/compositions/tomatometer"
    document = yaml.safe_load((await api_client.get(f"{base}/versions/1.0.0/content", headers=found.headers)).text)
    document["version"] = label
    document.pop("problem")
    document.pop("evidence", None)
    document["binding"]["dailySummary"]["from"]["version"] = pinned
    return await api_client.post(f"{base}/versions", content=yaml.safe_dump(document, sort_keys=False).encode(),
                                 headers={**found.headers, **YAML})


async def test_pinning_the_new_version_resolves_its_event(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _with_events(api_client, registration, db_session, gate, sphere, source, clocks,
                               "brevo-professional-up")
    (event,) = await _events(db_session, subject="binding")
    assert event.state == "open"
    sealed = await _seal_declared(api_client, found, "1.2.0", UP)
    assert sealed.status_code == 201, sealed.text
    (event,) = await _events(db_session, subject="binding")
    assert (event.state, event.resolved_by_id) == ("resolved", found.ids["user"])
    audit = await db_session.scalar(select(AuditEvent).where(AuditEvent.action == "composition.upstream_events_resolved"))
    assert audit is not None and audit.detail["events"] == [str(event.id)]
    sealed_audit = (await db_session.scalars(select(AuditEvent).where(
        AuditEvent.action == "composition.version_sealed").order_by(AuditEvent.created_at.desc()))).first()
    assert sealed_audit.detail["resolvedEvents"] == 1


async def test_pinning_a_newer_version_resolves_both_stacked_events(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _with_events(api_client, registration, db_session, gate, sphere, source, clocks,
                               "brevo-professional-up", "brevo-professional-retired")
    assert [e.state for e in await _events(db_session, subject="binding")] == ["open", "open"]
    # 2027-01 has no PROFESSIONAL any more, so pin it through a plan it still has.
    base = f"/v1/organizations/{found.org}/compositions/tomatometer"
    document = yaml.safe_load((await api_client.get(f"{base}/versions/1.0.0/content", headers=found.headers)).text)
    document.update(version="1.2.0")
    document.pop("problem")
    document.pop("evidence", None)
    document["binding"]["dailySummary"] = {"candidate": "email.brevo.standard",
                                           "from": {"sphere": "danruilop1/brevo", "version": RETIRED, "plan": "STANDARD"}}
    sealed = await api_client.post(f"{base}/versions", content=yaml.safe_dump(document, sort_keys=False).encode(),
                                   headers={**found.headers, **YAML})
    assert sealed.status_code == 201, sealed.text
    assert [e.state for e in await _events(db_session, subject="binding")] == ["resolved", "resolved"]


async def test_pinning_the_old_version_resolves_nothing(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _with_events(api_client, registration, db_session, gate, sphere, source, clocks,
                               "brevo-professional-up")
    sealed = await _seal_declared(api_client, found, "1.2.0", BREVO_2026_10)
    assert sealed.status_code == 201, sealed.text
    assert [e.state for e in await _events(db_session, subject="binding")] == ["open"]


async def _revision_at(api_client, found, version: str) -> int:
    """A new revision of the problem from the e-mail recipe with Brevo pinned at ``version``."""
    recipe = json.loads(json.dumps(EMAIL))
    for source in recipe["tasks"][0]["from"]:
        if source["sphere"]["pricing"] == BREVO:
            source["sphere"]["version"] = version
    url = f"/v1/organizations/{found.org}/problems/tomatometer-email/sphere"
    base = {"revision": found.ids["revision"]}
    preview = await api_client.post(f"{url}/expand", json={"recipe": recipe, "base": base}, headers=found.headers)
    assert preview.status_code == 200 and preview.json()["valid"], preview.text
    applied = await api_client.post(f"{url}/apply", json={"recipe": recipe, "base": base,
                                                          "expect": {"packageDigest": preview.json()["packageDigest"]}},
                                    headers=found.headers)
    assert applied.status_code == 201, applied.text
    return applied.json()["revision"]["revision"] if "revision" in applied.json() else applied.json()["revision"]


async def test_a_version_on_a_revision_that_reads_the_new_version_resolves_whatever_it_binds(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    from ._tomatometer import derive_and_seal

    found = await _with_events(api_client, registration, db_session, gate, sphere, source, clocks,
                               "brevo-professional-up")
    revision = await _revision_at(api_client, found, UP)
    organization, composition, user = await fresh(db_session, found)
    await derive_and_seal(db_session, organization, composition, user, "1.2.0", {"dailySummary": "email.resend.pro"},
                          revision)
    (event,) = await _events(db_session, subject="binding")
    assert event.state == "resolved"


async def test_a_version_on_the_old_revision_resolves_nothing(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    from ._tomatometer import derive_and_seal

    found = await _with_events(api_client, registration, db_session, gate, sphere, source, clocks,
                               "brevo-professional-up")
    organization, composition, user = await fresh(db_session, found)
    await derive_and_seal(db_session, organization, composition, user, "1.2.0",
                          {"dailySummary": "email.mailgun.foundation"}, found.ids["revision"])
    assert [e.state for e in await _events(db_session, subject="binding")] == ["open"]


async def test_a_deduplicated_seal_resolves_nothing(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _with_events(api_client, registration, db_session, gate, sphere, source, clocks,
                               "brevo-professional-up")
    base = f"/v1/organizations/{found.org}/compositions/tomatometer"
    content = (await api_client.get(f"{base}/versions/1.0.0/content", headers=found.headers)).content
    again = await api_client.post(f"{base}/versions", content=content, headers={**found.headers, **YAML})
    assert again.status_code in (200, 201)
    assert [e.state for e in await _events(db_session, subject="binding")] == ["open"]


async def test_an_offering_event_is_never_resolved_and_a_review_survives_resolution(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _with_events(api_client, registration, db_session, gate, sphere, source, clocks,
                               "brevo-professional-up", "tomatometer-1.2.0")
    binding = (await _events(db_session, subject="binding"))[0]
    await db_session.execute(update(CompositionUpstreamEvent).where(CompositionUpstreamEvent.id == binding.id).values(
        state="reviewed", note="Seen; re-solving", reviewed_by_id=found.ids["user"], reviewed_at=utcnow()))
    await db_session.commit()
    sealed = await _seal_declared(api_client, found, "1.2.0", UP)
    assert sealed.status_code == 201, sealed.text
    binding = (await _events(db_session, subject="binding"))[0]
    assert (binding.state, binding.note, binding.reviewed_by_id) == ("resolved", "Seen; re-solving", found.ids["user"])
    (offering,) = await _events(db_session, subject="offering")
    assert offering.state == "open"


async def test_a_fork_resolves_nothing_in_its_source(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    from _problem_helpers import make_org

    found = await _with_events(api_client, registration, db_session, gate, sphere, source, clocks,
                               "brevo-professional-up")
    await _seal_declared(api_client, found, "1.2.0", UP)
    target = await make_org(api_client, found.headers)
    forked = await api_client.post(f"/v1/organizations/{found.org}/compositions/tomatometer/fork", headers=found.headers,
                                   json={"version": "1.0.0", "targetOrganization": target, "dropProblem": True})
    assert forked.status_code == 201, forked.text
    events = await _events(db_session, composition_id=found.ids["composition"], subject="binding")
    assert [e.resolved_by_version_id is not None for e in events] == [True]
    assert all(e.composition_id == found.ids["composition"] for e in await _events(db_session))


def test_a_withdrawn_new_version_is_resolved_by_pinning_todays_latest() -> None:
    order = ["latest", "older"]
    assert at_least_as_new("latest", "withdrawn", order) and not at_least_as_new("older", "withdrawn", order)
