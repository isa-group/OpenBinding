"""Bounded execution of CPU-bound operations.

Decoding a request, validating it, compiling or evaluating and rendering the answer are CPU work.  All of it runs in a
dedicated thread pool and the number that may run at once is capped: a request that finds no free slot within
``acquire_timeout_ms`` is answered 503 with ``Retry-After``, and a tenant (the identity bound to the caller's token, see
:mod:`bim_service.auth`) that already has its share in flight is answered 429; the global cap is independent of the
per-tenant share.  The slot is taken *before* the body is decoded, so the number of decoded bodies in memory is bounded
by the number of slots, not by the number of requests that arrive.

The slot is returned when the *thread* finishes, not when the request times out: a thread cannot be interrupted, so a
timed-out operation (or one whose client went away) keeps counting against the cap until it ends.  Releasing the slot
earlier would allow more threads than slots.

Limits of the thread mode.  ``json.loads`` and pydantic-core are C code that does not give up the GIL while they run,
and the compiler and the evaluator are pure Python that the interpreter switches every ``sys.setswitchinterval``: a large
body being parsed in a pool thread can still stall the event loop for about as long as the parse takes, and CPU-bound
threads slow the loop down.  Moving the work to the pool bounds how many such stalls run at once and what they hold in
memory; it does not remove them.  Only processes would.

Optional memory budget (``memory_budget_bytes``, off by default).  An operation is charged
:data:`~bim_service.settings.BODY_MEMORY_FACTOR` times its request body from the moment it holds a slot until its
thread ends.  A charge that does not fit in what is left is answered 429 ``memory_budget`` with ``Retry-After``; a
single request larger than the whole budget is admitted only when nothing else is charged (otherwise it could never run
at all), and while it runs everything else is refused.  The charge is returned when the thread ends, like the slot.
"""

from __future__ import annotations

import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from .problems import ServiceProblem
from .settings import BimServiceSettings


class Gate:
    def __init__(self, settings: BimServiceSettings) -> None:
        self._settings = settings
        self._slots = threading.BoundedSemaphore(settings.max_concurrency)
        self._lock = threading.Lock()
        self._tenants: dict[str, int] = {}
        self._charged = 0
        self._chargers = 0
        self._executor = ThreadPoolExecutor(max_workers=settings.max_concurrency, thread_name_prefix="bim-op")

    def _retry_headers(self) -> dict[str, str]:
        return {"Retry-After": str(self._settings.retry_after_seconds)}

    def _take_tenant(self, tenant: str | None) -> None:
        limit = self._settings.effective_max_concurrency_per_tenant
        if tenant is None or limit == 0:
            return
        with self._lock:
            held = self._tenants.get(tenant, 0)
            if held >= limit:
                raise ServiceProblem(
                    429,
                    "rate_limited",
                    "the tenant already has the maximum number of operations in flight",
                    headers=self._retry_headers(),
                )
            self._tenants[tenant] = held + 1

    def _release_tenant(self, tenant: str | None) -> None:
        if tenant is None or self._settings.effective_max_concurrency_per_tenant == 0:
            return
        with self._lock:
            remaining = self._tenants.get(tenant, 0) - 1
            if remaining > 0:
                self._tenants[tenant] = remaining
            else:
                self._tenants.pop(tenant, None)

    def _take_memory(self, cost: int) -> int:
        """Charge ``cost`` bytes to the budget; the amount actually charged (0: no budget, or nothing to charge)."""
        budget = self._settings.memory_budget_bytes
        if budget == 0 or cost <= 0:
            return 0
        with self._lock:
            # A request bigger than the whole budget runs alone; anything else must fit in what is left.
            if self._chargers and self._charged + cost > budget:
                raise ServiceProblem(
                    429,
                    "memory_budget",
                    "the operations in flight already use the memory budget of the service; retry later",
                    headers=self._retry_headers(),
                )
            self._charged += cost
            self._chargers += 1
        return cost

    def _release_memory(self, charged: int) -> None:
        if charged <= 0:
            return
        with self._lock:
            self._charged -= charged
            self._chargers -= 1

    async def _take_slot(self) -> None:
        deadline = time.monotonic() + self._settings.acquire_timeout_ms / 1000
        while not self._slots.acquire(blocking=False):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ServiceProblem(
                    503,
                    "service_busy",
                    "all operation slots are busy; retry later",
                    headers=self._retry_headers(),
                )
            await asyncio.sleep(min(0.01, remaining))

    def _finish(self, tenant: str | None, charged: int, future: "asyncio.Future[Any]") -> None:
        self._slots.release()
        self._release_memory(charged)
        self._release_tenant(tenant)
        if not future.cancelled():
            future.exception()  # retrieved: a failure nobody waits for any more is not an "unretrieved" error

    async def run(
        self, function: Callable[..., Any], *args: Any, tenant: str | None = None, cost_bytes: int = 0
    ) -> Any:
        """``function(*args)`` in the pool, within the concurrency, memory and time limits.

        ``cost_bytes`` is the estimated memory the call needs (see the module docstring); ``function`` is what decodes
        the request, so it only starts once the slot and the budget are held.
        """
        self._take_tenant(tenant)
        try:
            await self._take_slot()
        except BaseException:
            self._release_tenant(tenant)
            raise
        try:
            charged = self._take_memory(cost_bytes)
        except BaseException:
            self._slots.release()
            self._release_tenant(tenant)
            raise
        try:
            future = asyncio.get_running_loop().run_in_executor(self._executor, function, *args)
        except BaseException:
            self._slots.release()
            self._release_memory(charged)
            self._release_tenant(tenant)
            raise
        future.add_done_callback(lambda done: self._finish(tenant, charged, done))
        finished, _ = await asyncio.wait({future}, timeout=self._settings.operation_timeout_seconds)
        if not finished:
            raise ServiceProblem(
                503,
                "operation_timeout",
                f"the operation exceeded its time budget of {self._settings.operation_timeout_seconds:g} s",
            )
        return future.result()

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
