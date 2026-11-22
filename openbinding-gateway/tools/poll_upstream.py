#!/usr/bin/env python3
"""Run one upstream watch cycle now, as the gateway's watcher does, and print what it did.

The gateway polls every watched pricing on its own (``UPSTREAM_POLL_INTERVAL_S``, 300 s by default, 20 s in the lab);
this tool runs the same cycle once, on demand, for an operator or a demo that does not want to wait:

    docker compose -f compose.lab.json exec gateway python tools/poll_upstream.py --once

It builds what the gateway's lifespan builds (the settings, the database engine and one ``SphereHttpSource``), takes
the watcher's advisory lock (a cycle a replica is running at that moment wins, and this one is reported as skipped
with ``skipped: "lock"``), and calls ``upstream_watcher.run_cycle``: the same housekeeping, claims, conditional
manifest reads, snapshots, classification and events, and the same back-off windows. ``--force`` claims every watch
with a live reference whatever its ``next_poll_at``; it still honours a watch's 429 window and cannot shorten the
two-404 ``gone`` debounce, which the database clock judges. No endpoint is added for it.

Output: the cycle's report on stdout, one ``upstream_watch_cycle …`` line, or with ``--json`` one JSON document
(``CycleReport``: claimed, not_modified, new_versions, busy, unavailable, gone, reads, classified, events, notified,
…, skipped). Exit code: 0 when the cycle ran, even when nothing changed or it was skipped; 1 on an exception; 2 on a
configuration error (no database). The watcher's own log lines go to stderr.

Usage:
    python tools/poll_upstream.py [--once] [--force] [--json]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
import sys
from collections.abc import Callable, Sequence
from typing import Any

EXIT_OK, EXIT_FAILED, EXIT_CONFIG = 0, 1, 2


async def poll(factory: Callable[[], Any], *, force: bool = False, source: Any = None, settings: Any = None) -> Any:
    """One cycle under the watcher's advisory lock; the ``CycleReport`` (``skipped="lock"`` when another holds it)."""
    from openbinding_gateway.jobs.reconciler import acquire_cycle_lock
    from openbinding_gateway.modules.compositions.application import upstream_watcher

    async with factory() as lock_session:
        if not await acquire_cycle_lock(lock_session, upstream_watcher.UPSTREAM_WATCH_LOCK_KEY):
            return upstream_watcher.CycleReport(skipped="lock")
        return await upstream_watcher.run_cycle(factory, source, force=force, settings=settings)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one upstream watch cycle now and print its report.")
    parser.add_argument("--once", action="store_true", help="one cycle (the only mode; says so explicitly)")
    parser.add_argument("--force", action="store_true",
                        help="claim every live watch now, whatever its next poll (429 windows and the gone debounce hold)")
    parser.add_argument("--json", action="store_true", help="print the report as one JSON document")
    return parser


async def _run(args: argparse.Namespace) -> int:
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.db import base as db_base
    from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
    from openbinding_gateway.modules.plans.application import installed_pricing_source, set_pricing_source

    settings = get_settings()
    if not settings.database_url:
        print("poll_upstream: no DATABASE_URL configured", file=sys.stderr)
        return EXIT_CONFIG
    own_source = installed_pricing_source() is None
    if own_source:
        set_pricing_source(SphereHttpSource(settings))
    db_base.init_engine(settings.database_url)
    try:
        report = await poll(db_base.session_factory(), force=args.force, settings=settings)
    finally:
        await db_base.dispose_engine()
        if own_source:
            set_pricing_source(None)
    print(json.dumps(report.as_json(), indent=2, sort_keys=True) if args.json else _line(report))
    return EXIT_OK


def _line(report: Any) -> str:
    return report.line() + (f" skipped={report.skipped}" if report.skipped else "")


def _masked(text: str) -> str:
    """``text`` with the userinfo of any URL in it (a database password) replaced by ``***``."""
    return re.sub(r"://[^/@\s]+@", "://***@", text)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(name)s %(message)s")
    try:
        return asyncio.run(_run(args))
    except Exception as error:  # noqa: BLE001 - the operator gets one line and exit 1, never a half-printed report
        print(f"poll_upstream: {type(error).__name__}: {_masked(str(error))[:300]}", file=sys.stderr)
        return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
