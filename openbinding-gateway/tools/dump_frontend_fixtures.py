#!/usr/bin/env python3
"""Write the gateway-produced fixtures of the frontend to frontend/src/test/fixtures/core/ and sphere/.

The frontend's view-models and mocks read what the gateway really answers, not a hand-written
copy of it. This tool runs the gateway in process (SQLite, inline dispatch, the pinned
toolchain), uploads a few packages as problems of a throwaway organization and writes the
response **bodies** (never headers) of the routes the frontend reads:

* ``<name>.facts.json``: ``getProblemCompilationFacts`` of the upload's compilation;
* ``<name>.validate.json``: ``validateBimPackage?include=facts`` of the same package;
* ``<name>.version.json``: ``getCompositionVersion?include=document`` of version 1.0.0 of a
  composition ``<name>`` derived from the first binding of the problem without a hard violation;
* ``<name>.diff.json``: ``diffCompositionVersions`` from that 1.0.0 to a 1.1.0 derived from the
  same binding with one task bound to another candidate;
* ``plans-pricing.json``: ``getPlansPricing``, OpenBinding's published pricing 0.2.0 as the recorded SPHERE serves it;
* ``templates.json`` and ``template.tomatometer.json``: ``listCompositionTemplates`` and
  ``getCompositionTemplate`` of the TomatoMeter template, as a visitor reads them;
* ``tomatometer-email.facts.json``: the facts of revision 3 of ``tomatometer-email``, made by the TomatoMeter
  composition template (``createCompositionFromTemplate``: the base, then the e-mail and the combined SPHERE recipes):
  value sources, properties and provenance;
* ``tomatometer-email.version.json``: version 1.0.0 of the composition ``tomatometer`` the template derives from that
  revision (Brevo PROFESSIONAL and Dropbox PLUS, pinned by ``from``; ZenQuotes), whose offering
  (``sphere/tomatometer``) was read when it was sealed, and ``tomatometer-email.upstream.json``, its upstream view
  (``getCompositionUpstream``).

The packages are ``simple-seq`` (``examples/demo/01_simple_seq``), ``fms`` (``13_fms``: an
exclusive choice and a local task), ``json-complete`` (``16_json_complete``: a parallel block
and a loop) and ``ambiguous`` (``01_simple_seq`` with a second catalog that gives task ``t1``
a candidate of the same id, so a document must write it ``<resource>/<id>``). ``ambiguous`` is
built here rather than checked in, because a checked-in package would join the BIM corpus.

One package is refused on purpose, for the editor's located diagnostics:

* ``refused.validate.json``: the 422 body of ``validateBimPackage?include=facts`` for
  ``15_bpmn_complete`` broken in five places (see :func:`refused_files`): a candidate feature
  value outside its declared domain, a constraint whose expression does not parse (a ``span``
  inside the expression string), a BPMN task no Application task maps (``bpmnElement``),
  a capacity rule naming an unknown dimension (a pointer into an array inside an array) and an
  event latency entry naming an unknown pool (a pointer through an array to an object). Some
  findings name the resource by its id (``placement``), not by its file;
* ``refused.package.json``: that package's files, by path, as the text that was sent, so the
  frontend resolves each pointer and span against the bytes the compiler read.

The compiler stops before its semantic checks when a resource fails its schema or a BPMN file
fails XML validation, so a schema finding (whose pointer may carry an unescaped ``/``) or a
duplicate BPMN id (the only finding with ``related`` locations) cannot share this body.

Every run mints fresh ids and instants, so the bodies are normalised before they are written:
each distinct UUID becomes ``00000000-0000-4000-8000-<12-digit counter>`` in order of first
appearance across the fixture set (files in a fixed order, keys sorted), and each ISO-8601
instant ``2026-01-01T00:00:00Z`` plus one second per distinct value in order of appearance, so
ordering by date survives. Content digests are deterministic and left as they are.

``sphere/`` holds the recorded SPHERE set the frontend's parity test reads (the frontend never reads the
gateway's ``tests/``): for every recorded Pricing2Yaml 3.x version and every synthetic one,
``<pricingId>.<versionId>.yml`` (``derived.<name>.yml``) and the matching ``.normalised.json``, copied from
``openbinding-gateway/tests/fixtures/sphere/normalised/`` (``tools/dump_normalised_pricings.py``); and the
gateway's own answers about SPHERE for the frontend's mocks, read with the recorded SPHERE
(``tests/sphere_recorded.py``) installed as the pricing source: ``search.<name>.json``
(``searchSpherePricings``), ``manifest.<name>.json`` (``getSpherePricing``) and ``version.<name>.json``
(``getSpherePricingVersion``) for TomatoMeter, set-B Mailgun and Dropbox (``…ce9c1``); and the two SPHERE import
journeys, ``expand.<name>.json`` (``expandSphereRecipe``), ``apply.<name>.json`` (``applySphereRecipe``) and
``recipe.<name>.json`` (``getSphereRecipe``) for ``tomatometer-email`` (the e-mail recipe on revision 1 of the
template's problem, J2, whose apply answers revision 2 that holds the same package) and ``storage`` (a new problem from Dropbox, J1).
``sphere/upstream/`` holds each upstream classifier golden (``tests/golden/upstream``, ``tools/dump_upstream_goldens.py``)
with the two YAMLs it compares (``<case>.old.yml``, ``<case>.new.yml``), which the parity test feeds to
pricing-renderer's ``compareSelections``.

    python tools/dump_frontend_fixtures.py               # rewrite frontend/src/test/fixtures/{core,sphere}/
    python tools/dump_frontend_fixtures.py --out DIR     # write DIR/core/ and DIR/sphere/ instead
    python tools/dump_frontend_fixtures.py --check       # fail if the checked-in fixtures differ
"""

