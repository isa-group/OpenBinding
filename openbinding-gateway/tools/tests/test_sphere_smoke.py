"""sphere_smoke: arguments, exit 0 on the recorded set, non-zero on a scripted ETag or contentHash mismatch (offline)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

TESTS = Path(__file__).resolve().parents[2] / "tests"
if str(TESTS) not in sys.path:
    sys.path.insert(0, str(TESTS))

import sphere_smoke as tool  # noqa: E402
from sphere_recorded import SFX, RecordedSphere  # noqa: E402

TOMATO = "6ab0a323697330667ccce8cd"
MAILGUN = "6ade364540e55445692b0eda"


@pytest.fixture
def recorded(monkeypatch) -> RecordedSphere:
    from openbinding_gateway.core import outbound

    sphere = RecordedSphere()
    monkeypatch.setattr(outbound, "_getaddrinfo", lambda host, port: sphere.getaddrinfo(host, port))
    return sphere


def test_the_recorded_set_passes(recorded: RecordedSphere, capsys) -> None:
    assert tool.main(["--json"], transport=recorded.transport()) == 0
    checks = json.loads(capsys.readouterr().out)
    assert {c["name"] for c in checks} == {
        "yaml_matches_etag", "functional_hash_matches_content_hash", "permalink_and_organization",
        "revalidation_304", "rate_limit_headers",
    }
    assert {c["family"] for c in checks} == {TOMATO, MAILGUN}
    assert all(c["ok"] for c in checks)
    # GET only, anonymous.
    assert {r.method for r in recorded.requests} == {"GET"}
    assert not any("x-api-key" in r.headers for r in recorded.requests)


def test_a_wrong_etag_fails(recorded: RecordedSphere) -> None:
    recorded.wrong_etag(f"/api/v1/public/pricings/{TOMATO}/versions/")
    assert tool.main(["--family", TOMATO], transport=recorded.transport()) == 2


def test_a_content_hash_mismatch_fails(recorded: RecordedSphere) -> None:
    manifest = json.loads((SFX / TOMATO / "manifest.json").read_text())
    manifest["versions"][0]["contentHash"] = "0" * 64
    recorded.serve(f"/api/v1/public/pricings/{TOMATO}", json.dumps(manifest).encode(),
                   {"content-type": "application/json", "etag": '"x"', "ratelimit-limit": "300"})
    assert tool.main(["--family", TOMATO], transport=recorded.transport()) == 1


@pytest.mark.parametrize("argv", [["--url", "http://sphere.score.us.es"], ["--family", "../users/me"]])
def test_bad_arguments(argv: list[str]) -> None:
    assert tool.main(argv) == 2
