"""Tests for tools/flow_metrics.py, the O6 half: green days, flaky age, the page and the read-only client.

No network: the HTTP layer is injected. The fixtures are synthetic and API-shaped.
"""

import importlib.util
import json
import subprocess
import sys
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "tools" / "flow_metrics.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "flow_metrics" / "o6"
TOKEN = "placeholder-not-a-credential"
NOW = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)

spec = importlib.util.spec_from_file_location("flow_metrics", SCRIPT)
fm = importlib.util.module_from_spec(spec)
sys.modules["flow_metrics"] = fm
spec.loader.exec_module(fm)


def fixture(name):
    return (FIXTURES / name).read_bytes()


class FakeApi:
    """Answers the two run lists from the fixtures and records every request."""

    def __init__(self):
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append((url, headers))
        event = parse_qs(urlsplit(url).query)["event"][0]
        name = {"push": "runs_push.json", "workflow_dispatch": "runs_dispatch.json"}[event]
        return 200, {}, fixture(name)


def run_main(tmp_path, *extra, transport=None, env=None):
    out = tmp_path / "page.md"
    argv = [
        "--since", "2026-10-01", "--until", "2026-10-05", "--as-of", "2026-11-01",
        "--flaky", str(FIXTURES / "flaky.md"), "--output", str(out), *extra,
    ]
    api = transport or FakeApi()
    code = fm.main(argv, transport=api, env=env or {}, now=NOW)
    return code, (out.read_text() if out.exists() else ""), api


# [utest->req~flow-metrics-green-days~1]
def test_green_days_use_the_last_completed_run_and_ignore_cancelled_and_unfinished():
    runs = json.loads(fixture("runs_push.json"))["workflow_runs"]
    runs += json.loads(fixture("runs_dispatch.json"))["workflow_runs"]
    result = fm.green_days(runs, "2026-10-01", "2026-10-05")
    assert result["window_days"] == 5
    assert result["days_with_runs"] == 4
    assert result["green"] == 3
    assert result["days_without_runs"] == 1
    assert result["red_days"] == ["2026-10-03"]
    assert result["per_event"] == {"push": 5, "workflow_dispatch": 2}


# [utest->req~flow-metrics-green-days~1]
def test_a_day_with_only_cancelled_runs_is_not_a_day_with_runs():
    runs = [{"event": "push", "status": "completed", "conclusion": "cancelled", "created_at": "2026-10-01T01:00:00Z"}]
    result = fm.green_days(runs, "2026-10-01", "2026-10-01")
    assert result["days_with_runs"] == 0
    assert result["days_without_runs"] == 1


# [utest->req~flow-metrics-green-days~1]
def test_the_runs_are_requested_for_develop_ci_by_event_and_window():
    api = FakeApi()
    client = fm.Client(None, api)
    fm.fetch_runs(client, "o/r", "ci.yml", "develop", "push", "2026-10-01", "2026-10-05")
    url, _ = api.calls[0]
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    assert parts.hostname == "api.github.com"
    assert parts.path == "/repos/o/r/actions/workflows/ci.yml/runs"
    assert query["branch"] == ["develop"]
    assert query["event"] == ["push"]
    assert query["created"] == ["2026-10-01..2026-10-05"]


# [utest->req~flow-metrics-flaky-age~1]
def test_flaky_age_classifies_open_and_deselected_entries_and_leaves_out_the_not_counted():
    text = (FIXTURES / "flaky.md").read_text()
    result = fm.flaky_age(text, date(2026, 11, 1), {"E2", "E3"})
    assert result["older"] == ["E5"]
    assert result["within"] == ["E6", "E7"]
    assert result["unknown"] == ["E4"]
    assert result["left_out"] == ["E2", "E3"]


# [utest->req~flow-metrics-flaky-age~1]
def test_with_nothing_left_out_the_deselected_entries_count():
    text = (FIXTURES / "flaky.md").read_text()
    result = fm.flaky_age(text, date(2026, 11, 1), set())
    assert result["older"] == ["E2", "E5"]
    assert result["unknown"] == ["E3", "E4"]


# [utest->req~flow-metrics-page~1]
def test_the_page_shows_the_o6_figures_and_says_o7_is_not_measured_yet(tmp_path):
    code, page, _ = run_main(tmp_path)
    assert code == 0
    assert "Green days: 3 of 4 days with runs (75.0 %)" in page
    assert "Days without runs (left out of the count): 1 of 5" in page
    assert "Runs by event: push 5, workflow_dispatch 2" in page
    assert "older than 7 days: E5." in page
    assert "unknown date: E4." in page
    assert "`--not-counted`" in page and "E2, E3" in page
    assert "Not measured yet." in page


