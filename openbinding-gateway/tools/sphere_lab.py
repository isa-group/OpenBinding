#!/usr/bin/env python3
"""The lab's SPHERE stand-in: recorded SPHERE answers, plus the synthetic "new upstream versions" a demo publishes.

The lab's gateway reads its default SPHERE here (``SPHERE_URL=http://sphere-lab:8080`` with
``SPHERE_REQUIRE_HTTPS=false``), so an upstream change appears on demand, the same way every time, and without
publishing anything to the public SPHERE. It knows only SPHERE's public contract and imports nothing from
``openbinding_gateway`` (standard library only, like ``feed_consumer.py``).

**API port** (``SPHERE_LAB_PORT``, 8080): exactly what the tests' ``RecordedSphere`` serves.

- Every request ``fixtures/sphere/routes.json`` recorded (path and sorted query) with its recorded body and headers
  (``ratelimit-*``, ``cache-control: private, no-cache``); an exact ``If-None-Match`` gets 304.
- Every **published** scenario of ``scenarios.json`` overlaid: the family's manifest gains the version first (a new
  ``latestVersionId``, the body serialised as ``RecordedSphere.publish`` does and an ``ETag`` that is its SHA-256, the
  scenario's name change), and the version's YAML is served with ``ETag`` = the SHA-256 of its bytes (the gateway's
  integrity check).
- Anything else is a 404, or, with ``SPHERE_LAB_PASSTHROUGH`` set to an https origin (the public SPHERE), a GET under
  ``/api/v1/`` forwarded **anonymously** (``User-Agent: openbinding-lab-sphere``; no key, no redirect, no proxy) and
  logged ``sphere_lab_passthrough``. An origin's 304 to the gateway's ``If-None-Match`` is passed on as a 304. A
  forwarded path that fails (no answer within 4 s, a transport error, a 429 or a 5xx) is a 503 and a redirect a 502, and the origin's ``retry-after`` and ``ratelimit-*`` are not passed on, so the
  gateway backs off that path only, never the stand-in's host or its anonymous bucket. The scenario families (every ``pricingId`` of ``scenarios.json``) are never
  forwarded: they always answer here, so a demo never depends on the network.

**Control port** (``SPHERE_LAB_CONTROL_PORT``, 8081), reachable only inside the compose network (no published port):

- ``POST /_lab/publish/<scenario>``: publishes one scenario, idempotently and append-only (``200`` ``published``, or
  ``already_published`` on a repeat); ``404`` for an unknown scenario, ``409`` for one that is not publishable
  (golden-only) or whose ``after`` predecessor is not published yet.
- ``GET /_lab/state``: the published scenarios, the request counts per route and status (304s included), the
  passthrough count and a pending throttle.
- ``POST /_lab/throttle?seconds=N``: the next manifest answer is ``429`` with ``Retry-After: N`` (1–3600), to show the
  gateway's back-off live.

**State.** The published list is kept in ``SPHERE_LAB_STATE/state.json`` (atomic rename), so a restart serves the same
versions; there is no unpublish, so a version the gateway snapshotted never vanishes. The lab resets it with
``docker compose … down --volumes``. Request counts live in memory.

Log lines on stdout: ``sphere_lab_start``, ``sphere_lab_request method= path= status=``, ``sphere_lab_publish``,
``sphere_lab_throttle`` and ``sphere_lab_passthrough path= status=``.

Usage (the lab's ``sphere-lab`` service; the tests run it in-process on free loopback ports):
    SPHERE_LAB_FIXTURES=fixtures/sphere SPHERE_LAB_STATE=/state python sphere_lab.py
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

API_PREFIX = "/api/v1/"
MANIFEST_PATH = re.compile(r"^/api/v1/public/pricings/([0-9a-f]{24})$")
SPHERE_ID = re.compile(r"[0-9a-f]{24}")
USER_AGENT = "openbinding-lab-sphere"
#: The largest answer forwarded from the passthrough origin (the gateway's own cap, SPHERE_MAX_BYTES).
PASSTHROUGH_MAX_BYTES = 5 * 1024 * 1024
#: Below the gateway's 5 s read timeout: a slow origin is answered here with a 503 before the gateway times out, so
#: the gateway never backs off this whole host (the scenario families with it) for one forwarded path.
PASSTHROUGH_TIMEOUT_S = 4.0
#: Headers of a forwarded answer the gateway reads; nothing else crosses (no cookie, no location). ``retry-after`` and
#: ``ratelimit-*`` never cross either: the public SPHERE's limits are not the stand-in's, and the gateway would close
#: the one anonymous bucket it shares with the locally served families.
FORWARDED_HEADERS = ("content-type", "etag", "cache-control", "vary")
DROPPED_HEADERS = {"content-length", "transfer-encoding", "content-encoding", "connection"}
MAX_THROTTLE_S = 3600
#: Distinct routes counted one by one; any further route is counted under ``(other)``.
MAX_COUNTED_ROUTES = 2000
YAML_HEADERS = {"content-type": "application/yaml", "cache-control": "private, no-cache"}

Answer = tuple[int, dict[str, str], bytes]


def route_key(path: str, query: str) -> str:
    """The key ``routes.json`` records a request by: its path and its sorted query (``RecordedSphere.route_key``)."""
    pairs = sorted(urllib.parse.parse_qsl(query, keep_blank_values=True))
    return path + ("?" + urllib.parse.urlencode(pairs) if pairs else "")


def etag_of(body: bytes) -> str:
    return '"' + hashlib.sha256(body).hexdigest() + '"'


def _json(status: int, body: Mapping[str, Any]) -> Answer:
    return status, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}, (
        json.dumps(body, indent=1, sort_keys=True).encode()
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def passthrough_opener() -> urllib.request.OpenerDirector:
    """An opener that never follows a redirect and never uses a proxy from the environment."""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


class StandIn:
    """The stand-in's state and answers, shared by both listeners (one lock)."""

    def __init__(
        self,
        fixtures: Path,
        state_dir: Path | None = None,
        *,
        passthrough: str | None = None,
        passthrough_timeout_s: float = PASSTHROUGH_TIMEOUT_S,
        opener: urllib.request.OpenerDirector | None = None,
        log: Callable[[str], None] = lambda line: print(line, flush=True),
    ) -> None:
        self.fixtures = Path(fixtures)
        self.state_dir = Path(state_dir) if state_dir else None
        self.passthrough = passthrough.rstrip("/") if passthrough else None
        self.passthrough_timeout_s = passthrough_timeout_s
        self.opener = opener or passthrough_opener()
        self.log = log
        self.routes: dict[str, dict[str, str]] = json.loads((self.fixtures / "routes.json").read_text())
        catalog = json.loads((self.fixtures / "scenarios.json").read_text())
        self.scenarios: dict[str, dict[str, Any]] = {entry["scenario"]: entry for entry in catalog}
        #: Never forwarded: every family a scenario changes always answers here.
        self.families = frozenset(entry["pricingId"] for entry in catalog)
        self.lock = threading.Lock()
        self.published: list[str] = []
        self.overlay: dict[str, tuple[dict[str, str], bytes]] = {}
        self.counts: dict[str, dict[str, int]] = {}
        self.passthrough_count = 0
        self.throttle_s: int | None = None
        for name in self._load_state():
            entry = self.scenarios.get(name)
            if entry is None or not entry["publishable"] or (entry["after"] and entry["after"] not in self.published):
                raise ValueError(f"the state names a scenario this catalog cannot publish: {name}")
            self._apply(entry)

    # -- state --------------------------------------------------------------------------------------------------------

    def _state_file(self) -> Path | None:
        return self.state_dir / "state.json" if self.state_dir else None

    def _load_state(self) -> list[str]:
        path = self._state_file()
        if path is None or not path.is_file():
            return []
        return list(json.loads(path.read_text()).get("published") or [])

    def _save_state(self) -> None:
        path = self._state_file()
        if path is None:
            return
        temporary = path.with_name(f".state.{os.getpid()}.{threading.get_ident()}.tmp")
        temporary.write_text(json.dumps({"published": self.published}, indent=1) + "\n")
        os.replace(temporary, path)

    # -- publishing ---------------------------------------------------------------------------------------------------

    def _manifest(self, pricing_id: str) -> dict[str, Any]:
        key = f"/api/v1/public/pricings/{pricing_id}"
        if key in self.overlay:
            return json.loads(self.overlay[key][1])
        return json.loads((self.fixtures / pricing_id / "manifest.json").read_text())

    def _apply(self, entry: Mapping[str, Any]) -> None:
        """Overlay one scenario, as ``RecordedSphere.publish`` does (same manifest bytes, same tags)."""
        pricing_id, version_id = entry["pricingId"], entry["versionId"]
        data = (self.fixtures / entry["file"]).read_bytes()
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError(f"{entry['file']} does not match the catalog's sha256")
        manifest = self._manifest(pricing_id)
        if not any(version["versionId"] == version_id for version in manifest["versions"]):
            manifest["versions"] = [{
                "versionId": version_id, "version": entry["label"], "createdAt": entry["createdAt"],
                "contentHash": entry["contentHash"],
            }] + list(manifest["versions"])
            manifest["latestVersionId"] = version_id
        if entry["manifest"].get("nameChange"):
            manifest["name"] = entry["manifest"]["nameChange"]
        body = json.dumps(manifest, indent=1).encode()
        headers = json.loads((self.fixtures / pricing_id / "manifest.headers.json").read_text())
        headers["etag"] = etag_of(body)
        self.overlay[f"/api/v1/public/pricings/{pricing_id}"] = (headers, body)
        self.overlay[f"/api/v1/public/pricings/{pricing_id}/versions/{version_id}/yaml"] = (
            {**YAML_HEADERS, "etag": etag_of(data)}, data,
        )
        self.published.append(entry["scenario"])

    def publish(self, name: str) -> Answer:
        with self.lock:
            entry = self.scenarios.get(name)
            if entry is None:
                return _json(404, {"error": "unknown_scenario", "scenario": name,
                                   "scenarios": sorted(n for n, e in self.scenarios.items() if e["publishable"])})
            if name in self.published:
                return _json(200, {"status": "already_published", "scenario": name, "versionId": entry["versionId"],
                                   "label": entry["label"], "pricingId": entry["pricingId"]})
            if not entry["publishable"]:
                return _json(409, {"error": "not_publishable", "scenario": name})
            if entry["after"] and entry["after"] not in self.published:
                return _json(409, {"error": "out_of_order", "scenario": name, "after": entry["after"]})
            self._apply(entry)
            self._save_state()
        self.log(f"sphere_lab_publish scenario={name} pricing={entry['pricingId']} version={entry['versionId']} "
                 f"label={entry['label']}")
        return _json(200, {"status": "published", "scenario": name, "versionId": entry["versionId"],
                           "label": entry["label"], "pricingId": entry["pricingId"]})

    def throttle(self, query: str) -> Answer:
        values = urllib.parse.parse_qs(query).get("seconds") or [""]
        seconds = values[0]
        if not seconds.isdigit() or not 1 <= int(seconds) <= MAX_THROTTLE_S:
            return _json(400, {"error": "seconds_invalid", "detail": f"seconds must be 1 to {MAX_THROTTLE_S}"})
        with self.lock:
            self.throttle_s = int(seconds)
        self.log(f"sphere_lab_throttle seconds={seconds}")
        return _json(200, {"status": "armed", "seconds": int(seconds)})

    def state(self) -> Answer:
        with self.lock:
            return _json(200, {
                "published": list(self.published),
                "scenarios": sorted(name for name, entry in self.scenarios.items() if entry["publishable"]),
                "requests": {key: dict(counts) for key, counts in sorted(self.counts.items())},
                "passthrough": self.passthrough_count,
                "passthroughOrigin": self.passthrough,
                "throttle": self.throttle_s,
            })

    # -- the API ------------------------------------------------------------------------------------------------------

    def _count(self, key: str, status: int) -> None:
        with self.lock:
            if key not in self.counts and len(self.counts) >= MAX_COUNTED_ROUTES:
                key = "(other)"
            counts = self.counts.setdefault(key, {})
            counts[str(status)] = counts.get(str(status), 0) + 1

    def _local(self, key: str) -> tuple[dict[str, str], bytes] | None:
        with self.lock:
            if key in self.overlay:
                headers, body = self.overlay[key]
                return dict(headers), body
        entry = self.routes.get(key)
        if entry is None:
            return None
        headers = json.loads((self.fixtures / entry["headers"]).read_text())
        return headers, (self.fixtures / entry["file"]).read_bytes()

    def _family(self, path: str) -> bool:
        return any(found in self.families for found in SPHERE_ID.findall(path))

    def answer(self, method: str, target: str, headers: Mapping[str, str]) -> Answer:
        """The answer to one request on the API port (``headers`` with lower-case names)."""
        if method != "GET":
            return _json(405, {"error": "METHOD NOT ALLOWED"})
        if not target.startswith("/"):
            return _json(400, {"error": "BAD REQUEST"})
        parts = urllib.parse.urlsplit(target)
        path, query = parts.path, parts.query
        key = route_key(path, query)
        if not path.startswith(API_PREFIX):
            return self._finish(key, _json(404, {"error": "NOT FOUND"}))
        if MANIFEST_PATH.match(path):
            with self.lock:
                throttle, self.throttle_s = self.throttle_s, None
            if throttle is not None:
                status, sent, body = _json(429, {"error": "TOO MANY REQUESTS"})
                return self._finish(key, (status, {**sent, "retry-after": str(throttle)}, body))
        local = self._local(key)
        if local is not None:
            recorded, body = local
            sent = {name.lower(): value for name, value in recorded.items() if name.lower() not in DROPPED_HEADERS}
            etag = sent.get("etag")
            if etag and headers.get("if-none-match") == etag:
                return self._finish(key, (304, {"etag": etag}, b""))
            return self._finish(key, (200, sent, body))
        if self.passthrough is None or self._family(path):
            return self._finish(key, _json(404, {"error": "NOT FOUND"}))
        return self._finish(key, self._forward(target, headers), passthrough=True)

    def _finish(self, key: str, answer: Answer, *, passthrough: bool = False) -> Answer:
        self._count(key, answer[0])
        name = "sphere_lab_passthrough" if passthrough else "sphere_lab_request"
        self.log(f"{name} method=GET path={key[:300]} status={answer[0]}")
        return answer

    def _forward(self, target: str, headers: Mapping[str, str]) -> Answer:
        """``target`` asked of the passthrough origin, anonymously.

        Whatever goes wrong upstream stays with this one path: a timeout, a transport failure or a 429 is a 503 (which
        the gateway remembers for that path only), a redirect a 502, and the origin's rate-limit headers are dropped.
        A 304 to the gateway's own ``If-None-Match`` (its cache revalidating, the watcher polling) is passed on as a
        304 with its ``ETag``: urllib raises it as an error, but it is the origin saying nothing changed.
        """
        with self.lock:
            self.passthrough_count += 1
        sent = {"User-Agent": USER_AGENT, "Accept": headers.get("accept") or "application/json"}
        if headers.get("if-none-match"):
            sent["If-None-Match"] = headers["if-none-match"]
        request = urllib.request.Request(f"{self.passthrough}{target}", headers=sent, method="GET")
        try:
            with self.opener.open(request, timeout=self.passthrough_timeout_s) as response:
                status, received, body = response.status, response.headers, response.read(PASSTHROUGH_MAX_BYTES + 1)
        except urllib.error.HTTPError as error:
            status, received, body = error.code, error.headers, error.read(PASSTHROUGH_MAX_BYTES + 1)
        except (urllib.error.URLError, OSError, ValueError):
            return _json(503, {"error": "SERVICE UNAVAILABLE"})
        if status == 429 or status >= 500:
            return _json(503, {"error": "SERVICE UNAVAILABLE"})
        kept = {name: received[name] for name in FORWARDED_HEADERS if received.get(name) is not None}
        if status == 304:
            return 304, kept, b""
        if 300 <= status < 400 or len(body) > PASSTHROUGH_MAX_BYTES:  # a redirect is never followed nor passed on
            return _json(502, {"error": "BAD GATEWAY"})
        return status, kept, body


