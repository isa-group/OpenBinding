"""Search text is matched literally: ``%`` and ``_`` are not wildcards."""

from __future__ import annotations

import pytest
from sqlalchemy import Column, Integer, String, create_engine, func, select
from sqlalchemy.orm import Session, declarative_base



class _Unescaped:
    """What the routes did before the helper existed: no escaping at all."""

    LIKE_ESCAPE = "\\"

    @staticmethod
    def like_contains(text):
        return f"%{text}%"


def helper():
    try:
        from openbinding_gateway.core import like
    except ImportError:
        return _Unescaped
    return like


Base = declarative_base()


class Row(Base):
    __tablename__ = "rows"
    id = Column(Integer, primary_key=True)
    name = Column(String)


@pytest.fixture
def session():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        s.add_all(
            Row(name=n)
            for n in ["a_b", "axb", "100%", "100 percent", "1000", "back\\slash", "backXslash"]
        )
        s.commit()
        yield s


def found(session, text):
    like = helper()
    stmt = select(Row.name).where(
        func.lower(Row.name).like(like.like_contains(text.lower()), escape=like.LIKE_ESCAPE)
    )
    return sorted(session.scalars(stmt))


@pytest.mark.parametrize(
    "text,expected",
    [
        ("plain", "%plain%"),
        ("a_b", "%a\\_b%"),
        ("100%", "%100\\%%"),
        ("a\\b", "%a\\\\b%"),
        ("", "%%"),
    ],
)
def test_the_helper_escapes_backslash_percent_and_underscore(text, expected):
    assert helper().like_contains(text) == expected


def test_an_underscore_is_not_a_wildcard(session):
    assert found(session, "a_b") == ["a_b"]


def test_a_percent_matches_only_literal_percents(session):
    assert found(session, "100%") == ["100%"]


def test_a_backslash_is_literal(session):
    assert found(session, "back\\slash") == ["back\\slash"]


async def test_the_admin_account_search_treats_wildcards_literally(
    api_client, registration, db_session
):
    from sqlalchemy import select as sel

    from openbinding_gateway import space_client
    from openbinding_gateway.db.models import User, UserRole
    from _pricing import fake_pricing_gate

    space_client.set_gate(fake_pricing_gate())
    try:
        created = await api_client.post("/v1/auth/register", json=registration())
        assert created.status_code == 201, created.text
        details = registration()
        await api_client.post("/v1/auth/register", json=details)
        user = (
            await db_session.execute(sel(User).where(User.username == details["username"]))
        ).scalars().one()
        user.role = UserRole.ADMIN
        await db_session.flush()
        tokens = await api_client.post(
            "/v1/auth/login",
            json={"username_or_email": details["username"], "password": details["password"]},
        )
        admin = {"Authorization": f"Bearer {tokens.json()['access_token']}"}

        username = created.json()["username"]
        at = next(i for i, c in enumerate(username) if c.isalnum())
        masked = username[:at] + "_" + username[at + 1 :]

        assert (await api_client.get("/v1/admin/users", params={"search": masked}, headers=admin)).json()["total"] == 0
        assert (await api_client.get("/v1/admin/users", params={"search": "%"}, headers=admin)).json()["total"] == 0
        assert (await api_client.get("/v1/admin/users", params={"search": username}, headers=admin)).json()["total"] >= 1
    finally:
        space_client.set_gate(None)
