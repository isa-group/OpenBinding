"""Simulated SPACE and SPHERE for the tool tests (an ``httpx.MockTransport`` handler).

Only the endpoints the tools use exist; anything else answers 599 and is recorded,
so a test can assert that a tool never called what it must not call. All names,
keys and identifiers are synthetic.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx

SPACE_KEY = "spk-SYNTHETIC-space-key-0001"
SPHERE_KEY = "sphk-SYNTHETIC-sphere-key-0002"
SPACE_ORG = "space-org-0001"
SPHERE_ORG = "sphere-org-0002"
ENV = {
    "SPACE_URL": "https://space.test",
    "SPACE_API_KEY": SPACE_KEY,
    "SPACE_ORGANIZATION_ID": SPACE_ORG,
    "SPHERE_URL": "https://sphere.test",
    "SPHERE_API_KEY": SPHERE_KEY,
    "SPHERE_ORGANIZATION_ID": SPHERE_ORG,
}
NOW = datetime(2026, 10, 12, 9, 30, 15, tzinfo=timezone.utc)
NOW_TEXT = "2026-10-12T09:30:15Z"


def pricing_yaml(
    *,
    saas: str = "openbinding",
    version: str = "1.0.0",
    created: str | None = "2026-09-01T10:00:00Z",
    cu: bool = False,
    quote: str = "'",
    crlf: bool = False,
) -> bytes:
    created_line = f"createdAt: {quote}{created}{quote}\n" if created is not None else ""
    capacity = (
        "  capacityUnits:\n    valueType: NUMERIC\n    defaultValue: 10\n    unit: CU\n" if cu else ""
    )
    text = (
        "# synthetic test pricing\n"
        "syntaxVersion: '3.1'\n"
        f"saasName: {saas}\n"
        f"version: {version}\n"
        f"{created_line}"
        "currency: EUR\n"
        "features:\n"
        "  solve:\n"
        "    description: Execute engines.\n"
        "    valueType: BOOLEAN\n"
        "    defaultValue: true\n"
        "    expression: pricingContext['features']['solve']\n"
        "usageLimits:\n"
        "  maxIterations:\n"
        "    valueType: NUMERIC\n"
        "    defaultValue: 100\n"
        "    unit: iteration\n"
        f"{capacity}"
        "plans:\n"
        "  BASIC:\n"
        "    price: 0.0\n"
        "    unit: user/month\n"
        "    features:\n"
        "      solve: {value: true}\n"
        "    usageLimits:\n"
        "      maxIterations: {value: 100}\n"
        "addOns: {}\n"
    )
    if crlf:
        text = text.replace("\n", "\r\n")
    return text.encode()


def parse_multipart(request: httpx.Request) -> tuple[dict[str, str], dict[str, bytes]]:
    boundary = re.search(r"boundary=([^;]+)", request.headers["content-type"]).group(1).strip('"').encode()
    fields: dict[str, str] = {}
    files: dict[str, bytes] = {}
    for part in request.content.split(b"--" + boundary)[1:]:
        if part.startswith(b"--"):
            break
        head, _, body = part.partition(b"\r\n\r\n")
        body = body[:-2] if body.endswith(b"\r\n") else body
        name = re.search(rb'name="([^"]*)"', head).group(1).decode()
        if b"filename=" in head:
            files[name] = body
        else:
            fields[name] = body.decode()
    return fields, files


@dataclass
class Seen:
    method: str
    host: str
    path: str
    params: dict[str, str]
    key: str | None


@dataclass
class FakeRemotes:
    requests: list[Seen] = field(default_factory=list)
    uploads: list[dict[str, Any]] = field(default_factory=list)
    sphere: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    space: dict[str, dict[str, Any]] = field(default_factory=dict)
    contracts: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: status override per (host, METHOD, path); a path ending in ``*`` is a prefix.
    statuses: dict[tuple[str, str, str], int] = field(default_factory=dict)
    sphere_listing_status: int = 200
    sphere_upload_response: tuple[int, Any] | None = None
    space_upload_response: tuple[int, Any] | None = None
    sphere_store_private: bool = True
    sphere_report_private: bool = True
    raw_bodies: dict[tuple[str, str, str], Any] = field(default_factory=dict)
    raise_on: dict[tuple[str, str, str], Exception] = field(default_factory=dict)
    yaml_url_override: dict[tuple[str, str], str] = field(default_factory=dict)

    # -- state --------------------------------------------------------------

    def add_sphere(self, slug: str, version: str, content: bytes, *, private: bool = False, created: str | None = None) -> None:
        self.sphere.setdefault(slug, []).append(
            {"version": version, "private": private, "content": content, "createdAt": created}
        )

    def add_space(self, name: str, versions: list[str]) -> None:
        self.space[name] = {
            "id": f"svc-{name}",
            "disabled": False,
            "versions": {version: {"id": f"prc-{name}-{version}", "version": version} for version in versions},
        }

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def methods(self) -> set[str]:
        return {item.method for item in self.requests}

    def posts(self, host: str | None = None) -> list[Seen]:
        return [item for item in self.requests if item.method == "POST" and host in (None, item.host)]

    # -- routing ------------------------------------------------------------

    def handle(self, request: httpx.Request) -> httpx.Response:
        host, path, method = request.url.host, request.url.path, request.method
        self.requests.append(Seen(method, host, path, dict(request.url.params), request.headers.get("x-api-key")))
        expected = {"space.test": SPACE_KEY, "sphere.test": SPHERE_KEY}.get(host)
        if expected is None:
            return httpx.Response(599, json={"error": "unknown host"})
        for (h, m, pattern), error in self.raise_on.items():
            if h == host and m == method and (path == pattern or (pattern.endswith("*") and path.startswith(pattern[:-1]))):
                raise error
        if path != "/api/v1/healthcheck" and request.headers.get("x-api-key") != expected:
            return httpx.Response(401, json={"error": "invalid key"})
        for (h, m, pattern), status in self.statuses.items():
            if h == host and m == method and (path == pattern or (pattern.endswith("*") and path.startswith(pattern[:-1]))):
                # An error that echoes the credential it was called with, in body and header.
                return httpx.Response(status, json={"error": f"denied; request authenticated with {expected}"},
                                      headers={"x-debug-credential": expected})
        for (h, m, pattern), body in self.raw_bodies.items():
            if h == host and m == method and path == pattern:
                return httpx.Response(200, json=body)
        return self._sphere(request, method, path) if host == "sphere.test" else self._space(request, method, path)

    def _sphere(self, request: httpx.Request, method: str, path: str) -> httpx.Response:
        api = "/api/v1"
        org = {"id": SPHERE_ORG, "name": "OpenBinding", "displayName": "OpenBinding"}
        if method == "GET" and path == f"{api}/users/me/orgs":
            return httpx.Response(200, json=[org])
        if method == "GET" and path == f"{api}/orgs/{SPHERE_ORG}":
            return httpx.Response(200, json=org)
        if method == "GET" and path == f"{api}/pricings/{SPHERE_ORG}":
            if self.sphere_listing_status != 200:
                return httpx.Response(self.sphere_listing_status, json={"error": "no listing"})
            return httpx.Response(200, json={"pricings": [{"slug": slug} for slug in sorted(self.sphere)]})
        match = re.fullmatch(rf"{api}/pricings/{SPHERE_ORG}/([^/]+)", path)
        if method == "GET" and match:
            slug = match.group(1)
            if slug not in self.sphere:
                return httpx.Response(404, json={"error": "not found"})
            versions = []
            for item in self.sphere[slug]:
                entry: dict[str, Any] = {
                    "version": item["version"],
                    "yaml": self.yaml_url_override.get((slug, item["version"]), f"/static/pricings/{slug}/{item['version']}.yml"),
                }
                if self.sphere_report_private:
                    entry["private"] = item["private"]
                if item["createdAt"]:
                    entry["createdAt"] = item["createdAt"]
                versions.append(entry)
            return httpx.Response(200, json={"slug": slug, "versions": versions})
        match = re.fullmatch(r"/static/pricings/([^/]+)/([^/]+)\.yml", path)
        if method == "GET" and match:
            for item in self.sphere.get(match.group(1), []):
                if item["version"] == match.group(2):
                    return httpx.Response(200, content=item["content"])
            return httpx.Response(404)
        create = path == f"{api}/pricings/{SPHERE_ORG}"
        versioned = re.fullmatch(rf"{api}/pricings/{SPHERE_ORG}/([^/]+)/([^/]+)", path)
        if method == "POST" and (create or versioned):
            fields, files = parse_multipart(request)
            self.uploads.append({"service": "sphere", "path": path, "fields": fields, "file": files.get("yaml")})
            if self.sphere_upload_response:
                status, body = self.sphere_upload_response
                return httpx.Response(status, json=body)
            slug = fields["name"] if create else versioned.group(1)
            if any(item["version"] == fields["version"] for item in self.sphere.get(slug, [])):
                return httpx.Response(409, json={"error": "version exists"})
            self.add_sphere(slug, fields["version"], files["yaml"],
                            private=(fields.get("private") == "true") and self.sphere_store_private)
            return httpx.Response(201, json={"ok": True})
        return httpx.Response(599, json={"error": f"unsupported {method} {path}"})

    def _service_json(self, name: str) -> dict[str, Any]:
        service = self.space[name]
        return {
            "id": service["id"],
            "name": name,
            "disabled": service["disabled"],
            "organizationId": SPACE_ORG,
            "activePricings": service["versions"],
            "archivedPricings": {},
        }

    def _space(self, request: httpx.Request, method: str, path: str) -> httpx.Response:
        api = "/api/v1"
        if method == "GET" and path == f"{api}/healthcheck":
            return httpx.Response(200, json={"message": "alive"})
        if method == "GET" and path == f"{api}/services":
            return httpx.Response(200, json=[self._service_json(name) for name in sorted(self.space)])
        match = re.fullmatch(rf"{api}/services/([^/]+)", path)
        if method == "GET" and match:
            name = match.group(1)
            if name not in self.space:
                return httpx.Response(404, json={"error": "service not found"})
            return httpx.Response(200, json=self._service_json(name))
        match = re.fullmatch(rf"{api}/services/([^/]+)/pricings", path)
        if method == "GET" and match:
            name = match.group(1)
            if name not in self.space:
                return httpx.Response(404, json={"error": "service not found"})
            return httpx.Response(200, json=list(self.space[name]["versions"].values()))
        if method == "POST" and path == f"{api}/services":
            _, files = parse_multipart(request)
            self.uploads.append({"service": "space", "path": path, "fields": {}, "file": files.get("pricing")})
            if self.space_upload_response:
                status, body = self.space_upload_response
                return httpx.Response(status, json=body)
            text = files["pricing"].decode()
            name = re.search(r"(?m)^saasName:\s*(\S+)", text).group(1)
            version = re.search(r"(?m)^version:\s*['\"]?([^'\"\s]+)", text).group(1)
            if name in self.space:
                return httpx.Response(409, json={"error": "service exists"})
            self.add_space(name, [version])
            return httpx.Response(201, json=self._service_json(name))
        match = re.fullmatch(rf"{api}/contracts/([^/]+)", path)
        if method == "GET" and match:
            contract = self.contracts.get(match.group(1))
            if contract is None:
                return httpx.Response(404, json={"error": "contract not found"})
            return httpx.Response(200, json=contract)
        if method == "POST" and path == f"{api}/contracts":
            body = json.loads(request.content)
            user_id = body["userContact"]["userId"]
            self.contracts[user_id] = {
                "id": f"ctr-{user_id}",
                "userContact": body["userContact"],
                "billingPeriod": {"autoRenew": True, "renewalDays": 30},
                "organizationId": SPACE_ORG,
                "usageLevels": {},
                "contractedServices": body["contractedServices"],
                "subscriptionPlans": body["subscriptionPlans"],
                "subscriptionAddOns": {},
                "history": [],
            }
            return httpx.Response(201, json=self.contracts[user_id])
        return httpx.Response(599, json={"error": f"unsupported {method} {path}"})


def production_world() -> FakeRemotes:
    """SPHERE slug ``openbinding`` (0.9.0 with CU, 1.0.0 clean) mirrored as a SPACE service."""
    fake = FakeRemotes()
    fake.add_sphere("openbinding", "0.9.0", pricing_yaml(version="0.9.0", created="2026-08-01T00:00:00Z", cu=True),
                    created="2026-08-01T00:00:01Z")
    fake.add_sphere("openbinding", "1.0.0", pricing_yaml(version="1.0.0", created="2026-09-01T10:00:00Z"))
    fake.add_space("openbinding", ["0.9.0", "1.0.0"])
    return fake


BASE_YAML = pricing_yaml(version="1.0.0", created="2026-09-01T10:00:00Z")
