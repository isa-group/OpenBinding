"""Live isolation probe of two PR previews (design.md section 8 of ``openspec/changes/m05-pr-previews``).

Assumption to confirm: rootless Docker keeps the host's loopback unreachable from a preview's
containers, so preview A cannot reach preview B's published port. The probe runs ``docker exec``
in A's ``gateway`` container with a one-line ``socket.create_connection`` client and compares
what it prints. The planner is not imported; the lab is only read through the ``docker`` CLI.

The module is skipped unless ``OPENBINDING_LAB_PROBE=1``. With it set, a missing ``docker``,
project or container FAILS the test. Environment (both projects named ``openbinding-pr-<n>``,
ports decimal in 18101-18199 and different)::

    OPENBINDING_PROBE_PROJECT_A / _B   OPENBINDING_PROBE_PORT_A / _B

Run from ``openbinding-gateway``::

    OPENBINDING_LAB_PROBE=1 uv run --locked --extra test pytest -q -rs ../lab/tests/test_preview_isolation.py
"""

from __future__ import annotations

import os
import re
import socket
import subprocess

import pytest

LIVE = os.environ.get("OPENBINDING_LAB_PROBE") == "1"
live = pytest.mark.skipif(not LIVE, reason="live probe: set OPENBINDING_LAB_PROBE=1")
NAME = re.compile(r"^openbinding-pr-[0-9]+$")
CLIENT = (
    "import socket,errno,sys\n"
    "try:\n"
    "    socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=5); print('ok')\n"
    "except socket.timeout:\n"
    "    print('timeout')\n"
    "except OSError as e:\n"
    "    print(errno.errorcode.get(e.errno, 'error'))\n"
)
RESOLVE = "import socket,sys; print(socket.gethostbyname(sys.argv[1]))"


def valid_name(value: str) -> bool:
    return bool(NAME.fullmatch(value))


def valid_port(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9]{5}", value)) and 18101 <= int(value) <= 18199


def parse_output(out: str) -> str:
    return out.strip()


def _docker(*args: str) -> str:
    try:
        run = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=60, check=False)
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        pytest.fail(f"docker {' '.join(args)}: {exc!r}")
    assert run.returncode == 0, f"docker {' '.join(args)} exited {run.returncode}: {run.stderr}"
    return run.stdout.strip()


def _container(project: str, service: str) -> str:
    out = _docker("ps", "-q", "--filter", f"label=com.docker.compose.project={project}",
                  "--filter", f"label=com.docker.compose.service={service}")
    ids = out.split()
    assert len(ids) == 1, f"expected one {service} container in {project}, found {ids}"
    return ids[0]


def _exec(cid: str, code: str, *argv: str) -> str:
    return parse_output(_docker("exec", cid, "python", "-c", code, *argv))


def _web_ip(project: str) -> str:
    network = f"{project}_default"
    fmt = '{{(index .NetworkSettings.Networks "%s").IPAddress}}' % network
    ip = _docker("inspect", "-f", fmt, _container(project, "web"))
    assert ip, f"web of {project} has no address on {network}"
    return ip


@pytest.fixture(scope="module")
def probe() -> dict:
    env = {k: os.environ.get(f"OPENBINDING_PROBE_{k}", "") for k in ("PROJECT_A", "PROJECT_B", "PORT_A", "PORT_B")}
    assert valid_name(env["PROJECT_A"]) and valid_name(env["PROJECT_B"]), f"bad project names: {env}"
    assert valid_port(env["PORT_A"]) and valid_port(env["PORT_B"]), f"bad ports: {env}"
    assert env["PROJECT_A"] != env["PROJECT_B"] and env["PORT_A"] != env["PORT_B"], "A and B must differ"
    published = _docker("port", _container(env["PROJECT_B"], "web"), "8080").split("\n")
    assert f"127.0.0.1:{env['PORT_B']}" in published, f"B does not publish {env['PORT_B']}: {published}"
    return {"a": env["PROJECT_A"], "b": env["PROJECT_B"], "port_b": int(env["PORT_B"]),
            "gateway": _container(env["PROJECT_A"], "gateway")}


@live
def test_b_port_refused_from_a(probe):
    """[utest->req~lab-deployment-preview-isolation~1] A's gateway gets ECONNREFUSED on B's port."""
    info = _docker("network", "inspect", f"{probe['a']}_default", "-f", "{{(index .IPAM.Config 0).Gateway}}")
    assert info, "network of A has no gateway address"
    assert _exec(probe["gateway"], CLIENT, info, str(probe["port_b"])) == "ECONNREFUSED"


@live
def test_a_reaches_own_web(probe):
    """[utest->req~lab-deployment-preview-isolation~1] Control: A's gateway connects to web:8080."""
    assert _exec(probe["gateway"], CLIENT, "web", "8080") == "ok"


@live
def test_b_port_answers_on_host(probe):
    """[utest->req~lab-deployment-preview-isolation~1] Control: B's port answers at 127.0.0.1."""
    with socket.create_connection(("127.0.0.1", probe["port_b"]), timeout=5):
        pass


@live
def test_web_resolves_to_own_container(probe):
    """[utest->req~lab-deployment-preview-isolation~1] Control: A's ``web`` is A's own container, not B's."""
    resolved = _exec(probe["gateway"], RESOLVE, "web")
    assert resolved == _web_ip(probe["a"]) != _web_ip(probe["b"])


def test_project_names():
    """[utest->req~lab-deployment-preview-isolation~1] Only ``openbinding-pr-<n>`` names are accepted."""
    assert valid_name("openbinding-pr-42")
    assert not any(valid_name(v) for v in ("openbinding-pr-", "openbinding-pr-4x", "x openbinding-pr-4", "openbinding-pr-4\n"))


def test_ports_and_output():
    """[utest->req~lab-deployment-preview-isolation~1] Ports stay in 18101-18199; output is trimmed."""
    assert valid_port("18101") and valid_port("18199")
    assert not any(valid_port(v) for v in ("18100", "18200", "1810", "abc", ""))
    assert parse_output("ECONNREFUSED\n") == "ECONNREFUSED"
