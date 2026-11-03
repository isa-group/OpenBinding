#!/usr/bin/env python3
"""Flow metrics of the develop branch (INTENT O6), read from the GitHub REST API.

Read-only and stdlib-only. Every request is a GET to https://api.github.com, including the pages that a Link header
points to. Redirects are refused. The token, when there is one, comes only from GH_TOKEN or GITHUB_TOKEN and is never
printed or written to the page.

O6 has two halves: the share of UTC days on which the last completed run of ci.yml on develop was green, and the age of
the open or deselected entries of the flaky register. O7 is not measured yet.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

API_HOST = "api.github.com"
DEFAULT_REPO = "isa-group/OpenBinding"
DEFAULT_WORKFLOW = "ci.yml"
DEFAULT_BRANCH = "develop"
DEFAULT_FLAKY = "docs/qa/FLAKY_TESTS.md"
DEFAULT_NOT_COUNTED = "E2,E3"
DEFAULT_WINDOW_DAYS = 30
EVENTS = ("push", "workflow_dispatch")
IGNORED_CONCLUSIONS = ("cancelled", "skipped")
FLAKY_LIMIT_DAYS = 7
RESULT_CAP = 1000
MAX_PAGES = 50


class FlowMetricsError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise FlowMetricsError(f"redirect refused (HTTP {code})")


def default_transport(url, headers):
    """GET url and return (status, headers, body). Redirects raise FlowMetricsError."""
    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with opener.open(request, timeout=30) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), b""
    except urllib.error.URLError as err:
        raise FlowMetricsError(f"request failed: {err.reason}") from None


def check_url(url):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.hostname != API_HOST or parts.port not in (None, 443):
        raise FlowMetricsError(f"refusing a URL outside https://{API_HOST}")


def token_from_env(env=None):
    env = os.environ if env is None else env
    return env.get("GH_TOKEN") or env.get("GITHUB_TOKEN") or None


def next_link(link_header):
    for part in (link_header or "").split(","):
        match = re.match(r'\s*<([^>]*)>\s*;\s*rel="?next"?', part)
        if match:
            return match.group(1)
    return None


class Client:
    def __init__(self, token=None, transport=default_transport):
        self._token = token
        self._transport = transport

    def get_pages(self, url):
        """Yield the decoded JSON body of url and of every page its Link header names."""
        for _ in range(MAX_PAGES):
            check_url(url)
            headers = {"Accept": "application/vnd.github+json", "User-Agent": "openbinding-flow-metrics"}
            if self._token:
                headers["Authorization"] = "Bearer " + self._token
            status, response_headers, body = self._transport(url, headers)
            if 300 <= status < 400:
                raise FlowMetricsError(f"redirect refused (HTTP {status})")
            if status != 200:
                raise FlowMetricsError(f"GET {urllib.parse.urlsplit(url).path} answered HTTP {status}")
            yield json.loads(body)
            link = {k.lower(): v for k, v in response_headers.items()}.get("link")
            url = next_link(link)
            if not url:
                return
        raise FlowMetricsError("too many pages")


def fetch_runs(client, repo, workflow, branch, event, since, until):
    """Return (runs, truncated) for one event over the window [since, until]."""
    query = urllib.parse.urlencode(
        {"branch": branch, "event": event, "created": f"{since}..{until}", "per_page": 100}
    )
    url = f"https://{API_HOST}/repos/{repo}/actions/workflows/{workflow}/runs?{query}"
    runs, total = [], 0
    for page in client.get_pages(url):
        total = page.get("total_count", total)
        runs.extend(page.get("workflow_runs", []))
    return runs, total > len(runs) or len(runs) >= RESULT_CAP


def green_days(runs, since, until):
    """O6 green days. runs: dicts with event, status, conclusion and created_at (ISO, UTC)."""
    counted = [
        r for r in runs
        if r.get("status") == "completed" and r.get("conclusion") not in IGNORED_CONCLUSIONS
    ]
    last = {}
    for run in sorted(counted, key=lambda r: r["created_at"]):
        last[run["created_at"][:10]] = run.get("conclusion")
    window = (date.fromisoformat(until) - date.fromisoformat(since)).days + 1
    green = sorted(day for day, conclusion in last.items() if conclusion == "success")
    per_event = {}
    for run in runs:
        per_event[run.get("event")] = per_event.get(run.get("event"), 0) + 1
    return {
        "window_days": window,
        "days_with_runs": len(last),
        "green": len(green),
        "days_without_runs": window - len(last),
        "red_days": sorted(day for day, c in last.items() if c != "success"),
        "per_event": per_event,
    }


def flaky_age(text, as_of, not_counted):
    """Classify open or deselected register rows as older, within or unknown."""
    result = {"older": [], "within": [], "unknown": [], "left_out": sorted(not_counted)}
    for line in text.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4 or not re.fullmatch(r"E\d+", cells[0]):
            continue
        entry, seen, status = cells[0], cells[2], cells[3].lower()
        if not status.startswith(("open", "deselected")) or entry in not_counted:
            continue
        match = re.match(r"\d{4}-\d{2}-\d{2}", seen)
        if not match:
            result["unknown"].append(entry)
        elif (as_of - date.fromisoformat(match.group(0))).days > FLAKY_LIMIT_DAYS:
            result["older"].append(entry)
        else:
            result["within"].append(entry)
    return result


def render(repo, since, until, as_of, green, flaky):
    def ids(items):
        return ", ".join(items) if items else "none"

    counts = ", ".join(f"{e} {green['per_event'].get(e, 0)}" for e in EVENTS)
    share = f"{100 * green['green'] / green['days_with_runs']:.1f} %" if green["days_with_runs"] else "n/a"
    lines = [
        "# Flow metrics",
        "",
        f"Repository: `{repo}` · branch `{DEFAULT_BRANCH}` · window {since} to {until} (UTC) · as of {as_of}",
        "",
        "## O6, platform reliability",
        "",
        f"- Green days: {green['green']} of {green['days_with_runs']} days with runs ({share}). Target: 95 % or more.",
        f"- Days without runs (left out of the count): {green['days_without_runs']} of {green['window_days']}.",
        f"- Days not green: {ids(green['red_days'])}.",
        f"- Runs by event: {counts}. Cancelled and skipped runs are ignored.",
        f"- Flaky entries older than {FLAKY_LIMIT_DAYS} days: {ids(flaky['older'])}.",
        f"- Flaky entries within {FLAKY_LIMIT_DAYS} days: {ids(flaky['within'])}.",
        f"- Flaky entries with an unknown date: {ids(flaky['unknown'])}.",
        f"- Left out of the count (`--not-counted`, decision `crp-flaky-b8-classification`): {ids(flaky['left_out'])}.",
        "",
        "## O7, delivery flow",
        "",
        "Not measured yet.",
        "",
        "Regenerate: `python3 tools/flow_metrics.py --since DATE --until DATE --output docs/qa/FLOW_METRICS.md`.",
        "",
    ]
    return "\n".join(lines)


def parse_args(argv):
    parser = argparse.ArgumentParser(description="O6 flow metrics of develop, read from the GitHub REST API (GET only).")
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--since", help="first UTC day, YYYY-MM-DD (default: 30 days ending yesterday)")
    parser.add_argument("--until", help="last UTC day, YYYY-MM-DD (default: yesterday)")
    parser.add_argument("--flaky", default=DEFAULT_FLAKY, help="flaky register (default: %(default)s)")
    parser.add_argument("--not-counted", default=DEFAULT_NOT_COUNTED, help="register ids left out of O6 (default: %(default)s)")
    parser.add_argument("--as-of", help="UTC day the flaky age is measured on (default: today)")
    parser.add_argument("--output", help="write the page here (default: stdout)")
    return parser.parse_args(argv)


def main(argv=None, transport=default_transport, env=None, now=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    today = (now or datetime.now(timezone.utc)).date()
    try:
        until = date.fromisoformat(args.until) if args.until else today - timedelta(days=1)
        since = date.fromisoformat(args.since) if args.since else until - timedelta(days=DEFAULT_WINDOW_DAYS - 1)
        as_of = date.fromisoformat(args.as_of) if args.as_of else today
    except ValueError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    if since > until:
        print("error: --since is after --until", file=sys.stderr)
        return 2
    not_counted = {x.strip() for x in args.not_counted.split(",") if x.strip()}
    try:
        with open(args.flaky, encoding="utf-8") as handle:
            register = handle.read()
        client = Client(token_from_env(env), transport)
        runs = []
        for event in EVENTS:
            got, truncated = fetch_runs(client, args.repo, DEFAULT_WORKFLOW, DEFAULT_BRANCH, event, since, until)
            runs.extend(got)
            if truncated:
                print(f"warning: the API returned a capped list of {event} runs; the figures may be incomplete", file=sys.stderr)
    except (FlowMetricsError, OSError, ValueError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    page = render(
        args.repo, since, until, as_of,
        green_days(runs, since.isoformat(), until.isoformat()),
        flaky_age(register, as_of, not_counted),
    )
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(page)
    else:
        sys.stdout.write(page)
    return 0


if __name__ == "__main__":
    sys.exit(main())