# [utest->req~flow-metrics-page~1]
def test_the_default_window_is_30_days_ending_yesterday_and_the_page_goes_to_stdout(capsys):
    code = fm.main(["--flaky", str(FIXTURES / "flaky.md")], transport=FakeApi(), env={}, now=NOW)
    assert code == 0
    assert "window 2026-10-02 to 2026-10-31 (UTC) · as of 2026-11-01" in capsys.readouterr().out


# [utest->req~flow-metrics-page~1]
def test_a_failed_request_gives_a_nonzero_exit_and_no_page(tmp_path):
    code, page, _ = run_main(tmp_path, transport=lambda url, headers: (500, {}, b""))
    assert code == 1
    assert page == ""


# [utest->req~flow-metrics-read-only~1]
def test_the_token_is_sent_from_the_environment_and_never_printed(tmp_path, capsys):
    code, page, api = run_main(tmp_path, env={"GITHUB_TOKEN": TOKEN})
    assert code == 0
    assert all(TOKEN in headers["Authorization"] for _, headers in api.calls)
    captured = capsys.readouterr()
    assert TOKEN not in page + captured.out + captured.err


# [utest->req~flow-metrics-read-only~1]
def test_gh_token_wins_over_github_token_and_no_token_means_no_authorization_header():
    assert fm.token_from_env({"GH_TOKEN": "first", "GITHUB_TOKEN": "second"}) == "first"
    assert fm.token_from_env({}) is None
    api = FakeApi()
    fm.fetch_runs(fm.Client(None, api), "o/r", "ci.yml", "develop", "push", "2026-10-01", "2026-10-05")
    assert "Authorization" not in api.calls[0][1]


# [utest->req~flow-metrics-read-only~1]
def test_pagination_follows_the_link_header_on_the_api_host():
    seen = []

    def transport(url, headers):
        seen.append(url)
        if len(seen) == 1:
            nxt = "https://api.github.com/repos/o/r/actions/workflows/ci.yml/runs?page=2"
            return 200, {"Link": f'<{nxt}>; rel="next", <{nxt}>; rel="last"'}, b'{"total_count": 2, "workflow_runs": [{"id": 1}]}'
        return 200, {}, b'{"total_count": 2, "workflow_runs": [{"id": 2}]}'

    runs, truncated = fm.fetch_runs(fm.Client(None, transport), "o/r", "ci.yml", "develop", "push", "2026-10-01", "2026-10-05")
    assert [r["id"] for r in runs] == [1, 2]
    assert len(seen) == 2
    assert not truncated


# [utest->req~flow-metrics-read-only~1]
def test_a_link_to_another_host_is_not_followed():
    seen = []

    def transport(url, headers):
        seen.append(url)
        return 200, {"Link": '<https://example.invalid/steal>; rel="next"'}, b'{"total_count": 9, "workflow_runs": []}'

    with pytest.raises(fm.FlowMetricsError):
        fm.fetch_runs(fm.Client(TOKEN, transport), "o/r", "ci.yml", "develop", "push", "2026-10-01", "2026-10-05")
    assert len(seen) == 1


# [utest->req~flow-metrics-read-only~1]
@pytest.mark.parametrize(
    "url",
    [
        "http://api.github.com/x",
        "https://api.github.com.example.invalid/x",
        "https://user@example.invalid/x",
        "https://api.github.com:8443/x",
    ],
)
def test_check_url_accepts_only_https_api_github_com(url):
    with pytest.raises(fm.FlowMetricsError):
        fm.check_url(url)
    fm.check_url("https://api.github.com/repos/o/r")


# [utest->req~flow-metrics-read-only~1]
def test_a_redirect_answer_is_refused():
    def transport(url, headers):
        return 302, {"Location": "https://example.invalid/"}, b""

    with pytest.raises(fm.FlowMetricsError):
        list(fm.Client(TOKEN, transport).get_pages("https://api.github.com/repos/o/r"))
    with pytest.raises(fm.FlowMetricsError):
        fm._NoRedirect().redirect_request(None, None, 301, "Moved", {}, "https://example.invalid/")


# [utest->req~flow-metrics-read-only~1]
def test_the_default_transport_sends_only_get(monkeypatch):
    methods = []

    class Response:
        status = 200
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return b"{}"

    class Opener:
        def open(self, request, timeout=None):
            methods.append(request.get_method())
            return Response()

    monkeypatch.setattr(urllib.request, "build_opener", lambda *handlers: Opener())
    status, _, body = fm.default_transport("https://api.github.com/repos/o/r", {})
    assert (status, body) == (200, b"{}")
    assert methods == ["GET"]


# [utest->req~flow-metrics-read-only~1]
def test_the_tool_runs_with_the_standard_library_alone():
    result = subprocess.run([sys.executable, "-I", str(SCRIPT), "--help"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    for flag in ("--repo", "--since", "--until", "--flaky", "--not-counted", "--as-of", "--output"):
        assert flag in result.stdout
