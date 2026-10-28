"""Architecture test: only ``lab/tools/**`` and the gateway plans module may call SPACE's or SPHERE's HTTP API.

The detector is a plain function of a file's path and text.  A file is a *direct caller* when it creates an HTTP client
or sends a request AND names a SPACE or SPHERE target.  Using httpx only for type annotations or transports is not a
call; the official clients (``space_client``, ``space-react-client``) are fine.  The ``control`` tests prove the
detector on in-memory samples.  Files outside the allowed paths that do call are pinned in ``KNOWN_DEVIATIONS``
with a reason; the pin can only shrink.

Run from ``openbinding-gateway`` with its environment::

    uv run --locked pytest ../lab/tests
"""

from __future__ import annotations

import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

SKIPPED_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".mypy_cache",
                ".pytest_cache", ".ruff_cache", "coverage", "playwright-report", "test-results"}
SOURCE_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}
# Only these trees are test code; a directory that is merely called tests/test/mocks/fixtures elsewhere (for example a
# production module under openbinding-gateway/src/openbinding_gateway/tests/) is scanned.
TEST_TREES = ("lab/tests/", "openbinding-gateway/tests/", "openbinding-gateway/tools/tests/", "frontend/e2e/",
              "frontend/tests/", "frontend/src/test/")
# test_*.py, *.test.ts and *.spec.ts; the .tsx/.js/.mjs/.cjs variants of the same naming are covered on purpose.
TEST_NAME = re.compile(r"(^test_.*\.py$|\.(test|spec)\.[cm]?[jt]sx?$)")
# The plans path is allowed by the brief and constitution 16.6 although the module does not exist yet.  ADR 0022 limits
# the raw-HTTP exception to lab/tools; the plans module is meant to use space-python-client, not raw HTTP.
ALLOWED_PREFIXES = ("lab/tools/", "openbinding-gateway/src/openbinding_gateway/plans/")
# The only file under lab/tools that may be a direct caller (ADR 0022); a new one needs a deliberate edit here and in
# the ADR.
LAB_TOOLS_DIRECT_CALLERS = {"lab/tools/space_lab_bootstrap.py"}

# Something that creates a client or sends a request.  ``httpx.AsyncBaseTransport``, ``httpx.MockTransport`` and
# ``logging.getLogger("httpx")`` are deliberately not matched.  Known limit: a module that only receives an already
# built client (injected as a parameter) and never names a library is not seen; the module that builds it is.
HTTP_CALL = re.compile(
    r"\bhttpx\.(?:Client|AsyncClient|get|post|put|patch|delete|head|request|stream)\b"
    r"|\bfrom\s+httpx\s+import\b"  # any name imported from httpx counts as client use
    r"|\brequests\.(?:get|post|put|patch|delete|head|request|Session)\b"
    r"|\baiohttp\.ClientSession\b|\bfrom\s+aiohttp\s+import\b"
    r"|\burllib\.request\b|\bfrom\s+urllib\s+import\s+request\b"
    r"|\burllib3\.(?:PoolManager|ProxyManager|HTTPConnectionPool|HTTPSConnectionPool|request|connection_from_url)\b"
    r"|\bfrom\s+urllib3\s+import\b"
    r"|\bhttp\.client\b|\bfrom\s+http\s+import\s+client\b"
    r"|\bhttps?\.(?:request|get)\s*\("  # Node http / https
    r"|(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s+)['\"](?:got|ky)['\"]"
    r"|\bXMLHttpRequest\b"
    r"|(?<![\w.])fetch\s*\(|\b(?:window|globalThis|self)\.fetch\s*\(|\baxios\b"
)
# ``import httpx as h`` followed by ``h.get(...)``: the alias is resolved per text.
ALIAS_IMPORT = re.compile(r"\bimport\s+(httpx|requests|aiohttp|urllib3)\s+as\s+(\w+)")
ALIAS_CALLS = {
    "httpx": r"(?:Client|AsyncClient|get|post|put|patch|delete|head|request|stream)",
    "requests": r"(?:get|post|put|patch|delete|head|request|Session)",
    "aiohttp": r"ClientSession",
    "urllib3": r"(?:PoolManager|ProxyManager|request)",
}
# Node: ``const http = require("node:http")`` or ``import https from "https"`` followed by ``.request(`` / ``.get(``.
NODE_HTTP_IMPORT = re.compile(r"(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s+)['\"](?:node:)?https?['\"]")
NODE_CALL = re.compile(r"\.(?:request|get)\s*\(")
# A SPACE or SPHERE target: configuration names, hosts or route paths.
TARGET = re.compile(
    r"(?<![A-Za-z])(?:space|sphere)_?url\b"  # SPACE_URL, space_url, sphereUrl, sphere_url
    r"|\bSPHERE_[A-Z_]*URL\b"
    r"|\b(?:sphere|space)\.score\.us\.es\b"
    r"|/api/v1/(?:services|organizations|contracts)\b|/api/v1/public/pricings"
    r"|/users/authenticate\b|/synchronization/run\b",
    re.IGNORECASE,
)

