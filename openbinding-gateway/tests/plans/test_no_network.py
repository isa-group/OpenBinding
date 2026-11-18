"""Tests cannot reach the network: ``core.outbound`` refuses what is not scripted, and with
``OPENBINDING_FORBID_NETWORK=1`` (the CI unit shards) a raw connect to a non-loopback address fails too."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from openbinding_gateway.core import outbound
from openbinding_gateway.core.outbound import OutboundPolicy
from sphere_recorded import NetworkForbidden

GATEWAY = Path(__file__).resolve().parents[2]


async def test_an_unscripted_outbound_read_is_forbidden() -> None:
    with pytest.raises(NetworkForbidden):
        await outbound.fetch("https://unscripted.example/pricing.yml", policy=OutboundPolicy())


async def test_an_unscripted_transport_is_forbidden(monkeypatch) -> None:
    monkeypatch.setattr(
        socket, "getaddrinfo", lambda host, port, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]
    )
    with pytest.raises(NetworkForbidden):
        await outbound.fetch("https://scripted-dns-only.example/pricing.yml", policy=OutboundPolicy())


def test_the_socket_block_refuses_a_non_loopback_connect(tmp_path: Path) -> None:
    probe = tmp_path / "test_probe.py"
    probe.write_text(textwrap.dedent('''
        import socket
        import pytest
        from sphere_recorded import NetworkForbidden

        def test_connect():
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(0.5)
            with pytest.raises(NetworkForbidden):
                sock.connect(("93.184.216.34", 443))
            sock.close()

        def test_loopback_is_allowed():
            server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server.bind(("127.0.0.1", 0)); server.listen(1)
            client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            client.connect(server.getsockname())
            client.close(); server.close()
    '''))
    target = GATEWAY / "tests" / "_probe_no_network_test.py"
    target.write_text(probe.read_text())
    try:
        environment = dict(os.environ, OPENBINDING_FORBID_NETWORK="1")
        done = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-o", "python_files=_probe_*_test.py",
             str(target.relative_to(GATEWAY))],
            cwd=GATEWAY, env=environment, capture_output=True, text=True, timeout=300,
        )
    finally:
        target.unlink()
    assert done.returncode == 0, done.stdout + done.stderr
    assert "2 passed" in done.stdout
