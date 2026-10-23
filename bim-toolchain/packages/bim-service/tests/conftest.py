"""Fixtures of the service tests: bearer tokens, application factories and a client.

``tokens_path`` holds two untagged tokens (one tenant, ``default``: a rotation of a single caller).
``tenant_tokens_path`` binds tokens to three tenants: ``acme`` (two tokens), ``other`` (one) and ``default`` (``TOKEN_NEW``).
"""

from __future__ import annotations

import os
import signal
import sys
from pathlib import Path

import pytest
from service_support import BASE_URL, TOKEN_ACME, TOKEN_ACME_NEXT, TOKEN_NEW, TOKEN_OLD, TOKEN_OTHER, bearer
from starlette.testclient import TestClient

from bim_service.app import create_app
from bim_service.settings import BimServiceSettings

# The OMG BPMN XSDs are not versioned: the session that runs these tests puts them in place first (tools/xsd_session.py).
TOOLS_DIR = Path(__file__).resolve().parents[3] / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from xsd_session import pytest_report_header, pytest_sessionstart  # noqa: E402,F401


#: Measurements that tests want to show: written by the ``report`` fixture, printed once at the end of the session.
REPORT = pytest.StashKey[list[str]]()


@pytest.fixture
def report(request):
    """``report(text)``: a line of measurement, printed in the "measurements" section that ends the pytest output
    (the output of a passing test is captured, and this section is not)."""
    lines = request.config.stash.setdefault(REPORT, [])
    return lines.append


@pytest.hookimpl(wrapper=True, tryfirst=True)
def pytest_sessionfinish(session, exitstatus):
    try:
        return (yield)
    finally:
        lines = session.config.stash.get(REPORT, [])
        reporter = session.config.pluginmanager.get_plugin("terminalreporter")
        if lines and reporter is not None:
            reporter.write_sep("=", "measurements")
            for line in lines:
                reporter.write_line(line)


@pytest.fixture
def tokens_path(tmp_path: Path) -> Path:
    path = tmp_path / "bim-tokens"
    path.write_text(f"{TOKEN_OLD}\n{TOKEN_NEW}\n", encoding="utf-8")
    path.chmod(0o600)
    return path


@pytest.fixture
def tenant_tokens_path(tmp_path: Path) -> Path:
    path = tmp_path / "bim-tenant-tokens"
    path.write_text(
        f"acme {TOKEN_ACME}\nacme\t{TOKEN_ACME_NEXT}\nother {TOKEN_OTHER}\n{TOKEN_NEW}\n", encoding="utf-8"
    )
    path.chmod(0o600)
    return path


@pytest.fixture
def make_app(tokens_path: Path):
    def make(**overrides):
        return create_app(BimServiceSettings(tokens_file=str(tokens_path), **overrides))

    return make


@pytest.fixture
def make_tenant_app(tenant_tokens_path: Path):
    def make(**overrides):
        return create_app(BimServiceSettings(tokens_file=str(tenant_tokens_path), **overrides))

    return make


@pytest.fixture
def process_app(make_app):
    """``process_app(**settings)``: an application whose operations run in worker processes (``executor="process"``).

    The workers load ``process_standins`` (operations driven by the request data, see that module); pass
    ``worker_preload=()`` for the real ones.  Every worker is started before the function returns, without the memory
    fit check (which depends on the container the tests run in), and the applications are closed at teardown.
    """
    if not (hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")):
        pytest.skip("process mode needs Linux with pidfd")
    apps = []

    def make(**overrides):
        overrides.setdefault("worker_preload", ("process_standins",))
        app = make_app(executor="process", **overrides)
        apps.append(app)
        app.state.gate.start_workers(check_fit=False)
        return app

    yield make
    for application in apps:
        application.state.gate.close()


@pytest.fixture
def app(make_app):
    return make_app()


@pytest.fixture
def client(app):
    return TestClient(app, base_url=BASE_URL, raise_server_exceptions=False, headers=bearer())
