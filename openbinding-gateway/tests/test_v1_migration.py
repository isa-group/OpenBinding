"""Smoke-test the destructive v1 database cut-over on SQLite."""

import os
import json
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path


def test_v1_migration_creates_resources_and_preserves_account_tables(tmp_path: Path) -> None:
    database = tmp_path / "migration.db"
    environment = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    root = Path(__file__).parents[1]
    completed = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", "upgrade", "head"],
        cwd=root,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    with sqlite3.connect(database) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"users", "api_keys", "v1_instance_snapshots", "v1_instance_resources", "v1_binding_ir", "v1_engine_revisions", "v1_engine_registration_revisions"} <= tables
        columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
        assert {
            "instance_complexity",
            "instance_snapshot_id",
            "provenance",
            "idempotency_key",
            "idempotency_fingerprint",
            "termination",
        } <= columns
        assert "binding_space" not in columns
        resource_columns = {row[1] for row in connection.execute("PRAGMA table_info(v1_instance_resources)")}
        assert {
            "resource_id",
            "api_version",
            "dialect_id",
            "registered_namespace",
            "registered_name",
            "registered_version",
            "registered_digest",
        } <= resource_columns
        registered_resource_columns = {
            row[1]
            for row in connection.execute(
                "PRAGMA table_info(v1_registered_resource_revisions)"
            )
        }
        assert {"api_version", "dialect_id"} <= registered_resource_columns
        registration_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(v1_engine_registration_revisions)")
        }
        assert {"namespace", "openapi_document", "openapi_digest", "is_active"} <= registration_columns
        api_key_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(api_keys)")
        }
        assert "grants" in api_key_columns


def test_v1_cutover_reports_exact_purge_and_preserves_accounts(tmp_path: Path) -> None:
    database = tmp_path / "cutover.db"
    environment = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    root = Path(__file__).parents[1]
    before = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", "upgrade", "441e59a50be2"],
        cwd=root,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert before.returncode == 0, before.stdout + before.stderr
    user_id = uuid.uuid4().hex
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO users (id, username, email, password_hash, role, is_active, plan_cache, contract_pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, "kept", "kept@example.org", "hash", "user", 1, "FREE", 0),
        )
        connection.execute(
            "INSERT INTO api_keys (id, user_id, name, prefix, secret_hash) VALUES (?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, user_id, "kept", "bim_kept", "hash"),
        )
        for index in range(2):
            connection.execute(
                "INSERT INTO jobs (id, owner_id, engine_id, engine_job_id, service_url, state, verbose, metered, concurrency_released, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (uuid.uuid4().hex, user_id, "legacy", f"job-{index}", "http://legacy", "queued", 0, 0, 0, "{}"),
            )
        for index in range(3):
            connection.execute(
                "INSERT INTO federated_engines (id, engine_id, owner_id, display_name, manifest, visibility, status, health_failures) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (uuid.uuid4().hex, f"legacy-{index}", user_id, f"Legacy {index}", "{}", "private", "draft", 0),
            )
        connection.commit()

    cutover = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", "upgrade", "head"],
        cwd=root,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert cutover.returncode == 0, cutover.stdout + cutover.stderr
    output = cutover.stdout + cutover.stderr
    assert "BIM v1 cut-over: purging 2 rows from jobs" in output
    assert "BIM v1 cut-over: purging 3 rows from federated_engines" in output
    with sqlite3.connect(database) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "federated_engines" not in tables
        assert connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
        assert connection.execute("SELECT username, plan_cache FROM users").fetchall() == [
            ("kept", "FREE")
        ]
        stored_key = connection.execute(
            "SELECT name, prefix, grants FROM api_keys"
        ).fetchone()
        assert stored_key[:2] == ("kept", "bim_kept")
        grants = json.loads(stored_key[2])
        assert grants["allEngines"] is True
        assert "engines:execute" in grants["permissions"]
        assert "admin:accounts:write" not in grants["permissions"]


def test_private_engine_lifecycle_migration_fails_closed(tmp_path: Path) -> None:
    database = tmp_path / "engine-lifecycle.db"
    environment = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    root = Path(__file__).parents[1]
    before = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", "upgrade", "9f1c2d3e4a5b"],
        cwd=root,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert before.returncode == 0, before.stdout + before.stderr

    user_id = uuid.uuid4().hex
    created_at = "2026-01-01 00:00:00"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO users (id, username, email, password_hash, role, is_active, plan_cache, contract_pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, "owner", "owner@example.org", "hash", "user", 1, "FREE", 0),
        )
        for index, state in enumerate(("draft", "pending_review", "published")):
            connection.execute(
                "INSERT INTO v1_engine_revisions (id, owner_id, namespace, name, version, digest, document, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    uuid.uuid4().hex,
                    user_id,
                    "owner",
                    f"engine-{index}",
                    "1.0.0",
                    f"sha256-{'a' * 63}{index}",
                    "{}",
                    state,
                    created_at,
                ),
            )
        for index, state in enumerate(("active", "public", "disabled", "pending_review", "rejected")):
            connection.execute(
                "INSERT INTO v1_engine_registration_revisions (id, owner_id, namespace, name, version, manifest_digest, engine_digest, document, endpoint, protocol_digest, mappings, auth_scheme, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    uuid.uuid4().hex,
                    user_id,
                    "owner",
                    f"deployment-{index}",
                    "1.0.0",
                    f"sha256-{'b' * 63}{index}",
                    f"sha256-{'a' * 63}0",
                    "{}",
                    "https://engine.example",
                    f"sha256-{'c' * 64}",
                    "{}",
                    "none",
                    state,
                    created_at,
                ),
            )
        connection.commit()

    upgraded = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", "upgrade", "head"],
        cwd=root,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr
    with sqlite3.connect(database) as connection:
        engines = connection.execute(
            "SELECT name, state FROM v1_engine_revisions ORDER BY name"
        ).fetchall()
        registrations = connection.execute(
            "SELECT name, state, is_active FROM v1_engine_registration_revisions ORDER BY name"
        ).fetchall()
    assert engines == [
        ("engine-0", "private"),
        ("engine-1", "private"),
        ("engine-2", "published"),
    ]
    assert registrations == [
        ("deployment-0", "private", 1),
        ("deployment-1", "published", 1),
        ("deployment-2", "private", 0),
        ("deployment-3", "private", 0),
        ("deployment-4", "rejected", 0),
    ]