# Known pre-existing deviations outside the allowed paths, one file per entry, no wildcards.  An entry that stops
# matching the detector, or a detected file that is missing here, fails the test.
KNOWN_DEVIATIONS = {
    "openbinding-gateway/tools/_remote_common.py":
        "development probe: SpaceRemote uses httpx for services and pricings, SphereRemote calls SPHERE directly; "
        "remote_probe.py, remote_provision.py and seed_lab.py reach SPACE only through it (httpx there is for types)",
    "openbinding-gateway/src/openbinding_gateway/sphere_client.py":
        "the gateway's home-made SPHERE client (httpx with x-api-key), removed later by ADR-0015 section 7",
}


def is_test_path(rel: str) -> bool:
    return rel.startswith(TEST_TREES) or bool(TEST_NAME.search(rel.rsplit("/", 1)[-1]))


def makes_http_call(text: str) -> bool:
    if HTTP_CALL.search(text):
        return True
    for module, alias in ALIAS_IMPORT.findall(text):
        if re.search(rf"\b{re.escape(alias)}\.{ALIAS_CALLS[module]}\b", text):
            return True
    return bool(NODE_HTTP_IMPORT.search(text)) and bool(NODE_CALL.search(text))


def is_direct_caller(text: str) -> bool:
    return makes_http_call(text) and bool(TARGET.search(text))


def is_allowed(rel: str) -> bool:
    return rel.startswith(ALLOWED_PREFIXES)


def source_files(root: Path = ROOT) -> list[str]:
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        # prune skipped directories so their trees are never walked
        dirnames[:] = [d for d in dirnames if d not in SKIPPED_DIRS and not d.endswith(".egg-info")]
        for name in filenames:
            path = Path(dirpath) / name
            if path.suffix in SOURCE_SUFFIXES:
                rel = "/".join(path.relative_to(root).parts)
                if not is_test_path(rel):
                    found.append(rel)
    return sorted(found)


def detected(root: Path = ROOT) -> set[str]:
    return {rel for rel in source_files(root)
            if is_direct_caller((root / rel).read_text(encoding="utf-8", errors="replace"))}


def outside_allowed() -> set[str]:
    return {rel for rel in detected() if not is_allowed(rel)}


# -- the real tree ---------------------------------------------------------------------------------------------------


def test_no_direct_http_to_space_or_sphere_outside_the_allowed_paths():
    # [utest->req~lab-space-no-direct-http~1]
    unexpected = sorted(outside_allowed() - set(KNOWN_DEVIATIONS))
    assert not unexpected, (
        f"direct HTTP to SPACE or SPHERE outside lab/tools and the plans module: {unexpected}; "
        "use space_client or move the call, do not add it to KNOWN_DEVIATIONS without an ADR"
    )


def test_known_deviations_are_pinned_and_still_needed():
    # [utest->req~lab-space-no-direct-http~1]
    assert all(reason.strip() and "*" not in path for path, reason in KNOWN_DEVIATIONS.items())
    for path in KNOWN_DEVIATIONS:
        assert not is_allowed(path), f"{path} is in an allowed path: remove it from KNOWN_DEVIATIONS"
        file = ROOT / path
        assert file.is_file(), f"{path} no longer exists: remove it from KNOWN_DEVIATIONS"
        assert is_direct_caller(file.read_text(encoding="utf-8")), (
            f"{path} no longer calls SPACE or SPHERE directly: remove it from KNOWN_DEVIATIONS"
        )
    assert outside_allowed() == set(KNOWN_DEVIATIONS)


