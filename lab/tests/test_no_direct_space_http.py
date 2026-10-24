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

import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

SKIPPED_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".mypy_cache",
                ".pytest_cache", ".ruff_cache", "coverage", "playwright-report", "test-results"}
SOURCE_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
TEST_DIRS = {"tests", "test", "__tests__", "e2e", "acceptance", "mocks", "__mocks__", "fixtures"}
TEST_NAME = re.compile(r"(^test_.*\.py$|_test\.py$|^conftest\.py$|\.(test|spec)\.[cm]?[jt]sx?$)")
ALLOWED_PREFIXES = ("lab/tools/", "openbinding-gateway/src/openbinding_gateway/plans/")

# Something that creates a client or sends a request.  ``httpx.AsyncBaseTransport``, ``httpx.MockTransport`` and
# ``logging.getLogger("httpx")`` are deliberately not matched.
HTTP_CALL = re.compile(
    r"\bhttpx\.(?:Client|AsyncClient|get|post|put|patch|delete|head|request|stream)\b"
    r"|\bfrom\s+httpx\s+import\s+[^\n]*\b(?:Client|AsyncClient|get|post|put|patch|delete|request|stream)\b"
    r"|\brequests\.(?:get|post|put|patch|delete|head|request|Session)\b"
    r"|\baiohttp\.ClientSession\b|\bfrom\s+aiohttp\s+import\b"
    r"|\burllib\.request\b|\bfrom\s+urllib\s+import\s+request\b"
    r"|(?<![\w.])fetch\s*\(|\baxios\b"
)
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
    parts = rel.split("/")
    return any(p in TEST_DIRS for p in parts[:-1]) or bool(TEST_NAME.search(parts[-1]))


def is_direct_caller(text: str) -> bool:
    return bool(HTTP_CALL.search(text)) and bool(TARGET.search(text))


def is_allowed(rel: str) -> bool:
    return rel.startswith(ALLOWED_PREFIXES)


def source_files() -> list[str]:
    found = []
    for path in sorted(ROOT.rglob("*")):
        rel_parts = path.relative_to(ROOT).parts
        if any(p in SKIPPED_DIRS or p.endswith(".egg-info") for p in rel_parts):
            continue
        if path.is_file() and path.suffix in SOURCE_SUFFIXES:
            rel = "/".join(rel_parts)
            if not is_test_path(rel):
                found.append(rel)
    return found


def detected() -> set[str]:
    return {rel for rel in source_files() if is_direct_caller((ROOT / rel).read_text(encoding="utf-8", errors="replace"))}


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


def test_control_skips_tests_and_mocks():
    # [utest->req~lab-space-no-direct-http~1]
    for rel in ("lab/tests/test_x.py", "frontend/e2e/mock.ts", "frontend/src/a.test.ts", "frontend/src/a.spec.tsx",
                "openbinding-gateway/tests/conftest.py", "openbinding-gateway/tests/helpers.py"):
        assert is_test_path(rel), rel
    assert not is_test_path("openbinding-gateway/tools/_remote_common.py")