from __future__ import annotations

import argparse
import asyncio
import itertools
import json
import os
import re
import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from collections.abc import Callable
from pathlib import Path
from typing import Any

GATEWAY_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(os.environ.get("OPENBINDING_REPO_ROOT", Path(__file__).resolve().parents[2])).resolve()
FIXTURES = REPO_ROOT / "frontend" / "src" / "test" / "fixtures" / "core"
#: The account that makes the fixtures. Not ``fixtures``: that is the organization's slug, and organizations and
#: usernames share one namespace (every account owns a personal organization named after it).
FIXTURES_USER = "fixture-author"
SPHERE_FIXTURES = FIXTURES.parent / "sphere"
SFX = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "sphere"
DEMO = REPO_ROOT / "examples" / "demo"

sys.path.insert(0, str(GATEWAY_ROOT / "src"))
sys.path.insert(0, str(GATEWAY_ROOT / "tools"))

#: Fixture name -> package directory (``None``: built by :func:`ambiguous_files`), in the order they are written.
PACKAGES: tuple[tuple[str, Path | None], ...] = (
    ("simple-seq", DEMO / "01_simple_seq"),
    ("fms", DEMO / "13_fms"),
    ("json-complete", DEMO / "16_json_complete"),
    ("ambiguous", None),
)

ZIP = {"Content-Type": "application/vnd.bim+zip"}
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$")
_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


def ambiguous_files() -> dict[str, bytes]:
    """``01_simple_seq`` with a second catalog, ``other``, whose ``c1a`` also provides ``t1``'s service."""
    source = DEMO / "01_simple_seq"
    files = {path.name: path.read_bytes() for path in sorted(source.iterdir()) if path.is_file()}
    instance = json.loads(files["instance.json"])
    instance["metadata"]["name"] = "demo_ambiguous_candidates"
    instance["spec"]["resources"]["candidateCatalog"]["other"] = "other.json"
    catalog = json.loads(files["candidates.json"])
    catalog["metadata"]["name"] = "demo_ambiguous_other_catalog"
    catalog["spec"]["candidates"] = {"c1a": {"provides": "service/t1", "features": {"latency": 12}}}
    files["instance.json"] = (json.dumps(instance, indent=2) + "\n").encode("utf-8")
    files["other.json"] = (json.dumps(catalog, indent=2) + "\n").encode("utf-8")
    return files


#: The demo package :func:`refused_files` breaks.
REFUSED_SOURCE = DEMO / "15_bpmn_complete"


def _edited(files: dict[str, bytes], name: str, change: Callable[[dict[str, Any]], None]) -> None:
    document = json.loads(files[name])
    change(document["spec"])
    files[name] = (json.dumps(document, indent=2) + "\n").encode("utf-8")


def refused_files() -> dict[str, bytes]:
    """``15_bpmn_complete`` with five findings the compiler reports together (see the module docstring)."""
    files = {path.name: path.read_bytes() for path in sorted(REFUSED_SOURCE.iterdir()) if path.is_file()}

    def out_of_domain(spec: dict[str, Any]) -> None:
        spec["candidates"]["auth-edge"]["features"]["latency"] = 900  # the domain is [0, 500]

    def unparsable(spec: dict[str, Any]) -> None:
        spec["constraints"]["end_to_end_latency"]["assert"] = "features.latency <= "

    def unknown_dimension_and_pool(spec: dict[str, Any]) -> None:
        spec["capacityRules"][0]["resources"][1] = "gpu"
        spec["events"]["client-request"]["latency"][1]["pool"]["id"] = "nowhere"

    _edited(files, "candidates.json", out_of_domain)
    _edited(files, "constraints.json", unparsable)
    _edited(files, "placement.json", unknown_dimension_and_pool)
    audit = b'<bpmn:serviceTask id="audit" name="Audit" />'
    if audit not in files["workflow.bpmn"]:
        raise SystemExit(f"{REFUSED_SOURCE.name}: workflow.bpmn no longer declares the task 'audit'")
    files["workflow.bpmn"] = files["workflow.bpmn"].replace(
        audit, audit + b'\n    <bpmn:serviceTask id="orphan" name="Orphan" />',
    )
    return files


def _archive(directory: Path | None) -> bytes:
    from openbinding_gateway.integrations import packages

    return packages.zip_files(ambiguous_files()) if directory is None else packages.zip_directory(directory)


#: The gateway's answers about SPHERE written to ``sphere/``: name -> (pricingId, versionId, search words).
SPHERE_FAMILIES = {
    "tomatometer": ("6ab0a323697330667ccce8cd", "6921867e7004563bd918e7e8", "tomatometer"),
    "mailgun": ("6ade364540e55445692b0eda", "6ade36454b2b5b01c587db3d", "Mailgun"),
    "dropbox": ("6ab0a323697330667ccce9c1", "687e4b68102baa50f3a5c7b7", "Dropbox"),
}


def _install_recorded_sphere(settings: Any) -> None:
    """The recorded SPHERE as the pricing source, resolving only its own hosts (nothing reaches the network)."""
    tests = Path(__file__).resolve().parents[1] / "tests"
    if str(tests) not in sys.path:
        sys.path.insert(0, str(tests))
    from sphere_recorded import RecordedSphere

    from openbinding_gateway.core import outbound

    global _RECORDED, _SETTINGS
    recorded = RecordedSphere()
    _RECORDED, _SETTINGS = recorded, settings
    outbound._getaddrinfo = lambda host, port: recorded.getaddrinfo(host, port)
    _fresh_pricing_source()


