#!/usr/bin/env python3
"""The lab's stand-in for TomatoMeter: it follows one composition environment's feed and mails through its provider.

It plays the application's side of the feed contract (``docs/COMPOSITION2YAML.md`` §16), so it knows only what is
published: it imports nothing from ``openbinding_gateway`` and needs the standard library and PyYAML alone.

* **The hand-off.** ``FEED_HANDOFF`` (``/handoff/openbinding.json``, written by ``tools/seed_lab.py`` into the
  ``lab-handoff`` volume) names the feed's address and key. The consumer starts without it and re-reads it on every
  poll: while it is missing or unreadable ``GET /state`` says ``waiting_for_handoff`` (and stays healthy), and a
  changed file (a re-seed) is used on the next poll.
* **The feed.** Every ``FEED_POLL_S`` seconds (3 in the lab; 30 is the recommended interval) it reads the feed with
  ``X-API-Key`` and ``If-None-Match``. A 200 is parsed with ``yaml.safe_load``; the e-mail provider is the second
  dot segment of ``binding.dailySummary.candidate`` (``email.<provider>.<plan>``), and an unknown provider keeps the
  previous one. A 304 keeps the state; any other answer keeps the last good state, records the status and honours
  ``Retry-After``. The key is never logged nor shown.
* **Sending.** ``POST /send {to?}`` posts the daily summary to Mailpit's ``POST /api/v1/send`` (``MAILPIT_URL``),
  tagged ``provider-<provider>`` and ``adoption-<n>`` and with the headers ``X-OpenBinding-Provider``,
  ``X-OpenBinding-Candidate`` and ``X-OpenBinding-Composition-Version``, so a reader of Mailpit sees which provider
  the composition in effect chose. TomatoMeter's real e-mail providers are never called.

HTTP on ``FEED_CONSUMER_PORT`` (8090), inside the lab's network only: ``GET /state`` and ``POST /send``.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

import yaml

logger = logging.getLogger("feed_consumer")

#: The e-mail providers TomatoMeter can send through (the second segment of a candidate id).
KNOWN_PROVIDERS = frozenset({"brevo", "mailgun", "postmark", "resend", "sendgrid", "selfhosted"})
SUBJECT = "TomatoMeter daily summary"
SENDER = {"Email": "daily-summary@tomatometer.example", "Name": "TomatoMeter"}
DEFAULT_RECIPIENT = "lab-user@tomatometer.example"
WAITING = "waiting_for_handoff"
FOLLOWING = "following"
REQUEST_TIMEOUT_S = 10.0


@dataclass
class State:
    """What ``GET /state`` answers: never the key."""

    status: str = WAITING
    provider: str | None = None
    candidate: str | None = None
    version: str | None = None
    adoption: str | None = None
    etag: str | None = None
    feedUrl: str | None = None
    lastStatus: int | None = None
    lastError: str | None = None
    polls: int = 0
    sent: int = 0
    updatedAt: float | None = None


@dataclass
class Handoff:
    feed_url: str
    key: str


@dataclass
class Answer:
    status: int
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""


def http_request(method: str, url: str, headers: dict[str, str], body: bytes | None = None) -> Answer:
    """One HTTP request with the standard library: every status is an answer, never an exception."""
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:  # noqa: S310 - lab URLs
            return Answer(response.status, {k.lower(): v for k, v in response.headers.items()}, response.read())
    except urllib.error.HTTPError as error:
        return Answer(error.code, {k.lower(): v for k, v in (error.headers or {}).items()}, error.read() or b"")


class Consumer:
    """The feed's state and the two actions, with the transport, the clock and the hand-off path injectable."""

    def __init__(
        self,
        handoff_path: str,
        mailpit_url: str,
        *,
        request: Callable[..., Answer] = http_request,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.handoff_path = handoff_path
        self.mailpit_url = mailpit_url.rstrip("/")
        self.request = request
        self.clock = clock
        self.state = State()
        self.lock = threading.Lock()
        self._handoff: Handoff | None = None
        #: Seconds the next poll must wait at least (a ``Retry-After``).
        self.retry_after: float = 0.0

    # -- the hand-off --------------------------------------------------------------------------------------

    def read_handoff(self) -> Handoff | None:
        try:
            with open(self.handoff_path, encoding="utf-8") as handle:
                document = json.load(handle)
            feed_url, key = document["feedUrl"], document["feedKey"]
            if not (isinstance(feed_url, str) and isinstance(key, str) and feed_url and key):
                raise ValueError("feedUrl and feedKey must be strings")
        except FileNotFoundError:
            self._wait("the hand-off file is not there yet")
            return None
        except (OSError, ValueError, KeyError, TypeError) as error:
            # Never the file's text: it holds the key.
            self._wait(f"the hand-off file cannot be read ({type(error).__name__})")
            return None
        found = Handoff(feed_url, key)
        if self._handoff is None or found != self._handoff:
            # A new hand-off (a re-seed): its feed is read afresh.
            with self.lock:
                self.state.etag = None
                self.state.feedUrl = feed_url
        self._handoff = found
        return found

    def _wait(self, reason: str) -> None:
        with self.lock:
            if self.state.provider is None:
                self.state.status = WAITING
            self.state.lastError = reason
            self.state.updatedAt = self.clock()

    # -- the feed ------------------------------------------------------------------------------------------

    def poll_once(self) -> None:
        handoff = self.read_handoff()
        if handoff is None:
            return
        headers = {"X-API-Key": handoff.key, "Accept": "application/yaml"}
        if self.state.etag:
            headers["If-None-Match"] = self.state.etag
        try:
            answer = self.request("GET", handoff.feed_url, headers)
        except (OSError, urllib.error.URLError) as error:
            self._failed(None, f"the feed cannot be reached ({type(error).__name__})")
            return
        self.retry_after = 0.0
        with self.lock:
            self.state.polls += 1
            self.state.lastStatus = answer.status
            self.state.updatedAt = self.clock()
        if answer.status == 304:
            return
        if answer.status != 200:
            retry = answer.headers.get("retry-after")
            if retry and retry.isdigit():
                self.retry_after = float(retry)
            self._failed(answer.status, f"the feed answered {answer.status}")
            return
        self._adopted(answer)

    def _adopted(self, answer: Answer) -> None:
        try:
            document = yaml.safe_load(answer.body.decode("utf-8"))
            candidate = document["binding"]["dailySummary"]["candidate"]
            if not isinstance(candidate, str):
                raise TypeError("the candidate is not a string")
        except (UnicodeDecodeError, yaml.YAMLError, KeyError, TypeError) as error:
            self._failed(200, f"the feed's document has no e-mail candidate ({type(error).__name__})")
            return
        parts = candidate.split(".")
        provider = parts[1] if len(parts) >= 3 else None
        with self.lock:
            self.state.etag = answer.headers.get("etag")
            self.state.version = answer.headers.get("openbinding-composition-version")
            self.state.adoption = answer.headers.get("openbinding-adoption")
            if provider not in KNOWN_PROVIDERS:
                # Keep sending through the provider in force: the composition names one this application lacks.
                self.state.lastError = f"unknown e-mail provider in {candidate}"
                if self.state.provider is None:
                    self.state.status = WAITING
                return
            self.state.status = FOLLOWING
            self.state.lastError = None
            if candidate != self.state.candidate:
                logger.info("feed: the e-mail provider is now %s (version %s)", provider, self.state.version)
            self.state.candidate = candidate
            self.state.provider = provider

    def _failed(self, status: int | None, reason: str) -> None:
        logger.warning("feed: %s; keeping the last good state", reason)
        with self.lock:
            self.state.lastError = reason
            self.state.updatedAt = self.clock()

    # -- sending -------------------------------------------------------------------------------------------

    def send(self, to: str | None = None) -> tuple[int, dict[str, Any]]:
        with self.lock:
            snapshot = State(**asdict(self.state))
        if snapshot.provider is None:
            return 409, {"code": WAITING, "error": "No composition is followed yet."}
        message = {
            "From": SENDER,
            "To": [{"Email": to or DEFAULT_RECIPIENT}],
            "Subject": SUBJECT,
            "Text": (
                f"Your pomodoros of today. Sent through {snapshot.provider} ({snapshot.candidate}), as composition "
                f"version {snapshot.version} (adoption #{snapshot.adoption}) says."
            ),
            "Tags": [f"provider-{snapshot.provider}", f"adoption-{snapshot.adoption}"],
            "Headers": {
                "X-OpenBinding-Provider": snapshot.provider,
                "X-OpenBinding-Candidate": snapshot.candidate or "",
                "X-OpenBinding-Composition-Version": snapshot.version or "",
            },
        }
        try:
            answer = self.request(
                "POST", f"{self.mailpit_url}/api/v1/send", {"Content-Type": "application/json"},
                json.dumps(message).encode("utf-8"),
            )
        except (OSError, urllib.error.URLError) as error:
            return 502, {"code": "mail_unavailable", "error": f"Mailpit cannot be reached ({type(error).__name__})."}
        if answer.status != 200:
            return 502, {"code": "mail_refused", "error": f"Mailpit answered {answer.status}."}
        try:
            identifier = json.loads(answer.body or b"{}").get("ID")
        except json.JSONDecodeError:
            identifier = None
        with self.lock:
            self.state.sent += 1
        logger.info("sent the daily summary through %s", snapshot.provider)
        return 200, {"status": "sent", "provider": snapshot.provider, "candidate": snapshot.candidate,
                     "version": snapshot.version, "adoption": snapshot.adoption, "messageId": identifier}

    def view(self) -> dict[str, Any]:
        with self.lock:
            return asdict(self.state)


def handler_for(consumer: Consumer) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "feed-consumer"

        def _answer(self, status: int, body: dict[str, Any]) -> None:
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802 - http.server's name
            if self.path.split("?")[0] == "/state":
                self._answer(200, consumer.view())
            else:
                self._answer(404, {"code": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path.split("?")[0] != "/send":
                self._answer(404, {"code": "not_found"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(min(length, 4096)) if length else b""
            try:
                payload = json.loads(raw) if raw else {}
                to = payload.get("to") if isinstance(payload, dict) else None
                if to is not None and not (isinstance(to, str) and "@" in to and len(to) <= 254):
                    raise ValueError
            except ValueError:
                self._answer(422, {"code": "invalid_request", "error": "Send {\"to\": \"<address>\"} or nothing."})
                return
            status, body = consumer.send(to)
            self._answer(status, body)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - the base class's name
            logger.debug("http: " + format, *args)

    return Handler


def run(consumer: Consumer, poll_s: float, stop: threading.Event) -> None:
    """Poll until ``stop``: every ``poll_s`` seconds, or later after a ``Retry-After``."""
    while not stop.is_set():
        try:
            consumer.poll_once()
        except Exception as error:  # noqa: BLE001 - the poller never dies; it keeps the last good state
            consumer._failed(None, f"the poll failed ({type(error).__name__})")
        stop.wait(max(poll_s, consumer.retry_after))


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    consumer = Consumer(
        os.environ.get("FEED_HANDOFF", "/handoff/openbinding.json"),
        os.environ.get("MAILPIT_URL", "http://mailpit:8025/mailpit"),
    )
    poll_s = float(os.environ.get("FEED_POLL_S", "3"))
    port = int(os.environ.get("FEED_CONSUMER_PORT", "8090"))
    stop = threading.Event()
    poller = threading.Thread(target=run, args=(consumer, poll_s, stop), name="feed-poller", daemon=True)
    poller.start()
    server = ThreadingHTTPServer(("0.0.0.0", port), handler_for(consumer))  # noqa: S104 - the lab network only
    logger.info("feed consumer on :%s, polling every %ss", port, poll_s)
    try:
        server.serve_forever()
    finally:
        stop.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
