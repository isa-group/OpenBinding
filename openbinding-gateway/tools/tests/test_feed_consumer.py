"""feed_consumer: the lab's stand-in for TomatoMeter, against stub HTTP servers for the feed and Mailpit.

It starts without a hand-off and picks one up later, follows the feed with ``If-None-Match``, keeps its last good
state on any refusal, honours ``Retry-After``, ignores an unknown provider, mails through Mailpit with the provider's
tags and headers, never shows or logs the key, and imports nothing from the gateway.
"""

from __future__ import annotations

import ast
import json
import logging
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

import feed_consumer as tool

KEY = "obe_d99385bd_" + "0" * 56
DOCUMENT = """\
syntaxVersion: '1.0'
composition: tomatometer
version: {label}
binding:
  login:
    candidate: auth.builtin.local
  dailySummary:
    candidate: {candidate}
"""


class Stub:
    """A local HTTP server answering from a queue (the last answer repeats), recording every request."""

    def __init__(self) -> None:
        self.answers: list[tuple[int, dict[str, str], bytes]] = []
        self.requests: list[dict] = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                stub.requests.append({
                    "method": self.command, "path": self.path,
                    "headers": {name.lower(): value for name, value in self.headers.items()},
                    "body": self.rfile.read(length) if length else b"",
                })
                status, headers, body = stub.answers[0] if len(stub.answers) == 1 else stub.answers.pop(0)
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_POST = _serve

            def log_message(self, *args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def feed():
    stub = Stub()
    yield stub
    stub.close()


@pytest.fixture
def mailpit():
    stub = Stub()
    stub.answers = [(200, {"Content-Type": "application/json"}, b'{"ID": "msg-1"}')]
    yield stub
    stub.close()


def adopted(label: str, candidate: str, etag: str, adoption: str) -> tuple[int, dict[str, str], bytes]:
    headers = {"ETag": etag, "OpenBinding-Composition-Version": label, "OpenBinding-Adoption": adoption,
               "Content-Type": "application/yaml; charset=utf-8"}
    return 200, headers, DOCUMENT.format(label=label, candidate=candidate).encode()


def write_handoff(path: Path, url: str, key: str = KEY) -> None:
    path.write_text(json.dumps({"organization": "lab-main", "composition": "tomatometer", "environment": "production",
                                "feedUrl": url, "feedKey": key}))


def test_without_a_handoff_it_waits_answers_409_and_reads_no_feed(tmp_path, feed, mailpit):
    consumer = tool.Consumer(str(tmp_path / "openbinding.json"), mailpit.url)
    consumer.poll_once()
    assert consumer.view()["status"] == "waiting_for_handoff"
    assert consumer.send() == (409, {"code": "waiting_for_handoff", "error": "No composition is followed yet."})
    assert feed.requests == [] and mailpit.requests == []


def test_a_handoff_that_appears_later_is_read_on_the_next_poll(tmp_path, feed, mailpit):
    path = tmp_path / "openbinding.json"
    consumer = tool.Consumer(str(path), mailpit.url)
    consumer.poll_once()
    feed.answers = [adopted("1.0.0", "email.brevo.professional", '"sha256-a"', "1")]
    write_handoff(path, f"{feed.url}/feed")
    consumer.poll_once()
    state = consumer.view()
    assert (state["status"], state["provider"], state["candidate"]) == ("following", "brevo", "email.brevo.professional")
    assert (state["version"], state["adoption"], state["etag"]) == ("1.0.0", "1", '"sha256-a"')
    (request,) = feed.requests
    assert request["headers"]["x-api-key"] == KEY and "if-none-match" not in request["headers"]


def test_304_keeps_the_state_and_a_new_candidate_switches_the_provider(tmp_path, feed, mailpit):
    path = tmp_path / "openbinding.json"
    write_handoff(path, f"{feed.url}/feed")
    consumer = tool.Consumer(str(path), mailpit.url)
    feed.answers = [
        adopted("1.0.0", "email.brevo.professional", '"sha256-a"', "1"),
        (304, {"ETag": '"sha256-a"'}, b""),
        adopted("1.0.0", "email.brevo.professional", '"sha256-a2"', "2"),
        adopted("1.1.0", "email.resend.pro", '"sha256-b"', "3"),
    ]
    consumer.poll_once()
    consumer.poll_once()
    assert feed.requests[1]["headers"]["if-none-match"] == '"sha256-a"'
    assert consumer.view()["provider"] == "brevo" and consumer.view()["lastStatus"] == 304
    consumer.poll_once()  # the same candidate under another tag: the provider stays
    assert consumer.view()["provider"] == "brevo" and consumer.view()["etag"] == '"sha256-a2"'
    consumer.poll_once()
    state = consumer.view()
    assert (state["provider"], state["candidate"], state["version"]) == ("resend", "email.resend.pro", "1.1.0")


@pytest.mark.parametrize("status", [401, 404, 429, 500, 503])
def test_a_refusal_keeps_the_last_good_state_and_honours_retry_after(tmp_path, feed, mailpit, status):
    path = tmp_path / "openbinding.json"
    write_handoff(path, f"{feed.url}/feed")
    consumer = tool.Consumer(str(path), mailpit.url)
    feed.answers = [adopted("1.0.0", "email.brevo.professional", '"sha256-a"', "1"),
                    (status, {"Retry-After": "7"}, b'{"code": "x"}')]
    consumer.poll_once()
    consumer.poll_once()
    state = consumer.view()
    assert (state["provider"], state["etag"], state["lastStatus"]) == ("brevo", '"sha256-a"', status)
    assert state["lastError"] == f"the feed answered {status}"
    assert consumer.retry_after == 7.0


def test_an_unknown_provider_keeps_the_previous_one(tmp_path, feed, mailpit):
    path = tmp_path / "openbinding.json"
    write_handoff(path, f"{feed.url}/feed")
    consumer = tool.Consumer(str(path), mailpit.url)
    feed.answers = [adopted("1.0.0", "email.brevo.professional", '"a"', "1"), adopted("2.0.0", "email.carrierpigeon.x", '"b"', "2")]
    consumer.poll_once()
    consumer.poll_once()
    state = consumer.view()
    assert state["provider"] == "brevo" and state["candidate"] == "email.brevo.professional"
    assert "unknown e-mail provider" in state["lastError"]


def test_a_changed_handoff_is_used_on_the_next_poll(tmp_path, feed, mailpit):
    path = tmp_path / "openbinding.json"
    write_handoff(path, f"{feed.url}/feed")
    consumer = tool.Consumer(str(path), mailpit.url)
    feed.answers = [adopted("1.0.0", "email.brevo.professional", '"a"', "1")]
    consumer.poll_once()
    other = "obe_0badc0de_" + "1" * 56
    write_handoff(path, f"{feed.url}/other", other)
    consumer.poll_once()
    assert feed.requests[-1]["path"] == "/other" and feed.requests[-1]["headers"]["x-api-key"] == other
    # A new hand-off reads its feed afresh: no validator of the old one.
    assert "if-none-match" not in feed.requests[-1]["headers"]


@pytest.mark.parametrize("content", ["not json", json.dumps({"feedUrl": "http://x"}), json.dumps({"feedKey": KEY})])
def test_an_unreadable_handoff_is_said_without_its_text(tmp_path, feed, mailpit, content):
    path = tmp_path / "openbinding.json"
    path.write_text(content)
    consumer = tool.Consumer(str(path), mailpit.url)
    consumer.poll_once()
    state = consumer.view()
    assert state["status"] == "waiting_for_handoff" and state["lastError"].startswith("the hand-off file cannot be read")
    assert KEY not in json.dumps(state) and feed.requests == []


def test_send_posts_the_tags_and_headers_of_the_provider_in_force(tmp_path, feed, mailpit):
    path = tmp_path / "openbinding.json"
    write_handoff(path, f"{feed.url}/feed")
    consumer = tool.Consumer(str(path), mailpit.url + "/mailpit")
    feed.answers = [adopted("1.1.0", "email.resend.pro", '"b"', "2")]
    consumer.poll_once()
    status, body = consumer.send("someone@tomatometer.example")
    assert status == 200 and body["messageId"] == "msg-1" and body["provider"] == "resend"
    (request,) = mailpit.requests
    assert request["method"] == "POST" and request["path"] == "/mailpit/api/v1/send"
    message = json.loads(request["body"])
    assert message["Subject"] == "TomatoMeter daily summary"
    assert message["To"] == [{"Email": "someone@tomatometer.example"}]
    assert message["Tags"] == ["provider-resend", "adoption-2"]
    assert message["Headers"] == {
        "X-OpenBinding-Provider": "resend", "X-OpenBinding-Candidate": "email.resend.pro",
        "X-OpenBinding-Composition-Version": "1.1.0",
    }
    mailpit.answers = [(500, {}, b"")]
    assert consumer.send()[0] == 502


def test_the_http_interface(tmp_path, feed, mailpit):
    path = tmp_path / "openbinding.json"
    consumer = tool.Consumer(str(path), mailpit.url)
    server = ThreadingHTTPServer(("127.0.0.1", 0), tool.handler_for(consumer))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        state = tool.http_request("GET", f"{base}/state", {})
        assert state.status == 200 and json.loads(state.body)["status"] == "waiting_for_handoff"
        waiting = tool.http_request("POST", f"{base}/send", {"Content-Type": "application/json"}, b"{}")
        assert waiting.status == 409 and json.loads(waiting.body)["code"] == "waiting_for_handoff"
        bad = tool.http_request("POST", f"{base}/send", {"Content-Type": "application/json"}, b'{"to": 3}')
        assert bad.status == 422
        assert tool.http_request("GET", f"{base}/nothing", {}).status == 404
    finally:
        server.shutdown()
        server.server_close()


def test_the_key_is_never_logged(tmp_path, feed, mailpit, caplog):
    caplog.set_level(logging.DEBUG, logger="feed_consumer")
    path = tmp_path / "openbinding.json"
    write_handoff(path, f"{feed.url}/feed")
    consumer = tool.Consumer(str(path), mailpit.url)
    feed.answers = [adopted("1.0.0", "email.brevo.professional", '"a"', "1"), (401, {}, b"")]
    consumer.poll_once()
    consumer.poll_once()
    consumer.send()
    assert caplog.records and KEY not in caplog.text and KEY not in json.dumps(consumer.view())


def test_the_poller_survives_a_crash_and_stops(tmp_path, mailpit, monkeypatch):
    consumer = tool.Consumer(str(tmp_path / "missing.json"), mailpit.url)
    calls = []

    def boom():
        calls.append(1)
        raise RuntimeError("bad")

    monkeypatch.setattr(consumer, "poll_once", boom)
    stop = threading.Event()
    worker = threading.Thread(target=tool.run, args=(consumer, 0.01, stop))
    worker.start()
    while len(calls) < 3:
        stop.wait(0.01)
    stop.set()
    worker.join(2)
    assert not worker.is_alive() and consumer.view()["lastError"] == "the poll failed (RuntimeError)"


def test_it_imports_nothing_from_the_gateway():
    source = Path(tool.__file__).read_text(encoding="utf-8")
    imported = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imported |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert "openbinding_gateway" not in imported and "httpx" not in imported
    assert imported <= {"__future__", "json", "logging", "os", "threading", "time", "urllib", "dataclasses", "http",
                        "typing", "yaml"}
    assert urllib.request  # the standard library is what it talks HTTP with
