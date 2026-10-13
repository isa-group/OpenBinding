"""Fixtures of the service tests: bearer tokens, application factories and a client.

``tokens_path`` holds two untagged tokens (one tenant, ``default``: a rotation of a single caller).
``tenant_tokens_path`` binds tokens to three tenants: ``acme`` (two tokens), ``other`` (one) and ``default`` (``TOKEN_NEW``).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from service_support import BASE_URL, TOKEN_ACME, TOKEN_ACME_NEXT, TOKEN_NEW, TOKEN_OLD, TOKEN_OTHER, bearer
from starlette.testclient import TestClient

from bim_service.app import create_app
from bim_service.settings import BimServiceSettings


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
def app(make_app):
    return make_app()


@pytest.fixture
def client(app):
    return TestClient(app, base_url=BASE_URL, raise_server_exceptions=False, headers=bearer())
