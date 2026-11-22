"""The lab's SPHERE stand-in (``openbinding-gateway/tools/sphere_lab.py``), run in-process on free loopback ports.

It must serve exactly what the tests' ``RecordedSphere`` serves (recorded bodies and headers, 304 on an exact
``If-None-Match``, version YAML tagged with its SHA-256, published scenarios overlaid the same way), keep what was
published across a restart, answer the scenario families locally whatever the passthrough says, and import nothing
but the standard library.
"""

from __future__ import annotations

import ast
import hashlib
import http.server
import json
import re
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "openbinding-gateway" / "tools"
TESTS = ROOT / "openbinding-gateway" / "tests"
SFX = TESTS / "fixtures" / "sphere"
TOOL = TOOLS / "sphere_lab.py"
DOCKERFILE = ROOT / "lab" / "sphere" / "Dockerfile"
sys.path.insert(0, str(TOOLS))
import sphere_lab

BREVO = "6ade2d4440e55445692b07f1"
TOMATOMETER = "6ab0a323697330667ccce8cd"
RESEND = "6ade2d2540e55445692b07c6"
MANIFEST = f"/api/v1/public/pricings/{BREVO}"
TOMATO_MANIFEST = f"/api/v1/public/pricings/{TOMATOMETER}"
ROUTES = json.loads((SFX / "routes.json").read_text())


class Running:
    """A stand-in on two free loopback ports; ``get``/``post`` answer ``(status, headers, body)``."""

    def __init__(self, state: Path | None, *, passthrough: str | None = None) -> None:
        self.lines: list[str] = []
        self.stand_in = sphere_lab.StandIn(SFX, state, passthrough=passthrough, log=self.lines.append)
        self.servers = sphere_lab.serve(self.stand_in, "127.0.0.1", 0, 0)
        self.api = f"http://127.0.0.1:{self.servers[0].server_port}"
        self.control = f"http://127.0.0.1:{self.servers[1].server_port}"

    def close(self) -> None:
        for server in self.servers:
            server.shutdown()
            server.server_close()

    @staticmethod
    def _open(request: urllib.request.Request) -> tuple[int, dict[str, str], bytes]:
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
        except urllib.error.HTTPError as error:
            return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()

    def get(self, path: str, base: str | None = None, **headers: str) -> tuple[int, dict[str, str], bytes]:
        return self._open(urllib.request.Request((base or self.api) + path, headers=headers))

    def post(self, path: str) -> tuple[int, dict[str, str], bytes]:
        return self._open(urllib.request.Request(self.control + path, data=b"", method="POST"))

    def state(self) -> dict:
        status, _, body = self.get("/_lab/state", self.control)
        assert status == 200
        return json.loads(body)


@pytest.fixture
def lab(tmp_path):
    (tmp_path / "state").mkdir()
    running = Running(tmp_path / "state")
    yield running
    running.close()


def _recorded(key: str) -> tuple[dict[str, str], bytes]:
    entry = ROUTES[key]
    return json.loads((SFX / entry["headers"]).read_text()), (SFX / entry["file"]).read_bytes()


def test_a_recorded_manifest_and_yaml_are_byte_identical_and_a_yaml_is_tagged_with_its_sha256(lab):
    headers, body = _recorded(MANIFEST)
    status, sent, served = lab.get(MANIFEST)
    assert status == 200 and served == body
    assert sent["etag"] == headers["etag"] and sent["cache-control"] == "private, no-cache"
    assert sent["ratelimit-limit"] == headers["ratelimit-limit"]
    yaml_path = f"{MANIFEST}/versions/6ade2d444b2b5b01c587d80d/yaml"
    status, sent, served = lab.get(yaml_path)
    assert status == 200 and served == _recorded(yaml_path)[1]
    assert sent["etag"] == '"' + hashlib.sha256(served).hexdigest() + '"'
    # A query is matched sorted, as RecordedSphere records it.
    search = next(key for key in ROUTES if key.startswith("/api/v1/pricings?") and "name=resend" in key)
    path, _, query = search.partition("?")
    reversed_query = "&".join(reversed(query.split("&")))
    assert lab.get(f"{path}?{reversed_query}")[2] == _recorded(search)[1]


def test_an_exact_if_none_match_is_a_304(lab):
    etag = lab.get(MANIFEST)[1]["etag"]
    status, sent, body = lab.get(MANIFEST, **{"If-None-Match": etag})
    assert (status, sent["etag"], body) == (304, etag, b"")
    assert lab.get(MANIFEST, **{"If-None-Match": '"other"'})[0] == 200
    assert lab.state()["requests"][MANIFEST] == {"200": 2, "304": 1}


