"""The tables behind accounts, sessions and API keys.

Two decisions here are worth stating, because both were deliberate and both
would look arbitrary later.

Enumerated columns are stored as strings with a check constraint rather than as
a native database enum. A native enum reads better in ``psql``, but altering one
is a migration with a table rewrite, and these are exactly the columns that grow
a value later - another role, another plan.

The plan a user is on is cached here, but it is not the truth. The contract in
SPACE is, because that is what decides whether a request is allowed. The column
exists so a user list can be rendered without one SPACE call per row, and
``contract_pending`` records the case that makes the cache necessary: a
registration that succeeded locally while SPACE was unreachable, to be
reconciled the next time that user turns up.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base


def utcnow() -> datetime:
    """Timezone-aware "now", so stored timestamps are never ambiguous."""
    return datetime.now(timezone.utc)


class UserRole(str, enum.Enum):
    USER = "user"
    ADMIN = "admin"


class Plan(str, enum.Enum):
    BASIC = "BASIC"
    PRO = "PRO"


def _enum_column(python_enum, default, length: int = 16):
    return mapped_column(
        Enum(
            python_enum,
            native_enum=False,
            length=length,
            values_callable=lambda e: [member.value for member in e],
        ),
        nullable=False,
        default=default,
    )


class User(Base):
    """Someone with an account, whichever channel they arrive through.

    The web session and an API key resolve to the same row on purpose: the
    pricing plan applies to the user, not to how they happened to call.
    """

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    #: Stored lower-cased, so that logging in is not a guessing game about case.
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    role: Mapped[UserRole] = _enum_column(UserRole, UserRole.USER)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    #: Display cache of the SPACE contract; see the module docstring.
    plan_cache: Mapped[Plan] = _enum_column(Plan, Plan.BASIC)
    contract_pending: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow, server_default=func.now()
    )

    api_keys: Mapped[List["ApiKey"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    refresh_tokens: Mapped[List["RefreshToken"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )

    @property
    def is_admin(self) -> bool:
        return self.role is UserRole.ADMIN


class ApiKey(Base):
    """A personal key for the API channel.

    Only a hash of the key is kept, so a database read does not hand over
    working credentials. The prefix is stored in the clear and indexed because
    something has to find the row before there is anything to compare against;
    it identifies the key without being enough to use it.
    """

    __tablename__ = "api_keys"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    prefix: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    secret_hash: Mapped[str] = mapped_column(String(128), nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    #: Written at most once a minute; an audit hint, not an access log.
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(back_populates="api_keys")

    @property
    def is_active(self) -> bool:
        return self.revoked_at is None


class RefreshToken(Base):
    """One issued refresh token, so that it can be rotated and revoked.

    Access tokens are short-lived and never stored; refresh tokens are the ones
    worth being able to take back, which is why only these have a row.
    """

    __tablename__ = "refresh_tokens"

    jti: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(back_populates="refresh_tokens")

    @property
    def is_usable(self) -> bool:
        if self.revoked_at is not None:
            return False
        expires_at = self.expires_at
        if expires_at.tzinfo is None:
            # SQLite hands back naive datetimes; the value is UTC either way.
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        return expires_at > utcnow()
