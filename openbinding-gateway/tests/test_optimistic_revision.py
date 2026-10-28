"""The revision helper: If-Match parsing, ETag stability and the precondition."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from openbinding_gateway.core import revision

STAMP = datetime(2026, 10, 28, 12, 30, 15, 123456, tzinfo=timezone.utc)


def row(stamp: datetime = STAMP, identity: uuid.UUID | None = None, table: str = "projects"):
    return SimpleNamespace(id=identity or uuid.UUID(int=1), updated_at=stamp, __tablename__=table)


def refusal(call) -> HTTPException:
    with pytest.raises(HTTPException) as caught:
        call()
    return caught.value


def test_etag_is_a_quoted_strong_tag() -> None:
    tag = revision.etag_for(row())

    assert tag.startswith('"') and tag.endswith('"') and not tag.startswith("W/")
    assert revision.parse_if_match(tag) == [tag]


def test_etag_is_stable_and_follows_updated_at() -> None:
    assert revision.etag_for(row()) == revision.etag_for(row())
    assert revision.etag_for(row()) != revision.etag_for(row(STAMP + timedelta(microseconds=1)))


def test_etag_differs_between_rows_and_tables() -> None:
    assert revision.etag_for(row()) != revision.etag_for(row(identity=uuid.UUID(int=2)))
    assert revision.etag_for(row()) != revision.etag_for(row(table="organizations"))


def test_etag_does_not_show_the_timestamp_or_id() -> None:
    tag = revision.etag_for(row())

    assert "2026" not in tag and str(uuid.UUID(int=1)) not in tag


def test_naive_and_aware_datetimes_give_the_same_etag() -> None:
    naive = STAMP.replace(tzinfo=None)
    offset = STAMP.astimezone(timezone(timedelta(hours=5)))

    assert revision.etag_for(row(naive)) == revision.etag_for(row(STAMP)) == revision.etag_for(row(offset))
    assert revision.normalise(naive) == STAMP


def test_parse_absent_header_is_none() -> None:
    assert revision.parse_if_match(None) is None


def test_parse_wildcard_and_lists() -> None:
    assert revision.parse_if_match("*") == ["*"]
    assert revision.parse_if_match(" * ") == ["*"]
    assert revision.parse_if_match('"a"') == ['"a"']
    assert revision.parse_if_match('"a", "b" ,"c"') == ['"a"', '"b"', '"c"']
    assert revision.parse_if_match('W/"a", "b"') == ['W/"a"', '"b"']


def test_parse_accepts_empty_list_elements() -> None:
    assert revision.parse_if_match('"a",') == ['"a"']
    assert revision.parse_if_match(', "a",, "b"') == ['"a"', '"b"']


@pytest.mark.parametrize("value", ["", "  ", ",", "abc", '"a', 'a"', '"a" "b"', '*, "a"', '"a", *', "W/a", "**", '"a"x'])
def test_parse_malformed_is_400(value: str) -> None:
    error = refusal(lambda: revision.parse_if_match(value))

    assert error.status_code == 400
    assert error.detail["code"] == "invalid_if_match"


def test_precondition_passes_for_absent_wildcard_and_current_tag() -> None:
    current = row()
    tag = revision.etag_for(current)

    revision.precondition(current, None)
    revision.precondition(current, "*")
    revision.precondition(current, tag)
    revision.precondition(current, f'"other", {tag}')


def test_precondition_refuses_a_stale_tag_with_the_current_one() -> None:
    current = row()
    stale = revision.etag_for(row(STAMP - timedelta(seconds=1)))

    error = refusal(lambda: revision.precondition(current, stale))

    assert error.status_code == 412
    assert error.detail["code"] == "precondition_failed"
    assert error.headers["ETag"] == revision.etag_for(current)


def test_precondition_never_matches_a_weak_tag() -> None:
    current = row()

    error = refusal(lambda: revision.precondition(current, "W/" + revision.etag_for(current)))

    assert error.status_code == 412


def test_precondition_malformed_is_400_not_412() -> None:
    assert refusal(lambda: revision.precondition(row(), "nonsense")).status_code == 400
