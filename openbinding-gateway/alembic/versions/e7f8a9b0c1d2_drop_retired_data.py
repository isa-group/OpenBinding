"""M9.6: drop the retired data (analysis tasks, sponsor proposals, draft reports).

The owner approved this irreversible drop with one guard: it only runs once the rows have been exported
with ``tools/export_retired_data.py``. The guard runs before any change: when the six selections hold no
row the revision proceeds; otherwise ``OPENBINDING_M96_EXPORT_MANIFEST`` must name a manifest whose row
counts, file hashes and primary-key sets equal the rows about to be deleted now.

The selections are the same SQL as in the export tool (``tests/test_drop_retired_data_migration.py``
compares the two texts). The migration uses raw SQL by table name, never ORM models, so it keeps
working while the models of the retired tables are gone.

Kept: publications, artifact_versions and everything else outside the four deleted selections.
The downgrade recreates ``analysis_tasks`` and ``sponsor_proposals`` empty.
"""
import hashlib
import json
import os
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic import op

revision = 'e7f8a9b0c1d2'
down_revision = 'b6c7d8e9f0a1'
branch_labels = None
depends_on = None

MANIFEST_VARIABLE = 'OPENBINDING_M96_EXPORT_MANIFEST'
ALEMBIC_HEAD = 'b6c7d8e9f0a1'
FORMAT = 'openbinding-m96-export/1'
CHUNK = 500

SOURCES = (
    'analysis_tasks',
    'sponsor_proposals',
    'report_drafts',
    'report_artifact_drafts',
    'report_artifacts',
    'report_project_artifacts',
)
PRIMARY_KEYS = {
    'analysis_tasks': ('id',),
    'sponsor_proposals': ('id',),
    'report_drafts': ('id',),
    'report_artifact_drafts': ('id',),
    'report_artifacts': ('id',),
    'report_project_artifacts': ('project_id', 'artifact_id'),
}

# Same text as tools/export_retired_data.py.
_REPORT_DRAFTS = (
    "SELECT rd.id FROM reports rd WHERE rd.state = 'draft' AND rd.version_id IS NULL "
    "AND NOT EXISTS (SELECT 1 FROM artifact_versions rdv WHERE rdv.artifact_id = rd.artifact_id) "
    "AND NOT EXISTS (SELECT 1 FROM publications rdp WHERE rdp.report_id = rd.id)"
)
_REPORT_ARTIFACT_DRAFTS = (
    "SELECT ad.id FROM artifact_drafts ad JOIN artifacts ada ON ada.id = ad.artifact_id "
    "WHERE ad.sealed_version_id IS NULL AND ada.kind = 'Report' "
    "AND NOT EXISTS (SELECT 1 FROM reports adr WHERE adr.draft_id = ad.id "
    "AND adr.id NOT IN (" + _REPORT_DRAFTS + "))"
)
_REPORT_ARTIFACTS = (
    "SELECT ra.id FROM artifacts ra WHERE ra.kind = 'Report' "
    "AND NOT EXISTS (SELECT 1 FROM artifact_versions rav WHERE rav.artifact_id = ra.id) "
    "AND NOT EXISTS (SELECT 1 FROM reports rar WHERE rar.artifact_id = ra.id "
    "AND rar.id NOT IN (" + _REPORT_DRAFTS + ")) "
    "AND NOT EXISTS (SELECT 1 FROM artifact_drafts rad WHERE rad.artifact_id = ra.id "
    "AND rad.id NOT IN (" + _REPORT_ARTIFACT_DRAFTS + "))"
)
SELECTIONS = {
    'analysis_tasks': "SELECT id FROM analysis_tasks",
    'sponsor_proposals': "SELECT id FROM sponsor_proposals",
    'report_drafts': _REPORT_DRAFTS,
    'report_artifact_drafts': _REPORT_ARTIFACT_DRAFTS,
    'report_artifacts': _REPORT_ARTIFACTS,
    'report_project_artifacts': (
        "SELECT pa.project_id, pa.artifact_id FROM project_artifacts pa WHERE pa.artifact_id IN ("
        + _REPORT_ARTIFACTS + ")"
    ),
}