def test_the_lab_tools_exception_is_recorded_in_the_adr():
    # [utest->req~lab-space-no-direct-http~1]
    adr = ROOT / "docs" / "adr" / "0022-lab-bootstrap-exception-to-constitution-16-1.md"
    assert adr.is_file() and "lab/tools" in adr.read_text(encoding="utf-8")


# -- controls: the detector on in-memory samples ---------------------------------------------------------------------

DIRECT = '''import httpx

async def services(space_url: str):
    return httpx.get(f"{space_url}/api/v1/services")
'''


def test_control_detects_a_direct_call():
    # [utest->req~lab-space-no-direct-http~1]
    assert is_direct_caller(DIRECT)
    gateway = "openbinding-gateway/src/openbinding_gateway/new_module.py"
    assert is_direct_caller(DIRECT) and not is_allowed(gateway)
    # the same text under the allowed paths is allowed
    assert is_allowed("lab/tools/space_lab_bootstrap.py")
    assert is_allowed("openbinding-gateway/src/openbinding_gateway/plans/catalog.py")
    assert not is_allowed("lab/tests/test_x.py") and not is_allowed("lab/other/tool.py")
    # forms of calls and targets
    assert is_direct_caller("const r = await fetch(`${sphereUrl}/api/v1/public/pricings`)")
    assert is_direct_caller("import requests\nrequests.post(SPACE_URL + '/x')")
    assert is_direct_caller("async with httpx.AsyncClient(base_url=os.environ['SPHERE_API_URL']) as c: ...")
    assert is_direct_caller("import urllib.request\nurllib.request.urlopen('https://sphere.score.us.es/x')")
    assert is_direct_caller("axios.get('/users/authenticate')")
    # not direct callers
    assert not is_direct_caller("from space_client import SpaceClientFactory\nclient = SpaceClientFactory.connect(space_url)")
    assert not is_direct_caller(
        "import httpx\n\ndef run(space_url: str, transport: httpx.AsyncBaseTransport | None = None): ...")
    assert not is_direct_caller('import httpx\nlogging.getLogger("httpx").setLevel(30)\nSPACE_URL = "x"')
    assert not is_direct_caller("httpx.MockTransport(handler)\nspace_url = 'http://space'")
    assert not is_direct_caller("import httpx\nhttpx.get('https://example.org/data')")
    assert not is_direct_caller("fetch('/api/v1/health')")


def test_control_detects_more_clients_and_aliases():
    # [utest->req~lab-space-no-direct-http~1]
    samples = {
        "httpx alias": "import httpx as h\nh.get(f'{SPACE_URL}/api/v1/services')",
        "from httpx import name": "from httpx import AsyncClient\nSPACE_URL = 'x'",
        "from httpx import multi-line": "from httpx import (\n    Timeout,\n)\nspace_url = 'x'",
        "requests alias": "import requests as rq\nrq.post(space_url + '/x')",
        "urllib3 PoolManager": "import urllib3\nurllib3.PoolManager().request('GET', SPACE_URL)",
        "urllib3 import": "from urllib3 import PoolManager\nSPACE_URL = 'x'",
        "http.client": "import http.client\nhttp.client.HTTPConnection('sphere.score.us.es')",
        "node http.request": "import http from 'node:http'\nhttp.request(`${spaceUrl}/api/v1/services`)",
        "node https.get": "const https = require('https')\nhttps.get(SPACE_URL)",
        "got": "import got from 'got'\nawait got(`${spaceUrl}/x`)",
        "ky": "import ky from 'ky'\nky.get(`${sphereUrl}/x`)",
        "XMLHttpRequest": "const x = new XMLHttpRequest()\nx.open('GET', SPACE_URL)",
        "window.fetch": "await window.fetch(`${spaceUrl}/api/v1/services`)",
        "globalThis.fetch": "await globalThis.fetch(`${sphereUrl}/x`)",
        "self.fetch": "await self.fetch(SPACE_URL)",
    }
    for name, text in samples.items():
        assert is_direct_caller(text), name
    # type-only use and the official client stay clear, also through an alias
    for name, text in {
        "annotation": "import httpx\ndef f(space_url: str, t: httpx.AsyncBaseTransport | None = None): ...",
        "alias annotation": "import httpx as h\ndef f(space_url: str, t: h.AsyncBaseTransport): ...",
        "mock transport": "import httpx\nt = httpx.MockTransport(handler)\nSPACE_URL = 'x'",
        "space_client only": "from space_client import SpaceClientFactory\nSpaceClientFactory.connect(SPACE_URL)",
        "node http without call": "import http from 'node:http'\nconst agent = new http.Agent()\nconst u = SPACE_URL",
        "client without target": "from httpx import AsyncClient\nAsyncClient().get('https://example.org')",
        "window.fetch without target": "await window.fetch('/api/v1/health')",
        "globalThis.fetch without target": "await globalThis.fetch('https://example.org')",
        "self.fetch without target": "await self.fetch('/data.json')",
        "fetch method of another object": "await cache.fetch(SPACE_URL)",
    }.items():
        assert not is_direct_caller(text), name


