#!/usr/bin/env python3
"""Record the SPHERE answers the gateway tests read offline (``tests/fixtures/sphere``).

This is the only tool of the repository that reads SPHERE over the network, and it is run by hand:
anonymous, GET only, a generic user agent, honouring ``RateLimit-*`` and ``Retry-After``. It imports
nothing of the gateway, so it runs with any Python 3.11.

    python tools/record_sphere_fixtures.py            # record what is missing; refuse to overwrite a changed file
    python tools/record_sphere_fixtures.py --update   # overwrite changed files
    python tools/record_sphere_fixtures.py --check    # report drift against the live API, write nothing
    python tools/record_sphere_fixtures.py --check-readme   # offline: the README and routes.json match the files

Every answer is stored with the headers the tests need (``ETag``, ``Cache-Control``, ``Vary``, ``RateLimit-*``)
and listed in ``routes.json`` by path and query, which is what ``tests/sphere_recorded.py`` serves. The
``derived/`` files are synthetic and generated here from recorded files (see the README).

The recorded pricings belong to their SPHERE authors; they are kept for the repository's tests only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://sphere.score.us.es"
API = "/api/v1"
USER_AGENT = "pricing-fixture-recorder/1"
FETCHED = "2026-11-18"
ROOT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "sphere"
KEPT_HEADERS = (
    "content-type",
    "etag",
    "cache-control",
    "vary",
    "ratelimit-limit",
    "ratelimit-remaining",
    "ratelimit-reset",
)
#: Headers that change on every request and are left out of the drift check.
VOLATILE = {"ratelimit-remaining", "ratelimit-reset"}

#: pricingId -> (set, which versions: "all" | "latest" | a list of version ids).
FAMILIES: dict[str, tuple[str, object]] = {
    "6ab0a323697330667ccce8cd": ("TomatoMeter (sphere)", "all"),
    "6adf1a6240e55445692b6f14": ("email set B: SendGrid (danruilop1)", "all"),
    "6ade364540e55445692b0eda": ("email set B: Mailgun (danruilop1)", "all"),
    "6ade2d4440e55445692b07f1": ("email set B: Brevo (danruilop1)", "all"),
    "6ade2d2540e55445692b07c6": ("email set B: Resend (danruilop1)", "all"),
    "6ade2f3b40e55445692b09aa": ("email set B: Postmark (danruilop1)", "all"),
    "6ade2ef740e55445692b094f": ("sendgrid@rapidapi (danruilop1)", "all"),
    "6ae0772d40e55445692c0143": ("email set A: SendGrid (danvelcam)", "all"),
    "6ae077ac40e55445692c01ce": ("email set A: Mailgun (danvelcam)", "all"),
    "6ae0768440e55445692c0081": ("email set A: Brevo (danvelcam)", "all"),
    "6ae076f340e55445692c0101": ("email set A: Resend (danvelcam)", "all"),
    "6ae0776f40e55445692c018c": ("email set A: Postmark (danvelcam)", "all"),
    "6ab0a323697330667cccea11": ("Resend (sphere), ambiguous owner/name", "all"),
    "6ab0a323697330667ccce8e9": ("Resend (sphere), ambiguous owner/name", "all"),
    "6ab0a323697330667ccce9c1": ("Dropbox USD (atenea)", "all"),
    "6ab0a323697330667cccea2d": ("Dropbox EUR (atenea)", "all"),
    "6ab0a323697330667ccce93d": ("Dropbox (atenea), latest 2.1", "all"),
    "6ab0a323697330667ccce9d9": ("Dropbox (atenea)", "latest"),
    "6ab0a323697330667ccce891": ("OpenBinding", ["6ada6dbd4b2b5b01c587d17f"]),
}

#: Discovery answers (``GET /api/v1/pricings``), as the gateway asks for them.
SEARCHES: list[dict[str, str]] = [
    {"name": "Mailgun", "limit": "24", "offset": "0"},
    {"name": "resend", "limit": "24", "offset": "0"},
    {"name": "Dropbox", "limit": "24", "offset": "0"},
    {"name": "sendgrid", "limit": "24", "offset": "0"},
    {"name": "tomatometer", "limit": "24", "offset": "0"},
    {"name": "twilio-sendgrid-email-api", "limit": "24", "offset": "0"},
    {"name": "twilio sendgrid email api", "limit": "24", "offset": "0"},
    {"name": "sendgridrapidapi", "limit": "24", "offset": "0"},
    {"name": "nosuchpricing", "limit": "24", "offset": "0"},
    {"collection": "email-apis-pricing-intelligence", "limit": "24", "offset": "0"},
    {"limit": "24", "offset": "0", "sort": "asc", "sortBy": "minPrice"},
    {"limit": "24", "min-minPrice": "10", "name": "Mailgun", "offset": "0"},
]

#: ``GET /api/v1/orgs/public?q=`` answers (non-personal organizations only).
PUBLIC_ORG_QUERIES = ["sphere", "danruilop1", "danvelcam", "atenea", "nobody"]


class Recorder:
    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.routes: dict[str, dict[str, str]] = {}
        self.drift: list[str] = []
        self.refused: list[str] = []
        self.written: list[str] = []

    # -- network --------------------------------------------------------------------------------------------------

    def get(self, path: str, query: dict[str, str] | None = None) -> tuple[bytes, dict[str, str]]:
        url = BASE + path + ("?" + urllib.parse.urlencode(sorted((query or {}).items())) if query else "")
        for _ in range(5):
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
            try:
                with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310 - fixed https base
                    body = response.read()
                    headers = {k.lower(): v for k, v in response.headers.items()}
            except urllib.error.HTTPError as exc:
                if exc.code == 429:
                    time.sleep(min(int(exc.headers.get("Retry-After", "10") or 10), 60))
                    continue
                raise
            remaining = headers.get("ratelimit-remaining")
            if remaining is not None and remaining.isdigit() and int(remaining) < 20:
                time.sleep(min(int(headers.get("ratelimit-reset", "10") or 10), 60))
            return body, {k: headers[k] for k in KEPT_HEADERS if k in headers}
        raise RuntimeError(f"SPHERE kept answering 429 for {path}")

    # -- files ----------------------------------------------------------------------------------------------------

    def keep(self, path: str, query: dict[str, str] | None, relative: str) -> bytes:
        body, headers = self.get(path, query)
        key = route_key(path, query)
        self.routes[key] = {"file": relative, "headers": headers_name(relative)}
        self._store(relative, body)
        self._store(headers_name(relative), (json.dumps(headers, indent=2, sort_keys=True) + "\n").encode(), headers=True)
        return body

    def _store(self, relative: str, content: bytes, *, headers: bool = False) -> None:
        target = ROOT / relative
        if target.exists():
            current = target.read_bytes()
            same = current == content
            if headers and not same:
                same = _stable(current) == _stable(content)
            if same:
                return
            if self.mode == "check":
                self.drift.append(relative)
                return
            if self.mode != "update":
                self.refused.append(relative)
                return
        elif self.mode == "check":
            self.drift.append(f"{relative} (missing)")
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        self.written.append(relative)

    # -- the set --------------------------------------------------------------------------------------------------

    def record(self) -> None:
        organizations: set[str] = set()
        for pricing_id, (_, wanted) in FAMILIES.items():
            manifest = json.loads(self.keep(f"{API}/public/pricings/{pricing_id}", None, f"{pricing_id}/manifest.json"))
            if wanted == "all":
                versions = [entry["versionId"] for entry in manifest["versions"]]
            elif wanted == "latest":
                versions = [manifest["latestVersionId"]]
            else:
                versions = list(wanted)  # type: ignore[arg-type]
            for version_id in versions:
                self.keep(
                    f"{API}/public/pricings/{pricing_id}/versions/{version_id}/yaml", None, f"{pricing_id}/{version_id}.yml"
                )
            permalink = json.loads(self.keep(f"{API}/permalinks/pricing/{pricing_id}", None, f"permalinks/{pricing_id}.json"))
            organizations.add(permalink["location"].split("/")[2])
        for organization_id in sorted(organizations):
            self.keep(f"{API}/orgs/{organization_id}", None, f"orgs/{organization_id}.json")
            offset = 0
            for page in range(20):
                query = {"limit": "24", "offset": str(offset)}
                answer = json.loads(
                    self.keep(f"{API}/pricings/{organization_id}", query, f"org-pricings/{organization_id}.{page}.json")
                )
                offset += 24
                if offset >= int(answer.get("total", 0)):
                    break
        for query in SEARCHES:
            self.keep(f"{API}/pricings", query, f"search/{slug(query)}.json")
        for q in PUBLIC_ORG_QUERIES:
            self.keep(f"{API}/orgs/public", {"q": q}, f"orgs-public/{q}.json")
        self.derive()
        self._store("routes.json", (json.dumps(self.routes, indent=2, sort_keys=True) + "\n").encode())
        self._store("README.md", readme(self.routes).encode())

    def derive(self) -> None:
        """The synthetic cases, built from recorded files (never fetched)."""
        mailgun = "6ade364540e55445692b0eda"
        manifest = json.loads((ROOT / mailgun / "manifest.json").read_text())
        version = manifest["latestVersionId"]
        source = (ROOT / mailgun / f"{version}.yml").read_text(encoding="utf-8")
        renamed = re.sub(r"^saasName:.*$", "saasName: Mailgun Renamed", source, count=1, flags=re.M)
        self._store("derived/mailgun-renamed.yml", renamed.encode())
        scale = _change_scale_limit(source)
        self._store("derived/mailgun-scale.yml", scale.encode())
        user = {
            "id": "6b00000000000000000000aa",
            "username": "fixture-user",
            "email": "fixture-user@example.invalid",
            "role": "USER",
            "firstName": "Fixture",
            "apiKey": {
                "id": "6b00000000000000000000ab",
                "scopes": [
                    {"organizationId": "6ade2ce94b2b5b01c587d7c6", "scope": "MANAGEMENT"},
                ],
            },
        }
        self._store("users-me.json", (json.dumps(user, indent=2, sort_keys=True) + "\n").encode())


def _change_scale_limit(text: str) -> str:
    """SCALE's ``emailsPerMonth`` raised by 1000 in the Mailgun version (the derived second version)."""
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    in_scale = in_limit = False
    done = False
    for line in lines:
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        if re.match(r"^\s{2}SCALE:\s*$", line):
            in_scale = True
        elif in_scale and indent <= 2 and stripped:
            in_scale = False
        if in_scale and stripped.startswith("emailsPerMonth:"):
            in_limit = True
        elif in_scale and in_limit and stripped.startswith("value:") and not done:
            value = stripped.split(":", 1)[1].strip()
            if value.replace(".", "", 1).isdigit():
                line = line.replace(value, str(int(float(value)) + 1000), 1)
                done = True
            in_limit = False
        out.append(line)
    if not done:
        raise RuntimeError("SCALE.emailsPerMonth not found in the Mailgun version")
    return "".join(out)