def _fresh_pricing_source() -> None:
    """A new pricing port over the recorded SPHERE (its manifest cache empty)."""
    from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
    from openbinding_gateway.modules.plans.application import set_pricing_source

    set_pricing_source(
        SphereHttpSource(_SETTINGS.model_copy(update={"sphere_enabled": True}), transport=_RECORDED.transport())
    )


_RECORDED: Any = None
_SETTINGS: Any = None
#: The feed key the fixtures mint: fixed, so the reveal fixture and the feed read are the same on every run.
FIXTURE_FEED_KEY = "obe_f1c7a5e0_" + "fixture-feed-key-not-a-secret-0123456789abc"


async def _sphere_bodies(client, headers: dict[str, str]) -> dict[str, Any]:
    bodies: dict[str, Any] = {}
    base = "/v1/organizations/fixtures/sphere/pricings"
    for name, (pricing_id, version_id, words) in SPHERE_FAMILIES.items():
        bodies[f"search.{name}.json"] = _ok(await client.get(base, params={"q": words}, headers=headers), 200).json()
        bodies[f"manifest.{name}.json"] = _ok(await client.get(f"{base}/{pricing_id}", headers=headers), 200).json()
        version = await client.get(f"{base}/{pricing_id}/versions/{version_id}", headers=headers)
        bodies[f"version.{name}.json"] = _ok(version, 200).json()
    return bodies


