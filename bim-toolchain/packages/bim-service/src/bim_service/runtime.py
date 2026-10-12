"""Bounded execution of CPU-bound operations.

Compiling and evaluating are pure CPU work.  They run in a dedicated thread pool and the number that may
run at once is capped: a request that finds no free slot within ``acquire_timeout_ms`` is answered 503 with
``Retry-After``, and a tenant that already has its share in flight is answered 429.  The slot is returned
when the *thread* finishes, not when the request times out: a thread cannot be interrupted, so a timed-out
operation keeps counting against the cap until it ends.
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
        self._executor = ThreadPoolExecutor(max_workers=settings.max_concurrency, thread_name_prefix="bim-op")

    def _retry_headers(self) -> dict[str, str]:
        return {"Retry-After": str(self._settings.retry_after_seconds)}

    def _take_tenant(self, tenant: str | None) -> None:
        limit = self._settings.max_concurrency_per_tenant
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
        if tenant is None or self._settings.max_concurrency_per_tenant == 0:
            return
        with self._lock:
            remaining = self._tenants.get(tenant, 0) - 1
            if remaining > 0:
                self._tenants[tenant] = remaining
            else:
                self._tenants.pop(tenant, None)

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

    def _finish(self, tenant: str | None, future: "asyncio.Future[Any]") -> None:
        self._slots.release()
        self._release_tenant(tenant)
        if not future.cancelled():
            future.exception()  # retrieved: a failure nobody waits for any more is not an "unretrieved" error

    async def run(self, function: Callable[..., Any], *args: Any, tenant: str | None = None) -> Any:
        """``function(*args)`` in the pool, within the concurrency and time limits."""
        self._take_tenant(tenant)
        try:
            await self._take_slot()
        except BaseException:
            self._release_tenant(tenant)
            raise
        try:
            future = asyncio.get_running_loop().run_in_executor(self._executor, function, *args)
        except BaseException:
            self._slots.release()
            self._release_tenant(tenant)
            raise
        future.add_done_callback(lambda done: self._finish(tenant, done))
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