# -- the two listeners -------------------------------------------------------------------------------------------------


def _handler(stand_in: StandIn, *, control: bool) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "openbinding-lab-sphere"
        sys_version = ""

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - BaseHTTPRequestHandler's name
            return

        def _send(self, answer: Answer) -> None:
            status, headers, body = answer
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _drain(self) -> None:
            length = self.headers.get("content-length", "")
            if length.isdigit() and int(length) > 0:
                self.rfile.read(min(int(length), 65536))

        def _dispatch(self) -> None:
            self._drain()
            if control:
                self._send(self._control())
                return
            headers = {name.lower(): value for name, value in self.headers.items()}
            self._send(stand_in.answer(self.command, self.path, headers))

        def _control(self) -> Answer:
            parts = urllib.parse.urlsplit(self.path)
            if self.command == "GET" and parts.path == "/_lab/state":
                return stand_in.state()
            if self.command == "POST" and parts.path.startswith("/_lab/publish/"):
                return stand_in.publish(urllib.parse.unquote(parts.path.removeprefix("/_lab/publish/")))
            if self.command == "POST" and parts.path == "/_lab/throttle":
                return stand_in.throttle(parts.query)
            return _json(404, {"error": "NOT FOUND"})

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _dispatch

    return Handler


def serve(stand_in: StandIn, host: str, port: int, control_port: int) -> tuple[ThreadingHTTPServer, ThreadingHTTPServer]:
    """Both listeners, started on daemon threads; the caller shuts them down."""
    servers = (
        ThreadingHTTPServer((host, port), _handler(stand_in, control=False)),
        ThreadingHTTPServer((host, control_port), _handler(stand_in, control=True)),
    )
    for server in servers:
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, name=f"sphere-lab-{server.server_port}", daemon=True).start()
    return servers


