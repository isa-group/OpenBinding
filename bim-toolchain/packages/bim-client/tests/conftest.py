"""Fixtures of the client tests: the service mounted in this process, and both implementations of the port."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from client_support import BASE_URL, TOKEN
from starlette.testclient import TestClient

from bim_client import HttpBim, InProcessBim
from bim_service.app import create_app
from bim_service.settings import BimServiceSettings

# The OMG BPMN XSDs are not versioned: the session that runs these tests puts them in place first (tools/xsd_session.py).
TOOLS_DIR = Path(__file__).resolve().parents[3] / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from xsd_session import pytest_report_header, pytest_sessionstart  # noqa: E402,F401


@pytest.fixture(scope="session")
def tokens_file(tmp_path_factory) -> Path:
    path = tmp_path_factory.mktemp("tokens") / "bim-token"
    path.write_text(TOKEN + "\n", encoding="utf-8")
    path.chmod(0o600)
    return path


@pytest.fixture(scope="session")
def service(tokens_file):
    return create_app(BimServiceSettings(tokens_file=str(tokens_file)))


@pytest.fixture(scope="session")
def http_bim(service, tokens_file):
    """``HttpBim`` talking to the service in this process (``TestClient`` is an ``httpx.Client``)."""
    client = TestClient(service, base_url=BASE_URL, raise_server_exceptions=False)
    with HttpBim(client=client, token_file=tokens_file) as bim:
        yield bim


@pytest.fixture(scope="session")
def inprocess_bim():
    with InProcessBim() as bim:
        yield bim
