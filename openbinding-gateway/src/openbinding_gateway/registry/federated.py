"""Turning rows in ``federated_engines`` into engines the gateway can use.

The registry is consulted from synchronous code - the validation pipeline, the
schema routes - and the rows live in an async database, so the two cannot meet
directly. They meet through a cache: this module reads the table, builds a
plugin and a transport per row, and hands the registry a snapshot to hold.
Everything downstream stays synchronous and knows nothing about where an engine
came from.

A row that will not load does not take the others with it. An engine whose
manifest no longer parses, or whose credential will not decrypt under the
current key, is skipped and reported; the alternative is one bad registration
making every engine disappear at startup.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..core.settings import Settings, get_settings
from ..db.models import EngineStatus, EngineVisibility, FederatedEngine
from ..federation.transport import FederatedTransport
from ..models.manifest import EngineManifest
from ..security.secrets import CredentialStore
from ..validation.engine_plugins.federated import FederatedEnginePlugin

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class FederatedEntry:
    """One registered engine, ready to be used."""

    engine_id: str
    owner_id: UUID
    owner_username: str
    visibility: EngineVisibility
    status: EngineStatus
    plugin: FederatedEnginePlugin
    transport: FederatedTransport
    verified_at: Optional[object] = None

    @property
    def is_usable(self) -> bool:
        return self.status is EngineStatus.ACTIVE

    def is_visible_to(self, user) -> bool:
        """Whether this engine exists as far as ``user`` is concerned.

        Callers turn a false into a 404 rather than a 403: telling a stranger
        that ``alice~tabu`` exists but is not theirs tells them about Alice.
        """
        if self.visibility is EngineVisibility.PUBLIC:
            return True
        if user is None:
            return False
        return getattr(user, "id", None) == self.owner_id or getattr(user, "is_admin", False)


def build_entry(
    row: FederatedEngine,
    *,
    store: CredentialStore,
    settings: Optional[Settings] = None,
) -> FederatedEntry:
    """One row, as a plugin and a transport. Raises if the row is unusable."""
    settings = settings or get_settings()
    manifest = EngineManifest.model_validate(row.manifest)

    credential: Optional[str] = None
    if row.credential_encrypted:
        # Decrypted once, at load, rather than on every solve: a key that has
        # been rotated should disable the engine visibly instead of failing
        # each request in the same way a dead engine does.
        credential = store.decrypt(row.credential_encrypted)

    owner_username = getattr(row.owner, "username", "") if row.owner is not None else ""

    plugin = FederatedEnginePlugin(
        manifest, owner=owner_username, verified_at=row.verified_at
    )
    transport = FederatedTransport(
        manifest,
        row.openapi_document or {},
        credential=credential,
        require_https=settings.federation_require_https,
    )

    return FederatedEntry(
        engine_id=row.engine_id,
        owner_id=row.owner_id,
        owner_username=owner_username,
        visibility=row.visibility,
        status=row.status,
        plugin=plugin,
        transport=transport,
        verified_at=row.verified_at,
    )


async def load_entries(
    session: AsyncSession,
    *,
    store: Optional[CredentialStore] = None,
    settings: Optional[Settings] = None,
) -> Tuple[List[FederatedEntry], List[str]]:
    """Every registered engine, plus a note for each that could not be built."""
    settings = settings or get_settings()
    store = store or CredentialStore.from_settings(settings)

    rows: Sequence[FederatedEngine] = (
        (
            await session.execute(
                select(FederatedEngine).options(selectinload(FederatedEngine.owner))
            )
        )
        .scalars()
        .all()
    )

    entries: List[FederatedEntry] = []
    problems: List[str] = []
    for row in rows:
        try:
            entries.append(build_entry(row, store=store, settings=settings))
        except Exception as error:  # noqa: BLE001 - one bad row must not hide the rest
            problems.append(f"{row.engine_id}: {error}")
            logger.warning("Skipping federated engine %s: %s", row.engine_id, error)

    return entries, problems