def _normalise(value):
    """A key part as the lowercase hyphenated UUID text when it is a UUID (SQLite stores 32 hex digits)."""
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, str) and len(value) in (32, 36):
        try:
            return str(uuid.UUID(value))
        except ValueError:
            return value
    return str(value)


def _select(bind, source):
    """The raw key rows of one selection, as the database returns them."""
    return [tuple(row) for row in bind.execute(sa.text(SELECTIONS[source])).all()]


def _key_set(rows):
    return {tuple(_normalise(part) for part in row) for row in rows}


def _refuse(reason):
    raise RuntimeError(
        f"M9.6 migration refused, nothing was changed: {reason}. The tables analysis_tasks and "
        f"sponsor_proposals and the draft reports are about to be deleted and need a matching export. "
        f"Run `python tools/export_retired_data.py --out DIR` against this database (gateway stopped), "
        f"then set {MANIFEST_VARIABLE} to DIR/manifest.json and run the migration again "
        f"(docs/runbooks/retired-data-export.md)."
    )


def _file_keys(source, path):
    keys = []
    # One row per "\n"-ended line; str.splitlines() would also split inside a string at U+2028.
    lines = path.read_bytes().split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    for number, raw in enumerate(lines, start=1):
        try:
            document = json.loads(raw)
            keys.append(tuple(_normalise(document[name]) for name in PRIMARY_KEYS[source]))
        except (ValueError, KeyError, TypeError):
            _refuse(f"source {source}: line {number} of {path.name} is not a row with its primary key")
    return keys


# [impl->req~data-retirement-guard~1]
# [impl->req~data-retirement-guard-empty~1]
def _guard(bind):
    """Return the selected key rows of every source, or raise before anything has changed."""
    selected = {source: _select(bind, source) for source in SOURCES}
    if not any(selected.values()):
        return selected
    location = os.environ.get(MANIFEST_VARIABLE)
    if not location:
        _refuse(f"{MANIFEST_VARIABLE} is not set")
    manifest_path = Path(location)
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        _refuse(f"{MANIFEST_VARIABLE}={location} cannot be read as a manifest ({error})")
    if not isinstance(manifest, dict) or manifest.get('format') != FORMAT:
        _refuse(f"the manifest {location} does not have format {FORMAT}")
    if manifest.get('alembic_head') != ALEMBIC_HEAD:
        _refuse(f"the manifest was exported at revision {manifest.get('alembic_head')!r}, not {ALEMBIC_HEAD}")
    entries = manifest.get('sources')
    if not isinstance(entries, dict):
        _refuse(f"the manifest {location} has no sources")
    for source in SOURCES:
        entry = entries.get(source)
        if not isinstance(entry, dict) or not all(isinstance(entry.get(k), t) for k, t in (('file', str), ('rows', int), ('sha256', str))):
            _refuse(f"source {source} is missing or malformed in the manifest")
        if entry['rows'] != len(selected[source]):
            _refuse(f"source {source}: the manifest has {entry['rows']} rows, the database has {len(selected[source])} now")
        if Path(entry['file']).name != entry['file'] or entry['file'] in ('', '.', '..'):
            _refuse(f"source {source}: the file name {entry['file']!r} is not a plain file name")
        data_path = manifest_path.parent / entry['file']
        try:
            digest = hashlib.sha256(data_path.read_bytes()).hexdigest()
        except OSError as error:
            _refuse(f"source {source}: the file {data_path} cannot be read ({error})")
        if digest != entry['sha256']:
            _refuse(f"source {source}: the sha256 of {data_path} is not the one in the manifest")
        keys = _file_keys(source, data_path)
        if len(keys) != entry['rows'] or set(keys) != _key_set(selected[source]):
            _refuse(f"source {source}: the primary keys in {data_path} are not those of the rows to be deleted")
    return selected


