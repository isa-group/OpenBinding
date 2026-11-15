#!/usr/bin/env python3
"""Write the gateway-produced fixtures of the frontend to frontend/src/test/fixtures/core/.

The frontend's view-models and mocks read what the gateway really answers, not a hand-written
copy of it. This tool runs the gateway in process (SQLite, inline dispatch, the pinned
toolchain), uploads a few packages as problems of a throwaway organization and writes the
response **bodies** (never headers) of the routes the frontend reads:

* ``<name>.facts.json``: ``getProblemCompilationFacts`` of the upload's compilation;
* ``<name>.validate.json``: ``validateBimPackage?include=facts`` of the same package.

The packages are ``simple-seq`` (``examples/demo/01_simple_seq``), ``fms`` (``13_fms``: an
exclusive choice and a local task), ``json-complete`` (``16_json_complete``: a parallel block
and a loop) and ``ambiguous`` (``01_simple_seq`` with a second catalog that gives task ``t1``
a candidate of the same id, so a document must write it ``<resource>/<id>``). ``ambiguous`` is
built here rather than checked in, because a checked-in package would join the BIM corpus.

Every run mints fresh ids and instants, so the bodies are normalised before they are written:
each distinct UUID becomes ``00000000-0000-4000-8000-<12-digit counter>`` in order of first
appearance across the fixture set (files in a fixed order, keys sorted), and each ISO-8601
instant ``2026-01-01T00:00:00Z`` plus one second per distinct value in order of appearance, so
ordering by date survives. Content digests are deterministic and left as they are.

    python tools/dump_frontend_fixtures.py               # rewrite frontend/src/test/fixtures/core/
    python tools/dump_frontend_fixtures.py --out DIR     # write somewhere else
    python tools/dump_frontend_fixtures.py --check       # fail if the checked-in fixtures differ
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

GATEWAY_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(os.environ.get("OPENBINDING_REPO_ROOT", Path(__file__).resolve().parents[2])).resolve()
FIXTURES = REPO_ROOT / "frontend" / "src" / "test" / "fixtures" / "core"
DEMO = REPO_ROOT / "examples" / "demo"

sys.path.insert(0, str(GATEWAY_ROOT / "src"))

#: Fixture name -> package directory (``None``: built by :func:`ambiguous_files`), in the order they are written.
PACKAGES: tuple[tuple[str, Path | None], ...] = (
    ("simple-seq", DEMO / "01_simple_seq"),
    ("fms", DEMO / "13_fms"),
    ("json-complete", DEMO / "16_json_complete"),
    ("ambiguous", None),
)

ZIP = {"Content-Type": "application/vnd.bim+zip"}
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$")
_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


def ambiguous_files() -> dict[str, bytes]:
    """``01_simple_seq`` with a second catalog, ``other``, whose ``c1a`` also provides ``t1``'s service."""
    source = DEMO / "01_simple_seq"
    files = {path.name: path.read_bytes() for path in sorted(source.iterdir()) if path.is_file()}
    instance = json.loads(files["instance.json"])
    instance["metadata"]["name"] = "demo_ambiguous_candidates"
    instance["spec"]["resources"]["candidateCatalog"]["other"] = "other.json"
    catalog = json.loads(files["candidates.json"])
    catalog["metadata"]["name"] = "demo_ambiguous_other_catalog"
    catalog["spec"]["candidates"] = {"c1a": {"provides": "service/t1", "features": {"latency": 12}}}
    files["instance.json"] = (json.dumps(instance, indent=2) + "\n").encode("utf-8")
    files["other.json"] = (json.dumps(catalog, indent=2) + "\n").encode("utf-8")
    return files


def _archive(directory: Path | None) -> bytes:
    from openbinding_gateway.integrations import packages

    return packages.zip_files(ambiguous_files()) if directory is None else packages.zip_directory(directory)


async def _bodies(work: Path) -> dict[str, Any]:
    """Every fixture body, by file name, from a fresh in-process gateway."""
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import event
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from openbinding_gateway import space_client
    from openbinding_gateway.access.dependencies import optional_session, session_dependency
    from openbinding_gateway.access.work_limits import WorkRateLimiter, set_work_limiter
    from openbinding_gateway.core.ratelimit import AuthRateLimiter, set_auth_limiter
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.db.base import Base
    from openbinding_gateway.main import app
    from openbinding_gateway.space_client import OpenGate

    settings = get_settings()
    settings.artifact_root = str(work / "artifacts")
    settings.work_rate_limit_compile_requests = 0
    settings.work_rate_limit_read_requests = 0
    settings.work_rate_limit_evaluate_requests = 0
    set_work_limiter(WorkRateLimiter(primary=None))
    set_auth_limiter(AuthRateLimiter(primary=None))
    space_client.set_gate(OpenGate())

    engine = create_async_engine(f"sqlite+aiosqlite:///{work / 'fixtures.db'}")

    # Transactions begin explicitly, as on PostgreSQL, so a SAVEPOINT nests (the SQLAlchemy recipe for pysqlite).
    @event.listens_for(engine.sync_engine, "connect")
    def _no_implicit_transactions(dbapi_connection, _record):
        dbapi_connection.isolation_level = None

    @event.listens_for(engine.sync_engine, "begin")
    def _begin_explicitly(connection):
        if connection.get_execution_options().get("isolation_level") != "AUTOCOMMIT":
            connection.exec_driver_sql("BEGIN")

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    bodies: dict[str, Any] = {}
    try:
        async with factory() as session:
            async def _session():
                yield session

            app.dependency_overrides[session_dependency] = _session
            app.dependency_overrides[optional_session] = _session
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://gateway") as client:
                headers = await _sign_in(client)
                created = await client.post("/v1/organizations", json={"slug": "fixtures", "name": "Fixtures"}, headers=headers)
                _ok(created, 201)
                for name, directory in PACKAGES:
                    archive = _archive(directory)
                    uploaded = await client.post(
                        "/v1/organizations/fixtures/problems", params={"slug": name}, content=archive,
                        headers={**headers, **ZIP},
                    )
                    _ok(uploaded, 201)
                    revision = uploaded.json()["revision"]["id"]
                    compilation = uploaded.json()["compilation"]["id"]
                    facts = await client.get(
                        f"/v1/organizations/fixtures/problems/{name}/revisions/{revision}/compilations/{compilation}/facts",
                        headers=headers,
                    )
                    bodies[f"{name}.facts.json"] = _ok(facts, 200).json()
                    validated = await client.post("/v1/bim/validate", params={"include": "facts"}, content=archive, headers=ZIP)
                    bodies[f"{name}.validate.json"] = _ok(validated, 200).json()
    finally:
        app.dependency_overrides.clear()
        space_client.set_gate(None)
        set_work_limiter(None)
        set_auth_limiter(None)
        await engine.dispose()
    return bodies


