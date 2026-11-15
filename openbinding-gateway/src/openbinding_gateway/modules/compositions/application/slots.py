"""The per-process slots of the compositions module: bounded concurrency, refused rather than queued.

Two pools, sized by the settings: ``language_slot`` for reading and writing documents
(``COMPOSITION_LANGUAGE_SLOTS``, 4) and ``evaluation_slot`` for every call that evaluates a
binding with the toolchain (``COMPOSITION_EVALUATION_SLOTS``, 2). A request that finds its pool
full is refused at once with 429 ``composition_busy`` and ``Retry-After: 1``, as the runs'
neighbourhood refuses with ``analysis_busy``: waiting would only hold the connection while
the work it waits for runs.

A pool is a semaphore that is never waited on (it is acquired only when free), so it binds to
no event loop. It is rebuilt when its configured size changes, which only a test does.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator

from fastapi import status

from ....core.settings import get_settings
from ....models.errors import api_error


@dataclass
class _Pool:
    size: int
    semaphore: asyncio.Semaphore


_POOLS: dict[str, _Pool] = {}


def _pool(name: str, size: int) -> asyncio.Semaphore:
    pool = _POOLS.get(name)
    if pool is None or pool.size != size:
        pool = _POOLS[name] = _Pool(size, asyncio.Semaphore(size))
    return pool.semaphore


@asynccontextmanager
async def _held(name: str, size: int, what: str) -> AsyncIterator[None]:
    semaphore = _pool(name, size)
    if semaphore.locked():
        raise api_error(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "composition_busy",
            f"Every {what} slot of this gateway is busy; retry in a moment.",
            headers={"Retry-After": "1"},
            retry_after_seconds=1,
        )
    async with semaphore:
        yield


@asynccontextmanager
async def language_slot() -> AsyncIterator[None]:
    """One slot for reading or writing a document; 429 ``composition_busy`` when none is free."""
    async with _held("language", get_settings().composition_language_slots, "Composition2Yaml"):
        yield


@asynccontextmanager
async def evaluation_slot() -> AsyncIterator[None]:
    """One slot for evaluating a binding with the toolchain; 429 ``composition_busy`` when none is free."""
    async with _held("evaluation", get_settings().composition_evaluation_slots, "evaluation"):
        yield


__all__ = ["evaluation_slot", "language_slot"]
