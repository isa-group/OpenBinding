"""tools/poll_upstream.py: one upstream watch cycle on demand (F6-C), on SQLite with the recorded SPHERE.

The seeded lab (``seed_lab.seed`` against ``RecordedSphere``) watches what TomatoMeter's versions read; a forced cycle
reads every watch, a published scenario becomes a new version and an event, and the tool's entry point prints the
report and exits 0 whatever the cycle found.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

import poll_upstream
import seed_lab

PASSWORD = "synthetic-lab-password-1"
EXAMPLES = seed_lab.find_examples_dir()
TOMATOMETER = "6ab0a323697330667ccce8cd"


@pytest.fixture
def recorded_sphere(monkeypatch):
    from openbinding_gateway.core import outbound
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
    from openbinding_gateway.modules.plans.application import set_pricing_source

    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "tests"))
    from sphere_recorded import RecordedSphere

    recorded = RecordedSphere()
    monkeypatch.setattr(outbound, "_getaddrinfo", lambda host, port: recorded.getaddrinfo(host, port))
    settings = get_settings()
    monkeypatch.setattr(settings, "sphere_enabled", True)
    monkeypatch.setattr(settings, "upstream_watch_enabled", True)
    source = SphereHttpSource(settings, transport=recorded.transport())
    set_pricing_source(source)
    yield recorded, source
    set_pricing_source(None)
    sys.modules.pop("sphere_recorded", None)


async def _seeded(db_session):
    result = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    assert result["sphere"]["status"] == "seeded", result["sphere"]
    await db_session.commit()
    return async_sessionmaker(db_session.bind, expire_on_commit=False)


async def test_a_forced_cycle_reads_every_watch_and_a_published_scenario_becomes_an_event(db_session, recorded_sphere):
    from openbinding_gateway.db.models import CompositionUpstreamEvent, PricingSnapshot

    recorded, source = recorded_sphere
    factory = await _seeded(db_session)
    first = await poll_upstream.poll(factory, force=True, source=source)
    assert first.skipped is None and first.claimed >= 4
    # The seed snapshotted every latest version: the first cycle sets each watch's ETag and snapshots nothing.
    assert (first.new_versions, first.events) == (0, 0)
    quiet = await poll_upstream.poll(factory, force=True, source=source)
    assert quiet.new_versions == 0 and quiet.not_modified >= 3 and quiet.events == 0

    recorded.publish("tomatometer-1.2.0")
    changed = await poll_upstream.poll(factory, force=True, source=source)
    assert changed.new_versions == 1 and changed.events == 1
    db_session.expire_all()
    (event,) = (await db_session.scalars(select(CompositionUpstreamEvent))).all()
    assert (event.subject, event.category, event.new_label) == ("offering", "offering_changed", "1.2.0")
    assert await db_session.scalar(
        select(func.count()).select_from(PricingSnapshot).where(PricingSnapshot.version_id == event.new_version_id)
    ) == 1
    again = await poll_upstream.poll(factory, force=True, source=source)
    assert again.events == 0 and again.new_versions == 0


async def test_without_force_nothing_is_due_right_after_a_cycle(db_session, recorded_sphere):
    _, source = recorded_sphere
    factory = await _seeded(db_session)
    await poll_upstream.poll(factory, force=True, source=source)
    report = await poll_upstream.poll(factory, source=source)
    assert report.claimed == 0 and report.reads == 0


async def test_a_cycle_held_by_a_replica_is_reported_as_skipped(db_session, monkeypatch):
    from openbinding_gateway.jobs import reconciler

    async def held(session, key):
        return False

    monkeypatch.setattr(reconciler, "acquire_cycle_lock", held)
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    report = await poll_upstream.poll(factory, force=True)
    assert report.skipped == "lock" and report.claimed == 0


def test_main_prints_the_report_as_json_and_exits_0_when_polling_is_off(tmp_path, monkeypatch, capsys):
    from sqlalchemy import create_engine

    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.db.base import Base

    database = tmp_path / "lab.db"
    engine = create_engine(f"sqlite:///{database}")
    Base.metadata.create_all(engine)
    engine.dispose()
    monkeypatch.setattr(get_settings(), "database_url", f"sqlite+aiosqlite:///{database}")
    assert poll_upstream.main(["--once", "--json"]) == poll_upstream.EXIT_OK
    report = json.loads(capsys.readouterr().out)
    assert report["skipped"] == "disabled" and report["claimed"] == 0

    assert poll_upstream.main(["--once"]) == poll_upstream.EXIT_OK
    assert capsys.readouterr().out.startswith("upstream_watch_cycle claimed=0 ")


def test_main_without_a_database_is_a_configuration_error(monkeypatch, capsys):
    from openbinding_gateway.core.settings import get_settings

    monkeypatch.setattr(get_settings(), "database_url", None)
    assert poll_upstream.main(["--once"]) == poll_upstream.EXIT_CONFIG
    assert "no DATABASE_URL" in capsys.readouterr().err


def test_an_exception_exits_1_with_one_line_and_no_password(monkeypatch, capsys):
    from openbinding_gateway.core.settings import get_settings

    monkeypatch.setattr(get_settings(), "database_url", "postgresql+asyncpg://openbinding:s3cret-pw@postgres/openbinding")

    async def broken(*args, **kwargs):
        raise RuntimeError("cannot reach postgresql+asyncpg://openbinding:s3cret-pw@postgres/openbinding")

    monkeypatch.setattr(poll_upstream, "poll", broken)
    assert poll_upstream.main(["--once"]) == poll_upstream.EXIT_FAILED
    captured = capsys.readouterr()
    assert captured.out == "" and "RuntimeError" in captured.err and "s3cret-pw" not in captured.err