async def _bodies(work: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Every fixture body, by file name, from a fresh in-process gateway: ``core/``'s and ``sphere/``'s."""
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import event
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from openbinding_gateway import space_client
    from openbinding_gateway.access.dependencies import optional_session, session_dependency
    from openbinding_gateway.access.work_limits import WorkRateLimiter, set_work_limiter
    from openbinding_gateway.core.ratelimit import AuthRateLimiter, set_auth_limiter
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.db.base import Base
    from openbinding_gateway.integrations import packages
    from openbinding_gateway.main import app
    from openbinding_gateway.space_client import OpenGate

    settings = get_settings()
    settings.artifact_root = str(work / "artifacts")
    settings.work_rate_limit_compile_requests = 0
    settings.work_rate_limit_read_requests = 0
    settings.work_rate_limit_evaluate_requests = 0
    set_work_limiter(WorkRateLimiter(primary=None))
    set_auth_limiter(AuthRateLimiter(primary=None))
    space_client.set_gate(OpenGate())
    settings.sphere_enabled = True
    settings.space_pricing_version = "0.2.0"
    _install_recorded_sphere(settings)

    engine = create_async_engine(f"sqlite+aiosqlite:///{work / 'fixtures.db'}")

    # Transactions begin explicitly, as on PostgreSQL, so a SAVEPOINT nests (the SQLAlchemy recipe for pysqlite).
    @event.listens_for(engine.sync_engine, "connect")
    def _no_implicit_transactions(dbapi_connection, _record):
        dbapi_connection.isolation_level = None

    @event.listens_for(engine.sync_engine, "begin")
    def _begin_explicitly(connection):
        if connection.get_execution_options().get("isolation_level") != "AUTOCOMMIT":
            connection.exec_driver_sql("BEGIN")

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    bodies: dict[str, Any] = {}
    sphere: dict[str, Any] = {}
    try:
        async with factory() as session:
            async def _session():
                yield session

            app.dependency_overrides[session_dependency] = _session
            app.dependency_overrides[optional_session] = _session
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://gateway") as client:
                headers = await _sign_in(client)
                created = await client.post("/v1/organizations", json={"slug": "fixtures", "name": "Fixtures"}, headers=headers)
                _ok(created, 201)
                for name, directory in PACKAGES:
                    archive = _archive(directory)
                    uploaded = await client.post(
                        "/v1/organizations/fixtures/problems", params={"slug": name}, content=archive,
                        headers={**headers, **ZIP},
                    )
                    _ok(uploaded, 201)
                    revision = uploaded.json()["revision"]["id"]
                    compilation = uploaded.json()["compilation"]["id"]
                    facts = await client.get(
                        f"/v1/organizations/fixtures/problems/{name}/revisions/{revision}/compilations/{compilation}/facts",
                        headers=headers,
                    )
                    bodies[f"{name}.facts.json"] = _ok(facts, 200).json()
                    validated = await client.post("/v1/bim/validate", params={"include": "facts"}, content=archive, headers=ZIP)
                    bodies[f"{name}.validate.json"] = _ok(validated, 200).json()
                    version, diff = await _versions(client, headers, name, bodies[f"{name}.facts.json"])
                    bodies[f"{name}.version.json"] = version
                    bodies[f"{name}.diff.json"] = diff
                refused = refused_files()
                answer = await client.post(
                    "/v1/bim/validate", params={"include": "facts"}, content=packages.zip_files(refused), headers=ZIP,
                )
                bodies["refused.validate.json"] = _ok(answer, 422).json()
                bodies["refused.package.json"] = {path: content.decode("utf-8") for path, content in refused.items()}
                sphere = await _sphere_bodies(client, headers)
                imported_core, imported_sphere = await _sphere_imports(client, headers, session)
                bodies.update(imported_core)
                sphere.update(imported_sphere)
                bodies["plans-pricing.json"] = _ok(await client.get("/v1/plans/pricing"), 200).json()
                # The composition template catalog, as a visitor reads it, and the TomatoMeter template.
                bodies["templates.json"] = _ok(await client.get("/v1/compositions/templates"), 200).json()
                bodies["template.tomatometer.json"] = _ok(
                    await client.get("/v1/compositions/templates/tomatometer"), 200).json()
    finally:
        app.dependency_overrides.clear()
        space_client.set_gate(None)
        set_work_limiter(None)
        set_auth_limiter(None)
        await engine.dispose()
    return bodies, sphere


async def _sphere_imports(client, headers: dict[str, str], session) -> tuple[dict[str, Any], dict[str, Any]]:
    """TomatoMeter through its composition template, the SPHERE import journeys, and the operation of it.

    ``from-template`` makes ``tomatometer-email`` (revision 1 the base, 2 the e-mail recipe, 3 the combined recipe)
    and ``tomatometer`` 1.0.0 (Brevo PROFESSIONAL, Dropbox PLUS, ZenQuotes, offering ``sphere/tomatometer``): the
    path the lab seed takes. J2's bodies are the e-mail recipe previewed on revision 1 and applied (revision 2 holds
    its package, so the apply answers that revision) and read back from revision 2; J1 previews and applies
    ``storage-recipe.json`` as a new problem ``storage``.
    """
    examples = REPO_ROOT / "examples" / "tomatometer"
    core: dict[str, Any] = {}
    sphere: dict[str, Any] = {}
    made = _ok(await client.post("/v1/organizations/fixtures/compositions/from-template",
                                 json={"template": "tomatometer"}, headers=headers), 201).json()
    email = json.loads((examples / "email-recipe.json").read_text())
    journeys = (
        ("tomatometer-email", email, {"revision": 1}, 200),
        ("storage", json.loads((examples / "storage-recipe.json").read_text()), None, 201),
    )
    for name, recipe, base_ref, applied_status in journeys:
        url = f"/v1/organizations/fixtures/problems/{name}/sphere"
        preview = _ok(await client.post(f"{url}/expand", json={"recipe": recipe, "base": base_ref}, headers=headers), 200).json()
        sphere[f"expand.{name}.json"] = preview
        applied = await client.post(
            f"{url}/apply", json={"recipe": recipe, "base": base_ref, "expect": {"packageDigest": preview["packageDigest"]}},
            headers=headers,
        )
        sphere[f"apply.{name}.json"] = _ok(applied, applied_status).json()
        params = {"revision": 2} if name == "tomatometer-email" else None
        sphere[f"recipe.{name}.json"] = _ok(await client.get(f"{url}/recipe", params=params, headers=headers), 200).json()
    problems = "/v1/organizations/fixtures/problems/tomatometer-email/revisions"
    latest = made["problem"]["revision"]
    compilation = _ok(await client.get(f"{problems}/{latest}/compilation", headers=headers), 200).json()
    facts = await client.get(f"{problems}/{compilation['revision_id']}/compilations/{compilation['id']}/facts",
                             headers=headers)
    core["tomatometer-email.facts.json"] = _ok(facts, 200).json()
    compositions = "/v1/organizations/fixtures/compositions"
    version = await client.get(f"{compositions}/tomatometer/versions/1.0.0", params={"include": "document"}, headers=headers)
    core["tomatometer-email.version.json"] = _ok(version, 200).json()
    upstream = await client.get(f"{compositions}/tomatometer/upstream", headers=headers)
    core["tomatometer-email.upstream.json"] = _ok(upstream, 200).json()
    template = json.loads((REPO_ROOT / "examples" / "templates" / "tomatometer.json").read_text())
    core.update(await _operation(
        client, headers, session, template["composition"]["binding"], revision=latest,
        recipe=json.loads((examples / "tomatometer-recipe.json").read_text()),
    ))
    core.update(await _upstream(client, headers, session))
    return core, sphere


async def _upstream(client, headers: dict[str, str], session) -> dict[str, Any]:
    """F6: what the watcher records for ``tomatometer`` (``production`` has 1.0.0 in effect, 1.1.0 is the latest), as
    the gateway answers it. Every file is named ``upstream.*``, so it sorts after the earlier fixtures.

    A first cycle reads every watched manifest; Brevo then publishes 2026-11 (a values-changed event on 1.0.0, which
    is reviewed), 2027-01 (PROFESSIONAL retired: binding invalid), TomatoMeter its 1.2.0 offering, Dropbox answers 404
    twice an interval apart (source unavailable) and Resend's manifest stops listing the version 1.1.0 pins
    (withdrawn). The watcher's clock is moved by hand; nothing sleeps.
    """
    from datetime import timedelta as _delta

    from sqlalchemy import select as _select, update as _update
    from sqlalchemy.ext.asyncio import async_sessionmaker as _sessions

    from openbinding_gateway.db.models import CompositionUpstreamEvent, User, UserRole, utcnow
    from openbinding_gateway.jobs import clock
    from openbinding_gateway.modules.compositions.application import upstream_watcher
    from openbinding_gateway.modules.plans.application import get_pricing_source

    out: dict[str, Any] = {}
    compositions = "/v1/organizations/fixtures/compositions/tomatometer"
    events = f"{compositions}/upstream-events"
    factory = _sessions(session.bind, expire_on_commit=False)
    moment = [utcnow()]
    original = clock.utcnow
    clock.utcnow = lambda: moment[0]
    settings = _SETTINGS.model_copy(update={"sphere_enabled": True, "upstream_watch_enabled": True,
                                            "upstream_poll_interval_s": 20})

    async def run(seconds: float = 30) -> None:
        moment[0] = moment[0] + _delta(seconds=seconds)
        await session.commit()
        await upstream_watcher.run_cycle(factory, get_pricing_source(), force=True, settings=settings)

    async def newest(**where: Any) -> str:
        query = _select(CompositionUpstreamEvent.id).order_by(CompositionUpstreamEvent.detected_at.desc())
        for name, value in where.items():
            query = query.where(getattr(CompositionUpstreamEvent, name) == value)
        found = await session.scalar(query.limit(1))
        assert found is not None, where
        return str(found)

    try:
        await run()
        _RECORDED.publish("brevo-professional-up")
        await run()
        raised = await newest(category="values_changed")
        out["upstream.tomatometer.events.json"] = _ok(await client.get(events, headers=headers), 200).json()
        out["upstream.tomatometer.event.values-changed.json"] = _ok(
            await client.get(f"{events}/{raised}", headers=headers), 200).json()
        out["upstream.tomatometer.composition.json"] = _ok(await client.get(compositions, headers=headers), 200).json()
        out["upstream.tomatometer.environment.production.json"] = _ok(
            await client.get(f"{compositions}/environments/production", headers=headers), 200).json()
        out["upstream.tomatometer.versions.json"] = _ok(
            await client.get(f"{compositions}/versions", headers=headers), 200).json()
        detail = out["upstream.tomatometer.event.values-changed.json"]
        for side in ("old", "new"):
            snapshot = detail[side]["snapshotId"]
            out[f"upstream.brevo.{detail[side]['label']}.yaml"] = _ok(await client.get(
                f"/v1/organizations/fixtures/pricing-snapshots/{snapshot}/yaml", headers=headers), 200).text
        out["upstream.notifications.json"] = _ok(
            await client.get("/v1/notifications", params={"kind": "UpstreamEvent"}, headers=headers), 200).json()
        out["upstream.me.events.json"] = _ok(await client.get("/v1/users/me/upstream-events", headers=headers), 200).json()
        out["upstream.tomatometer.event.reviewed.json"] = _ok(await client.post(
            f"{events}/{raised}/review", json={"note": "Seen; re-solving"}, headers=headers), 200).json()
        _RECORDED.publish("brevo-professional-retired")
        await run()
        out["upstream.tomatometer.event.binding-invalid.json"] = _ok(await client.get(
            f"{events}/{await newest(category='binding_invalid')}", headers=headers), 200).json()
        out["upstream.tomatometer.events.two.json"] = _ok(
            await client.get(events, params={"subject": "binding"}, headers=headers), 200).json()
        _RECORDED.publish("tomatometer-1.2.0")
        await run()
        out["upstream.tomatometer.event.offering-changed.json"] = _ok(await client.get(
            f"{events}/{await newest(subject='offering')}", headers=headers), 200).json()
        dropbox = _RECORDED.manifest_path("6ab0a323697330667ccce9c1")
        _RECORDED.not_found(dropbox, times=2)
        await run()
        await run(25)
        unavailable = await newest(new_ref="gone:1")
        out["upstream.tomatometer.event.unavailable.json"] = _ok(
            await client.get(f"{events}/{unavailable}", headers=headers), 200).json()
        resend = "6ade2d2540e55445692b07c6"
        manifest = _RECORDED.manifest(resend)
        pinned = manifest["latestVersionId"]
        data = (_RECORDED.root / resend / f"{pinned}.yml").read_text().replace(
            "version: ", "version: '2026-12' # ", 1).encode()
        import hashlib as _hashlib

        later = "6fff0000000000000000d001"
        manifest["versions"] = [{"versionId": later, "version": "2026-12", "createdAt": "2026-12-01T00:00:00.000Z",
                                 "contentHash": "0" * 64}]
        manifest["latestVersionId"] = later
        _RECORDED.serve_manifest(resend, manifest)
        _RECORDED.serve(_RECORDED.yaml_path(resend, later), data,
                        {"content-type": "application/yaml", "etag": '"' + _hashlib.sha256(data).hexdigest() + '"'})
        await run()
        out["upstream.tomatometer.event.withdrawn.json"] = _ok(
            await client.get(f"{events}/{await newest(new_ref=later)}", headers=headers), 200).json()
        me = _ok(await client.get("/v1/users/me", headers=headers), 200).json()
        await session.execute(_update(User).where(User.username == me["username"]).values(role=UserRole.ADMIN))
        await session.commit()
        queues = _ok(await client.get("/v1/admin/queues", headers=headers), 200).json()
        out["upstream.admin.queues.json"] = {"upstreamWatch": queues["upstreamWatch"]}
        await session.execute(_update(User).where(User.username == me["username"]).values(role=UserRole.USER))
        await session.commit()
    finally:
        clock.utcnow = original
        _RECORDED.extra.clear()
        _RECORDED.scripts.clear()
        _RECORDED.published.clear()
        _fresh_pricing_source()
    return out


async def _operation(
    client, headers: dict[str, str], session, binding: dict[str, str], *, revision: int, recipe: dict[str, Any],
) -> dict[str, Any]:
    """F4's operation of ``tomatometer``: a second version, two environments, three adoptions, a feed key, the feed,
    margins, check reports, what-if evaluations and the versions derived from a run.

    1.1.0 binds Resend PRO instead of Brevo PROFESSIONAL, from the same revision; ``production`` (an operator, ADMIN adopts, 1000 expected users, one feed
    key with the fixed ``FIXTURE_FEED_KEY``) adopts 1.0.0, 1.1.0 and 1.0.0 again; ``staging`` (MEMBER adopts) is
    empty. ``tomatometer.check.production.newer.json`` is the same check once Brevo published its scenario 2026-11
    (``RecordedSphere.publish``): the only fixture with ``newer``. ``tomatometer.evaluate.revision.json`` evaluates against a
    demand variant, revision 4 (the combined recipe with twice the demand).
    """
    import copy

    from openbinding_gateway.security import apikeys, feed_keys

    out: dict[str, Any] = {}
    compositions = "/v1/organizations/fixtures/compositions/tomatometer"
    environments = f"{compositions}/environments"
    _ok(await client.post(f"{compositions}/derive", headers=headers,
                          json={"revision": f"tomatometer-email@{revision}", "binding": {**binding, "dailySummary": "email.resend.pro"},
                                "version": "1.1.0", "offering": {"sphere": "sphere/tomatometer"}}), 201)
    me = _ok(await client.get("/v1/users/me", headers=headers), 200).json()["username"]
    _ok(await client.post(environments, headers=headers, json={
        "slug": "production", "name": "Production", "description": "What TomatoMeter reads in production.",
        "operator": me, "adoptRole": "ADMIN", "expectedUsers": 1000,
    }), 201)
    _ok(await client.post(environments, headers=headers, json={
        "slug": "staging", "name": "Staging", "adoptRole": "MEMBER",
    }), 201)
    for label, note in (("1.0.0", "Go live"), ("1.1.0", "Switch to Resend"), ("1.0.0", "Back to Brevo")):
        tag = _ok(await client.get(f"{environments}/production", headers=headers), 200).headers["ETag"]
        _ok(await client.post(f"{environments}/production/adopt", headers={**headers, "If-Match": tag},
                              json={"version": label, "note": note}), 200)
    minted = feed_keys.mint
    prefix = FIXTURE_FEED_KEY.rsplit("_", 1)[0]
    feed_keys.mint = lambda: apikeys.MintedKey(FIXTURE_FEED_KEY, prefix, apikeys.hash_key(FIXTURE_FEED_KEY))
    try:
        out["tomatometer.key.created.json"] = _ok(await client.post(
            f"{environments}/production/keys", headers=headers, json={"label": "TomatoMeter production"}), 201).json()
    finally:
        feed_keys.mint = minted
    out["tomatometer.environments.json"] = _ok(await client.get(environments, headers=headers), 200).json()
    production = _ok(await client.get(f"{environments}/production", headers=headers), 200).json()
    out["tomatometer.environment.production.json"] = production
    out["tomatometer.adoptions.production.json"] = _ok(
        await client.get(f"{environments}/production/adoptions", headers=headers), 200).json()
    pinned = production["inEffect"]["evaluation"]["id"]
    out["tomatometer.margins.1.0.0.json"] = _ok(await client.get(
        f"{compositions}/versions/1.0.0/margins", params={"users": 1000, "evaluation": pinned}, headers=headers), 200).json()
    out["tomatometer.margins.1.1.0.json"] = _ok(await client.get(
        f"{compositions}/versions/1.1.0/margins", params={"users": 1000}, headers=headers), 200).json()
    feed = _ok(await client.get(f"{environments}/production/composition", headers={"X-API-Key": FIXTURE_FEED_KEY}), 200)
    out["tomatometer.feed.production.yaml"] = feed.text
    out["tomatometer.feed.production.headers.json"] = {
        name: feed.headers[name] for name in (
            "content-type", "etag", "cache-control", "vary", "x-content-type-options", "openbinding-adoption",
            "openbinding-composition-version",
        )
    }
    _fresh_pricing_source()
    out["tomatometer.check.production.json"] = _ok(
        await client.post(f"{environments}/production/check", headers=headers), 200).json()
    # Set-B Brevo (the family the e-mail plan was read from) publishes its scenario 2026-11 (scenarios.json).
    _RECORDED.publish("brevo-professional-up")
    _fresh_pricing_source()
    out["tomatometer.check.production.newer.json"] = _ok(
        await client.post(f"{environments}/production/check", headers=headers), 200).json()
    _RECORDED.extra.clear()
    _RECORDED.published.clear()
    _fresh_pricing_source()
    out["tomatometer.versions.json"] = _ok(await client.get(f"{compositions}/versions", headers=headers), 200).json()
    # The calculator: a what-if binding with users, and the same against a demand variant (revision 3).
    out["tomatometer.evaluate.users.json"] = _ok(await client.post(
        f"{compositions}/evaluate", headers=headers,
        json={"version": "1.1.0", "binding": {"dailySummary": "email.mailgun.foundation"}, "users": 1000}), 200).json()
    doubled = copy.deepcopy(recipe)
    doubled["demand"]["monthlyEmails"]["value"] = 60000
    doubled["demand"]["dailyEmails"]["value"] = 2000
    url = "/v1/organizations/fixtures/problems/tomatometer-email/sphere"
    base = {"revision": revision}
    preview = _ok(await client.post(f"{url}/expand", json={"recipe": doubled, "base": base}, headers=headers), 200).json()
    _ok(await client.post(f"{url}/apply", headers=headers, json={
        "recipe": doubled, "base": base, "expect": {"packageDigest": preview["packageDigest"]}}), 201)
    out["tomatometer.evaluate.revision.json"] = _ok(await client.post(
        f"{compositions}/evaluate", headers=headers,
        json={"version": "1.1.0", "revision": revision + 1, "binding": {"dailySummary": "email.brevo.professional"},
              "users": 1000}), 200).json()
    out["tomatometer.runs.derived.json"] = await _derived_from_a_run(client, headers, session)
    return out


async def _derived_from_a_run(client, headers: dict[str, str], session) -> Any:
    """A10's answer: ``simple-seq`` 2.0.0 derived from a finished run whose solution is 1.0.0's binding, then the
    organization's compositions listed with ``?run=``."""
    from sqlalchemy import select

    from openbinding_gateway.db.models import CompositionDerivation, Job, JobState, User

    compositions = "/v1/organizations/fixtures/compositions"
    version = _ok(await client.get(f"{compositions}/simple-seq/versions/1.0.0", headers=headers), 200).json()
    derivation = await session.scalar(select(CompositionDerivation).where(
        CompositionDerivation.version_id == uuid.UUID(version["id"])))
    user = await session.scalar(select(User).where(User.username == FIXTURES_USER))
    organization_id = (await client.get("/v1/organizations/fixtures", headers=headers)).json()["id"]
    job = Job(
        created_by_id=user.id, engine_id="random-search", engine_job_id="fixtures-run", service_url="http://engine",
        state=JobState.COMPLETED, termination="FEASIBLE",
        result={"solutions": [{"decision": {"kind": "binding", "binding": derivation.binding}, "features": {}}]},
        organization_id=uuid.UUID(organization_id), revision_id=derivation.revision_id,
        compilation_id=derivation.compilation_id, provenance={},
    )
    session.add(job)
    await session.commit()
    _ok(await client.post(f"{compositions}/simple-seq/derive", headers=headers,
                          json={"run": str(job.id), "version": "2.0.0"}), 201)
    return _ok(await client.get(compositions, params={"run": str(job.id)}, headers=headers), 200).json()


