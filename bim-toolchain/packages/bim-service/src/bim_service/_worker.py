"""Entry point of a worker process (``BIM_SERVICE_EXECUTOR=process``) and the frame format shared with the parent.

The parent (:mod:`bim_service.workers`) starts ``python -s -c 'from bim_service._worker import main; main()' <fd>``, where
``<fd>`` is one end of an ``AF_UNIX`` ``SOCK_STREAM`` socket pair.  Everything crosses it in frames::

    struct.pack('!4sBII', b'BIMW', kind, header_len, body_len) + header + body

``kind`` is 1 ``CONFIG`` (parent to child, once), 2 ``REQUEST`` (parent to child), 3 ``READY`` or 4 ``RESPONSE`` (child to
parent).  The header is UTF-8 JSON built by the sender, the body is opaque bytes; nothing is pickled, in either
direction.  This module imports only the standard library at the top: the parent imports it for the constants, the child
imports the service inside :func:`main`, after its configuration has arrived.

A worker reads its ``CONFIG``, applies the limits of the interpreter, imports the service, warms up, lowers its own
priority, sets its resource limits on itself and says ``READY``; then it answers one ``REQUEST`` at a time until the parent
closes the socket.  It has no environment of the service (no ``BIM_SERVICE_*``, no token): everything it needs is in the
``CONFIG`` header.  ``RLIMIT_AS`` is a limit of *virtual* size (address space), not of resident memory.
"""

from __future__ import annotations

import json
import os
import socket
import struct
import sys
from typing import Any

MAGIC = b"BIMW"
FRAME = struct.Struct("!4sBII")
CONFIG, REQUEST, READY, RESPONSE = 1, 2, 3, 4

#: Largest header the parent accepts from a worker (``READY`` and ``RESPONSE``), and the largest it sends.
MAX_HEADER = 16 * 1024
MAX_CONFIG_HEADER = 64 * 1024
#: Largest ``REQUEST`` header (the body is bounded by ``max_body_bytes``).
MAX_REQUEST_HEADER = 1024 * 1024

MIB = 1024 * 1024
PROBLEM_MEDIA_TYPE = "application/problem+json"
JSON_MEDIA_TYPE = "application/json"


class ProtocolViolation(Exception):
    """A frame that does not follow the format."""


def pack_frame(kind: int, header: dict[str, Any], body_length: int = 0) -> bytes:
    """The fixed prefix and the JSON header of a frame whose body has ``body_length`` bytes."""
    raw = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return FRAME.pack(MAGIC, kind, len(raw), body_length) + raw


def send_frame(sock: socket.socket, kind: int, header: dict[str, Any], body: bytes | bytearray = b"") -> None:
    sock.sendall(pack_frame(kind, header, len(body)))
    if body:
        sock.sendall(body)


def _recv_into(sock: socket.socket, view: memoryview) -> bool:
    """Fill ``view``; ``False`` if the peer closed before the first byte, an error if it closed in the middle."""
    got = 0
    while got < len(view):
        count = sock.recv_into(view[got:])
        if count == 0:
            if got == 0:
                return False
            raise ProtocolViolation("the peer closed the socket in the middle of a frame")
        got += count
    return True


def read_frame(
    sock: socket.socket, expect: int, max_header: int, max_body: int
) -> tuple[dict[str, Any], bytes] | None:
    """The next frame of kind ``expect`` as ``(header, body)``, or ``None`` at end of stream."""
    prefix = bytearray(FRAME.size)
    if not _recv_into(sock, memoryview(prefix)):
        return None
    magic, kind, header_length, body_length = FRAME.unpack(prefix)
    if magic != MAGIC or kind != expect:
        raise ProtocolViolation("unexpected frame")
    if header_length > max_header or body_length > max_body:
        raise ProtocolViolation("frame too large")
    raw = bytearray(header_length)
    if header_length and not _recv_into(sock, memoryview(raw)):
        raise ProtocolViolation("the peer closed the socket in the middle of a frame")
    header = json.loads(bytes(raw))
    if not isinstance(header, dict):
        raise ProtocolViolation("the header is not an object")
    body = bytearray(body_length)
    if body_length and not _recv_into(sock, memoryview(body)):
        raise ProtocolViolation("the peer closed the socket in the middle of a frame")
    return header, bytes(body)


def read_status(path: str = "/proc/self/status") -> dict[str, int]:
    """``VmSize``, ``VmPeak``, ``VmRSS`` and ``VmHWM`` of a process in bytes (``/proc/<pid>/status``)."""
    found: dict[str, int] = {}
    with open(path, encoding="ascii", errors="replace") as handle:
        for line in handle:
            key, _, rest = line.partition(":")
            if key in ("VmSize", "VmPeak", "VmRSS", "VmHWM"):
                found[key] = int(rest.split()[0]) * 1024
    return found


def capabilities_identity() -> str:
    """Digest of the static capabilities: parent and worker must agree, or they run different toolchains."""
    import hashlib

    from . import operations

    text = json.dumps(operations._static_capabilities(), sort_keys=True, ensure_ascii=True, default=str)
    return hashlib.sha256(text.encode("ascii")).hexdigest()


def _frames(error: BaseException, limit: int = 12) -> list[str]:
    import traceback

    return [
        f"{os.path.splitext(os.path.basename(frame.filename))[0]}:{frame.name}:{frame.lineno}"
        for frame in traceback.extract_tb(error.__traceback__)[-limit:]
    ]