def passthrough_origin(value: str | None) -> str | None:
    """``SPHERE_LAB_PASSTHROUGH``: empty (off) or an https origin with no path, query or userinfo."""
    if not value or not value.strip():
        return None
    parts = urllib.parse.urlsplit(value.strip())
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.path not in ("", "/") \
            or parts.query or parts.fragment:
        raise ValueError("SPHERE_LAB_PASSTHROUGH must be an https origin such as https://sphere.score.us.es, or empty")
    return f"https://{parts.netloc}"


def main(environ: Mapping[str, str] | None = None) -> int:
    source = os.environ if environ is None else environ
    here = Path(__file__).resolve().parent
    fixtures = Path(source.get("SPHERE_LAB_FIXTURES") or here.parent / "tests" / "fixtures" / "sphere")
    state = source.get("SPHERE_LAB_STATE") or None
    try:
        passthrough = passthrough_origin(source.get("SPHERE_LAB_PASSTHROUGH"))
        stand_in = StandIn(fixtures, Path(state) if state else None, passthrough=passthrough)
    except (OSError, ValueError) as error:
        print(f"sphere_lab: {error}", file=sys.stderr, flush=True)
        return 2
    host = source.get("SPHERE_LAB_HOST") or "0.0.0.0"  # noqa: S104 - a container port, published nowhere
    port, control_port = int(source.get("SPHERE_LAB_PORT") or 8080), int(source.get("SPHERE_LAB_CONTROL_PORT") or 8081)
    servers = serve(stand_in, host, port, control_port)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    stand_in.log(f"sphere_lab_start port={port} control={control_port} routes={len(stand_in.routes)} "
                 f"published={','.join(stand_in.published) or '-'} passthrough={passthrough or 'off'}")
    while not stop.wait(1.0):
        pass
    for server in servers:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