def test_publish_serves_what_recorded_sphere_serves_and_is_idempotent(lab):
    sys.path.insert(0, str(TESTS))
    from sphere_recorded import RecordedSphere

    recorded = RecordedSphere()
    entry = recorded.publish("brevo-professional-up")
    status, _, body = lab.post("/_lab/publish/brevo-professional-up")
    assert status == 200 and json.loads(body)["status"] == "published"
    status, sent, served = lab.get(MANIFEST)
    expected = recorded.extra[(MANIFEST, "")]
    assert served == expected[0] and sent["etag"] == expected[1]["etag"]
    manifest = json.loads(served)
    assert manifest["latestVersionId"] == entry["versionId"] == "6fff00000000000000000001"
    status, sent, yaml = lab.get(f"{MANIFEST}/versions/{entry['versionId']}/yaml")
    assert status == 200 and hashlib.sha256(yaml).hexdigest() == entry["sha256"]
    assert sent["etag"] == '"' + entry["sha256"] + '"'
    status, _, body = lab.post("/_lab/publish/brevo-professional-up")
    assert status == 200 and json.loads(body)["status"] == "already_published"
    assert lab.get(MANIFEST)[2] == served
    assert lab.state()["published"] == ["brevo-professional-up"]
    assert any(line.startswith("sphere_lab_publish scenario=brevo-professional-up") for line in lab.lines)


def test_the_catalog_order_unknown_and_golden_only_scenarios_are_refused(lab):
    status, _, body = lab.post("/_lab/publish/brevo-professional-retired")
    assert status == 409 and json.loads(body) == {
        "error": "out_of_order", "scenario": "brevo-professional-retired", "after": "brevo-professional-up",
    }
    status, _, body = lab.post("/_lab/publish/no-such-scenario")
    assert status == 404 and json.loads(body)["error"] == "unknown_scenario"
    assert "tomatometer-1.2.0" in json.loads(body)["scenarios"]
    golden_only = next(e["scenario"] for e in json.loads((SFX / "scenarios.json").read_text()) if not e["publishable"])
    assert lab.post(f"/_lab/publish/{golden_only}")[0] == 409
    assert lab.post("/_lab/publish/brevo-professional-up")[0] == 200
    assert lab.post("/_lab/publish/brevo-professional-retired")[0] == 200
    manifest = json.loads(lab.get(MANIFEST)[2])
    assert [v["version"] for v in manifest["versions"][:3]] == ["2027-01", "2026-11", "2026-10"]
    assert manifest["latestVersionId"] == "6fff00000000000000000002"
    assert lab.state()["published"] == ["brevo-professional-up", "brevo-professional-retired"]