async def _versions(client, headers: dict[str, str], name: str, facts: dict[str, Any]) -> tuple[Any, Any]:
    """A composition ``name`` with two versions derived from the problem ``name``: 1.0.0 from the first binding
    (in the facts' task and candidate order) without a hard violation, 1.1.0 from the first that differs from
    it in one task. Answers 1.0.0 with its document, and the diff of the two."""
    base = "/v1/organizations/fixtures/compositions"
    _ok(await client.post(base, json={"slug": name, "name": name}, headers=headers), 201)
    base = f"{base}/{name}"
    eligible = {task["id"]: [item["written"] for item in task["eligible"]] for task in facts["tasks"] if task["kind"] == "service"}

    async def derivable(binding: dict[str, str], version: str, *, seal: bool) -> bool:
        answer = await client.post(
            f"{base}/derive", headers=headers,
            json={"revision": f"{name}@1", "binding": binding, "version": version, "seal": seal},
        )
        if answer.status_code == 422 and not seal:
            return False
        _ok(answer, 201 if seal else 200)
        return True

    first = None
    for choice in itertools.product(*eligible.values()):
        binding = dict(zip(eligible, choice, strict=True))
        if await derivable(binding, "1.0.0", seal=False):
            first = binding
            break
    if first is None:
        raise SystemExit(f"{name}: no binding of the problem is free of hard violations")
    second = None
    for task, candidates in eligible.items():
        for candidate in candidates:
            if candidate != first[task] and await derivable({**first, task: candidate}, "1.1.0", seal=False):
                second = {**first, task: candidate}
                break
        if second is not None:
            break
    if second is None:
        raise SystemExit(f"{name}: no second binding differs from the first in one task")
    await derivable(first, "1.0.0", seal=True)
    await derivable(second, "1.1.0", seal=True)
    version = await client.get(f"{base}/versions/1.0.0", params={"include": "document"}, headers=headers)
    diff = await client.get(f"{base}/diff", params={"from": "1.0.0", "to": "1.1.0"}, headers=headers)
    return _ok(version, 200).json(), _ok(diff, 200).json()