def _stable(content: bytes) -> dict:
    data = json.loads(content)
    return {k: v for k, v in data.items() if k not in VOLATILE}


def route_key(path: str, query: dict[str, str] | None) -> str:
    return path + ("?" + urllib.parse.urlencode(sorted(query.items())) if query else "")


def headers_name(relative: str) -> str:
    stem = relative.rsplit(".", 1)[0]
    return f"{stem}.headers.json"


def slug(query: dict[str, str]) -> str:
    parts = [f"{k}-{v.replace(' ', '_')}" for k, v in sorted(query.items()) if k not in {"limit", "offset"}] or ["all"]
    return re.sub(r"[^A-Za-z0-9._-]+", "-", "__".join(parts)).strip("-")


def _syntax(text: str) -> str:
    match = re.search(r"^syntaxVersion:\s*['\"]?([^'\"\s#]+)", text, flags=re.M)
    return match.group(1) if match else "?"


def readme(routes: dict[str, dict[str, str]]) -> str:
    """The provenance README, computed from the files (``--check-readme`` recomputes and compares it)."""
    lines = [
        "# Recorded SPHERE answers",
        "",
        "Recorded from the public, anonymous API of https://sphere.score.us.es by",
        "`openbinding-gateway/tools/record_sphere_fixtures.py` (GET only, no key). `routes.json` lists every",
        "recorded request (path and sorted query) with its body and headers files; `tests/sphere_recorded.py`",
        "serves exactly these, and the tests never reach the network.",
        "",
        "**Licence note.** The pricings belong to their SPHERE authors (the `sphere`, `danruilop1`, `danvelcam`",
        "and `atenea` organizations). They are recorded for this repository's tests only and are not",
        "redistributed beyond them. `derived/` and `users-me.json` are synthetic (see below).",
        "",
        "## Versions",
        "",
        "| pricingId | versionId | label | syntax | SPHERE organization | collection | set | sha256 | contentHash | bytes | fetched |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for pricing_id, (role, _) in FAMILIES.items():
        manifest_path = ROOT / pricing_id / "manifest.json"
        if not manifest_path.exists():
            continue
        manifest = json.loads(manifest_path.read_text())
        location = ""
        permalink = ROOT / "permalinks" / f"{pricing_id}.json"
        if permalink.exists():
            location = json.loads(permalink.read_text())["location"]
        org_id = location.split("/")[2] if location else ""
        owner = ""
        if org_id and (ROOT / "orgs" / f"{org_id}.json").exists():
            owner = json.loads((ROOT / "orgs" / f"{org_id}.json").read_text())["name"]
        collection = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query).get("collection", [""])[0]
        for entry in manifest["versions"]:
            path = ROOT / pricing_id / f"{entry['versionId']}.yml"
            if not path.exists():
                continue
            data = path.read_bytes()
            lines.append(
                f"| `{pricing_id}` | `{entry['versionId']}` | {entry['version']} | {_syntax(data.decode('utf-8'))} | "
                f"{owner} | {collection or '-'} | {role} | `{hashlib.sha256(data).hexdigest()[:16]}…` | "
                f"`{entry['contentHash'][:16]}…` | {len(data)} | {FETCHED} |"
            )
    lines += [
        "",
        "## Other answers",
        "",
        "- `<pricingId>/manifest.json`: `GET /api/v1/public/pricings/<pricingId>` (all versions, newest per SPHERE's order).",
        "- `permalinks/<pricingId>.json`: `GET /api/v1/permalinks/pricing/<pricingId>` (organization id and slug).",
        "- `orgs/<organizationId>.json`: `GET /api/v1/orgs/<organizationId>` (the organization name of a family).",
        "- `org-pricings/<organizationId>.<page>.json`: `GET /api/v1/pricings/<organizationId>?limit=24&offset=<24·page>`.",
        "- `orgs-public/<q>.json`: `GET /api/v1/orgs/public?q=<q>` (non-personal organizations only).",
        "- `search/<query>.json`: `GET /api/v1/pricings?…` (discovery, with SPHERE's whole-result histograms).",
        "",
        "## Synthetic files (not fetched)",
        "",
        "- `derived/mailgun-renamed.yml`: the recorded set-B Mailgun version with `saasName` changed (a rename; same",
        "  functional hash, other bytes).",
        "- `derived/mailgun-scale.yml`: the same version with SCALE's `emailsPerMonth` raised by 1000 (a second version",
        "  for the cross-version comparisons; no recorded real family has two 3.x versions sharing a numeric plan).",
        "- `users-me.json`: a `/users/me` answer with no real personal data (the email is `example.invalid`).",
        "",
        f"{len(routes)} recorded requests.",
        "",
    ]
    return "\n".join(lines)


def check_readme() -> list[str]:
    problems = []
    routes = json.loads((ROOT / "routes.json").read_text())
    for key, entry in routes.items():
        for name in (entry["file"], entry["headers"]):
            if not (ROOT / name).exists():
                problems.append(f"{key}: {name} is missing")
    if (ROOT / "README.md").read_text() != readme(routes):
        problems.append("README.md differs from the files (run the recorder to regenerate it)")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="report drift against the live API; write nothing")
    group.add_argument("--update", action="store_true", help="overwrite changed files")
    group.add_argument("--check-readme", action="store_true", help="offline: README and routes.json match the files")
    args = parser.parse_args(argv)
    if args.check_readme:
        problems = check_readme()
        for problem in problems:
            print(problem)
        return 1 if problems else 0
    recorder = Recorder("check" if args.check else "update" if args.update else "record")
    recorder.record()
    for name in recorder.written:
        print(f"wrote {name}")
    for name in recorder.drift:
        print(f"drift {name}")
    for name in recorder.refused:
        print(f"changed upstream, not overwritten (use --update): {name}")
    return 1 if recorder.drift or recorder.refused else 0


if __name__ == "__main__":
    sys.exit(main())
