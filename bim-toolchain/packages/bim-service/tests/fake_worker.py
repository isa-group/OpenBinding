"""A fake worker that speaks the protocol of ``bim_service._worker`` and then misbehaves.

``workers.child_argv`` is patched to start this instead of the real worker.  It answers ``READY`` correctly, then reads each
request (the body of ``/compile``: ``{"package": base64(behaviour)}``) and breaks one rule of the answer, as named by the
behaviour.  The parent must kill it, answer 500 and never allocate what the frame declares.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import struct
import sys

from bim_service import _worker
from bim_service._worker import MAGIC, READY, RESPONSE, read_frame, read_status, send_frame

GIB = 1 << 30


def _good(seq: int, **override) -> dict:
    header = {
        "seq": seq, "status": 200, "mediaType": "application/json", "headers": {}, "rssBytes": 1, "outcome": "ok",
    }  # fmt: skip
    header.update(override)
    return header


def _raw(sock: socket.socket, magic: bytes, kind: int, header_length: int, body_length: int, header: bytes = b"") -> None:
    sock.sendall(struct.pack("!4sBII", magic, kind, header_length, body_length) + header)


def misbehave(sock: socket.socket, behaviour: str, seq: int) -> None:
    body = b"{}"
    if behaviour == "bad-magic":
        _raw(sock, b"XXXX", RESPONSE, 0, 0)
    elif behaviour == "huge-header":
        _raw(sock, MAGIC, RESPONSE, GIB, 0)
    elif behaviour == "huge-body":
        _raw(sock, MAGIC, RESPONSE, len(json.dumps(_good(seq))), GIB, json.dumps(_good(seq)).encode())
    elif behaviour == "bad-json":
        _raw(sock, MAGIC, RESPONSE, 5, 0, b"{{{{{")
    elif behaviour == "wrong-seq":
        send_frame(sock, RESPONSE, _good(seq + 100), body)
    elif behaviour == "status-302":
        send_frame(sock, RESPONSE, _good(seq, status=302), body)
    elif behaviour == "set-cookie":
        send_frame(sock, RESPONSE, _good(seq, headers={"Set-Cookie": "a=b"}), body)
    elif behaviour == "long-retry-after":
        send_frame(sock, RESPONSE, _good(seq, headers={"Retry-After": "9" * 65}), body)
    elif behaviour == "media-type":
        send_frame(sock, RESPONSE, _good(seq, mediaType="text/html"), body)
    elif behaviour == "wrong-kind":
        _raw(sock, MAGIC, READY, 2, 0, b"{}")
    elif behaviour == "ok":
        send_frame(sock, RESPONSE, _good(seq), b'{"ok":true}')
    else:
        raise SystemExit(3)


def main() -> None:
    sock = socket.socket(fileno=int(sys.argv[1]))
    read_frame(sock, _worker.CONFIG, _worker.MAX_CONFIG_HEADER, 0)
    status = read_status()
    send_frame(
        sock,
        READY,
        {
            "pid": os.getpid(), "rssBytes": status["VmRSS"], "vmSizeBytes": status["VmSize"],
            "limits": {"as": 0, "core": 0, "fsize": 0, "nofile": 64}, "identity": _worker.capabilities_identity(),
        },
    )  # fmt: skip
    while True:
        frame = read_frame(sock, _worker.REQUEST, _worker.MAX_REQUEST_HEADER, 1 << 30)
        if frame is None:
            os._exit(0)
        header, body = frame
        behaviour = base64.b64decode(json.loads(body)["package"]).decode()
        misbehave(sock, behaviour, header["seq"])