def test_what_was_published_survives_a_restart_with_the_same_state_directory(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    first = Running(state)
    try:
        assert first.post("/_lab/publish/tomatometer-1.2.0")[0] == 200
        served = first.get(TOMATO_MANIFEST)[2]
    finally:
        first.close()
    assert json.loads((state / "state.json").read_text()) == {"published": ["tomatometer-1.2.0"]}
    assert [p.name for p in state.iterdir()] == ["state.json"]
    second = Running(state)
    try:
        assert second.get(TOMATO_MANIFEST)[2] == served
        assert json.loads(second.post("/_lab/publish/tomatometer-1.2.0")[2])["status"] == "already_published"
    finally:
        second.close()
    fresh = Running(tmp_path / "other")
    try:
        assert fresh.get(TOMATO_MANIFEST)[2] == _recorded(TOMATO_MANIFEST)[1]
    finally:
        fresh.close()


def test_a_throttle_gives_one_429_with_retry_after_then_normal_answers(lab):
    status, _, body = lab.post("/_lab/throttle?seconds=17")
    assert status == 200 and json.loads(body) == {"status": "armed", "seconds": 17}
    assert lab.state()["throttle"] == 17
    status, sent, _ = lab.get(MANIFEST)
    assert status == 429 and sent["retry-after"] == "17"
    assert lab.get(MANIFEST)[0] == 200
    for bad in ("0", "3601", "x", ""):
        assert lab.post(f"/_lab/throttle?seconds={bad}")[0] == 400


class Upstream:
    """A stand-in for the public SPHERE behind the passthrough: it records what it was asked."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, str]]] = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:
                return

            def do_GET(self) -> None:
                owner.requests.append((self.path, {k.lower(): v for k, v in self.headers.items()}))
                body = b'{"pricings": []}'
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("set-cookie", "a=b")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def test_passthrough_forwards_an_unrecorded_get_anonymously_and_never_a_scenario_family(tmp_path):
    upstream = Upstream()
    running = Running(None, passthrough=upstream.origin)
    try:
        status, sent, body = running.get("/api/v1/pricings?name=nothing-recorded&limit=24&offset=0",
                                         **{"x-api-key": "org-key", "Authorization": "Bearer t"})
        assert status == 200 and body == b'{"pricings": []}' and "set-cookie" not in sent
        ((path, headers),) = upstream.requests
        assert path == "/api/v1/pricings?name=nothing-recorded&limit=24&offset=0"
        assert headers["user-agent"] == "openbinding-lab-sphere"
        assert "x-api-key" not in headers and "authorization" not in headers
        # The scenario families answer here, recorded or not: an unrecorded version of Brevo or TomatoMeter is a 404.
        for path in (f"{MANIFEST}/versions/6fff00000000000000000001/yaml", f"{TOMATO_MANIFEST}/versions/x/yaml",
                     f"/api/v1/pricings/{BREVO}?limit=24&offset=0"):
            assert running.get(path)[0] == 404, path
        assert len(upstream.requests) == 1
        # Recorded paths never leave either, nor anything outside /api/v1/.
        assert running.get(f"/api/v1/public/pricings/{RESEND}")[0] == 200
        assert running.get("/_lab/state")[0] == 404 and running.get("/other")[0] == 404
        assert len(upstream.requests) == 1
        state = running.state()
        assert state["passthrough"] == 1
        passthrough = [line for line in running.lines if line.startswith("sphere_lab_passthrough")]
        assert passthrough == [("sphere_lab_passthrough method=GET path=/api/v1/pricings?limit=24&name=nothing-recorded"
                                "&offset=0 status=200")]
        assert not [line for line in passthrough if BREVO in line or TOMATOMETER in line]
    finally:
        running.close()
        upstream.close()


def test_without_passthrough_an_unrecorded_path_is_a_404(lab):
    assert lab.get("/api/v1/pricings?name=nothing-recorded&limit=24&offset=0")[0] == 404
    assert lab.state()["passthrough"] == 0


def test_only_get_is_answered_and_the_ports_do_not_serve_each_other(lab):
    request = urllib.request.Request(lab.api + MANIFEST, data=b"{}", method="POST")
    assert Running._open(request)[0] == 405
    assert lab.get("/_lab/state")[0] == 404
    assert lab.get(MANIFEST, lab.control)[0] == 404
    assert lab.stand_in.answer("GET", "http://evil.example/api/v1/x", {})[0] == 400


def test_the_passthrough_origin_must_be_an_https_origin():
    assert sphere_lab.passthrough_origin("") is None and sphere_lab.passthrough_origin(None) is None
    assert sphere_lab.passthrough_origin("https://sphere.score.us.es/") == "https://sphere.score.us.es"
    for value in ("http://sphere.score.us.es", "https://sphere.score.us.es/api", "https://u:p@sphere.score.us.es",
                  "https://sphere.score.us.es?x=1", "sphere.score.us.es"):
        with pytest.raises(ValueError):
            sphere_lab.passthrough_origin(value)


def test_the_stand_in_imports_only_the_standard_library():
    tree = ast.parse(TOOL.read_text(encoding="utf-8"))
    modules = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, "no relative import"
            modules.add((node.module or "").split(".")[0])
    assert modules and modules <= set(sys.stdlib_module_names), modules - set(sys.stdlib_module_names)
    assert "openbinding_gateway" not in TOOL.read_text(encoding="utf-8").split('"""', 2)[2]


def test_the_image_copies_only_the_tool_and_the_recorded_set_and_runs_unprivileged():
    text = DOCKERFILE.read_text(encoding="utf-8")
    copies = [line.split()[1] for line in text.splitlines() if line.startswith("COPY ")]
    assert copies == ["openbinding-gateway/tests/fixtures/sphere/", "openbinding-gateway/tools/sphere_lab.py"]
    assert [line for line in text.splitlines() if line.startswith("FROM ")] == [
        line for line in text.splitlines() if line.startswith("FROM python:3.11-slim@sha256:")
    ]
    assert re.findall(r"^USER (\S+)", text, re.MULTILINE) == ["10001"]
    assert text.index("USER 10001") < text.index("CMD [")
    assert "pip install" not in text and "apt-get" not in text