async def _sign_in(client) -> dict[str, str]:
    details = {"username": "fixtures", "email": "fixtures@example.org", "password": "fixtures-throwaway-password"}
    _ok(await client.post("/v1/auth/register", json=details), 201)
    login = await client.post("/v1/auth/login", json={"username_or_email": "fixtures", "password": details["password"]})
    return {"Authorization": f"Bearer {_ok(login, 200).json()['access_token']}"}


def _ok(response, status: int):
    if response.status_code != status:
        raise SystemExit(f"{response.request.method} {response.request.url.path} answered {response.status_code}: {response.text}")
    return response


def normalise(bodies: dict[str, Any]) -> dict[str, Any]:
    """The bodies with every UUID and every instant replaced by a stable stand-in (see the module docstring)."""
    ids: dict[str, str] = {}
    instants: dict[str, str] = {}

    def replace(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: replace(value[key]) for key in sorted(value)}
        if isinstance(value, list):
            return [replace(item) for item in value]
        if isinstance(value, str) and _UUID.match(value):
            if value not in ids:
                ids[value] = f"00000000-0000-4000-8000-{len(ids) + 1:012d}"
            return ids[value]
        if isinstance(value, str) and _INSTANT.match(value):
            if value not in instants:
                instants[value] = (_EPOCH + timedelta(seconds=len(instants))).strftime("%Y-%m-%dT%H:%M:%SZ")
            return instants[value]
        return value

    return {name: replace(bodies[name]) for name in sorted(bodies)}


def render(bodies: dict[str, Any]) -> dict[str, str]:
    """Each fixture file's text."""
    return {name: json.dumps(body, indent=2, sort_keys=True, ensure_ascii=False) + "\n" for name, body in normalise(bodies).items()}


def _environment() -> None:
    """A throwaway in-process gateway: the repository's schemas, its own signing secret, jobs in the request, no SPHERE.

    Set before the gateway is imported, which reads them once.
    """
    os.environ.setdefault("GENERAL_SCHEMA_PATH", str(REPO_ROOT / "schemas" / "general" / "schema.json"))
    os.environ.setdefault("SCHEMAS_DIR", str(REPO_ROOT / "schemas"))
    os.environ["GATEWAY_JWT_SECRET"] = "dump-frontend-fixtures-throwaway-secret"
    os.environ["JOB_DISPATCH_MODE"] = "inline"
    os.environ["SPHERE_ENABLED"] = "false"


def generate() -> dict[str, str]:
    _environment()
    with tempfile.TemporaryDirectory(prefix="ob-fixtures-") as work:
        return render(asyncio.run(_bodies(Path(work))))


def drift(files: dict[str, str], directory: Path) -> list[str]:
    """What differs between ``files`` and the ``.json`` files of ``directory``."""
    present = {path.name for path in directory.glob("*.json")} if directory.is_dir() else set()
    found = [f"missing: {name}" for name in sorted(set(files) - present)]
    found += [f"not generated: {name}" for name in sorted(present - set(files))]
    found += [
        f"differs: {name}" for name in sorted(set(files) & present)
        if (directory / name).read_text(encoding="utf-8") != files[name]
    ]
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--out", type=Path, help="Write the fixtures to this directory instead.")
    target.add_argument("--check", action="store_true", help="Do not write; exit non-zero if the checked-in fixtures differ.")
    arguments = parser.parse_args(argv)

    files = generate()
    if arguments.check:
        found = drift(files, FIXTURES)
        if found:
            print("The frontend fixtures are out of date; run tools/dump_frontend_fixtures.py and commit the result:")
            print("\n".join(f"  {line}" for line in found))
            return 1
        print(f"{FIXTURES.relative_to(REPO_ROOT)} is up to date ({len(files)} files).")
        return 0
    out = arguments.out or FIXTURES
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.json"):
        if stale.name not in files:
            stale.unlink()
    for name, content in files.items():
        (out / name).write_text(content, encoding="utf-8")
    print(f"Wrote {len(files)} files to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
