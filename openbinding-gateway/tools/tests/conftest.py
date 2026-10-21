"""Shared setup for the tests of the private SPACE/SPHERE tools and the lab seed.

Everything runs against simulated transports (``httpx.MockTransport``) and an
in-memory SQLite database; no network and no real service is ever contacted.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
import pytest_asyncio

TOOLS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(os.environ.get("OPENBINDING_REPO_ROOT", TOOLS_DIR.parents[1]))
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

os.environ.setdefault("GENERAL_SCHEMA_PATH", str(REPO_ROOT / "schemas" / "general" / "schema.json"))
os.environ.setdefault("SCHEMAS_DIR", str(REPO_ROOT / "schemas"))
os.environ.setdefault("GATEWAY_JWT_SECRET", "test-secret-not-used-anywhere-real")
os.environ.setdefault("JOB_DISPATCH_MODE", "inline")
os.environ["SPHERE_ENABLED"] = "false"

_REMOTE_VARIABLES = (
    "SPACE_URL",
    "SPACE_API_KEY",
    "SPACE_ORGANIZATION_ID",
    "SPHERE_URL",
    "SPHERE_API_KEY",
    "SPHERE_ORGANIZATION_ID",
    "SPACE_DEV_SERVICE_NAME",
    "SPACE_DEV_PLAN",
    "SPACE_DEV_PRICING_VERSION",
    "SPACE_PROD_SERVICE_NAME",
    "DEMO_SEED_PASSWORD",
)
for _name in _REMOTE_VARIABLES:
    os.environ.pop(_name, None)


@pytest.fixture(autouse=True)
def isolated_remote_environment(monkeypatch):
    """The tools read the process environment; no test may see (or use) a real one."""
    for name in _REMOTE_VARIABLES:
        monkeypatch.delenv(name, raising=False)


@pytest_asyncio.fixture
async def db_session(tmp_path, monkeypatch):
    """A session on a database that exists only for this test (SQLite in memory)."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.db.base import Base

    monkeypatch.setattr(get_settings(), "artifact_root", str(tmp_path / "blobs"))
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()
