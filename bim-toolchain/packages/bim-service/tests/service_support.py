"""Constants and helpers shared by the service tests (the name is unique across the packages' test folders)."""

from __future__ import annotations

import asyncio
import contextlib
import sys
from pathlib import Path

import httpx

TOOLCHAIN_ROOT = Path(__file__).resolve().parents[3]
TOOLS_DIR = TOOLCHAIN_ROOT / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

TOKEN_OLD = "old-" + "0123456789abcdef" * 3
TOKEN_NEW = "new-" + "fedcba9876543210" * 3
BASE_URL = "http://bim.test"


def bearer(token: str = TOKEN_NEW, **extra: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", **extra}


def run(coroutine):
    """Run a coroutine to completion (the tests are synchronous; no pytest plugin is needed)."""
    return asyncio.run(coroutine)


@contextlib.asynccontextmanager
async def async_client(app, headers: dict[str, str] | None = None):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url=BASE_URL, headers=headers or bearer()) as client:
        yield client
