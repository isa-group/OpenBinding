"""Readers of the kernel's memory figures and the child process of ``test_analysis_b8_rss.py``.

Run as ``python rss_support.py <N>`` it builds the service, measures the resident memory of *its own* process before,
during and after ``N`` concurrent ``/evaluate`` requests of the largest allowed body, and prints one JSON object.  A fresh
process per measurement keeps the figures free of what the rest of the test session left in the heap.
"""

from __future__ import annotations

import asyncio
import ctypes
import gc
import json
import os
import platform
import sys
import tempfile
import time
from pathlib import Path

MiB = 1024 * 1024


def proc_status() -> dict[str, str]:
    fields = {}
    for line in Path("/proc/self/status").read_text().splitlines():
        key, _, value = line.partition(":")
        fields[key] = value.strip()
    return fields


def kib(field: str) -> int:
    """A ``/proc/self/status`` field given in kB (``VmRSS``, ``VmHWM``), in bytes."""
    return int(proc_status()[field].split()[0]) * 1024


def reset_peak() -> bool:
    """Reset ``VmHWM`` (Linux 4.0+); False when the kernel or the sandbox refuses."""
    try:
        with open("/proc/self/clear_refs", "w") as handle:
            handle.write("5")
    except OSError:
        return False
    return True


def trim() -> None:
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        pass


def cgroup_directory() -> Path | None:
    """The cgroup v2 directory with memory files that this process belongs to, if any."""
    root = Path("/sys/fs/cgroup")
    try:
        for line in Path("/proc/self/cgroup").read_text().splitlines():
            hierarchy, _, rest = line.partition(":")
            controllers, _, path = rest.partition(":")
            if hierarchy == "0" and controllers == "":
                for directory in (root / path.lstrip("/"), root):
                    if (directory / "memory.current").exists() or (directory / "memory.max").exists():
                        return directory
    except OSError:
        pass
    return None


def cgroup_value(name: str) -> str | None:
    directory = cgroup_directory()
    if directory is None:
        return None
    try:
        return (directory / name).read_text().strip()
    except OSError:
        return None


def cgroup_bytes(name: str) -> int | None:
    value = cgroup_value(name)
    return int(value) if value is not None and value.isdigit() else None


def cgroup_reclaimable() -> int:
    """Page cache of the cgroup (``active_file`` + ``inactive_file`` of ``memory.stat``): counted in ``memory.current``,
    given back under pressure."""
    text = cgroup_value("memory.stat") or ""
    fields = dict(line.split() for line in text.splitlines() if len(line.split()) == 2)
    return int(fields.get("active_file", 0)) + int(fields.get("inactive_file", 0))


def meminfo_available() -> int | None:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) * 1024
    except OSError:
        pass
    return None


def room() -> tuple[int | None, str]:
    """Bytes that may still be allocated according to the tightest visible limit, and which limit it is."""
    limits = []
    available = meminfo_available()
    if available is not None:
        limits.append((available, "MemAvailable"))
    maximum, current = cgroup_bytes("memory.max"), cgroup_bytes("memory.current")
    if maximum is not None and current is not None:
        limits.append((maximum - current + cgroup_reclaimable(), "cgroup memory.max - memory.current + page cache"))
    return min(limits) if limits else (None, "unknown")


def mib(value: int | None) -> str:
    return "n/a" if value is None else f"{value / MiB:.1f} MiB"


def largest_body(limit: int) -> bytes:
    """An evaluate request of exactly ``limit`` bytes made of many small objects (the most expensive shape measured)."""
    item = b'{"id": 123456, "w": 1.5, "tags": ["a", "b"], "n": null}'
    head, tail = b'{"ir": {"items": [', b']}, "bindings": [{}]}'
    count = (limit - len(head) - len(tail) + 2) // (len(item) + 2)
    document = head + (item + b", ") * (count - 1) + item + tail
    assert len(document) <= limit
    return document + b" " * (limit - len(document))  # trailing whitespace is valid JSON


def child(count: int) -> dict:
    import httpx

    status = proc_status()
    result: dict = {
        "pid": os.getpid(),
        "name": status.get("Name"),
        "python": platform.python_version(),
        "implementation": platform.python_implementation(),
        "system": f"{platform.system()} {platform.release()}",
        "cpus": os.cpu_count(),
        "requests": count,
        "rss_interpreter": kib("VmRSS"),
    }
    from bim_service import operations
    from bim_service.app import create_app
    from bim_service.settings import BimServiceSettings

    operations.evaluate = lambda ir, bindings, execution, on_error: {"results": []}  # the service layer alone
    token = "memory-probe-" + "0123456789abcdef" * 3
    tokens = Path(tempfile.mkdtemp()) / "tokens"
    tokens.write_text(token + "\n")
    tokens.chmod(0o600)
    app = create_app(BimServiceSettings(tokens_file=str(tokens), max_concurrency_per_tenant=0, operation_timeout_seconds=300))
    gc.collect()
    result["rss_idle"] = kib("VmRSS")  # imports done, application built, nothing served
    limit = app.state.settings.max_body_bytes
    payload = largest_body(limit)
    result["body_bytes"] = limit
    gc.collect()
    result["rss_before"] = kib("VmRSS")  # as above plus the request, held by the in-process client
    result["cgroup_before"] = cgroup_bytes("memory.current")
    result["peak_reset"] = reset_peak()

    async def post_many() -> list[int]:
        transport = httpx.ASGITransport(app=app)
        headers = {"Authorization": f"Bearer {token}", "content-type": "application/json"}
        async with httpx.AsyncClient(transport=transport, base_url="http://bim.test", headers=headers) as client:
            responses = await asyncio.gather(
                *(client.post("/bim/v1/evaluate", content=payload) for _ in range(count))
            )
            return [response.status_code for response in responses]

    started = time.perf_counter()
    result["statuses"] = asyncio.run(post_many())
    result["seconds"] = time.perf_counter() - started
    result["rss_peak"] = kib("VmHWM")
    result["rss_end"] = kib("VmRSS")
    result["cgroup_end"] = cgroup_bytes("memory.current")
    gc.collect()
    result["rss_gc"] = kib("VmRSS")
    trim()
    result["rss_trim"] = kib("VmRSS")
    return result


if __name__ == "__main__":
    print(json.dumps(child(int(sys.argv[1]))))
