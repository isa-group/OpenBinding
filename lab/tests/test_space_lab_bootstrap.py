"""Tests of the SPACE lab bootstrap: the Dockerfiles of ``lab/space`` and ``lab/tools`` (static rules) and the tool
``lab/tools/space_lab_bootstrap.py`` (behaviour against a stateful in-memory fake SPACE; no network, no Docker).

The Dockerfile rules are plain functions of the file text that return a failure message or None.  The ``control`` test
calls them on conforming in-memory samples, mutated, so every rule is proven to refuse what it must.  The tool is
loaded by file path inside a fixture, so a missing module fails the test at run time while collection still works.
Tests drive the async code with ``asyncio.run`` and need no pytest plugin.

Run from ``openbinding-gateway`` with its environment::

    uv run --locked --extra test pytest ../lab/tests
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import re
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

SPACE_DOCKERFILE = ROOT / "lab" / "space" / "Dockerfile"
TOOL_DOCKERFILE = ROOT / "lab" / "tools" / "Dockerfile"
REQUIREMENTS = ROOT / "lab" / "tools" / "requirements.txt"
TOOL = ROOT / "lab" / "tools" / "space_lab_bootstrap.py"
SEED = ROOT / "openbinding-gateway" / "tools" / "seed_lab.py"

COMMIT = "ef4dc8949435d998e2aff525226e3fcc85e2f7ba"
API_IMAGE = "node:21.1-slim@sha256:cba276a6db06f49c589bcea35c598b5a960880ed5631bd4407a61c414ec7a9b9"
GIT_IMAGE = "node:21.1@sha256:0052410af98158173b17a26e0e2a46a3932095ac9a0ded660439a8ffae65b1e3"
PYTHON_IMAGE = "python:3.12.8-slim-bookworm@sha256:2199a62885a12290dc9c5be3ca0681d367576ab7bf037da120e564723292a2f0"
SPHERE_LINK = "https://sphere.score.us.es/p/6ab0a323697330667ccce891"
USERS = ("lab-admin", "lab-owner", "lab-orgadmin", "lab-member", "lab-viewer", "lab-outsider")
# The seed's id function (openbinding-gateway/tools/seed_lab.py): uuid5(SEED_NAMESPACE, "user:<username>").
SEED_NAMESPACE = uuid.UUID("6f1d3a52-8c0e-4b7a-9d21-0f5e7c3a9b10")

ADMIN_USER = "lab-space-admin"
ADMIN_PASSWORD = "Sample-Admin-Password-7731"
ADMIN_KEY = "admin-key-sample-AAAA1111"
SPACE_URL = "http://space-api:3000"


def seed_id(name: str) -> str:
    return str(uuid.uuid5(SEED_NAMESPACE, f"user:{name}"))


# -- Dockerfile rules: text in, failure message or None out ----------------------------------------------------------

FROM_LINE = re.compile(r"^(?:--platform=\S+\s+)?([a-z0-9][a-z0-9./_-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64})(?:\s+[Aa][Ss]\s+\S+)?$")
SECRET_NAME = re.compile(r"SECRET|PASSWORD|TOKEN|KEY|SALT", re.IGNORECASE)
SECRET_SHAPE = re.compile(r"sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY")


def instructions(text: str) -> list[tuple[str, str]]:
    """(INSTRUCTION, arguments) pairs: comments dropped, backslash continuations joined."""
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("#")]
    joined = re.sub(r"\\[ \t]*\n", " ", "\n".join(lines))
    out = []
    for line in joined.splitlines():
        parts = line.strip().split(None, 1)
        if parts:
            out.append((parts[0].upper(), parts[1].strip() if len(parts) > 1 else ""))
    return out


def commands(text: str) -> list[str]:
    """Every shell command of every RUN, split on && || ; (the exec form is joined)."""
    found = []
    for name, args in instructions(text):
        if name != "RUN":
            continue
        if args.startswith("["):
            try:
                args = " ".join(json.loads(args))
            except ValueError:
                pass
        found.extend(c.strip() for c in re.split(r"&&|\|\||;", args) if c.strip())
    return found


def final_stage(text: str) -> list[tuple[str, str]]:
    items = instructions(text)
    last = max((i for i, (name, _) in enumerate(items) if name == "FROM"), default=-1)
    return items[last + 1:] if last >= 0 else []


def rule_from_lines(text: str, expected: list[str]) -> str | None:
    froms = [args for name, args in instructions(text) if name == "FROM"]
    if not froms:
        return "no FROM"
    refs = []
    for args in froms:
        match = FROM_LINE.fullmatch(args)
        if not match:
            return f"FROM {args!r} is not image:tag@sha256:<64 hex>"
        refs.append(match.group(1))
    missing = [e for e in expected if e not in refs]
    if missing:
        return f"missing the pinned base image {missing}"
    if [r for r in refs if r not in expected]:
        return f"unexpected base image in {refs}"
    return None


def rule_no_secret(text: str) -> str | None:
    for name, args in instructions(text):
        if name in ("ARG", "ENV"):
            names = re.findall(r"(?:^|\s)([A-Za-z_]\w*)=", args) or [args.split()[0]]
            for item in names:
                if SECRET_NAME.search(item):
                    return f"{name} {item} holds a secret"
    live = "\n".join(args for name, args in instructions(text))
    if SECRET_SHAPE.search(live):
        return "a secret-shaped literal"
    return None


def rule_user(text: str) -> str | None:
    users = [args for name, args in final_stage(text) if name == "USER"]
    if not users:
        return "the final stage has no USER"
    ids = users[-1].split(":")
    if len(ids) != 2 or not all(i.isdigit() and int(i) > 0 for i in ids):
        return f"USER {users[-1]!r} must be a numeric non-root uid and a numeric non-zero gid"
    return None


def rule_space_commit(text: str) -> str | None:
    live = [(n, a) for n, a in instructions(text)]
    joined = "\n".join(a for _, a in live)
    if COMMIT not in joined:
        return f"the commit {COMMIT} is not named"
    if "SCORELabUS/space" not in joined:
        return "the repository SCORELabUS/space is not named"
    cmds = commands(text)
    if any(re.search(r"\bgit\s+(?:\S+\s+)*clone\b", c) for c in cmds):
        return "git clone is forbidden: fetch the commit"
    if any(re.search(r"v1\.7\.1|--branch|\brefs/|\b(?:main|master|develop)\b", c) for c in cmds):
        return "a tag, branch or ref is used in a command"
    fetches = [c for c in cmds if re.search(r"\bgit\b.*\bfetch\b", c)]
    if not fetches or any(COMMIT not in c for c in fetches):
        return "every git fetch must name the literal commit"
    for c in cmds:
        if re.search(r"\bgit\b.*\bcheckout\b", c) and not re.search(rf"checkout\s+(?:FETCH_HEAD|{COMMIT})\s*$", c):
            return "git checkout must use FETCH_HEAD or the commit"
    checks = [c for c in cmds if re.search(r"\bgit\b[^|]*\brev-parse\s+HEAD\b", c)]
    if not checks:
        return "no git rev-parse HEAD verification"
    for c in checks:
        rest = re.sub(r"\$\(\s*git[^)]*rev-parse\s+HEAD\s*\)|`\s*git[^`]*rev-parse\s+HEAD\s*`", "", c)
        if COMMIT not in rest or "$" in rest:
            return "the HEAD verification must compare with the literal commit, not a variable"
    if not any(re.search(r"(?:^|\s)(?:test|\[)\s", c) for c in checks):
        return "the HEAD verification does not fail the build"
    for name, args in instructions(text):
        if name == "RUN" and "rev-parse" in args and re.search(r"\|\||;", args):
            return "the HEAD verification must not be neutralised by || or ;"
        if name in ("ADD", "COPY") and re.search(r"v1\.7\.1|#|--branch|\brefs/", args) and "SCORELabUS" in args:
            return "a tag, branch or ref is used in ADD"
    return None


def rule_pnpm(text: str) -> str | None:
    live = "\n".join(a for _, a in instructions(text))
    if not re.search(r"pnpm@10\.9\.0(?![\w.])", live) or re.search(r"pnpm@(?!10\.9\.0(?![\w.]))", live):
        return "pnpm must be installed as exactly pnpm@10.9.0"
    installs = [c for c in commands(text) if re.search(r"\bpnpm\s+(?:install|i)\b", c)]
    if not installs:
        return "no pnpm install command"
    for c in installs:
        if "--frozen-lockfile" not in c:
            return f"pnpm install without --frozen-lockfile: {c!r}"
    return None


def rule_expose(text: str) -> str | None:
    ports = [args for name, args in final_stage(text) if name == "EXPOSE"]
    return None if ports == ["3000"] or "3000" in " ".join(ports).split() else "the final stage must EXPOSE 3000"


def rule_space_dockerfile(text: str) -> str | None:
    for rule in (rule_space_commit, lambda t: rule_from_lines(t, [GIT_IMAGE, API_IMAGE]), rule_pnpm, rule_expose):
        message = rule(text)
        if message:
            return message
    froms = [args for name, args in instructions(text) if name == "FROM"]
    if not froms[-1].startswith("node:21.1-slim@"):
        return "the final (api) stage must be node:21.1-slim"
    return None


def rule_space_hygiene(text: str) -> str | None:
    return rule_no_secret(text) or rule_user(text)


def rule_requirements(text: str) -> str | None:
    names = set()
    pin = re.compile(r"([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9,._-]+\])?==[A-Za-z0-9][A-Za-z0-9._+!]*")
    for raw in text.splitlines():
        line = raw.split(" #", 1)[0].strip()
        if not line or line.startswith("#"):
            continue
        match = pin.fullmatch(line)
        if not match:
            return f"{line!r} is not name==version"
        names.add(match.group(1).lower().replace("_", "-"))
    missing = {"httpx", "space-python-client"} - names
    return f"requirements lack {sorted(missing)}" if missing else None


def rule_tool_dockerfile(text: str) -> str | None:
    message = rule_from_lines(text, [PYTHON_IMAGE]) or rule_no_secret(text) or rule_user(text)
    if message:
        return message
    installs = [c for c in commands(text) if re.search(r"\bpip3?\s+install\b", c)]
    if not installs:
        return "no pip install command"
    for c in installs:
        tokens = c.split()
        rest = tokens[tokens.index("install") + 1:]
        requirement = None
        positional = []
        skip = False
        for i, token in enumerate(rest):
            if skip:
                skip = False
            elif token in ("-r", "--requirement"):
                requirement = rest[i + 1] if i + 1 < len(rest) else None
                skip = True
            elif token.startswith("--requirement="):
                requirement = token.split("=", 1)[1]
            elif not token.startswith("-"):
                positional.append(token)
        if not requirement or not requirement.endswith("requirements.txt") or positional:
            return f"pip install must install only from requirements.txt: {c!r}"
    args = [a for n, a in instructions(text) if n in ("COPY", "ADD")]
    if not any("lab/tools/requirements.txt" in a for a in args):
        return "lab/tools/requirements.txt is not copied"
    if not any("lab/tools/space_lab_bootstrap.py" in a for a in args):
        return "space_lab_bootstrap.py is not copied"
    entry = [a for n, a in instructions(text) if n == "ENTRYPOINT"]
    if not entry or "space_lab_bootstrap" not in entry[-1]:
        return "ENTRYPOINT must run the tool"
    return None


SAMPLE_SPACE = f"""# syntax=docker/dockerfile:1
FROM {GIT_IMAGE} AS source
WORKDIR /src
RUN git init \\
 && git fetch --depth 1 https://github.com/SCORELabUS/space.git {COMMIT} \\
 && git checkout FETCH_HEAD \\
 && test "$(git rev-parse HEAD)" = "{COMMIT}"