def test_grants_migration_retires_only_a_superseded_invalid_deployment(
    tmp_path: Path,
) -> None:
    database = tmp_path / "granular-keys.db"
    environment = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    root = Path(__file__).parents[1]
    before = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", "upgrade", "c7b2a4d91e30"],
        cwd=root,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert before.returncode == 0, before.stdout + before.stderr

    user_id = uuid.uuid4().hex
    engine_id = uuid.uuid4().hex
    bad_id = uuid.uuid4().hex
    pending_id = uuid.uuid4().hex
    good_id = uuid.uuid4().hex
    engine_digest = f"sha256-{'a' * 64}"
    bad_digest = f"sha256-{'b' * 64}"
    pending_digest = f"sha256-{'e' * 64}"
    good_digest = f"sha256-{'c' * 64}"
    created_at = "2026-01-01 00:00:00"
    engine_ref = {
        "namespace": "owner",
        "name": "solver",
        "version": "1.0.0",
        "digest": engine_digest,
    }
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO users (id, username, email, password_hash, role, is_active, plan_cache, contract_pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, "owner", "owner@example.org", "hash", "user", 1, "FREE", 0),
        )
        connection.execute(
            "INSERT INTO v1_engine_revisions (id, owner_id, namespace, name, version, digest, document, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                engine_id,
                user_id,
                "owner",
                "solver",
                "1.0.0",
                engine_digest,
                json.dumps({"metadata": {"namespace": "owner", "name": "solver", "version": "1.0.0"}}),
                "published",
                created_at,
            ),
        )
        for registration_id, version, manifest_digest, document, report in (
            (
                bad_id,
                "1.0.0",
                bad_digest,
                {"spec": {"engine": engine_ref, "endpoint": "https://solver.example"}},
                {"status": "failed", "checks": [{"message": "missing OpenAPI"}]},
            ),
            (
                pending_id,
                "1.0.0-draft",
                pending_digest,
                {"spec": {"engine": engine_ref, "endpoint": "https://solver.example"}},
                {"status": "pending", "checks": []},
            ),
            (
                good_id,
                "1.0.1",
                good_digest,
                {
                    "spec": {
                        "engine": engine_ref,
                        "endpoint": "https://solver.example",
                        "openapi": {"openapi": "3.1.0", "paths": {}},
                    }
                },
                {"status": "verified", "checks": []},
            ),
        ):
            connection.execute(
                "INSERT INTO v1_engine_registration_revisions (id, owner_id, namespace, name, version, manifest_digest, engine_digest, document, endpoint, protocol_digest, mappings, auth_scheme, verification_report, state, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    registration_id,
                    user_id,
                    "owner",
                    "solver-deployment",
                    version,
                    manifest_digest,
                    engine_digest,
                    json.dumps(document),
                    "https://solver.example",
                    f"sha256-{'d' * 64}",
                    "{}",
                    "none",
                    json.dumps(report),
                    "published" if registration_id == good_id else "private",
                    1 if registration_id == good_id else 0,
                    created_at,
                ),
            )
            connection.execute(
                "INSERT INTO v1_manifest_publications (id, resource_kind, resource_digest, publisher_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (uuid.uuid4().hex, "EngineRegistration", manifest_digest, user_id, "public", created_at),
            )
        connection.execute(
            "INSERT INTO v1_engine_credentials (id, registration_id, credential_ref, credential_encrypted, updated_at) VALUES (?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, bad_id, "legacy", "encrypted", created_at),
        )
        connection.execute(
            "INSERT INTO v1_engine_credentials (id, registration_id, credential_ref, credential_encrypted, updated_at) VALUES (?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, pending_id, "draft", "encrypted", created_at),
        )
        connection.commit()

    upgraded = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", "upgrade", "head"],
        cwd=root,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr
    with sqlite3.connect(database) as connection:
        registrations = connection.execute(
            "SELECT version, manifest_digest FROM v1_engine_registration_revisions ORDER BY version"
        ).fetchall()
        publications = connection.execute(
            "SELECT resource_digest FROM v1_manifest_publications WHERE resource_kind = 'EngineRegistration' ORDER BY resource_digest"
        ).fetchall()
        credentials = connection.execute(
            "SELECT COUNT(*) FROM v1_engine_credentials"
        ).fetchone()[0]
        engines = connection.execute(
            "SELECT COUNT(*) FROM v1_engine_revisions"
        ).fetchone()[0]

    assert registrations == [
        ("1.0.0-draft", pending_digest),
        ("1.0.1", good_digest),
    ]
    assert publications == [(good_digest,), (pending_digest,)]
    assert credentials == 1
    assert engines == 1
