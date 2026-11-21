#!/usr/bin/env python3
"""Record the SPHERE answers the gateway tests read offline (``tests/fixtures/sphere``).

This is the only tool of the repository that reads SPHERE over the network, and it is run by hand:
anonymous, GET only, a generic user agent, honouring ``RateLimit-*`` and ``Retry-After``. It imports
nothing of the gateway, so it runs with any Python 3.11.

    python tools/record_sphere_fixtures.py            # record what is missing; refuse to overwrite a changed file
    python tools/record_sphere_fixtures.py --update   # overwrite changed files
    python tools/record_sphere_fixtures.py --check    # report drift against the live API, write nothing
    python tools/record_sphere_fixtures.py --check-readme   # offline: the README and routes.json match the files
    python tools/record_sphere_fixtures.py --derive         # offline: write the derived files and the README
    python tools/record_sphere_fixtures.py --check-derived  # offline: the derived files match what is derived

Every answer is stored with the headers the tests need (``ETag``, ``Cache-Control``, ``Vary``, ``RateLimit-*``)
and listed in ``routes.json`` by path and query, which is what ``tests/sphere_recorded.py`` serves. The
``derived/`` files and ``scenarios.json`` are synthetic and generated here from recorded files, offline (see the
README); deriving reads the gateway's content-hash port for each scenario's ``contentHash``.

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
    "6ab0a323697330667ccce891": ("OpenBinding", "all"),
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
        for relative, content in derived_files().items():
            self._store(relative, content)


def derived_files() -> dict[str, bytes]:
    """Every synthetic file, computed offline from the recorded ones (``--check-derived`` compares them)."""
    out: dict[str, bytes] = {}
    mailgun = "6ade364540e55445692b0eda"
    manifest = json.loads((ROOT / mailgun / "manifest.json").read_text())
    version = manifest["latestVersionId"]
    source = (ROOT / mailgun / f"{version}.yml").read_text(encoding="utf-8")
    renamed = re.sub(r"^saasName:.*$", "saasName: Mailgun Renamed", source, count=1, flags=re.M)
    out["derived/mailgun-renamed.yml"] = renamed.encode()
    out["derived/mailgun-scale.yml"] = _change_scale_limit(source).encode()
    files, catalog = scenario_files()
    out.update(files)
    out["scenarios.json"] = (json.dumps(catalog, indent=2) + "\n").encode()
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
    out["users-me.json"] = (json.dumps(user, indent=2, sort_keys=True) + "\n").encode()
    return out


# -- Scenarios: synthetic "new upstream versions" (F6) ------------------------------------------------------------

BREVO = "6ade2d4440e55445692b07f1"
BREVO_2026_10 = "6ade2d444b2b5b01c587d80d"
TOMATOMETER = "6ab0a323697330667ccce8cd"
TOMATOMETER_100 = "6921867e7004563bd918e7e8"

#: Every scenario: its family, the version it starts from (another scenario's name for ``after``), a synthetic
#: versionId (prefix ``6fff``, never a real SPHERE id), its label and creation date, whether the lab may publish it,
#: the scenario it must follow, a manifest name change, and the edits (dotted paths into the YAML text).
SCENARIOS: list[dict[str, object]] = [
    {"scenario": "brevo-professional-up", "pricingId": BREVO, "from": BREVO_2026_10,
     "versionId": "6fff00000000000000000001", "label": "2026-11", "createdAt": "2026-11-15",
     "publishable": True, "after": None, "nameChange": None,
     "edits": [("set", "variables.professionalPrices.150000", "549")]},
    {"scenario": "brevo-professional-retired", "pricingId": BREVO, "from": "brevo-professional-up",
     "versionId": "6fff00000000000000000002", "label": "2027-01", "createdAt": "2027-01-10",
     "publishable": True, "after": "brevo-professional-up", "nameChange": None,
     "edits": [("delete", "plans.PROFESSIONAL", None), ("drop-item", "addOns.*.availableFor", "PROFESSIONAL")]},
    {"scenario": "brevo-renamed-family", "pricingId": BREVO, "from": BREVO_2026_10,
     "versionId": BREVO_2026_10, "label": "2026-10", "createdAt": None,
     "publishable": True, "after": None, "nameChange": "Brevo",
     "edits": [("set", "saasName", "Brevo")]},
    {"scenario": "tomatometer-1.2.0", "pricingId": TOMATOMETER, "from": TOMATOMETER_100,
     "versionId": "6fff00000000000000000003", "label": "1.2.0", "createdAt": "2026-11-20",
     "publishable": True, "after": None, "nameChange": None,
     "edits": [("set", "plans.basic.price", "0.99"),
               ("set", "plans.basic.features", "\n      dailySummary:\n        value: true"),
               ("set", "plans.basic.usageLimits", "\n      maxPomodoroTimers:\n        value: 5")]},
    {"scenario": "brevo-professional-renamed", "pricingId": BREVO, "from": BREVO_2026_10,
     "versionId": "6fff00000000000000000011", "label": "2026-11-renamed", "createdAt": "2026-11-16",
     "publishable": False, "after": None, "nameChange": None,
     "edits": [("rename", "plans.PROFESSIONAL", "PROFESSIONAL_PLUS"),
               ("rename-item", "addOns.*.availableFor", "PROFESSIONAL=PROFESSIONAL_PLUS")]},
    {"scenario": "brevo-sla", "pricingId": BREVO, "from": BREVO_2026_10,
     "versionId": "6fff00000000000000000012", "label": "2026-11-sla", "createdAt": "2026-11-16",
     "publishable": False, "after": None, "nameChange": None,
     "edits": [("insert", "plans.PROFESSIONAL.features", "sla:\n  value: true")]},
    {"scenario": "brevo-daily-limit", "pricingId": BREVO, "from": BREVO_2026_10,
     "versionId": "6fff00000000000000000013", "label": "2026-11-daily-limit", "createdAt": "2026-11-16",
     "publishable": False, "after": None, "nameChange": None,
     "edits": [("set", "plans.PROFESSIONAL.usageLimits.emailsPerDay.value", "500")]},
    {"scenario": "brevo-private", "pricingId": BREVO, "from": BREVO_2026_10,
     "versionId": "6fff00000000000000000014", "label": "2026-11-private", "createdAt": "2026-11-16",
     "publishable": False, "after": None, "nameChange": None,
     "edits": [("insert", "plans.PROFESSIONAL", "private: true")]},
    {"scenario": "brevo-label", "pricingId": BREVO, "from": BREVO_2026_10,
     "versionId": "6fff00000000000000000015", "label": "2026-11-label", "createdAt": "2026-11-16",
     "publishable": False, "after": None, "nameChange": None,
     "edits": [("set", "plans.PROFESSIONAL.price", "Contact sales")]},
    {"scenario": "brevo-addon", "pricingId": BREVO, "from": BREVO_2026_10,
     "versionId": "6fff00000000000000000016", "label": "2026-11-addon", "createdAt": "2026-11-16",
     "publishable": False, "after": None, "nameChange": None,
     "edits": [("set", "addOns.samlSso.features.ssoSaml.value", "false")]},
    {"scenario": "tomatometer-1.1.0-fis-like", "pricingId": TOMATOMETER, "from": TOMATOMETER_100,
     "versionId": "6fff00000000000000000017", "label": "1.1.0-fis-like", "createdAt": "2026-11-10",
     "publishable": False, "after": None, "nameChange": None,
     "edits": [("set", "plans.basic.features", "\n      dailySummary:\n        value: true"),
               ("set", "plans.basic.usageLimits", "\n      maxPomodoroTimers:\n        value: 5")]},
]


class YamlText:
    """Edits of a block-style YAML text by dotted path, keeping every other byte (indentation of two spaces).

    ``set`` replaces a key's inline value (a value starting with a newline becomes a nested block), ``delete``
    removes a key with its block, ``rename`` renames a key, ``insert`` adds lines as the first children of a
    mapping, ``drop-item`` and ``rename-item`` edit ``- item`` lines of a list (``*`` matches every key at that
    level; an emptied list becomes ``[]``, never null, which would mean "every plan").
    """

    def __init__(self, text: str) -> None:
        self.lines = text.splitlines(keepends=True)

    def text(self) -> str:
        return "".join(self.lines)

    @staticmethod
    def _indent(line: str) -> int:
        return len(line) - len(line.lstrip(" "))

    @staticmethod
    def _key(line: str) -> str | None:
        match = re.match(r"^\s*(?:'([^']*)'|\"([^\"]*)\"|([^\s:#'\"-][^:#]*?)):(?:\s|$)", line)
        if not match:
            return None
        return next(group for group in match.groups() if group is not None)

    def _end(self, index: int) -> int:
        """The index after the block of the key at ``index``."""
        indent = self._indent(self.lines[index])
        end = index + 1
        while end < len(self.lines):
            line = self.lines[end]
            if line.strip() and self._indent(line) <= indent and not (
                line.lstrip().startswith("- ") and self._indent(line) == indent
                and self.lines[index].rstrip().endswith(":")
            ):
                break
            end += 1
        return end

    def find(self, path: str) -> list[int]:
        """The line indexes of every key the dotted path names (``*`` matches any key)."""
        found = [(-1, len(self.lines), -1)]
        for segment in path.split("."):
            nxt = []
            for parent, end, indent in found:
                start = parent + 1
                child = None
                for index in range(start, end):
                    line = self.lines[index]
                    if not line.strip() or line.lstrip().startswith("#"):
                        continue
                    level = self._indent(line)
                    if level <= indent:
                        break
                    if child is None:
                        child = level
                    if level != child:
                        continue
                    key = self._key(line)
                    if key is not None and (segment == "*" or key == segment):
                        nxt.append((index, self._end(index), level))
            found = nxt
        if not found:
            raise KeyError(path)
        return [index for index, _, _ in found]

    def apply(self, operation: str, path: str, value: str | None) -> None:
        if operation == "set":
            (index,) = self.find(path)
            line = self.lines[index]
            head = line[: line.index(":") + 1]
            end = self._end(index)
            assert value is not None
            if value.startswith("\n"):
                self.lines[index:end] = [head + "\n"] + [part + "\n" for part in value[1:].split("\n")]
            else:
                self.lines[index:end] = [f"{head} {value}\n"]
        elif operation == "delete":
            for index in reversed(self.find(path)):
                del self.lines[index:self._end(index)]
        elif operation == "rename":
            assert value is not None
            for index in self.find(path):
                line = self.lines[index]
                key = self._key(line)
                assert key is not None
                self.lines[index] = line.replace(key, value, 1)
        elif operation == "insert":
            (index,) = self.find(path)
            line = self.lines[index]
            assert value is not None
            if line.rstrip().endswith("null"):
                head = line[: line.index(":") + 1]
                self.lines[index] = head + "\n"
            pad = " " * (self._indent(line) + 2)
            self.lines[index + 1:index + 1] = [pad + part + "\n" for part in value.split("\n")]
        elif operation in ("drop-item", "rename-item"):
            assert value is not None
            old, _, new = value.partition("=")
            for index in reversed(self.find(path)):
                end = self._end(index)
                items = [i for i in range(index + 1, end) if self.lines[i].strip() == f"- {old}"]
                for item in reversed(items):
                    if operation == "rename-item":
                        self.lines[item] = self.lines[item].replace(f"- {old}", f"- {new}", 1)
                    else:
                        del self.lines[item]
                end = self._end(index)
                if operation == "drop-item" and items and not any(
                    self.lines[i].lstrip().startswith("- ") for i in range(index + 1, end)
                ):
                    line = self.lines[index]
                    self.lines[index] = line[: line.index(":") + 1] + " []\n"
        else:
            raise ValueError(operation)


def _scenario_text(scenario: dict[str, object], texts: dict[str, str]) -> str:
    start = str(scenario["from"])
    base = texts[start] if start in texts else (ROOT / str(scenario["pricingId"]) / f"{start}.yml").read_text(
        encoding="utf-8"
    )
    document = YamlText(base)
    for operation, path, value in scenario["edits"]:  # type: ignore[union-attr]
        document.apply(operation, path, value)
    if scenario["createdAt"] is not None:
        document.apply("set", "version", f"'{scenario['label']}'")
        document.apply("set", "createdAt", f"'{scenario['createdAt']}'")
    return document.text()


def scenario_files() -> tuple[dict[str, bytes], list[dict[str, object]]]:
    """The derived YAML of every scenario and the catalog (``scenarios.json``)."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    from openbinding_gateway.modules.plans.domain.content_hash import functional_hash

    texts: dict[str, str] = {}
    files: dict[str, bytes] = {}
    catalog: list[dict[str, object]] = []
    for scenario in SCENARIOS:
        name = str(scenario["scenario"])
        text = _scenario_text(scenario, texts)
        texts[name] = text
        data = text.encode("utf-8")
        relative = f"derived/{name}.yml"
        files[relative] = data
        created = scenario["createdAt"]
        if created is None:
            entry = json.loads((ROOT / str(scenario["pricingId"]) / "manifest.json").read_text())
            created_at = next(v["createdAt"] for v in entry["versions"] if v["versionId"] == scenario["versionId"])
        else:
            created_at = f"{created}T00:00:00.000Z"
        catalog.append({
            "scenario": name,
            "pricingId": scenario["pricingId"],
            "versionId": scenario["versionId"],
            "label": scenario["label"],
            "createdAt": created_at,
            "file": relative,
            "contentHash": functional_hash(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "publishable": scenario["publishable"],
            "after": scenario["after"],
            "manifest": {"nameChange": scenario["nameChange"]},
        })
    return files, catalog


def check_derived() -> list[str]:
    """Offline: every synthetic file equals what ``derived_files`` computes now."""
    problems = []
    for relative, content in derived_files().items():
        target = ROOT / relative
        if not target.exists():
            problems.append(f"{relative} is missing")
        elif target.read_bytes() != content:
            problems.append(f"{relative} differs from what the recorder derives")
    known = set(derived_files())
    for path in sorted((ROOT / "derived").glob("*.yml")):
        if f"derived/{path.name}" not in known:
            problems.append(f"derived/{path.name} is not derived by the recorder")
    return problems


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
        "redistributed beyond them. `derived/`, `scenarios.json` and `users-me.json` are synthetic (see below). The",
        "frontend's copy (`frontend/src/test/fixtures/sphere`, written by `tools/dump_frontend_fixtures.py`), which its",
        "unit tests and mocked Playwright specs draw and preview, is under the same note. Using them in the local lab",
        "(the lab's SPHERE stand-in, built on this machine from this directory and never published as an image)",
        "counts as test use.",
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
        "## Scenarios (synthetic upstream versions, never published to SPHERE)",
        "",
        "`scenarios.json` lists each \"new upstream version\" the F6 tests, goldens, frontend fixtures and the lab",
        "stand-in publish, derived here from a recorded version by explicit dotted-path edits (`SCENARIOS`). Version",
        "ids start with `6fff` and are never real SPHERE ids; each `createdAt` comes after the family's recorded latest,",
        "so a published version becomes `latestVersionId` by SPHERE's order. They are synthetic and never published",
        "to SPHERE.",
        "",
        "| scenario | pricingId | versionId | label | what changed | publishable | after |",
        "|---|---|---|---|---|---|---|",
    ]
    for scenario in SCENARIOS:
        changed = "; ".join(f"{op} `{path}`" + (f" = `{value.strip()}`" if value and "\\n" not in value and "\n" not in value else "")
                            for op, path, value in scenario["edits"])  # type: ignore[union-attr]
        if scenario["nameChange"]:
            changed += f"; manifest name `{scenario['nameChange']}`"
        lines.append(
            f"| `{scenario['scenario']}` | `{scenario['pricingId']}` | `{scenario['versionId']}` | {scenario['label']} | "
            f"{changed} | {'yes' if scenario['publishable'] else 'no'} | {scenario['after'] or '-'} |"
        )
    lines += [
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
    group.add_argument("--check-derived", action="store_true", help="offline: the derived files match the recorder")
    group.add_argument("--derive", action="store_true", help="offline: write the derived files and the README only")
    args = parser.parse_args(argv)
    if args.check_derived:
        problems = check_derived()
        for problem in problems:
            print(problem)
        return 1 if problems else 0
    if args.derive:
        recorder = Recorder("update")
        recorder.derive()
        routes = json.loads((ROOT / "routes.json").read_text())
        recorder._store("README.md", readme(routes).encode())
        for name in recorder.written:
            print(f"wrote {name}")
        return 0
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
