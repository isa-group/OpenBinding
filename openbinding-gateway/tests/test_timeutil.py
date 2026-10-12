"""``utc_timestamp_z``: the exact createdAt wire format, whatever the process clock zone."""

from __future__ import annotations

import re
import time
from datetime import datetime, timedelta, timezone

import pytest

from openbinding_gateway.core import timeutil
from openbinding_gateway.core.timeutil import utc_timestamp_z

STRICT = re.compile(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$")


@pytest.fixture
def madrid_clock(monkeypatch):
    """A process whose local timezone is not UTC, restored afterwards."""
    # A POSIX rule rather than a zoneinfo name: it needs no tz database.
    monkeypatch.setenv("TZ", "CET-1CEST,M3.5.0,M10.5.0/3")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


def _frozen(monkeypatch, moment: datetime) -> None:
    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return moment.astimezone(tz) if tz is not None else moment.replace(tzinfo=None)

    monkeypatch.setattr(timeutil, "datetime", Frozen)


def test_explicit_utc_moment_is_formatted_to_the_second():
    moment = datetime(2026, 10, 12, 0, 0, 0, tzinfo=timezone.utc)
    assert utc_timestamp_z(moment) == "2026-10-12T00:00:00Z"


def test_fractions_are_dropped_not_rounded():
    moment = datetime(2026, 10, 12, 23, 59, 59, 999999, tzinfo=timezone.utc)
    assert utc_timestamp_z(moment) == "2026-10-12T23:59:59Z"


def test_other_offsets_are_converted_to_utc():
    plus_two = timezone(timedelta(hours=2))
    moment = datetime(2026, 10, 12, 1, 30, 5, tzinfo=plus_two)
    assert utc_timestamp_z(moment) == "2026-10-11T23:30:05Z"


def test_a_naive_datetime_is_refused():
    with pytest.raises(ValueError, match="timezone-aware"):
        utc_timestamp_z(datetime(2026, 10, 12, 0, 0, 0))


def test_the_default_clock_is_frozen_and_the_process_zone_is_not_utc(monkeypatch, madrid_clock):
    # 22:00:00 UTC on 2026-10-11 is already 2026-10-12 00:00 in CEST.
    _frozen(monkeypatch, datetime(2026, 10, 11, 22, 0, 0, 123456, tzinfo=timezone.utc))
    assert time.localtime(0).tm_gmtoff == 3600  # the process really is not on UTC
    assert datetime.now().astimezone().utcoffset() != timedelta(0)
    assert utc_timestamp_z() == "2026-10-11T22:00:00Z"


def test_the_output_matches_the_strict_pattern_in_every_case(monkeypatch, madrid_clock):
    samples = [
        datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc),
        datetime(2026, 12, 31, 23, 59, 59, tzinfo=timezone.utc),
        datetime(2028, 2, 29, 12, 0, 0, tzinfo=timezone(timedelta(hours=-5))),
    ]
    for moment in samples:
        value = utc_timestamp_z(moment)
        assert STRICT.fullmatch(value), value
        assert len(value) == 20
    assert STRICT.fullmatch(utc_timestamp_z())
    assert not STRICT.fullmatch("2026-10-12T00:00:00.000Z")
    assert not STRICT.fullmatch("2026-10-12T00:00:00+00:00")