async def _sign_in(client) -> dict[str, str]:
    details = {"username": FIXTURES_USER, "email": "fixtures@example.org", "password": "fixtures-throwaway-password"}
    _ok(await client.post("/v1/auth/register", json=details), 201)
    login = await client.post("/v1/auth/login", json={"username_or_email": FIXTURES_USER, "password": details["password"]})
    return {"Authorization": f"Bearer {_ok(login, 200).json()['access_token']}"}


def _ok(response, status: int):
    if response.status_code != status:
        raise SystemExit(f"{response.request.method} {response.request.url.path} answered {response.status_code}: {response.text}")
    return response


def normalise(bodies: dict[str, Any]) -> dict[str, Any]:
    """The bodies with every UUID and every instant replaced by a stable stand-in (see the module docstring)."""
    ids: dict[str, str] = {}
    instants: dict[str, str] = {}

    def replace(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: replace(value[key]) for key in sorted(value)}
        if isinstance(value, list):
            return [replace(item) for item in value]
        if isinstance(value, str) and _UUID.match(value):
            if value not in ids:
                ids[value] = f"00000000-0000-4000-8000-{len(ids) + 1:012d}"
            return ids[value]
        if isinstance(value, str) and _INSTANT.match(value):
            if value not in instants:
                instants[value] = (_EPOCH + timedelta(seconds=len(instants))).strftime("%Y-%m-%dT%H:%M:%SZ")
            return instants[value]
        return value

    return {name: replace(bodies[name]) for name in sorted(bodies)}