def test_control_scans_mts_and_cts_and_prunes_skipped_directories(tmp_path):
    # [utest->req~lab-space-no-direct-http~1]
    assert {".mts", ".cts"} <= SOURCE_SUFFIXES
    files = {
        "web/a.mts": "await window.fetch(`${spaceUrl}/api/v1/services`)",
        "web/b.cts": "await globalThis.fetch(SPACE_URL)",
        "web/c.mts": "const x = 1",
        "node_modules/pkg/d.mts": "await self.fetch(SPACE_URL)",
        "web/node_modules/e.py": DIRECT,
        "web/e.egg-info/f.py": DIRECT,
        "web/a.test.mts": "await window.fetch(SPACE_URL)",
    }
    for rel, text in files.items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(text, encoding="utf-8")
    assert source_files(tmp_path) == ["web/a.mts", "web/b.cts", "web/c.mts"]
    assert detected(tmp_path) == {"web/a.mts", "web/b.cts"}


def test_control_skips_tests_and_mocks():
    # [utest->req~lab-space-no-direct-http~1]
    for rel in ("lab/tests/test_x.py", "frontend/e2e/mock.ts", "frontend/src/a.test.ts", "frontend/src/a.spec.tsx",
                "openbinding-gateway/tests/conftest.py", "openbinding-gateway/tests/helpers.py",
                "openbinding-gateway/tools/tests/fakes.py", "frontend/e2e/live/support.ts",
                "openbinding-gateway/src/openbinding_gateway/test_helpers.py"):
        assert is_test_path(rel), rel
    assert not is_test_path("openbinding-gateway/tools/_remote_common.py")
    # a directory merely called tests/test/mocks/fixtures is not a test tree
    for rel in ("openbinding-gateway/src/openbinding_gateway/tests/client.py",
                "openbinding-gateway/src/openbinding_gateway/mocks/space.py",
                "frontend/src/fixtures/space.ts", "lab/tools/tests/bootstrap.py"):
        assert not is_test_path(rel), rel
    # so a production module in such a directory that calls SPACE directly is detected and not allowed
    rel = "openbinding-gateway/src/openbinding_gateway/tests/client.py"
    assert not any(p in SKIPPED_DIRS for p in rel.split("/"))  # source_files() also keeps it
    assert not is_test_path(rel) and not is_allowed(rel) and is_direct_caller(DIRECT)


def test_lab_tools_has_only_the_bootstrap_as_a_direct_caller():
    # [utest->req~lab-space-no-direct-http~1]
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    # ADR 0022 limits the raw-HTTP exception to the bootstrap; a new raw-HTTP file in lab/tools needs a deliberate
    # edit of LAB_TOOLS_DIRECT_CALLERS and of the ADR.
    in_tools = {rel for rel in detected() if rel.startswith("lab/tools/")}
    assert in_tools == LAB_TOOLS_DIRECT_CALLERS, (
        f"direct SPACE/SPHERE callers under lab/tools: {sorted(in_tools)}; expected {sorted(LAB_TOOLS_DIRECT_CALLERS)}; "
        "update this test and ADR 0022 deliberately"
    )
    # control: the same comparison on an in-memory tree catches a second raw-HTTP file and ignores a types-only one
    sample = {
        "lab/tools/space_lab_bootstrap.py": DIRECT,
        "lab/tools/other.py": DIRECT,
        "lab/tools/types_only.py": "import httpx\ndef f(space_url, t: httpx.AsyncBaseTransport): ...",
    }
    found = {rel for rel, text in sample.items() if rel.startswith("lab/tools/") and is_direct_caller(text)}
    assert found == LAB_TOOLS_DIRECT_CALLERS | {"lab/tools/other.py"}
    assert found != LAB_TOOLS_DIRECT_CALLERS
