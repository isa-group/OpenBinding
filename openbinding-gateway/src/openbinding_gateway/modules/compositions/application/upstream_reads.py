"""Bounded SPHERE manifest reads, shared by "Check now" (``check``) and the upstream watcher.

``ManifestReads`` reads at most ``max_reads`` manifests within ``deadline_s`` through the pricing port (its cache,
windows and back-off), once per ``(endpoint, pricing)``, and never raises: each read answers a ``Manifest``, a
``NotModified`` or a typed ``ReadFailure``:

* ``busy``: SPHERE's rate limit or the port's window (``retry_after`` seconds);
* ``unavailable``: timeout, 5xx, transport, integrity, a switched-off or unknown endpoint, or this object's own
  budget or deadline spent (``reason``);
* ``not_found``: nothing readable there for this caller (one 404 for missing, hidden, private and withdrawn);
* ``invalid``: not a pricing this gateway reads.

``check`` maps every failure to ``unavailable`` (its report stays as it was); the watcher tells them apart, since
only a confirmed ``not_found`` may ever become an event and ``busy``/``unavailable`` only reschedule. The object
reads and returns; it writes nothing.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from ...plans.application import (
    Credential,
    Manifest,
    NotModified,
    PricingInvalid,
    PricingNotFound,
    PricingSource,
    PricingSourceBusy,
    PricingSourceUnavailable,
    SphereEndpoint,
    get_pricing_source,
    is_sphere_id,
)

FailureKind = Literal["busy", "unavailable", "not_found", "invalid"]


@dataclass(frozen=True)
class ReadFailure:
    kind: FailureKind
    reason: str | None = None
    retry_after: int | None = None


ReadAnswer = Manifest | NotModified | ReadFailure


class ManifestReads:
    """The manifest reads of one check or one watcher cycle: bounded by count and time, typed, never raising."""

    def __init__(
        self,
        source: PricingSource | None = None,
        *,
        max_reads: int,
        deadline_s: float,
        revalidate: bool = False,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._source = source
        self.max_reads = max_reads
        self.deadline_s = deadline_s
        self.revalidate = revalidate
        self.clock = clock
        self.started = clock()
        #: Reads attempted (each one may have sent a request).
        self.sent = 0
        self._found: dict[tuple[str, str], ReadAnswer] = {}

    @property
    def left(self) -> int:
        return max(0, self.max_reads - self.sent)

    def spend(self, reads: int) -> None:
        """Count reads made outside this object (the watcher's YAML and family reads) against the budget."""
        self.sent += reads

    def _remaining(self) -> float:
        return self.deadline_s - (self.clock() - self.started)

    async def read(
        self,
        where: SphereEndpoint,
        pricing_id: str,
        credential: Credential | None,
        *,
        if_none_match: str | None = None,
    ) -> ReadAnswer:
        """The manifest of ``pricing_id`` (once per endpoint and pricing within this object)."""
        key = (where.key, pricing_id)
        if key in self._found:
            return self._found[key]
        answer = await self._read(where, pricing_id, credential, if_none_match)
        self._found[key] = answer
        return answer

    async def _read(
        self, where: SphereEndpoint, pricing_id: str, credential: Credential | None, if_none_match: str | None
    ) -> ReadAnswer:
        if not is_sphere_id(pricing_id):
            return ReadFailure("not_found", "not_a_sphere_id")
        if self.left <= 0:
            return ReadFailure("unavailable", "budget")
        remaining = self._remaining()
        if remaining <= 0:
            return ReadFailure("unavailable", "deadline")
        self.sent += 1
        source = self._source or get_pricing_source()
        try:
            return await asyncio.wait_for(
                source.manifest(
                    where, pricing_id, credential if where.registry is None else None,
                    if_none_match=if_none_match, revalidate=self.revalidate,
                ),
                remaining,
            )
        except asyncio.TimeoutError:
            return ReadFailure("unavailable", "deadline")
        except PricingSourceBusy as exc:
            return ReadFailure("busy", "sphere_busy", exc.retry_after)
        except PricingNotFound:
            return ReadFailure("not_found")
        except PricingSourceUnavailable as exc:
            return ReadFailure("unavailable", exc.reason)
        except PricingInvalid:
            return ReadFailure("invalid")