def _delete(bind, table, column, values, expected):
    deleted = 0
    for start in range(0, len(values), CHUNK):
        statement = sa.text(f"DELETE FROM {table} WHERE {column} IN :ids").bindparams(sa.bindparam('ids', expanding=True))
        deleted += bind.execute(statement, {'ids': values[start:start + CHUNK]}).rowcount
    if deleted != expected:
        raise RuntimeError(f"M9.6 migration: deleted {deleted} rows of {table}, expected {expected}; nothing is committed")


# [impl->req~data-retirement-removed-set~1]
# [impl->req~data-retirement-kept-set~1]
def upgrade():
    bind = op.get_bind()
    selected = _guard(bind)
    # Foreign-key order: reports, their drafts, project links, artifacts.
    _delete(bind, 'reports', 'id', [row[0] for row in selected['report_drafts']], len(selected['report_drafts']))
    _delete(bind, 'artifact_drafts', 'id', [row[0] for row in selected['report_artifact_drafts']], len(selected['report_artifact_drafts']))
    artifact_ids = [row[0] for row in selected['report_artifacts']]
    _delete(bind, 'project_artifacts', 'artifact_id', artifact_ids, len(selected['report_project_artifacts']))
    _delete(bind, 'artifacts', 'id', artifact_ids, len(selected['report_artifacts']))
    op.drop_table('sponsor_proposals')
    op.drop_table('analysis_tasks')


# [impl->req~data-retirement-downgrade~1]
def downgrade():
    """Both tables come back empty, as they were at b6c7d8e9f0a1 (a2b3c4d5e6f7 + f2a3b4c5d6e7, d1e2f3a4b5c6)."""
    op.create_table(
        'analysis_tasks',
        sa.Column('id', sa.Uuid(), primary_key=True),
        sa.Column('owner_id', sa.Uuid(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('fingerprint', sa.String(80), nullable=False),
        sa.Column('revision', sa.String(80), nullable=False),
        sa.Column('request', sa.JSON(), nullable=False),
        sa.Column('state', sa.String(16), nullable=False),
        sa.Column('progress', sa.Float(), nullable=False),
        sa.Column('cancellation_requested', sa.Boolean(), nullable=False),
        sa.Column('lease_token', sa.String(36)),
        sa.Column('lease_until', sa.DateTime(timezone=True)),
        sa.Column('result', sa.JSON()),
        sa.Column('error', sa.String(512)),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'),
        sa.UniqueConstraint('owner_id', 'fingerprint', name='uq_analysis_tasks_owner_fingerprint'),
    )
    op.create_index('ix_analysis_tasks_owner_id', 'analysis_tasks', ['owner_id'])
    op.create_index('ix_analysis_tasks_state', 'analysis_tasks', ['state'])
    op.create_table(
        'sponsor_proposals',
        sa.Column('id', sa.Uuid(), primary_key=True),
        sa.Column('organization_id', sa.Uuid(), sa.ForeignKey('organizations.id', ondelete='CASCADE'), nullable=False),
        sa.Column('proposed_user_id', sa.Uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('proposed_by_user_id', sa.Uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('status', sa.String(32), nullable=False, server_default='pending'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('decided_by_user_id', sa.Uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('decision_reason', sa.String(64), nullable=True),
    )
    op.create_index('ix_sponsor_proposals_organization_id', 'sponsor_proposals', ['organization_id'])
    op.create_index('ix_sponsor_proposals_proposed_user_id', 'sponsor_proposals', ['proposed_user_id'])
    op.create_index('ix_sponsor_proposals_proposed_by_user_id', 'sponsor_proposals', ['proposed_by_user_id'])
    op.create_index('ix_sponsor_proposals_expires_at', 'sponsor_proposals', ['expires_at'])
    op.create_index(
        'uq_sponsor_proposal_pending',
        'sponsor_proposals',
        ['organization_id'],
        unique=True,
        sqlite_where=sa.text("status = 'pending'"),
        postgresql_where=sa.text("status = 'pending'"),
    )