FROM {API_IMAGE} AS api
RUN npm install --global pnpm@10.9.0
WORKDIR /app
COPY --from=source /src/api/ ./
RUN pnpm install --frozen-lockfile
RUN pnpm build
EXPOSE 3000
USER 1000:1000
CMD ["pnpm", "start"]
"""

SAMPLE_TOOL = f"""FROM {PYTHON_IMAGE}
WORKDIR /app
COPY lab/tools/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY lab/tools/space_lab_bootstrap.py ./space_lab_bootstrap.py
USER 1000:1000
ENTRYPOINT ["python", "/app/space_lab_bootstrap.py"]
"""

SAMPLE_REQUIREMENTS = "# pinned\nhttpx==0.28.1\nspace-python-client==1.0.0\nanyio==4.6.0  # transitive\n"


# -- the real files (they fail until the other tasks write them) ----------------------------------------------------


def _read(path: Path) -> str:
    assert path.is_file(), f"{path.relative_to(ROOT)} does not exist yet"
    return path.read_text(encoding="utf-8")


def test_space_dockerfile_pins_commit_and_digests():
    # [utest->req~lab-space-image-pinned-commit~1]
    assert rule_space_dockerfile(_read(SPACE_DOCKERFILE)) is None


def test_space_dockerfile_has_no_secret_and_runs_non_root():
    # [utest->req~lab-space-image-pinned-commit~1]
    assert rule_space_hygiene(_read(SPACE_DOCKERFILE)) is None


def test_tool_dockerfile_pins_digest_and_requirements():
    # [utest->req~lab-space-image-pinned-commit~1]
    assert rule_tool_dockerfile(_read(TOOL_DOCKERFILE)) is None
    assert rule_requirements(_read(REQUIREMENTS)) is None


# -- controls: the Dockerfile rules on conforming in-memory samples, mutated ------------------------------------------


def _space_all(text: str) -> str | None:
    return rule_space_dockerfile(text) or rule_space_hygiene(text)


def _tool_all(text: str) -> str | None:
    return rule_tool_dockerfile(text)


def _swap(old: str, new: str):
    def mutate(text: str) -> str:
        assert old in text, old
        return text.replace(old, new, 1)
    return mutate


def _append_final(line: str):
    return lambda text: text.rstrip("\n").replace('CMD ["pnpm", "start"]', f'{line}\nCMD ["pnpm", "start"]')


SPACE_MUTATIONS = {
    "tag instead of the commit": _swap(f"space.git {COMMIT}", "space.git v1.7.1"),
    "branch instead of the commit": _swap(f"space.git {COMMIT}", "space.git main"),
    "git clone": _swap("git init", "git clone --branch v1.7.1 https://github.com/SCORELabUS/space.git ."),
    "checkout of a tag": _swap("checkout FETCH_HEAD", "checkout v1.7.1"),
    "no verification": _swap(f' \\\n && test "$(git rev-parse HEAD)" = "{COMMIT}"', ""),
    "variable in the verification": _swap(f'= "{COMMIT}"', '= "$SPACE_COMMIT"'),
    "tag-only FROM": _swap(f"@sha256:{GIT_IMAGE.rsplit(':', 1)[1]}", ""),
    "short digest": _swap(API_IMAGE, API_IMAGE[:-1]),
    "other base image": _swap("node:21.1-slim@", "node:22-slim@"),
    "secret ARG": _append_final("ARG SPACE_ADMIN_PASSWORD"),
    "secret ENV": _append_final("ENV JWT_SALT=pepper"),
    "root user": _swap("USER 1000:1000", "USER root"),
    "uid zero": _swap("USER 1000:1000", "USER 0"),
    "user by name": _swap("USER 1000:1000", "USER node"),
    "gid zero": _swap("USER 1000:1000", "USER 1000:0"),
    "no gid": _swap("USER 1000:1000", "USER 1000"),
    "no user": _swap("USER 1000:1000\n", ""),
    "unpinned pnpm": _swap("pnpm@10.9.0", "pnpm@latest"),
    "pnpm major only": _swap("pnpm@10.9.0", "pnpm@10"),
    "pnpm install without frozen lockfile": _swap("pnpm install --frozen-lockfile", "pnpm install"),
    "second install not frozen": _swap("RUN pnpm build", "RUN pnpm install && pnpm build"),
    "wrong port": _swap("EXPOSE 3000", "EXPOSE 8080"),
}

TOOL_MUTATIONS = {
    "tag-only FROM": _swap(f"@sha256:{PYTHON_IMAGE.rsplit(':', 1)[1]}", ""),
    "short digest": _swap(PYTHON_IMAGE, PYTHON_IMAGE[:-1]),
    "pip install of a package name": _swap("pip install --no-cache-dir -r requirements.txt", "pip install httpx"),
    "package next to the requirements": _swap("-r requirements.txt", "-r requirements.txt httpx"),
    "secret ARG": _swap("WORKDIR /app", "ARG SPACE_ADMIN_PASSWORD\nWORKDIR /app"),
    "root user": _swap("USER 1000:1000", "USER root"),
    "user by name": _swap("USER 1000:1000", "USER app"),
    "tool not copied": _swap("COPY lab/tools/space_lab_bootstrap.py ./space_lab_bootstrap.py\n", ""),
    "entrypoint elsewhere": _swap("/app/space_lab_bootstrap.py", "/app/other.py"),
}

REQUIREMENT_MUTATIONS = {
    "range": _swap("httpx==0.28.1", "httpx>=0.27"),
    "compatible release": _swap("httpx==0.28.1", "httpx~=0.28"),
    "URL": _swap("anyio==4.6.0", "anyio @ https://example.org/anyio.whl"),
    "unpinned name": _swap("anyio==4.6.0", "anyio"),
    "extra without pin": _swap("anyio==4.6.0", "anyio[trio]"),
    "httpx missing": _swap("httpx==0.28.1\n", ""),
    "client missing": _swap("space-python-client==1.0.0\n", ""),
}


def test_control_dockerfile_rules_refuse_violations():
    # [utest->req~lab-space-image-pinned-commit~1]
    assert _space_all(SAMPLE_SPACE) is None, "the conforming sample must pass"
    assert _tool_all(SAMPLE_TOOL) is None and rule_requirements(SAMPLE_REQUIREMENTS) is None
    for label, mutate in SPACE_MUTATIONS.items():
        mutated = mutate(SAMPLE_SPACE)
        assert mutated != SAMPLE_SPACE, label
        assert _space_all(mutated), f"space Dockerfile: {label} was not refused"
    for label, mutate in TOOL_MUTATIONS.items():
        mutated = mutate(SAMPLE_TOOL)
        assert mutated != SAMPLE_TOOL, label
        assert _tool_all(mutated), f"tool Dockerfile: {label} was not refused"
    for label, mutate in REQUIREMENT_MUTATIONS.items():
        mutated = mutate(SAMPLE_REQUIREMENTS)
        assert mutated != SAMPLE_REQUIREMENTS, label
        assert rule_requirements(mutated), f"requirements: {label} was not refused"
    # comments may mention the tag and a variable: only commands count
    commented = "# the tag v1.7.1 moves, so only the commit is used\n" + SAMPLE_SPACE
    assert _space_all(commented) is None


# -- the fake SPACE ---------------------------------------------------------------------------------------------------


class FakeSpace:
    """A stateful in-memory SPACE served through ``httpx.MockTransport``; it counts every call and records violations
    (a host other than SPACE_URL's, any SPHERE key header, an unknown api key)."""

    host = "space-api"

    def __init__(self, *, pricings=None, sync_script=("queued", "checking", "applying", "ready"),
                 created_name="openbinding", echo_on_error=False, fail_service_post=False, map_shape=False):
        self.organizations: list[dict] = []
        self.services: dict[str, dict] = {}
        self.sync_status: dict[str, str] = {}
        self.sync_script = list(sync_script)
        self.pricings = pricings if pricings is not None else [{"version": "1.0.0", "id": "p1"}, {"version": "1.1.0", "id": "p2"}]
        self.map_shape = map_shape
        self.created_name = created_name
        self.echo_on_error = echo_on_error
        self.fail_service_post = fail_service_post
        self.requests: list[tuple[str, str]] = []
        self.violations: list[str] = []
        self.issued_keys: list[str] = []
        self.key_posts = 0
        self.org_seq = 0
        self.sync_polls = 0

    # state helpers
    def add_organization(self, *, with_key: bool = False) -> dict:
        self.org_seq += 1
        org = {"id": f"org-{self.org_seq}", "name": "openbinding", "owner": ADMIN_USER, "apiKeys": []}
        if with_key:
            self._new_key(org)
        self.organizations.append(org)
        return org

    def add_service(self, *, ready: bool = True, **overrides) -> dict:
        service = {"name": "openbinding", "source": "sphere", "permanentUrl": SPHERE_LINK, "policy": "all_last"}
        service.update(overrides)
        self.services[service["name"]] = service
        self.sync_status[service["name"]] = "ready" if ready else "queued"
        return service

    def _new_key(self, org: dict) -> str:
        key = f"mgmt-key-sample-{len(self.issued_keys) + 1:03d}-ZZ99"
        org["apiKeys"].append({"key": key, "scope": "MANAGEMENT"})
        self.issued_keys.append(key)
        return key

    @property
    def secrets(self) -> list[str]:
        return [ADMIN_PASSWORD, ADMIN_KEY, *self.issued_keys]

    def count(self, method: str, fragment: str = "") -> int:
        return sum(1 for m, p in self.requests if m == method and fragment in p)

    def changes(self) -> list[tuple[str, str]]:
        """Requests that change SPACE, apart from the authentication."""
        return [(m, p) for m, p in self.requests if m == "POST" and not p.endswith("/users/authenticate")]

    # transport
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.host != self.host:
            self.violations.append(f"request to {request.url.host}")
            return httpx.Response(599, json={"error": "foreign host"})
        for name in request.headers:
            if "sphere" in name.lower():
                self.violations.append(f"SPHERE header {name}")
        method, path = request.method, request.url.path
        self.requests.append((method, path))
        body = json.loads(request.content) if request.content else {}
        if path == "/api/v1/users/authenticate" and method == "POST":
            if body.get("username") == ADMIN_USER and body.get("password") == ADMIN_PASSWORD:
                return httpx.Response(200, json={"username": ADMIN_USER, "apiKey": ADMIN_KEY, "role": "ADMIN"})
            return httpx.Response(401, json={"error": "bad credentials"})
        key = request.headers.get("x-api-key")
        if key != ADMIN_KEY and key not in self.issued_keys:
            self.violations.append(f"unknown api key on {method} {path}")
            return httpx.Response(401, json={"error": "unknown key"})
        return self._route(method, path, body)

    def _route(self, method: str, path: str, body: dict) -> httpx.Response:
        if path == "/api/v1/organizations":
            if method == "GET":
                return httpx.Response(200, json=json.loads(json.dumps(self.organizations)))
            if method == "POST":
                if body.get("name") != "openbinding" or body.get("owner") != ADMIN_USER:
                    return httpx.Response(400, json={"error": "bad organization"})
                org = self.add_organization()
                return httpx.Response(201, json=json.loads(json.dumps(org)))
        match = re.fullmatch(r"/api/v1/organizations/([^/]+)/api-keys", path)
        if match and method == "POST":
            org = next((o for o in self.organizations if o["id"] == match.group(1)), None)
            if org is None or body.get("scope") != "MANAGEMENT":
                return httpx.Response(400, json={"error": "bad key request"})
            self.key_posts += 1
            self._new_key(org)
            return httpx.Response(200, json=json.loads(json.dumps(org)))
        if path == "/api/v1/services" and method == "GET":
            return httpx.Response(200, json=list(self.services.values()))
        if path == "/api/v1/services" and method == "POST":
            if self.fail_service_post:
                text = f"service failed for key {self.issued_keys[-1] if self.issued_keys else ADMIN_KEY} password {ADMIN_PASSWORD}" \
                    if self.echo_on_error else "service failed"
                return httpx.Response(500, json={"error": text}, headers={"x-debug": text} if self.echo_on_error else {})
            if (body.get("source"), body.get("permanentUrl"), body.get("policy")) != ("sphere", SPHERE_LINK, "all_last"):
                return httpx.Response(400, json={"error": "bad service"})
            service = {"name": self.created_name, **body}
            self.services[self.created_name] = service
            self.sync_status[self.created_name] = "queued"
            return httpx.Response(201, json=service)
        match = re.fullmatch(r"/api/v1/services/([^/]+)(/.*)?", path)
        if match:
            name, tail = match.group(1), match.group(2) or ""
            service = self.services.get(name)
            if service is None:
                return httpx.Response(404, json={"error": "not found"})
            if tail == "" and method == "GET":
                return httpx.Response(200, json=service)
            if tail == "/synchronization/run" and method == "POST":
                self.sync_status[name] = "queued"
                return httpx.Response(202, json={"status": "queued"})
            if tail == "/synchronization" and method == "GET":
                if self.sync_status[name] != "ready" and self.sync_script:
                    self.sync_status[name] = self.sync_script.pop(0) if len(self.sync_script) > 1 else self.sync_script[0]
                self.sync_polls += 1
                status = self.sync_status[name]
                return httpx.Response(200, json={"status": status, "error": "sync broke" if status in ("failed", "blocked") else None})
            if tail == "/pricings" and method == "GET":
                if self.map_shape:
                    return httpx.Response(200, json=self.pricings)
                return httpx.Response(200, json=self.pricings)
        return httpx.Response(404, json={"error": f"unexpected {method} {path}"})


class FakeContracts:
    """Records the ContractToCreate models of space_client.types.models; get_contract returns None when missing."""

    def __init__(self):
        self.store: dict[str, SimpleNamespace] = {}
        self.added: list = []
        self.gets: list[str] = []

    def preload(self, name: str, version: str = "1.1.0", plan: str = "FREE") -> None:
        self.store[seed_id(name)] = SimpleNamespace(contracted_services={"openbinding": version},
                                                   subscription_plans={"openbinding": plan})

    async def get_contract(self, user_id: str):
        self.gets.append(user_id)
        return self.store.get(user_id)

    async def add_contract(self, contract_to_create):
        self.added.append(contract_to_create)
        user_id = contract_to_create.user_contact.user_id
        self.store[user_id] = SimpleNamespace(contracted_services=dict(contract_to_create.contracted_services),
                                              subscription_plans=dict(contract_to_create.subscription_plans))
        return contract_to_create


@pytest.fixture
def tool():
    assert TOOL.is_file(), "lab/tools/space_lab_bootstrap.py does not exist yet"
    spec = importlib.util.spec_from_file_location("space_lab_bootstrap_under_test", TOOL)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop(spec.name, None)


def make_config(tool, **overrides):
    values = {"space_url": SPACE_URL, "admin_user": ADMIN_USER, "admin_password": ADMIN_PASSWORD, "plan": "FREE",
              "poll_attempts": 60, "poll_seconds": 5}
    values.update(overrides)
    return tool.Config(**values)


class Sleeps:
    def __init__(self):
        self.calls: list[float] = []

    async def __call__(self, seconds):
        self.calls.append(seconds)


def run(tool, fake: FakeSpace, contracts: FakeContracts, sleeps: Sleeps | None = None, **config):
    sleeps = sleeps if sleeps is not None else Sleeps()
    report = asyncio.run(tool.bootstrap(make_config(tool, **config), transport=fake.transport(), contracts=contracts,
                                        sleep=sleeps))
    assert not fake.violations, fake.violations
    return report


# -- requirement lab-space-bootstrap-creates --------------------------------------------------------------------------


def test_the_configuration_comes_from_the_environment(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    config = tool.Config.from_environ({"SPACE_ADMIN_PASSWORD": "pw"})
    assert (config.space_url, config.admin_user, config.admin_password, config.plan) == (
        "http://space-api:3000", "lab-space-admin", "pw", "FREE")
    assert (config.poll_attempts, config.poll_seconds) == (60, 5)
    config = tool.Config.from_environ({"SPACE_URL": "http://other:3000", "SPACE_ADMIN_USER": "someone",
                                       "SPACE_ADMIN_PASSWORD": "pw", "SPACE_BOOTSTRAP_PLAN": "PRO"})
    assert (config.space_url, config.admin_user, config.plan) == ("http://other:3000", "someone", "PRO")
    with pytest.raises(tool.BootstrapError):
        tool.Config.from_environ({})
    with pytest.raises(tool.BootstrapError):
        tool.Config.from_environ({"SPACE_URL": "http://x:3000", "SPACE_ADMIN_PASSWORD": ""})
    with pytest.raises(Exception):
        config.plan = "OTHER"  # frozen dataclass


def test_the_constants_and_the_synthetic_users_follow_the_seed(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    assert (tool.SPHERE_LINK, tool.SERVICE_NAME, tool.ORGANIZATION_NAME, tool.SOURCE, tool.POLICY) == (
        SPHERE_LINK, "openbinding", "openbinding", "sphere", "all_last")
    assert tuple(tool.SYNTHETIC_USERS) == USERS
    for name in USERS:
        assert tool.synthetic_user_id(name) == seed_id(name)
    assert issubclass(tool.BootstrapError, Exception)
    # the test's copies follow seed_lab.py itself (the tool keeps its own copy, see design.md section 3)
    seed = SEED.read_text(encoding="utf-8")
    assert f'SEED_NAMESPACE = uuid.UUID("{SEED_NAMESPACE}")' in seed
    assert re.findall(r'^    \("(lab-[a-z]+)", UserRole', seed, re.MULTILINE) == list(USERS)


def test_it_creates_organization_key_service_and_contracts(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    fake, contracts = FakeSpace(), FakeContracts()
    report = run(tool, fake, contracts)
    assert report == {"organization": "created", "apiKey": "created", "service": "created", "synchronization": "ready",
                      "contracts": {name: "created" for name in USERS}}
    assert len(fake.organizations) == 1 and fake.organizations[0]["owner"] == ADMIN_USER
    assert [k["scope"] for k in fake.organizations[0]["apiKeys"]] == ["MANAGEMENT"]
    assert set(fake.services) == {"openbinding"}
    assert len(contracts.added) == 6


def test_the_service_comes_from_the_sphere_link_with_all_last(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    posted: list[dict] = []
    fake, contracts = FakeSpace(), FakeContracts()
    inner = fake._handle

    def spy(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/api/v1/services":
            posted.append(json.loads(request.content))
        return inner(request)

    transport = httpx.MockTransport(spy)
    asyncio.run(tool.bootstrap(make_config(tool), transport=transport, contracts=contracts, sleep=Sleeps()))
    assert posted == [{"source": "sphere", "permanentUrl": SPHERE_LINK, "policy": "all_last"}]
    assert fake.count("POST", "/api/v1/services") == 1


def test_it_waits_for_the_first_synchronization(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    fake, contracts, sleeps = FakeSpace(sync_script=("queued", "checking", "applying", "ready")), FakeContracts(), Sleeps()
    report = run(tool, fake, contracts, sleeps)
    assert report["synchronization"] == "ready"
    assert fake.count("POST", "/synchronization/run") == 1
    assert fake.sync_polls == 4
    assert sleeps.calls and set(sleeps.calls) == {5} and len(sleeps.calls) <= 60
    # the run comes before the first poll; contracts only after readiness
    paths = [p for _, p in fake.requests]
    assert paths.index("/api/v1/services/openbinding/synchronization/run") < paths.index(
        "/api/v1/services/openbinding/synchronization")
    assert len(contracts.added) == 6


def test_contracts_use_the_client_and_the_ids_of_the_seed(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    pricings = [{"version": "1.0.0", "id": "a"}, {"version": "1.10.0", "id": "b"}, {"version": "1.2.0", "id": "c"}]
    fake, contracts = FakeSpace(pricings=pricings), FakeContracts()
    run(tool, fake, contracts, plan="PRO")
    models = {m.user_contact.user_id: m for m in contracts.added}
    assert set(models) == {seed_id(n) for n in USERS}
    for name in USERS:
        model = models[seed_id(name)]
        assert model.user_contact.email == f"{name}@example.org"
        assert model.contracted_services == {"openbinding": "1.10.0"}, "versions compare numerically"
        assert model.subscription_plans == {"openbinding": "PRO"}
        assert not model.subscription_add_ons
    assert set(contracts.gets) == set(models)


def test_archived_pricings_are_ignored_in_the_map_shape(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    pricings = {"activePricings": {"1.0.0": {}, "1.1.0": {}}, "archivedPricings": {"2.0.0": {}}}
    fake, contracts = FakeSpace(pricings=pricings, map_shape=True), FakeContracts()
    run(tool, fake, contracts)
    assert {m.contracted_services["openbinding"] for m in contracts.added} == {"1.1.0"}


def _assert_aborted(tool, fake: FakeSpace, contracts: FakeContracts, named: str = "", **config):
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(tool.bootstrap(make_config(tool, **config), transport=fake.transport(), contracts=contracts,
                                   sleep=Sleeps()))
    assert not fake.violations, fake.violations
    assert contracts.added == [], "a contract was created after the abort"
    assert re.search(named, str(raised.value), re.IGNORECASE), f"the error must name the failed item ({named!r})"


@pytest.mark.parametrize("status", ["failed", "blocked", "degraded"])
def test_a_failed_synchronization_or_foreign_service_name_aborts(tool, status):
    # [utest->req~lab-space-bootstrap-creates~1]
    _assert_aborted(tool, FakeSpace(sync_script=("queued", status)), FakeContracts(), "synchroni")

    # through main: non-zero status and one redacted line on stderr
    fake = FakeSpace(sync_script=("queued", status))
    real = tool.bootstrap

    async def aborting(config, **kwargs):
        return await real(config, transport=fake.transport(), contracts=FakeContracts(), sleep=Sleeps())

    tool.bootstrap = aborting
    try:
        environ = {"SPACE_URL": SPACE_URL, "SPACE_ADMIN_USER": ADMIN_USER, "SPACE_ADMIN_PASSWORD": ADMIN_PASSWORD}
        assert tool.main([], environ) == 1
    finally:
        tool.bootstrap = real


def test_a_synchronization_that_never_gets_ready_aborts_after_the_polls(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    fake, contracts, sleeps = FakeSpace(sync_script=("checking",)), FakeContracts(), Sleeps()
    with pytest.raises(tool.BootstrapError):
        asyncio.run(tool.bootstrap(make_config(tool, poll_attempts=3), transport=fake.transport(), contracts=contracts,
                                   sleep=sleeps))
    assert fake.sync_polls == 3 and len(sleeps.calls) <= 3 and contracts.added == []


def test_a_created_service_with_a_foreign_name_aborts(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    _assert_aborted(tool, FakeSpace(created_name="something-else"), FakeContracts(), "service")


def test_no_active_pricing_version_aborts(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    _assert_aborted(tool, FakeSpace(pricings=[]), FakeContracts(), "pricing")
    _assert_aborted(tool, FakeSpace(pricings={"activePricings": {}, "archivedPricings": {"2.0.0": {}}}, map_shape=True),
                    FakeContracts(), "pricing")


@pytest.mark.parametrize("override", [{"source": "local"}, {"permanentUrl": "https://sphere.score.us.es/p/other"},
                                      {"policy": "all_first"}])
def test_an_existing_service_with_other_settings_aborts_unchanged(tool, override):
    # [utest->req~lab-space-bootstrap-creates~1]
    fake, contracts = FakeSpace(), FakeContracts()
    fake.add_organization(with_key=True)
    before = dict(fake.add_service(**override))
    _assert_aborted(tool, fake, contracts, "service")
    assert fake.services["openbinding"] == before, "the existing service was modified"
    assert fake.changes() == [], "the abort must not create or run anything"


# -- requirement lab-space-bootstrap-idempotent -----------------------------------------------------------------------


def test_a_second_run_changes_nothing(tool):
    # [utest->req~lab-space-bootstrap-idempotent~1]
    fake, contracts = FakeSpace(), FakeContracts()
    run(tool, fake, contracts)
    fake.requests.clear()
    contracts.added.clear()
    report = run(tool, fake, contracts)
    assert report == {"organization": "exists", "apiKey": "exists", "service": "exists", "synchronization": "skipped",
                      "contracts": {name: "exists" for name in USERS}}
    assert fake.changes() == [], "a second run sent a creating request"
    assert contracts.added == []
    assert fake.count("POST", "/synchronization/run") == 0 and fake.key_posts == 1
    assert len(fake.organizations) == 1 and len(fake.organizations[0]["apiKeys"]) == 1


def test_a_partial_state_is_completed(tool):
    # [utest->req~lab-space-bootstrap-idempotent~1]
    # only the organization exists
    fake, contracts = FakeSpace(), FakeContracts()
    fake.add_organization()
    report = run(tool, fake, contracts)
    assert report["organization"] == "exists" and report["apiKey"] == "created" and report["service"] == "created"
    assert set(report["contracts"].values()) == {"created"}
    assert len(fake.organizations) == 1 and fake.key_posts == 1, "the existing organization is reused, its key created"

    # organization, key and ready service present; contracts for two users only
    fake, contracts = FakeSpace(), FakeContracts()
    fake.add_organization(with_key=True)
    fake.add_service(ready=True)
    contracts.preload("lab-admin")
    contracts.preload("lab-owner")
    report = run(tool, fake, contracts)
    assert report["organization"] == "exists" and report["apiKey"] == "exists" and report["service"] == "exists"
    assert report["synchronization"] == "skipped"
    assert report["contracts"] == {"lab-admin": "exists", "lab-owner": "exists", "lab-orgadmin": "created",
                                   "lab-member": "created", "lab-viewer": "created", "lab-outsider": "created"}
    assert {m.user_contact.user_id for m in contracts.added} == {seed_id(n) for n in USERS[2:]}
    assert fake.key_posts == 0, "the existing MANAGEMENT key must be reused"
    assert fake.changes() == []


# -- requirement lab-space-bootstrap-sphere-readonly ------------------------------------------------------------------


def _source() -> str:
    assert TOOL.is_file(), "lab/tools/space_lab_bootstrap.py does not exist yet"
    return TOOL.read_text(encoding="utf-8")


def test_the_tool_holds_no_sphere_key_and_never_writes_to_sphere(tool):
    # [utest->req~lab-space-bootstrap-sphere-readonly~1]
    source = _source()
    code = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("#"))
    assert "SPHERE_API_KEY" not in source
    assert not re.search(r"environ(?:\.get)?\s*[\[(]\s*['\"]SPHERE_", code), "reads a SPHERE_* variable"
    assert not re.search(r"""open\([^)]*['"][wax+]b?['"]|\.write_text\(|\.write_bytes\(|Path\([^)]*\)\.write|os\.write\(|\.write\(""",
                         code), "the tool writes to a file"
    assert not re.search(r"(print|log\w*\.\w+|logger\.\w+|logging\.\w+)\([^)]*(password|api_?key|\.key\b|secret)", code,
                         re.IGNORECASE), "a password or key is printed or logged"
    # behaviour: every request goes to the SPACE host, none to SPHERE and none with a SPHERE header
    fake, contracts = FakeSpace(), FakeContracts()
    run(tool, fake, contracts)
    assert fake.violations == [] and fake.requests
    assert tool.SPHERE_LINK == SPHERE_LINK  # only sent to SPACE as data, never requested


def _logging_records(caplog):
    return "\n".join(f"{r.getMessage()} {r.exc_text or ''} {r.args}" for r in caplog.records)


def test_nothing_secret_is_printed_or_persisted(tool, capsys, caplog, tmp_path, monkeypatch):
    # [utest->req~lab-space-bootstrap-sphere-readonly~1]
    monkeypatch.chdir(tmp_path)
    caplog.set_level(logging.DEBUG)

    def assert_clean(fake: FakeSpace, *extra: str):
        out, err = capsys.readouterr()
        haystack = "\n".join([out, err, _logging_records(caplog), *extra])
        for secret in fake.secrets:
            assert secret not in haystack, "a secret reached the output, a log or an error"
        assert list(tmp_path.iterdir()) == [], "the tool wrote a file"

    # a successful run through main
    fake, contracts = FakeSpace(), FakeContracts()
    environ = {"SPACE_URL": SPACE_URL, "SPACE_ADMIN_USER": ADMIN_USER, "SPACE_ADMIN_PASSWORD": ADMIN_PASSWORD}

    async def fake_bootstrap(config, **kwargs):
        return await real(config, transport=fake.transport(), contracts=contracts, sleep=Sleeps())

    real = tool.bootstrap
    monkeypatch.setattr(tool, "bootstrap", fake_bootstrap)
    assert tool.main([], environ) == 0
    out, err = capsys.readouterr()
    assert len(out.strip().splitlines()) == 1 and json.loads(out)["organization"] == "created"
    for secret in fake.secrets:
        assert secret not in out and secret not in err
    assert_clean(fake)

    # bootstrap directly: the report holds no secret
    fake, contracts = FakeSpace(), FakeContracts()
    report = asyncio.run(real(make_config(tool), transport=fake.transport(), contracts=contracts, sleep=Sleeps()))
    assert_clean(fake, json.dumps(report))

    # a failing run whose error body echoes the key and the password
    fake, contracts = FakeSpace(echo_on_error=True, fail_service_post=True), FakeContracts()
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(real(make_config(tool), transport=fake.transport(), contracts=contracts, sleep=Sleeps()))
    text = "".join([str(raised.value), repr(raised.value), *map(str, raised.value.args)])
    chain = raised.value
    while chain.__cause__ or chain.__context__:
        chain = chain.__cause__ or chain.__context__
        text += str(chain) + repr(chain)
    assert fake.issued_keys, "the failure must happen after a key was issued"
    assert_clean(fake, text)

    # the same failure through main: one redacted line on stderr, status 1
    fake, contracts = FakeSpace(echo_on_error=True, fail_service_post=True), FakeContracts()

    async def failing(config, **kwargs):
        return await real(config, transport=fake.transport(), contracts=contracts, sleep=Sleeps())

    monkeypatch.setattr(tool, "bootstrap", failing)
    assert tool.main([], environ) == 1
    out, err = capsys.readouterr()
    assert out == "" and len(err.strip().splitlines()) == 1
    for secret in fake.secrets:
        assert secret not in err
    assert list(tmp_path.iterdir()) == []