def render(bodies: dict[str, Any]) -> dict[str, str]:
    """Each fixture file's text."""
    return {name: json.dumps(body, indent=2, sort_keys=True, ensure_ascii=False) + "\n" for name, body in normalise(bodies).items()}


def _environment() -> None:
    """A throwaway in-process gateway: the repository's schemas, its own signing secret, jobs in the request, no SPHERE.

    Set before the gateway is imported, which reads them once.
    """
    os.environ.setdefault("GENERAL_SCHEMA_PATH", str(REPO_ROOT / "schemas" / "general" / "schema.json"))
    os.environ.setdefault("SCHEMAS_DIR", str(REPO_ROOT / "schemas"))
    os.environ["GATEWAY_JWT_SECRET"] = "dump-frontend-fixtures-throwaway-secret"
    os.environ["JOB_DISPATCH_MODE"] = "inline"
    os.environ["SPHERE_ENABLED"] = "false"


def generate() -> tuple[dict[str, str], dict[str, str]]:
    """``core/``'s files and the gateway-answered files of ``sphere/``."""
    _environment()
    with tempfile.TemporaryDirectory(prefix="ob-fixtures-") as work:
        core, sphere = asyncio.run(_bodies(Path(work)))
        # OpenBinding's pricing is the recorded SPHERE version, the same on every run, and its document's key order is
        # the pricing's own (plans in the order they are offered): written as the gateway answers it, not normalised.
        verbatim = {"plans-pricing.json": core.pop("plans-pricing.json")}
        texts = {name: core.pop(name) for name in [name for name in core if name.endswith(".yaml")]}
        files = render(core)
        files.update({name: json.dumps(body, indent=2, ensure_ascii=False) + "\n" for name, body in verbatim.items()})
        files.update(texts)
        return dict(sorted(files.items())), _render_sphere(sphere)


