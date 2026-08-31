"""Add immutable API-key grants and retire invalid duplicate deployments."""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any, Mapping, Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e12f4a7c9b30"
down_revision: Union[str, None] = "c7b2a4d91e30"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_USER_PERMISSIONS = [
    "account:read",
    "account:write",
    "keys:read",
    "keys:write",
    "instances:read",
    "instances:write",
    "instances:analyze",
    "jobs:read",
    "engines:read",
    "engines:execute",
    "engines:register",
    "engines:publish",
    "extensions:register",
]
_ADMIN_PERMISSIONS = [
    "engines:moderate",
    "extensions:moderate",
    "admin:accounts:read",
    "admin:accounts:write",
]


def _json_object(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, Mapping) else {}
    return {}


def _retire_invalid_duplicates(bind) -> None:
    """Delete only failed legacy rows superseded by a verified deployment.

    Older OpenBinding builds accepted EngineRegistration rows without their
    deployment OpenAPI document. Those rows can never pass today's immutable
    conformance check and, when a verified replacement exists for the same
    owner/name/Engine/endpoint, are only a broken duplicate. Sole drafts and
    historical valid revisions are deliberately untouched.
    """

    registrations = sa.table(
        "v1_engine_registration_revisions",
        sa.column("id", sa.Uuid()),
        sa.column("owner_id", sa.Uuid()),
        sa.column("name", sa.String()),
        sa.column("manifest_digest", sa.String()),
        sa.column("engine_digest", sa.String()),
        sa.column("endpoint", sa.String()),
        sa.column("document", sa.JSON()),
        sa.column("verification_report", sa.JSON()),
    )
    publications = sa.table(
        "v1_manifest_publications",
        sa.column("resource_kind", sa.String()),
        sa.column("resource_digest", sa.String()),
    )
    credentials = sa.table(
        "v1_engine_credentials",
        sa.column("registration_id", sa.Uuid()),
    )
    grouped: dict[tuple[Any, str, str, str], list[Any]] = defaultdict(list)
    rows = list(bind.execute(sa.select(registrations)).mappings())
    for row in rows:
        grouped[(row["owner_id"], row["name"], row["engine_digest"], row["endpoint"])].append(row)

    doomed: list[Any] = []
    doomed_digests: list[str] = []
    for group in grouped.values():
        if len(group) < 2:
            continue
        verified = [
            row
            for row in group
            if _json_object(row["verification_report"]).get("status") == "verified"
            and isinstance(_json_object(row["document"]).get("spec"), Mapping)
            and isinstance(_json_object(row["document"])["spec"].get("openapi"), Mapping)
        ]
        if not verified:
            continue
        for row in group:
            document = _json_object(row["document"])
            report = _json_object(row["verification_report"])
            spec = document.get("spec") if isinstance(document.get("spec"), Mapping) else {}
            if (
                not isinstance(spec.get("openapi"), Mapping)
                and report.get("status") == "failed"
            ):
                doomed.append(row["id"])
                doomed_digests.append(row["manifest_digest"])

    if doomed_digests:
        bind.execute(
            sa.delete(publications).where(
                publications.c.resource_kind == "EngineRegistration",
                publications.c.resource_digest.in_(doomed_digests),
            )
        )
    if doomed:
        # PostgreSQL follows the FK's ON DELETE CASCADE. SQLite migrations do
        # not necessarily enable FK pragmas, so make the same result explicit.
        bind.execute(
            sa.delete(credentials).where(credentials.c.registration_id.in_(doomed))
        )
        bind.execute(sa.delete(registrations).where(registrations.c.id.in_(doomed)))


def upgrade() -> None:
    op.add_column("api_keys", sa.Column("grants", sa.JSON(), nullable=True))
    bind = op.get_bind()

    api_keys = sa.table(
        "api_keys",
        sa.column("id", sa.Uuid()),
        sa.column("user_id", sa.Uuid()),
        sa.column("grants", sa.JSON()),
    )
    users = sa.table(
        "users",
        sa.column("id", sa.Uuid()),
        sa.column("role", sa.String()),
    )
    rows = bind.execute(
        sa.select(api_keys.c.id, users.c.role).select_from(
            api_keys.join(users, api_keys.c.user_id == users.c.id)
        )
    )
    for key_id, role in rows:
        permissions = [*_USER_PERMISSIONS]
        if role == "admin":
            permissions.extend(_ADMIN_PERMISSIONS)
        bind.execute(
            sa.update(api_keys)
            .where(api_keys.c.id == key_id)
            .values(
                grants={
                    "permissions": sorted(permissions),
                    "allEngines": True,
                    "engines": [],
                }
            )
        )

    with op.batch_alter_table("api_keys") as batch:
        batch.alter_column(
            "grants",
            existing_type=sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'"),
        )

    _retire_invalid_duplicates(bind)


def downgrade() -> None:
    with op.batch_alter_table("api_keys") as batch:
        batch.drop_column("grants")