def _fail(error: BaseException) -> tuple[str, int, str, dict[str, str], bytes, dict[str, Any]]:
    """``(outcome, status, media type, headers, body, extra header members)`` for an exception of a job."""
    from .problems import failure_response
    from .wire import render_json

    if isinstance(error, MemoryError):
        return "memory", 500, JSON_MEDIA_TYPE, {}, b"", {}
    try:
        failure = failure_response(error)
        if failure is not None:
            status, problem, headers = failure
            return "problem", status, PROBLEM_MEDIA_TYPE, headers, render_json(problem), {}
    except MemoryError:
        return "memory", 500, JSON_MEDIA_TYPE, {}, b"", {}
    except Exception:  # the answer could not be rendered: a crash like any other
        pass
    # The class and where it was raised, never the message (it may quote the input).
    return "crash", 500, JSON_MEDIA_TYPE, {}, b"", {"exception": type(error).__name__, "frames": _frames(error)}


def _answer(
    table: dict[str, Any],
    header: dict[str, Any],
    body: bytes,
    as_limit: int,
    peak_ready: int,
    cpu_hard: int,
    timeout: float,
) -> tuple[dict[str, Any], bytes]:
    import math
    import resource

    used = resource.getrusage(resource.RUSAGE_SELF)
    soft = math.ceil(used.ru_utime + used.ru_stime) + math.ceil(timeout) + 2
    if cpu_hard != resource.RLIM_INFINITY:
        soft = min(soft, cpu_hard)
    resource.setrlimit(resource.RLIMIT_CPU, (soft, cpu_hard))

    outcome, status, media, headers, payload, extra = "ok", 200, JSON_MEDIA_TYPE, {}, b"", {}
    try:
        payload = table[header["op"]](header.get("contentType"), body)
    except Exception as error:  # MemoryError too
        outcome, status, media, headers, payload, extra = _fail(error)
    status_now = read_status()
    # Heuristic backstop: ``bim_core`` may turn a MemoryError into one of its own errors; a peak at the limit (that was
    # not already there when the worker became ready) is not trusted whatever the answer says.
    peak = status_now.get("VmPeak", 0)
    if peak >= as_limit - MIB and peak > peak_ready:
        outcome, status, media, headers, payload, extra = "memory", 500, JSON_MEDIA_TYPE, {}, b"", {}
    answer = {
        "seq": header["seq"],
        "status": status,
        "mediaType": media,
        "headers": headers,
        "rssBytes": status_now.get("VmRSS", 0),
        "outcome": outcome,
        **extra,
    }
    return answer, payload


def _serve(sock: socket.socket) -> int:
    import importlib
    import resource

    frame = read_frame(sock, CONFIG, MAX_CONFIG_HEADER, 0)
    if frame is None:
        return 1
    config = frame[0]
    sys.set_int_max_str_digits(config["int_max_str_digits"])
    sys.setrecursionlimit(config["recursionlimit"])
    for name in config["preload"]:
        importlib.import_module(name)

    from bim_core import Limits

    from . import jobs, operations
    from .settings import BimServiceSettings

    operations.warm_up()
    max_body = int(config["max_body_bytes"])
    timeout = float(config["operation_timeout_seconds"])
    settings = BimServiceSettings(
        max_body_bytes=max_body,
        max_registered_resources=config["max_registered_resources"],
        max_bindings=config["max_bindings"],
        neighborhood_max_seconds=config["neighborhood_max_seconds"],
        operation_timeout_seconds=timeout,
        limits=Limits(**config["limits"]),
    )
    table = {name: build(settings) for name, build in jobs.JOBS.items()}
    identity = capabilities_identity()

    try:
        os.nice(10)
    except OSError:
        pass
    try:
        with open("/proc/self/oom_score_adj", "w", encoding="ascii") as handle:
            handle.write("1000")
    except OSError:
        pass
    status = read_status()
    slack = max(32 * MIB, max_body)
    as_limit = status["VmSize"] + int(config["allowance"]) + slack
    peak_ready = status.get("VmPeak", status["VmSize"])
    cpu_hard = resource.getrlimit(resource.RLIMIT_CPU)[1]
    resource.setrlimit(resource.RLIMIT_AS, (as_limit, as_limit))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    send_frame(
        sock,
        READY,
        {
            "pid": os.getpid(),
            "rssBytes": status["VmRSS"],
            "vmSizeBytes": status["VmSize"],
            "limits": {
                "as": resource.getrlimit(resource.RLIMIT_AS)[0],
                "core": resource.getrlimit(resource.RLIMIT_CORE)[0],
                "fsize": resource.getrlimit(resource.RLIMIT_FSIZE)[0],
                "nofile": resource.getrlimit(resource.RLIMIT_NOFILE)[0],
            },
            "identity": identity,
        },
    )

    while True:
        frame = read_frame(sock, REQUEST, MAX_REQUEST_HEADER, max_body)
        if frame is None:
            return 0  # the parent closed the socket
        header, body = frame
        answer, payload = _answer(table, header, body, as_limit, peak_ready, cpu_hard, timeout)
        del body
        send_frame(sock, RESPONSE, answer, payload)
        del payload


def main() -> None:
    """Run as a worker; never returns."""
    code = 70
    try:
        sock = socket.socket(fileno=int(sys.argv[1]))
        code = _serve(sock)
    except BaseException:
        code = 70
    finally:
        os._exit(code)
