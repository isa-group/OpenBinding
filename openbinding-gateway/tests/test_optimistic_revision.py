"""The revision helper: If-Match parsing, ETag stability and the precondition."""

from __future__ import annotations

import re
import time
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

    assert re.fullmatch(r'"[0-9a-f]{32}"', tag)


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


@pytest.mark.parametrize(
    "value", ["", "  ", ",", "abc", '"a', 'a"', '"a" "b"', '*, "a"', '"a", *', "W/a", "**", '"a"x', '"a b"']
)
def test_parse_malformed_is_400(value: str) -> None:
    error = refusal(lambda: revision.parse_if_match(value))

    assert error.status_code == 400
    assert error.detail["code"] == "invalid_if_match"


def test_parse_accepts_tabs_as_optional_whitespace() -> None:
    assert revision.parse_if_match('\t"a" ,\t"b"\t') == ['"a"', '"b"']
    assert revision.parse_if_match("\t*\t") == ["*"]


@pytest.mark.parametrize(
    "value", ['"a" "b"', '　"a"', '"a"\x0c', '"a"\r', '"a"\x0b,"b"', '"a"\u0085,"b"']
)
def test_parse_refuses_whitespace_that_is_not_space_or_tab(value: str) -> None:
    assert refusal(lambda: revision.parse_if_match(value)).status_code == 400


def test_parse_refuses_a_value_over_the_cap_before_the_grammar_runs(monkeypatch) -> None:
    at_cap = '"' + "a" * (revision.MAX_IF_MATCH_LENGTH - 2) + '"'
    over = '"' + "a" * (revision.MAX_IF_MATCH_LENGTH - 1) + '"'

    assert len(at_cap) == revision.MAX_IF_MATCH_LENGTH
    assert revision.parse_if_match(at_cap) == [at_cap]

    class Unreachable:
        def fullmatch(self, value: str):
            raise AssertionError("the grammar ran on a value over the cap")

    monkeypatch.setattr(revision, "_IF_MATCH", Unreachable())
    error = refusal(lambda: revision.parse_if_match(over))
    assert error.status_code == 400
    assert error.detail["code"] == "invalid_if_match"


@pytest.mark.parametrize("filler", [", " * 1000, " " * 2000, ",\t" * 1000 + "x", '"a"' + " ," * 700 + "x"])
def test_parse_of_a_pathological_header_returns_quickly(filler: str) -> None:
    started = time.perf_counter()
    try:
        revision.parse_if_match(filler)
    except HTTPException:
        pass

    assert time.perf_counter() - started < 0.5


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


# -- A revision that is not a row's: ``opaque_etag`` and ``check`` ------------------------------


def test_opaque_etag_is_the_row_digest_for_the_same_parts() -> None:
    current = row()
    stamp = STAMP.isoformat(timespec="microseconds")

    assert revision.opaque_etag(current.__tablename__, current.id, stamp) == revision.etag_for(current)
    assert re.fullmatch(r'"[0-9a-f]{32}"', revision.opaque_etag("contract", uuid.UUID(int=1), "v7"))
    assert revision.opaque_etag("contract", uuid.UUID(int=1), "v7") != revision.opaque_etag(
        "contract", uuid.UUID(int=2), "v7"
    )


def test_check_passes_for_absent_wildcard_and_a_list_naming_the_current_tag() -> None:
    tag = revision.opaque_etag("contract", "u", "v1")

    revision.check(None, tag)
    revision.check(["*"], tag)
    revision.check(['"other"', tag], tag)
    # The resource exists but keeps no revision: only the absent header and ``*`` pass.
    revision.check(None, None)
    revision.check(["*"], None)


def test_check_refuses_a_stale_or_weak_tag_with_the_current_one() -> None:
    tag = revision.opaque_etag("contract", "u", "v2")

    for tags in (['"stale"'], ["W/" + tag]):
        error = refusal(lambda tags=tags: revision.check(tags, tag))
        assert error.status_code == 412
        assert error.detail["code"] == "precondition_failed"
        assert error.headers["ETag"] == tag


def test_check_refuses_any_tag_for_a_resource_without_revision_and_carries_no_etag() -> None:
    error = refusal(lambda: revision.check(['"abc"'], None))

    assert error.status_code == 412
    assert not (error.headers or {}).get("ETag")


def test_names_is_a_tag_list_without_the_wildcard() -> None:
    assert revision.names(['"a"']) and revision.names(['"a"', '"b"'])
    assert not revision.names(None) and not revision.names(["*"])