def _render_sphere(bodies: dict[str, Any]) -> dict[str, str]:
    """As ``render``; a snapshot's ``yamlHref`` embeds its id, so it is written again from the replaced id."""
    normalised = normalise(bodies)
    for body in normalised.values():
        snapshot = body.get("snapshot") if isinstance(body, dict) else None
        if isinstance(snapshot, dict) and "yamlHref" in snapshot:
            snapshot["yamlHref"] = f"/v1/organizations/fixtures/pricing-snapshots/{snapshot['id']}/yaml"
    return {name: json.dumps(body, indent=2, sort_keys=True, ensure_ascii=False) + "\n" for name, body in normalised.items()}


def drift(files: dict[str, str], directory: Path) -> list[str]:
    """What differs between ``files`` and the ``.json`` files of ``directory``."""
    present = (
        {path.name for pattern in ("*.json", "*.yaml") for path in directory.glob(pattern)} if directory.is_dir() else set()
    )
    found = [f"missing: {name}" for name in sorted(set(files) - present)]
    found += [f"not generated: {name}" for name in sorted(present - set(files))]
    found += [
        f"differs: {name}" for name in sorted(set(files) & present)
        if (directory / name).read_text(encoding="utf-8") != files[name]
    ]
    return found


def sphere_files() -> dict[str, str]:
    """``sphere/``: every readable recorded or derived version and its golden, by file name."""
    files: dict[str, str] = {}
    for golden in sorted((SFX / "normalised").glob("*.json")):
        text = golden.read_text(encoding="utf-8")
        if '"refused"' in text[:40]:
            continue
        family, _, version = golden.stem.partition("@")
        source = SFX / family / f"{version}.yml"
        files[f"{family}.{version}.yml"] = source.read_text(encoding="utf-8")
        files[f"{family}.{version}.normalised.json"] = text
    return files


def upstream_files() -> dict[str, str]:
    """``sphere/upstream/``: each upstream classifier golden (``tests/golden/upstream``) with the two YAMLs it
    compares, for the frontend's parity test (pricing-renderer's ``compareSelections`` against the Python port)."""
    import dump_upstream_goldens as upstream

    files: dict[str, str] = {}
    golden_dir = upstream.DEFAULT_OUT
    for case in json.loads((golden_dir / "cases.json").read_text(encoding="utf-8"))["cases"]:
        name = case["name"]
        files[f"upstream/{name}.json"] = (golden_dir / f"{name}.json").read_text(encoding="utf-8")
        for side in ("old", "new"):
            if case.get(side) is not None:
                data, _ = upstream.pricing_bytes(case[side])
                files[f"upstream/{name}.{side}.yml"] = data.decode("utf-8")
    return files


def sphere_drift(files: dict[str, str], directory: Path) -> list[str]:
    present = (
        {path.relative_to(directory).as_posix() for path in directory.rglob("*") if path.is_file()}
        if directory.is_dir() else set()
    )
    found = [f"missing: sphere/{name}" for name in sorted(set(files) - present)]
    found += [f"not generated: sphere/{name}" for name in sorted(present - set(files))]
    found += [
        f"differs: sphere/{name}" for name in sorted(set(files) & present)
        if (directory / name).read_text(encoding="utf-8") != files[name]
    ]
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--out", type=Path, help="Write the fixtures to this directory instead.")
    target.add_argument("--check", action="store_true", help="Do not write; exit non-zero if the checked-in fixtures differ.")
    arguments = parser.parse_args(argv)

    files, answered = generate()
    sphere = {**sphere_files(), **upstream_files(), **answered}
    if arguments.check:
        found = drift(files, FIXTURES) + sphere_drift(sphere, SPHERE_FIXTURES)
        if found:
            print("The frontend fixtures are out of date; run tools/dump_frontend_fixtures.py and commit the result:")
            print("\n".join(f"  {line}" for line in found))
            return 1
        print(f"{FIXTURES.parent.relative_to(REPO_ROOT)} is up to date ({len(files) + len(sphere)} files).")
        return 0
    core_out = arguments.out / "core" if arguments.out else FIXTURES
    sphere_out = arguments.out / "sphere" if arguments.out else SPHERE_FIXTURES
    core_out.mkdir(parents=True, exist_ok=True)
    for stale in [*core_out.glob("*.json"), *core_out.glob("*.yaml")]:
        if stale.name not in files:
            stale.unlink()
    for name, content in files.items():
        (core_out / name).write_text(content, encoding="utf-8")
    sphere_out.mkdir(parents=True, exist_ok=True)
    for stale in sphere_out.rglob("*"):
        if stale.is_file() and stale.relative_to(sphere_out).as_posix() not in sphere:
            stale.unlink()
    for name, content in sphere.items():
        (sphere_out / name).parent.mkdir(parents=True, exist_ok=True)
        (sphere_out / name).write_text(content, encoding="utf-8")
    print(f"Wrote {len(files)} files to {core_out} and {len(sphere)} to {sphere_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
