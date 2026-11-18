"""Reading fetched pricing bytes off the event loop.

Loading (``yaml12``), the functional hash and the normaliser are pure but can be slow on a large or
hostile document, so they run in a worker thread, at most ``MAX_PARALLEL`` at a time per event loop, and
the caller gives up after ``TIMEOUT_S`` (``PricingInvalid("yaml_limits")``); the loader's limits bound the
work a thread can be asked to do.
"""

from __future__ import annotations

import asyncio
import weakref
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from ..domain import yaml12
from ..domain.content_hash import functional_hash_of
from ..domain.errors import PricingInvalid
from ..domain.pricing2yaml import NormalisedPricing, normalise

MAX_PARALLEL = 4
TIMEOUT_S = 5.0

_LIMITERS: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = weakref.WeakKeyDictionary()


@dataclass(frozen=True)
class ParsedPricing:
    """A YAML pricing read: the document, SPHERE's functional hash, and the normaliser's verdict."""

    document: Mapping[str, Any]
    content_hash: str
    normalised: NormalisedPricing | None
    refusal: PricingInvalid | None

    @property
    def valid(self) -> bool:
        return self.normalised is not None and self.normalised.valid


def parse_sync(raw: bytes | str) -> ParsedPricing:
    """Load, hash and normalise; raises ``PricingInvalid`` only when the bytes are not a YAML mapping."""
    document = yaml12.load(raw)
    if not isinstance(document, Mapping):
        raise PricingInvalid("sphere_pricing_invalid", "a pricing is a YAML mapping")
    content_hash = functional_hash_of(document)
    try:
        return ParsedPricing(document, content_hash, normalise(document), None)
    except PricingInvalid as refusal:
        return ParsedPricing(document, content_hash, None, refusal)


def _limiter() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    limiter = _LIMITERS.get(loop)
    if limiter is None:
        limiter = asyncio.Semaphore(MAX_PARALLEL)
        _LIMITERS[loop] = limiter
    return limiter


async def parse(raw: bytes | str, *, timeout_s: float = TIMEOUT_S) -> ParsedPricing:
    """``parse_sync`` in a worker thread, bounded in parallelism and in the time the caller waits."""
    async with _limiter():
        try:
            return await asyncio.wait_for(asyncio.to_thread(parse_sync, raw), timeout=timeout_s)
        except TimeoutError as exc:
            raise PricingInvalid("yaml_limits", "reading the pricing took too long") from exc
