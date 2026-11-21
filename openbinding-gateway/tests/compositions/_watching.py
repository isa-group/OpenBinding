"""The watcher's test harness (not a test module): two clocks moved by hand and one cycle on the test database.

``jobs.clock.utcnow`` is the watcher's clock on SQLite and ``SphereHttpSource(clock=)`` the adapter's; nothing sleeps.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import PricingWatch
from openbinding_gateway.jobs import clock
from openbinding_gateway.modules.compositions.application import upstream_watcher as uw

START = datetime(2026, 11, 21, 12, 0, 0, tzinfo=timezone.utc)


class Clocks:
    """The watcher's clock (``jobs.clock.utcnow``) and the adapter's (monotonic seconds), moved together."""

    def __init__(self, monkeypatch) -> None:
        self.now = START
        self.adapter = 1000.0
        monkeypatch.setattr(clock, "utcnow", lambda: self.now)

    def __call__(self) -> float:
        return self.adapter

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)
        self.adapter += seconds


def settings(**update):
    return get_settings().model_copy(update={"sphere_enabled": True, "upstream_watch_enabled": True,
                                             "upstream_poll_interval_s": 20, **update})


async def cycle(db_session, source, *, force: bool = True, **update) -> uw.CycleReport:
    await db_session.commit()
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    report = await uw.run_cycle(factory, source, force=force, settings=settings(**update))
    db_session.expire_all()
    return report


async def watch_of(db_session, pricing_id: str) -> PricingWatch:
    return await db_session.scalar(select(PricingWatch).where(PricingWatch.pricing_id == pricing_id)
                                   .execution_options(populate_existing=True))
