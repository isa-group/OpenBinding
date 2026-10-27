"""Tests of the SPACE lab bootstrap: the Dockerfile of ``lab/tools`` (static rules) and the tool
``lab/tools/space_lab_bootstrap.py`` (behaviour against a stateful in-memory fake of the REMOTE SPACE; no network, no
Docker).

The tool talks to https://space.score.us.es with a MANAGEMENT api key only: it never authenticates a user, never touches
an organization or an api key, and never lets the key out.  The Dockerfile rules are plain functions of the file text
that return a failure message or None.  The ``control`` tests call them on conforming in-memory samples, mutated, so
every rule is proven to refuse what it must.  The tool is loaded by file path inside a fixture, so a missing module
fails the test at run time while collection still works.  Tests drive the async code with ``asyncio.run`` and need no
pytest plugin.

Run from ``openbinding-gateway`` with its environment::

    uv run --locked --extra test pytest ../lab/tests
"""

from __future__ import annotations

import ast
import asyncio
import dataclasses
import fnmatch
import importlib.util
import json
import logging
import os
import re
import sys
import tomllib
import uuid
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

TOOL_DOCKERFILE = ROOT / "lab" / "tools" / "Dockerfile"
REQUIREMENTS = ROOT / "lab" / "tools" / "requirements.txt"
TOOL = ROOT / "lab" / "tools" / "space_lab_bootstrap.py"
SEED = ROOT / "openbinding-gateway" / "tools" / "seed_lab.py"

PYTHON_IMAGE = "python:3.12.8-slim-bookworm@sha256:2199a62885a12290dc9c5be3ca0681d367576ab7bf037da120e564723292a2f0"
SPHERE_LINK = "https://sphere.score.us.es/p/6ab0a323697330667ccce891"
USERS = ("lab-admin", "lab-owner", "lab-orgadmin", "lab-member", "lab-viewer", "lab-outsider")
# The seed's id function (openbinding-gateway/tools/seed_lab.py): uuid5(SEED_NAMESPACE, "user:<username>").
SEED_NAMESPACE = uuid.UUID("6f1d3a52-8c0e-4b7a-9d21-0f5e7c3a9b10")

SPACE_URL = "https://space.score.us.es"
API_KEY = "mgmt-key-sample-001-ZZ99"
SPHERE_SAMPLE_KEY = "sphere-sample-key"
SECRET_SAMPLE = "sk-" + "A" * 20  # built at run time: a secret scanner must not flag the file
PROXY_VARIABLES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy")
UV_LOCK = ROOT / "openbinding-gateway" / "uv.lock"
IN_PROGRESS = ("queued", "checking", "applying")
NO_AUTH_ROUTES = ("/users/authenticate", "/organizations", "api-keys")


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


def host_copy_sources(text: str) -> list[str]:
    """Sources of the COPY/ADD instructions that read the build context (those without --from), as written."""
    found = []
    for name, args in instructions(text):
        if name not in ("COPY", "ADD"):
            continue
        tokens = args.split()
        if any(t.startswith("--from=") for t in tokens):
            continue
        tokens = [t for t in tokens if not t.startswith("--")]
        found.extend(t[2:] if t.startswith("./") else t for t in tokens[:-1])
    return found


def ignored_by_context(path: str, patterns: list[str]) -> bool:
    """.dockerignore semantics for the three kinds used here: ``*``, ``!name`` and plain names (the last match wins;
    a pattern matching a parent directory of the path matches the path)."""
    parts = path.split("/")
    prefixes = ["/".join(parts[:i]) for i in range(1, len(parts) + 1)]
    state = False
    for raw in patterns:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        negate = line.startswith("!")
        pattern = (line[1:] if negate else line).strip("/")
        if any(fnmatch.fnmatchcase(p, pattern) for p in prefixes):
            state = not negate
    return state


def rule_context_copies(text: str, patterns: list[str]) -> str | None:
    for source in host_copy_sources(text):
        if ignored_by_context(source, patterns):
            return f"COPY source {source!r} is excluded by the .dockerignore of the build context"
    return None


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
    # the build context is lab/tools: sources are relative to it
    sources = host_copy_sources(text)
    if "requirements.txt" not in sources:
        return "requirements.txt is not copied"
    if "space_lab_bootstrap.py" not in sources:
        return "space_lab_bootstrap.py is not copied"
    if set(sources) - {"requirements.txt", "space_lab_bootstrap.py"}:
        return f"unexpected COPY sources {sources} (the context is lab/tools)"
    entry = [a for n, a in instructions(text) if n == "ENTRYPOINT"]
    if not entry or "space_lab_bootstrap" not in entry[-1]:
        return "ENTRYPOINT must run the tool"
    return None


SAMPLE_TOOL = f"""FROM {PYTHON_IMAGE}
WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY space_lab_bootstrap.py ./space_lab_bootstrap.py
USER 1000:1000
ENTRYPOINT ["python", "/app/space_lab_bootstrap.py"]
"""

SAMPLE_REQUIREMENTS = "# pinned\nhttpx==0.28.1\nspace-python-client==1.0.0\nanyio==4.6.0  # transitive\n"


# -- the real files --------------------------------------------------------------------------------------------------


def _read(path: Path) -> str:
    assert path.is_file(), f"{path.relative_to(ROOT)} does not exist yet"
    return path.read_text(encoding="utf-8")


def test_tool_dockerfile_pins_digest_and_requirements():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    assert rule_tool_dockerfile(_read(TOOL_DOCKERFILE)) is None
    assert rule_requirements(_read(REQUIREMENTS)) is None


# -- controls: the Dockerfile rules on conforming in-memory samples, mutated ------------------------------------------


def _swap(old: str, new: str):
    def mutate(text: str) -> str:
        assert old in text, old
        return text.replace(old, new, 1)
    return mutate


TOOL_MUTATIONS = {
    "tag-only FROM": _swap(f"@sha256:{PYTHON_IMAGE.rsplit(':', 1)[1]}", ""),
    "short digest": _swap(PYTHON_IMAGE, PYTHON_IMAGE[:-1]),
    "pip install of a package name": _swap("pip install --no-cache-dir -r requirements.txt", "pip install httpx"),
    "package next to the requirements": _swap("-r requirements.txt", "-r requirements.txt httpx"),
    "secret ARG": _swap("WORKDIR /app", "ARG SPACE_API_KEY\nWORKDIR /app"),
    "root user": _swap("USER 1000:1000", "USER root"),
    "user by name": _swap("USER 1000:1000", "USER app"),
    "secret-shaped literal": _swap("WORKDIR /app", f"ENV GREETING={SECRET_SAMPLE}\nWORKDIR /app"),
    "tool not copied": _swap("COPY space_lab_bootstrap.py ./space_lab_bootstrap.py\n", ""),
    "requirements not copied": _swap("COPY requirements.txt ./requirements.txt\n", ""),
    "source relative to the repository root": _swap("COPY space_lab_bootstrap.py", "COPY lab/tools/space_lab_bootstrap.py"),
    "extra file copied": _swap("COPY space_lab_bootstrap.py ./", "COPY secrets.env space_lab_bootstrap.py ./"),
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
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    assert rule_tool_dockerfile(SAMPLE_TOOL) is None and rule_requirements(SAMPLE_REQUIREMENTS) is None
    for label, mutate in TOOL_MUTATIONS.items():
        mutated = mutate(SAMPLE_TOOL)
        assert mutated != SAMPLE_TOOL, label
        assert rule_tool_dockerfile(mutated), f"tool Dockerfile: {label} was not refused"
    for label, mutate in REQUIREMENT_MUTATIONS.items():
        mutated = mutate(SAMPLE_REQUIREMENTS)
        assert mutated != SAMPLE_REQUIREMENTS, label
        assert rule_requirements(mutated), f"requirements: {label} was not refused"
    # comments may mention anything: only instructions count
    assert rule_tool_dockerfile(f"# the key is SPACE_API_KEY={SECRET_SAMPLE}\n" + SAMPLE_TOOL) is None


def _from_tool(text: str) -> str | None:
    return rule_from_lines(text, [PYTHON_IMAGE])


# (rule, mutations, labels): each listed mutation must be refused by that rule alone, not by a neighbour
ALONE_CONTROLS = [
    (_from_tool, ["tag-only FROM", "short digest"]),
    (rule_no_secret, ["secret ARG", "secret-shaped literal"]),
    (rule_user, ["root user", "user by name"]),
    (rule_tool_dockerfile, ["pip install of a package name", "package next to the requirements", "tool not copied",
                            "requirements not copied", "source relative to the repository root", "extra file copied",
                            "entrypoint elsewhere"]),
]


def test_control_each_dockerfile_rule_refuses_its_mutations_alone():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    for rule, labels in ALONE_CONTROLS:
        assert rule(SAMPLE_TOOL) is None, f"{rule.__name__}: the conforming sample must pass"
        for label in labels:
            mutated = TOOL_MUTATIONS[label](SAMPLE_TOOL)
            assert mutated != SAMPLE_TOOL, label
            assert rule(mutated), f"{rule.__name__}: {label} was not refused by this rule alone"


# -- the build context: every host COPY must survive the .dockerignore of the declared context -----------------------

TOOL_CONTEXT = ROOT / "lab" / "tools"  # `docker build -f lab/tools/Dockerfile lab/tools`
SAMPLE_IGNORE = ["*", "!requirements.txt", "!space_lab_bootstrap.py"]


def test_every_host_copy_survives_the_ignore_rules_of_its_context():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    ignore = TOOL_CONTEXT / ".dockerignore"
    assert ignore.is_file(), f"{ignore.relative_to(ROOT)} does not exist"
    text = _read(TOOL_DOCKERFILE)
    assert rule_context_copies(text, ignore.read_text(encoding="utf-8").splitlines()) is None
    for source in host_copy_sources(text):
        assert (TOOL_CONTEXT / source).is_file(), f"{source} is not in {TOOL_CONTEXT.relative_to(ROOT)}"
    assert host_copy_sources(text), "the tool image copies nothing from its context"
    assert not (ROOT / "lab" / "tools" / "Dockerfile.dockerignore").exists(), "a Dockerfile.dockerignore is forbidden"


def test_control_the_context_matcher_refuses_excluded_copies():
    # [utest->req~lab-deployment-remote-bootstrap-profile~1]
    assert rule_context_copies(SAMPLE_TOOL, SAMPLE_IGNORE) is None
    assert host_copy_sources(SAMPLE_TOOL) == ["requirements.txt", "space_lab_bootstrap.py"]
    assert rule_context_copies(SAMPLE_TOOL, ["*"]), "everything excluded must be refused"
    assert rule_context_copies(SAMPLE_TOOL, ["*", "!requirements.txt"]), "an excluded tool source must be refused"
    assert rule_context_copies(SAMPLE_TOOL, ["*", "!space_lab_bootstrap.py"]), "an excluded requirements file must be refused"
    assert rule_context_copies(SAMPLE_TOOL, ["requirements.txt", "!requirements.txt", "space_lab_bootstrap.py"])
    old = SAMPLE_TOOL.replace("COPY requirements.txt", "COPY lab/tools/requirements.txt")
    assert rule_context_copies(old, SAMPLE_IGNORE), "a repository-root path is not in the lab/tools context"
    assert rule_context_copies(SAMPLE_TOOL.replace("COPY space_lab_bootstrap.py", "COPY secrets.env"), SAMPLE_IGNORE)


# -- the fake remote SPACE --------------------------------------------------------------------------------------------


class FakeSpace:
    """A stateful in-memory remote SPACE served through ``httpx.MockTransport``; it records every call and every
    violation: a host or port other than SPACE_URL's, a scheme other than https, a request without the MANAGEMENT key
    in ``x-api-key``, a SPHERE header, or a call to a retired route (user authentication, organizations, api keys).

    The shapes follow SPACE at ef4dc894 as read from its source (MEDIUM confidence, unverified live): a service created
    from SPHERE carries ``source`` and the ``sphere`` sub-document; the synchronization status is
    ``configuration.status`` (``sync_shape="top"``: top level).  ``echo_on_error`` puts the key in the body and in a
    header of the failing answers; ``reject_key`` answers every request 401 with the key echoed.
    """

    def __init__(self, *, host="space.score.us.es", port=None, key=API_KEY, pricings=None,
                 sync_script=("queued", "checking", "applying", "ready"), created_name="openbinding",
                 echo_on_error=False, fail_service_post=False, sync_shape="nested", redirect_services=None,
                 reject_key=False, summaries=False):
        self.host, self.port, self.key = host, port, key
        self.summaries = summaries
        self.services: dict[str, dict] = {}
        self.sync_status: dict[str, str] = {}
        self.sync_script = list(sync_script)
        self.pricings = pricings if pricings is not None else [{"version": "1.0.0", "id": "p1"}, {"version": "1.1.0", "id": "p2"}]
        self.created_name = created_name
        self.echo_on_error = echo_on_error
        self.fail_service_post = fail_service_post
        self.sync_shape = sync_shape
        self.redirect_services = redirect_services
        self.reject_key = reject_key
        self.requests: list[tuple[str, str]] = []
        self.sent: list[str] = []
        self.violations: list[str] = []
        self.sync_polls = 0

    # state helpers
    def add_service(self, *, ready: bool = True, sync: str | None = None, flat: bool = False, **overrides) -> dict:
        settings = {"source": "sphere", "permanentUrl": SPHERE_LINK, "policy": "all_last"}
        settings.update(overrides)
        if flat:
            service = {"name": "openbinding", **settings}
        else:
            service = {"name": "openbinding", "source": settings["source"],
                       "sphere": {"permanentUrl": settings["permanentUrl"], "policy": settings["policy"], "status": "ready"}}
        self.services[service["name"]] = service
        self.sync_status[service["name"]] = sync or ("ready" if ready else "queued")
        return service

    @property
    def secrets(self) -> list[str]:
        return [self.key]

    def count(self, method: str, fragment: str = "", exact: bool = False) -> int:
        return sum(1 for m, p in self.requests if m == method and (p == fragment if exact else fragment in p))

    def changes(self) -> list[tuple[str, str]]:
        """Every request other than a GET."""
        return [(m, p) for m, p in self.requests if m != "GET"]

    # transport
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.host != self.host or request.url.port != self.port:
            self.violations.append(f"request to {request.url.host}:{request.url.port}")
            return httpx.Response(599, json={"error": "foreign host"})
        if request.url.scheme != "https":
            self.violations.append(f"scheme {request.url.scheme}")
        for name in request.headers:
            if "sphere" in name.lower():
                self.violations.append(f"SPHERE header {name}")
        method, path = request.method, request.url.path
        self.requests.append((method, path))
        self.sent.append(f"{request.url} {dict(request.headers)} {request.content.decode('utf-8', 'replace')}")
        if any(route in path for route in NO_AUTH_ROUTES):
            self.violations.append(f"retired route {method} {path}")
            return httpx.Response(404, json={"error": "not used"})
        if request.headers.get("x-api-key") != self.key:
            self.violations.append(f"missing or wrong x-api-key on {method} {path}")
            return httpx.Response(401, json={"error": "MANAGEMENT key required"})
        if self.reject_key:
            return httpx.Response(401, json={"error": f"rejected key {self.key}"}, headers={"x-debug": self.key})
        body = json.loads(request.content) if request.content else {}
        return self._route(method, path, body)

    def _route(self, method: str, path: str, body: dict) -> httpx.Response:
        if path == "/api/v1/services" and method == "GET":
            if self.redirect_services:
                return httpx.Response(302, headers={"location": self.redirect_services})
            if self.summaries:  # the list carries summaries; source and sphere only on the item route
                return httpx.Response(200, json=[{"name": s["name"], "status": "active"} for s in self.services.values()])
            return httpx.Response(200, json=json.loads(json.dumps(list(self.services.values()))))
        if path == "/api/v1/services" and method == "POST":
            if self.fail_service_post:
                text = f"service failed for key {self.key}" if self.echo_on_error else "service failed"
                return httpx.Response(500, json={"error": text}, headers={"x-debug": text} if self.echo_on_error else {})
            if (body.get("source"), body.get("permanentUrl"), body.get("policy")) != ("sphere", SPHERE_LINK, "all_last"):
                return httpx.Response(400, json={"error": "bad service"})
            service = {"name": self.created_name, "source": "sphere",
                       "sphere": {"permanentUrl": SPHERE_LINK, "policy": "all_last", "status": "queued"}}
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
            if tail == "" and method in ("PUT", "PATCH"):
                service.update(body)
                return httpx.Response(200, json=service)
            if tail == "" and method == "DELETE":
                del self.services[name]
                return httpx.Response(204)
            if tail == "/synchronization/run" and method == "POST":
                self.sync_status[name] = "queued"
                return httpx.Response(202, json={"status": "queued"})
            if tail == "/synchronization" and method == "GET":
                # only a synchronization in progress advances; ready and the abort statuses stay
                if self.sync_status[name] in IN_PROGRESS and self.sync_script:
                    self.sync_status[name] = self.sync_script.pop(0) if len(self.sync_script) > 1 else self.sync_script[0]
                self.sync_polls += 1
                status = self.sync_status[name]
                if self.sync_shape == "top":
                    return httpx.Response(200, json={"status": status})
                return httpx.Response(200, json={
                    "source": "sphere",
                    "configuration": {"permanentUrl": SPHERE_LINK, "policy": "all_last", "status": status,
                                      "error": "sync broke" if status in ("failed", "blocked") else None},
                    "retainedVersions": [], "run": None})
            if tail == "/pricings" and method == "GET":
                return httpx.Response(200, json=self.pricings)
        return httpx.Response(404, json={"error": f"unexpected {method} {path}"})


def space_api_error(status_code: int, payload=None):
    """A SpaceApiError as space-python-client 1.0.0 raises it: (status_code, method, path, payload)."""
    from space_client import SpaceApiError

    return SpaceApiError(status_code=status_code, method="GET", path="/contracts/sample", payload=payload)


class FakeContracts:
    """Records the ContractToCreate models of space_client.types.models.

    ``missing``: what get_contract does for a user without a contract, ``"none"`` (return None) or ``"404"`` (raise
    SpaceApiError 404, as the client does).  ``refuse``: add_contract returns None and stores nothing, as the client
    does on a 4xx.  ``error``: an exception get_contract raises for every user.
    """

    def __init__(self, *, missing: str = "none", refuse: bool = False, error: Exception | None = None):
        self.store: dict[str, SimpleNamespace] = {}
        self.added: list = []
        self.gets: list[str] = []
        self.missing, self.refuse, self.error = missing, refuse, error

    def preload(self, name: str, version: str = "1.1.0", plan: str = "FREE") -> None:
        self.store[seed_id(name)] = SimpleNamespace(contracted_services={"openbinding": version},
                                                   subscription_plans={"openbinding": plan})

    async def get_contract(self, user_id: str):
        self.gets.append(user_id)
        if self.error is not None:
            raise self.error
        if user_id not in self.store and self.missing == "404":
            raise space_api_error(404, {"error": "Contract not found"})
        return self.store.get(user_id)

    async def add_contract(self, contract_to_create):
        self.added.append(contract_to_create)
        if self.refuse:
            return None
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


def make_config(tool, environ=None, **overrides):
    """The configuration as the environment gives it (SPACE_URL and SPACE_API_KEY), then dataclass overrides."""
    config = tool.Config.from_environ({"SPACE_URL": SPACE_URL, "SPACE_API_KEY": API_KEY, **(environ or {})})
    return dataclasses.replace(config, **overrides) if overrides else config


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


def _created_report() -> dict:
    return {"service": "created", "synchronization": "ready", "contracts": {name: "created" for name in USERS}}


def _existing_report() -> dict:
    return {"service": "exists", "synchronization": "skipped", "contracts": {name: "exists" for name in USERS}}


# -- configuration ----------------------------------------------------------------------------------------------------


def test_the_configuration_comes_from_the_environment(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    config = tool.Config.from_environ({"SPACE_API_KEY": API_KEY})
    assert (config.space_url, config.plan) == ("https://space.score.us.es", "FREE")
    assert (config.poll_attempts, config.poll_seconds) == (60, 5)
    config = tool.Config.from_environ({"SPACE_URL": "https://other.example.org", "SPACE_API_KEY": API_KEY,
                                       "SPACE_BOOTSTRAP_PLAN": "PRO"})
    assert (config.space_url, config.plan) == ("https://other.example.org", "PRO")
    # the empty string selects the defaults
    config = tool.Config.from_environ({"SPACE_URL": "", "SPACE_API_KEY": API_KEY, "SPACE_BOOTSTRAP_PLAN": ""})
    assert (config.space_url, config.plan) == ("https://space.score.us.es", "FREE")
    with pytest.raises(Exception):
        config.plan = "OTHER"  # frozen dataclass


def test_the_admin_user_and_password_are_gone(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    names = {field.name for field in dataclasses.fields(tool.Config)}
    assert not {name for name in names if "admin" in name or "password" in name}, names
    # an old SPACE_ADMIN_* configuration neither satisfies nor changes the new one
    with pytest.raises(tool.BootstrapError) as raised:
        tool.Config.from_environ({"SPACE_ADMIN_USER": "lab-space-admin", "SPACE_ADMIN_PASSWORD": "pw"})
    assert str(raised.value) == "configuration: SPACE_API_KEY is required"


@pytest.mark.parametrize("environ", [{}, {"SPACE_API_KEY": ""}, {"SPACE_URL": SPACE_URL}])
def test_a_missing_api_key_is_refused(tool, environ):
    # [utest->req~lab-space-remote-bootstrap~1]
    with pytest.raises(tool.BootstrapError) as raised:
        tool.Config.from_environ(environ)
    assert str(raised.value) == "configuration: SPACE_API_KEY is required"


@pytest.mark.parametrize("url", ["http://space.score.us.es", "http://space-api:3000", "ftp://x",
                                 "https://user:pw@space.score.us.es", "https://", "https:///path", "space.score.us.es",
                                 "https://:443", "https://host:abc", "https://host:99999",
                                 "https://space.score.us.es?x=1", "https://space.score.us.es#a",
                                 "https://space.score.us.es\\@evil.example", "https://space.score.us.es/\n",
                                 "https://space.score.us.es/api", "https://space.score.us.es/ ",
                                 "https://space.score.us.es\t", "https://space.score.us.es/\x00",
                                 "https://space.score.us.es?", "https://space.score.us.es/#"])
def test_an_invalid_space_url_is_refused(tool, url):
    # [utest->req~lab-space-remote-bootstrap~1]
    with pytest.raises(tool.BootstrapError) as raised:
        tool.Config.from_environ({"SPACE_URL": url, "SPACE_API_KEY": API_KEY})
    assert url not in str(raised.value) and "user:pw" not in _error_text(raised.value)
    assert API_KEY not in _error_text(raised.value)
    assert str(raised.value).startswith("configuration: SPACE_URL")


@pytest.mark.parametrize("url, expected", [
    ("https://space.score.us.es", "https://space.score.us.es"),
    ("https://space.example.org", "https://space.example.org"),
    ("https://other-space.example:8443/", "https://other-space.example:8443"),
])
def test_a_valid_space_url_is_accepted_and_normalised(tool, url, expected):
    # [utest->req~lab-space-remote-bootstrap~1]
    assert tool.Config.from_environ({"SPACE_URL": url, "SPACE_API_KEY": API_KEY}).space_url == expected


def test_the_constants_and_the_synthetic_users_follow_the_seed(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    assert (tool.SPHERE_LINK, tool.SERVICE_NAME, tool.SOURCE, tool.POLICY) == (
        SPHERE_LINK, "openbinding", "sphere", "all_last")
    assert tuple(tool.SYNTHETIC_USERS) == USERS
    for name in USERS:
        assert tool.synthetic_user_id(name) == seed_id(name)
    assert issubclass(tool.BootstrapError, Exception)
    # the test's copies follow seed_lab.py itself (the tool keeps its own copy, see design.md section 3)
    seed = SEED.read_text(encoding="utf-8")
    assert f'SEED_NAMESPACE = uuid.UUID("{SEED_NAMESPACE}")' in seed
    assert re.findall(r'^    \("(lab-[a-z]+)", UserRole', seed, re.MULTILINE) == list(USERS)


# -- the bootstrap sequence -------------------------------------------------------------------------------------------


def test_it_creates_the_service_and_the_contracts_with_the_key_only(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(), FakeContracts()
    report = run(tool, fake, contracts)
    assert report == _created_report()
    assert set(report) == {"service", "synchronization", "contracts"}, "no organization or apiKey entry"
    assert set(fake.services) == {"openbinding"}
    assert len(contracts.added) == 6
    # the sequence: list, create, run, poll, then the pricing versions; nothing else
    collapsed = [request for index, request in enumerate(fake.requests)
                 if index == 0 or request != fake.requests[index - 1]]
    assert collapsed == [("GET", "/api/v1/services"), ("POST", "/api/v1/services"),
                         ("POST", "/api/v1/services/openbinding/synchronization/run"),
                         ("GET", "/api/v1/services/openbinding/synchronization"),
                         ("GET", "/api/v1/services/openbinding/pricings")]
    assert fake.sync_polls == 4
    assert not any(route in path for _, path in fake.requests for route in NO_AUTH_ROUTES)
    assert all(f"'x-api-key': '{API_KEY}'" in sent for sent in fake.sent), "every request carries the key"


def test_the_service_comes_from_the_sphere_link_with_all_last(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    posted: list[dict] = []
    fake, contracts = FakeSpace(), FakeContracts()
    inner = fake._handle

    def spy(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/api/v1/services":
            posted.append(json.loads(request.content))
        return inner(request)

    asyncio.run(tool.bootstrap(make_config(tool), transport=httpx.MockTransport(spy), contracts=contracts,
                               sleep=Sleeps()))
    assert posted == [{"source": "sphere", "permanentUrl": SPHERE_LINK, "policy": "all_last"}]
    assert fake.count("POST", "/api/v1/services", exact=True) == 1


def test_every_request_goes_to_the_host_of_the_configured_url(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(host="other-space.example", port=8443), FakeContracts()
    config = make_config(tool, {"SPACE_URL": "https://other-space.example:8443"})
    report = asyncio.run(tool.bootstrap(config, transport=fake.transport(), contracts=contracts, sleep=Sleeps()))
    assert not fake.violations, fake.violations
    assert report == _created_report() and fake.requests and len(contracts.added) == 6


def test_it_waits_for_the_first_synchronization(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts, sleeps = FakeSpace(sync_script=("queued", "checking", "applying", "ready")), FakeContracts(), Sleeps()
    report = run(tool, fake, contracts, sleeps)
    assert report["synchronization"] == "ready"
    assert fake.count("POST", "/synchronization/run") == 1
    assert fake.sync_polls == 4
    assert sleeps.calls == [5, 5, 5]
    # the run comes before the first poll; contracts only after readiness
    paths = [p for _, p in fake.requests]
    assert paths.index("/api/v1/services/openbinding/synchronization/run") < paths.index(
        "/api/v1/services/openbinding/synchronization")
    assert len(contracts.added) == 6


def test_contracts_use_the_client_and_the_ids_of_the_seed(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
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


def test_the_plan_comes_from_the_environment(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(), FakeContracts()
    asyncio.run(tool.bootstrap(make_config(tool, {"SPACE_BOOTSTRAP_PLAN": "PRO"}), transport=fake.transport(),
                               contracts=contracts, sleep=Sleeps()))
    assert {m.subscription_plans["openbinding"] for m in contracts.added} == {"PRO"}


def test_archived_pricings_are_ignored_in_the_map_shape(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    pricings = {"activePricings": {"1.0.0": {}, "1.1.0": {}}, "archivedPricings": {"2.0.0": {}}}
    fake, contracts = FakeSpace(pricings=pricings), FakeContracts()
    run(tool, fake, contracts)
    assert {m.contracted_services["openbinding"] for m in contracts.added} == {"1.1.0"}


def test_archived_pricings_are_ignored_in_the_list_shape(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    pricings = [{"version": "1.0.0", "status": "active"}, {"version": "1.1.0"},
                {"version": "2.0.0", "status": "archived"}]
    fake, contracts = FakeSpace(pricings=pricings), FakeContracts()
    run(tool, fake, contracts)
    assert {m.contracted_services["openbinding"] for m in contracts.added} == {"1.1.0"}


def _error_text(error: BaseException) -> str:
    text = str(error) + repr(error) + "".join(map(str, error.args))
    seen = {id(error)}
    while (error.__cause__ or error.__context__) and id(error.__cause__ or error.__context__) not in seen:
        error = error.__cause__ or error.__context__
        seen.add(id(error))
        text += str(error) + repr(error)
    return text


def _assert_aborted(tool, fake: FakeSpace, contracts: FakeContracts, named: str = "", **config):
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(tool.bootstrap(make_config(tool, **config), transport=fake.transport(), contracts=contracts,
                                   sleep=Sleeps()))
    assert not fake.violations, fake.violations
    assert contracts.added == [], "a contract was created after the abort"
    assert re.search(named, str(raised.value), re.IGNORECASE), f"the error must name the failed item ({named!r})"


@pytest.mark.parametrize("status", ["failed", "blocked", "degraded"])
def test_a_failed_synchronization_aborts(tool, status, capsys, monkeypatch):
    # [utest->req~lab-space-remote-bootstrap~1]
    _assert_aborted(tool, FakeSpace(sync_script=("queued", status)), FakeContracts(), "synchroni")

    # through main: non-zero status, nothing on stdout and one redacted line on stderr
    fake = FakeSpace(sync_script=("queued", status))
    real = tool.bootstrap

    async def aborting(config, **kwargs):
        return await real(config, transport=fake.transport(), contracts=FakeContracts(), sleep=Sleeps())

    monkeypatch.setattr(tool, "bootstrap", aborting)
    capsys.readouterr()
    assert tool.main([], {"SPACE_URL": SPACE_URL, "SPACE_API_KEY": API_KEY}) == 1
    out, err = capsys.readouterr()
    assert out == ""
    assert err == f"space_lab_bootstrap: synchronization: the service synchronization is {status}\n"


def test_a_synchronization_that_never_gets_ready_aborts_after_the_polls(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts, sleeps = FakeSpace(sync_script=("checking",)), FakeContracts(), Sleeps()
    with pytest.raises(tool.BootstrapError):
        asyncio.run(tool.bootstrap(make_config(tool, poll_attempts=3), transport=fake.transport(), contracts=contracts,
                                   sleep=sleeps))
    assert fake.sync_polls == 3 and sleeps.calls == [5, 5] and contracts.added == []


def test_a_created_service_with_a_foreign_name_aborts(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(created_name="something-else"), FakeContracts()
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(tool.bootstrap(make_config(tool), transport=fake.transport(), contracts=contracts, sleep=Sleeps()))
    assert str(raised.value) == "service: the created service is not named openbinding"
    assert not fake.violations, fake.violations
    assert fake.count("POST", "/synchronization/run") == 0, "a synchronization was run for the foreign service"
    assert fake.sync_polls == 0 and contracts.added == [] and contracts.gets == []


def test_no_active_pricing_version_aborts(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    _assert_aborted(tool, FakeSpace(pricings=[]), FakeContracts(), "pricing")
    _assert_aborted(tool, FakeSpace(pricings={"activePricings": {}, "archivedPricings": {"2.0.0": {}}}),
                    FakeContracts(), "pricing")


@pytest.mark.parametrize("override", [{"source": "local"}, {"permanentUrl": "https://sphere.score.us.es/p/other"},
                                      {"policy": "all_first"}])
def test_an_existing_service_with_other_settings_aborts_unchanged(tool, override):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(), FakeContracts()
    before = dict(fake.add_service(**override))
    _assert_aborted(tool, fake, contracts, "service")
    assert fake.services["openbinding"] == before, "the existing service was modified"
    assert fake.changes() == [], "the abort must not create or run anything"


# -- a second run and partial states ----------------------------------------------------------------------------------


def test_a_second_run_sends_no_create_or_run_request(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(), FakeContracts(missing="404")
    assert run(tool, fake, contracts) == _created_report()
    fake.requests.clear()
    contracts.added.clear()
    assert run(tool, fake, contracts) == _existing_report()
    assert fake.changes() == [], "a second run sent a creating or running request"
    assert contracts.added == []
    assert fake.count("POST", "/synchronization/run") == 0
    assert set(fake.services) == {"openbinding"}


def test_a_partial_state_is_completed(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    # a ready service present; contracts for two users only
    fake, contracts = FakeSpace(), FakeContracts()
    fake.add_service(ready=True)
    contracts.preload("lab-admin")
    contracts.preload("lab-owner")
    report = run(tool, fake, contracts)
    assert report["service"] == "exists" and report["synchronization"] == "skipped"
    assert report["contracts"] == {"lab-admin": "exists", "lab-owner": "exists", "lab-orgadmin": "created",
                                   "lab-member": "created", "lab-viewer": "created", "lab-outsider": "created"}
    assert {m.user_contact.user_id for m in contracts.added} == {seed_id(n) for n in USERS[2:]}
    assert fake.changes() == []


def test_an_existing_service_still_synchronizing_is_polled_until_ready(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts, sleeps = FakeSpace(sync_script=("checking", "applying", "ready")), FakeContracts(), Sleeps()
    fake.add_service(sync="queued")
    report = run(tool, fake, contracts, sleeps)
    assert report["service"] == "exists" and report["synchronization"] == "ready"
    assert fake.count("POST", "/synchronization/run") == 0 and fake.changes() == []
    assert fake.sync_polls == 3 and sleeps.calls == [5, 5]
    assert len(contracts.added) == 6


@pytest.mark.parametrize("status", ["blocked", "degraded", "failed"])
def test_an_existing_service_with_a_broken_synchronization_aborts(tool, status):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(), FakeContracts()
    fake.add_service(sync=status)
    _assert_aborted(tool, fake, contracts, f"synchronization.*{status}")
    assert fake.changes() == [], "nothing is created or run for a broken synchronization"


def test_a_top_level_status_and_a_flat_service_are_accepted(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(sync_shape="top"), FakeContracts()
    assert run(tool, fake, contracts)["synchronization"] == "ready"
    fake.requests.clear()
    assert run(tool, fake, contracts)["synchronization"] == "skipped" and fake.changes() == []
    fake, contracts = FakeSpace(), FakeContracts()
    fake.add_service(flat=True)
    report = run(tool, fake, contracts)
    assert report["service"] == "exists" and report["synchronization"] == "skipped" and fake.changes() == []


def test_a_summary_entry_is_completed_from_the_item_route(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(summaries=True), FakeContracts()
    fake.add_service()
    report = run(tool, fake, contracts)
    assert report["service"] == "exists" and report["synchronization"] == "skipped"
    assert fake.count("GET", "/api/v1/services/openbinding", exact=True) == 1, "the item route was not read"
    assert fake.changes() == [] and len(contracts.added) == 6


@pytest.mark.parametrize("override", [{"source": "local"}, {"permanentUrl": "https://sphere.score.us.es/p/other"},
                                      {"policy": "all_first"}])
def test_a_summary_entry_with_other_settings_aborts_unchanged(tool, override):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(summaries=True), FakeContracts()
    before = dict(fake.add_service(**override))
    _assert_aborted(tool, fake, contracts, "service")
    assert fake.services["openbinding"] == before and fake.changes() == []


def test_a_full_list_entry_needs_no_item_read(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(), FakeContracts()
    fake.add_service()
    run(tool, fake, contracts)
    assert fake.count("GET", "/api/v1/services/openbinding", exact=True) == 0


# -- bounds on what the SPACE answers ---------------------------------------------------------------------------------


def test_a_response_body_over_one_mebibyte_is_refused_before_decoding(tool, monkeypatch):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    big = b'["' + b"A" * (1024 * 1024) + b'"]'
    monkeypatch.setattr(tool.json, "loads", lambda *a, **kw: pytest.fail("the body was decoded"))
    monkeypatch.setattr(httpx.Response, "json", lambda self, **kw: pytest.fail("the body was decoded"))
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=big,
                                                                    headers={"content-type": "application/json"}))
    contracts = FakeContracts()
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(tool.bootstrap(make_config(tool), transport=transport, contracts=contracts, sleep=Sleeps()))
    assert str(raised.value) == "service: GET /services returned a body over 1 MiB"
    assert contracts.added == []


def test_a_body_of_exactly_one_mebibyte_is_still_read(tool):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    fake, contracts = FakeSpace(), FakeContracts()
    fake.add_service()
    inner = fake._handle

    def padded(request: httpx.Request) -> httpx.Response:
        response = inner(request)
        if request.url.path == "/api/v1/services" and request.method == "GET":
            body = response.content
            return httpx.Response(200, content=body + b" " * (1024 * 1024 - len(body)))
        return response

    report = asyncio.run(tool.bootstrap(make_config(tool), transport=httpx.MockTransport(padded), contracts=contracts,
                                        sleep=Sleeps()))
    assert report["service"] == "exists"


def test_pricing_versions_that_do_not_look_like_versions_are_ignored(tool):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    invalid = ["9.0.0/../x", "9.1 ", "9.2.0\n", "v9", "9.3.0?x=1", "9.4.0#a", "9..0", "9.5.", "", "9.6\\0", "9.7.0-"]
    pricings = [{"version": "1.0.0"}, {"version": "1.1.0+build.5"}, *({"version": v} for v in invalid)]
    fake, contracts = FakeSpace(pricings=pricings), FakeContracts()
    run(tool, fake, contracts)
    assert {m.contracted_services["openbinding"] for m in contracts.added} == {"1.1.0+build.5"}
    fake, contracts = FakeSpace(pricings={"activePricings": {"9.0.0/../x": {}, "1.0.0": {}, "9.1\n": {}}}), FakeContracts()
    run(tool, fake, contracts)
    assert {m.contracted_services["openbinding"] for m in contracts.added} == {"1.0.0"}


def test_without_a_valid_pricing_version_it_aborts(tool):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    _assert_aborted(tool, FakeSpace(pricings=[{"version": "../x"}, {"version": "9.1\n"}]), FakeContracts(), "no active pricing")
    _assert_aborted(tool, FakeSpace(pricings={"activePricings": {"latest": {}}}), FakeContracts(), "no active pricing")


# -- proxy variables never reach a client that carries the key --------------------------------------------------------


def _visible_proxies() -> list[str]:
    return [name for name in PROXY_VARIABLES if name in os.environ]


def _set_proxies(monkeypatch) -> None:
    for name in PROXY_VARIABLES:
        monkeypatch.setenv(name, "http://proxy.invalid:3128")
    for name in ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR"):
        monkeypatch.setenv(name, "/etc/ssl/sample")


def _assert_trust_variables_kept() -> None:
    assert [os.environ.get(n) for n in ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR")] == ["/etc/ssl/sample"] * 3


def test_the_sdk_client_is_created_without_proxy_variables(tool, monkeypatch):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    fake, contracts = FakeSpace(), FakeContracts()
    seen: list[list[str]] = []

    async def close():
        return None

    def connect_async(url, api_key, timeout=None):
        seen.append(_visible_proxies())
        return SimpleNamespace(contracts=contracts, close=close)

    monkeypatch.setattr(tool.SpaceClientFactory, "connect_async", staticmethod(connect_async))
    _set_proxies(monkeypatch)
    assert _visible_proxies() == list(PROXY_VARIABLES)
    asyncio.run(tool.bootstrap(make_config(tool), transport=fake.transport(), sleep=Sleeps()))
    assert seen == [[]], f"the SDK client was built with proxy variables in the environment: {seen}"
    _assert_trust_variables_kept()


def test_main_removes_the_proxy_variables_before_any_client_is_built(tool, monkeypatch, capsys):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    seen: list[list[str]] = []

    async def stub(config, **kwargs):
        seen.append(_visible_proxies())
        return {"service": "exists"}

    monkeypatch.setattr(tool, "bootstrap", stub)
    _set_proxies(monkeypatch)
    assert tool.main([], {"SPACE_URL": SPACE_URL, "SPACE_API_KEY": API_KEY}) == 0
    assert seen == [[]] and _visible_proxies() == [], "main left a proxy variable in the process environment"
    _assert_trust_variables_kept()
    assert capsys.readouterr().out == '{"service": "exists"}\n'


def test_main_removes_the_proxy_variables_even_when_the_configuration_is_refused(tool, monkeypatch, capsys):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    _set_proxies(monkeypatch)
    assert tool.main([], {}) == 1
    assert _visible_proxies() == []
    capsys.readouterr()


# -- contracts through the client -------------------------------------------------------------------------------------


def test_a_missing_contract_reported_as_404_is_created(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(), FakeContracts(missing="404")
    contracts.preload("lab-admin")
    report = run(tool, fake, contracts)
    assert report["contracts"] == {"lab-admin": "exists", **{name: "created" for name in USERS[1:]}}
    assert {m.user_contact.user_id for m in contracts.added} == {seed_id(n) for n in USERS[1:]}


def test_a_contract_refused_without_an_error_aborts(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(), FakeContracts(refuse=True)
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(tool.bootstrap(make_config(tool), transport=fake.transport(), contracts=contracts, sleep=Sleeps()))
    assert str(raised.value) == "contracts: lab-admin not confirmed"
    assert len(contracts.added) == 1, "the bootstrap stops at the first contract it cannot confirm"


def test_a_contract_with_another_plan_is_not_confirmed(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(), FakeContracts()
    real_add = contracts.add_contract

    async def downgrading(model):
        await real_add(model)
        contracts.store[model.user_contact.user_id].subscription_plans = {"openbinding": "OTHER"}

    contracts.add_contract = downgrading
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(tool.bootstrap(make_config(tool, plan="PRO"), transport=fake.transport(), contracts=contracts,
                                   sleep=Sleeps()))
    assert str(raised.value) == "contracts: lab-admin not confirmed"


def test_a_contract_stored_with_another_version_is_not_confirmed(tool):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(), FakeContracts()
    real_add = contracts.add_contract

    async def keeping_another_version(model):
        await real_add(model)
        contracts.store[model.user_contact.user_id].contracted_services = {"openbinding": "0.0.1"}

    contracts.add_contract = keeping_another_version
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(tool.bootstrap(make_config(tool), transport=fake.transport(), contracts=contracts, sleep=Sleeps()))
    assert str(raised.value) == "contracts: lab-admin not confirmed"
    assert len(contracts.added) == 1


def test_the_contracts_client_gets_the_key_and_is_closed(tool, monkeypatch):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(), FakeContracts()
    calls: list[tuple] = []
    closed: list[bool] = []

    async def close():
        closed.append(True)

    def connect_async(url, api_key, timeout=None):
        calls.append((url, api_key))
        return SimpleNamespace(contracts=contracts, close=close)

    monkeypatch.setattr(tool.SpaceClientFactory, "connect_async", staticmethod(connect_async))
    report = asyncio.run(tool.bootstrap(make_config(tool), transport=fake.transport(), sleep=Sleeps()))
    assert not fake.violations, fake.violations
    assert set(report["contracts"].values()) == {"created"} and len(contracts.added) == 6
    assert calls == [(SPACE_URL, API_KEY)]
    assert closed == [True]


# -- main -------------------------------------------------------------------------------------------------------------


def test_main_prints_one_sorted_json_line_on_success(tool, capsys, monkeypatch):
    # [utest->req~lab-space-remote-bootstrap~1]
    fake, contracts = FakeSpace(), FakeContracts()
    real = tool.bootstrap

    async def wired(config, **kwargs):
        return await real(config, transport=fake.transport(), contracts=contracts, sleep=Sleeps())

    monkeypatch.setattr(tool, "bootstrap", wired)
    capsys.readouterr()
    assert tool.main([], {"SPACE_URL": SPACE_URL, "SPACE_API_KEY": API_KEY}) == 0
    out, err = capsys.readouterr()
    assert out == json.dumps(_created_report(), sort_keys=True) + "\n"
    assert err == ""


def test_main_refuses_a_missing_key_without_output_on_stdout(tool, capsys):
    # [utest->req~lab-space-remote-bootstrap~1]
    capsys.readouterr()
    assert tool.main([], {}) == 1
    out, err = capsys.readouterr()
    assert out == "" and err == "space_lab_bootstrap: configuration: SPACE_API_KEY is required\n"


# -- secrets and boundaries -------------------------------------------------------------------------------------------


def _source() -> str:
    assert TOOL.is_file(), "lab/tools/space_lab_bootstrap.py does not exist yet"
    return TOOL.read_text(encoding="utf-8")


def _code_strings(source: str) -> list[str]:
    """Every string constant of the module except docstrings."""
    tree = ast.parse(source)
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            first = node.body[0] if node.body else None
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                docstrings.add(id(first.value))
    return [n.value for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docstrings]


def test_the_tool_has_no_retired_route_or_variable_and_never_writes(tool):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    source = _source()
    code = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("#"))
    strings = "\n".join(_code_strings(source))
    for retired in ("authenticate", "/organizations", "api-keys", "SPACE_ADMIN", "SPHERE_API_KEY"):
        assert retired not in strings, f"the tool still names {retired}"
    assert "SPHERE_API_KEY" not in source
    assert not re.search(r"environ(?:\.get)?\s*[\[(]\s*['\"]SPHERE_", code), "reads a SPHERE_* variable"
    assert not re.search(r"(?:getenv|environ)[^\n]*SPHERE_", code), "reads a SPHERE_* variable"
    assert not re.search(r"""open\([^)]*['"][rwxab+t]+['"]|\.write_text\(|\.write_bytes\(|Path\([^)]*\)\.write|os\.write\(|\.write\(""",
                         code), "the tool writes to a file"
    assert not re.search(r"\bos\.open\(|\.touch\(|FileHandler\b", code), "the tool creates a file"
    assert not re.search(r"(print|log\w*\.\w+|logger\.\w+|logging\.\w+)\([^)]*(password|api_?key|\.key\b|secret)", code,
                         re.IGNORECASE), "a key is printed or logged"
    assert "follow_redirects=False" in code and "trust_env=False" in code
    assert tool.SPHERE_LINK == SPHERE_LINK  # only sent to SPACE as data, never requested


def test_the_tool_imports_only_the_standard_library_httpx_and_space_client():
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    tree = ast.parse(_source())
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, "relative import"
            imported.add(node.module)
    roots = {name.split(".")[0] for name in imported}
    assert "openbinding_gateway" not in roots
    assert roots - set(sys.stdlib_module_names) - {"httpx", "space_client"} == set(), roots


def test_the_api_key_is_held_out_of_the_representation(tool):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    config = make_config(tool)
    assert API_KEY not in repr(config) and API_KEY not in str(config)
    holders = [f for f in dataclasses.fields(config) if getattr(config, f.name) == API_KEY]
    assert len(holders) == 1 and holders[0].repr is False


def _logging_records(caplog):
    return "\n".join(f"{r.getMessage()} {r.exc_text or ''} {r.args}" for r in caplog.records)


def test_nothing_secret_is_printed_or_persisted(tool, capsys, caplog, tmp_path, monkeypatch):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    monkeypatch.chdir(tmp_path)
    caplog.set_level(logging.DEBUG)

    def assert_clean(fake: FakeSpace, *extra: str):
        out, err = capsys.readouterr()
        haystack = "\n".join([out, err, _logging_records(caplog), *extra])
        for secret in fake.secrets:
            assert secret not in haystack, "a secret reached the output, a log or an error"
        assert SPHERE_SAMPLE_KEY not in haystack + "\n".join(fake.sent), "the SPHERE key was used"
        assert list(tmp_path.iterdir()) == [], "the tool wrote a file"

    real = tool.bootstrap
    # a successful run through main; a SPHERE key in the environment is never read nor sent
    fake, contracts = FakeSpace(), FakeContracts()
    environ = {"SPACE_URL": SPACE_URL, "SPACE_API_KEY": API_KEY, "SPHERE_API_KEY": SPHERE_SAMPLE_KEY}

    async def fake_bootstrap(config, **kwargs):
        return await real(config, transport=fake.transport(), contracts=contracts, sleep=Sleeps())

    monkeypatch.setattr(tool, "bootstrap", fake_bootstrap)
    assert tool.main([], environ) == 0
    out, err = capsys.readouterr()
    assert len(out.strip().splitlines()) == 1 and json.loads(out)["service"] == "created"
    for secret in [*fake.secrets, SPHERE_SAMPLE_KEY]:
        assert secret not in out and secret not in err
    assert fake.sent and SPHERE_SAMPLE_KEY not in "\n".join(fake.sent + [repr(m) for m in contracts.added])
    assert_clean(fake)

    # bootstrap directly: the report holds no secret
    fake, contracts = FakeSpace(), FakeContracts()
    report = asyncio.run(real(make_config(tool), transport=fake.transport(), contracts=contracts, sleep=Sleeps()))
    assert_clean(fake, json.dumps(report))

    # failing runs whose answers echo the key: in an error body and header, and in a 401
    for failing_fake in (FakeSpace(echo_on_error=True, fail_service_post=True), FakeSpace(reject_key=True)):
        fake, contracts = failing_fake, FakeContracts()
        with pytest.raises(tool.BootstrapError) as raised:
            asyncio.run(real(make_config(tool), transport=fake.transport(), contracts=contracts, sleep=Sleeps()))
        assert fake.requests
        assert_clean(fake, _error_text(raised.value))

    # the same failures through main: one redacted line on stderr, nothing on stdout, status 1
    for failing_fake in (FakeSpace(echo_on_error=True, fail_service_post=True), FakeSpace(reject_key=True)):
        fake, contracts = failing_fake, FakeContracts()

        async def failing(config, **kwargs):
            return await real(config, transport=fake.transport(), contracts=contracts, sleep=Sleeps())

        monkeypatch.setattr(tool, "bootstrap", failing)
        assert tool.main([], environ) == 1
        out, err = capsys.readouterr()
        assert out == "" and len(err.strip().splitlines()) == 1
        assert err.startswith("space_lab_bootstrap: service:")
        for secret in [*fake.secrets, SPHERE_SAMPLE_KEY]:
            assert secret not in err
        assert SPHERE_SAMPLE_KEY not in "\n".join(fake.sent)
        assert list(tmp_path.iterdir()) == []


def test_a_contract_lookup_error_names_only_its_type(tool):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    fake = FakeSpace()
    contracts = FakeContracts(error=space_api_error(500, {"error": f"broken for {API_KEY}"}))
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(tool.bootstrap(make_config(tool), transport=fake.transport(), contracts=contracts, sleep=Sleeps()))
    assert str(raised.value) == "contracts: lab-admin failed (SpaceApiError)"
    text = _error_text(raised.value)
    for secret in fake.secrets:
        assert secret not in text
    assert contracts.added == []


def test_a_contracts_error_behind_the_sdk_client_closes_it_and_swallows_the_close_error(tool, monkeypatch):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    fake = FakeSpace()
    contracts = FakeContracts(error=space_api_error(500, {"error": "broken"}))
    closed: list[bool] = []

    async def close():
        closed.append(True)
        raise RuntimeError(f"close failed with {API_KEY}")

    def connect_async(url, api_key, timeout=None):
        return SimpleNamespace(contracts=contracts, close=close)

    monkeypatch.setattr(tool.SpaceClientFactory, "connect_async", staticmethod(connect_async))
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(tool.bootstrap(make_config(tool), transport=fake.transport(), sleep=Sleeps()))
    assert str(raised.value) == "contracts: lab-admin failed (SpaceApiError)"
    assert closed == [True], "the SDK client was not closed after the contracts error"
    text = _error_text(raised.value)
    assert "RuntimeError" not in text and "close failed" not in text, "the close error replaced or joined the real one"
    for secret in fake.secrets:
        assert secret not in text


@pytest.mark.parametrize("step", ["connect", "close"])
def test_a_failing_contracts_client_names_only_the_exception_type(tool, monkeypatch, step):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    fake, contracts = FakeSpace(), FakeContracts()

    async def close():
        if step == "close":
            raise RuntimeError(f"close failed with {API_KEY}")

    def connect_async(url, api_key, timeout=None):
        if step == "connect":
            raise RuntimeError(f"cannot connect with {api_key}")
        return SimpleNamespace(contracts=contracts, close=close)

    monkeypatch.setattr(tool.SpaceClientFactory, "connect_async", staticmethod(connect_async))
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(tool.bootstrap(make_config(tool), transport=fake.transport(), sleep=Sleeps()))
    text = _error_text(raised.value)
    assert "RuntimeError" in str(raised.value)
    for secret in fake.secrets:
        assert secret not in text


def test_a_key_that_cannot_be_sent_does_not_travel_in_the_error(tool):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    odd_key = "mgmt-clé-sample"
    fake = FakeSpace(key=odd_key)
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(tool.bootstrap(make_config(tool, {"SPACE_API_KEY": odd_key}), transport=fake.transport(),
                                   contracts=FakeContracts(), sleep=Sleeps()))
    assert odd_key not in _error_text(raised.value)


def test_a_redirect_is_not_followed_and_proxies_are_not_read(tool):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    fake, contracts = FakeSpace(redirect_services="https://elsewhere.example/api/v1/services"), FakeContracts()
    _assert_aborted(tool, fake, contracts, "service")
    assert fake.count("GET", "/api/v1/services") == 1
    code = _source()
    assert "follow_redirects=False" in code and "trust_env=False" in code


def test_main_reports_an_unexpected_error_by_its_type_only(tool, capsys, monkeypatch):
    # [utest->req~lab-space-remote-bootstrap-secrets~1]
    async def exploding(config, **kwargs):
        raise RuntimeError(f"boom {API_KEY}")

    monkeypatch.setattr(tool, "bootstrap", exploding)
    assert tool.main([], {"SPACE_URL": SPACE_URL, "SPACE_API_KEY": API_KEY}) == 1
    out, err = capsys.readouterr()
    assert out == "" and err == "space_lab_bootstrap: unexpected RuntimeError\n"


def test_control_the_fake_records_retired_routes_and_modifications():
    # [utest->req~lab-space-remote-bootstrap~1]
    fake = FakeSpace()
    fake.add_service()

    async def modify():
        async with httpx.AsyncClient(base_url=SPACE_URL, transport=fake.transport()) as client:
            headers = {"x-api-key": API_KEY}
            await client.put("/api/v1/services/openbinding", headers=headers, json={"source": "local"})
            await client.delete("/api/v1/services/openbinding", headers=headers)
            assert fake.violations == []
            await client.post("/api/v1/users/authenticate", headers=headers, json={})
            await client.get("/api/v1/organizations", headers=headers)
            await client.get("/api/v1/services")

    asyncio.run(modify())
    assert fake.changes() == [("PUT", "/api/v1/services/openbinding"), ("DELETE", "/api/v1/services/openbinding"),
                              ("POST", "/api/v1/users/authenticate")]
    assert fake.services == {}
    assert len(fake.violations) == 3 and "x-api-key" in fake.violations[-1]


def _normalise(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


LINUX_PY312 = {"sys_platform": "linux", "platform_system": "Linux", "os_name": "posix", "python_version": "3.12",
               "python_full_version": "3.12.8", "implementation_name": "cpython",
               "platform_python_implementation": "CPython", "platform_machine": "x86_64", "extra": ""}


def _dependency_closure(packages: dict, roots: set[str]) -> set[str]:
    """Names reachable from ``roots`` through each package's ``dependencies`` (not its optional ones), skipping entries
    whose marker is false on linux with python 3.12."""
    from packaging.markers import Marker

    seen, todo = set(), list(roots)
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        for dep in packages[name].get("dependencies", []):
            marker = dep.get("marker")
            if marker and not Marker(marker).evaluate(LINUX_PY312):
                continue
            todo.append(_normalise(dep["name"]))
    return seen


def test_the_tool_requirements_follow_the_gateway_lock():
    # [utest->req~lab-space-remote-bootstrap~1]
    packages = {_normalise(p["name"]): p for p in tomllib.loads(_read(UV_LOCK))["package"]}
    locked = {name: p["version"] for name, p in packages.items() if "version" in p}
    pins = {}
    for raw in _read(REQUIREMENTS).splitlines():
        line = raw.split("#", 1)[0].strip()
        if "==" in line:
            name, version = line.split("==", 1)
            pins[_normalise(name.split("[", 1)[0])] = version.strip()
    shared = set(pins) & set(locked)
    assert {"httpx", "space-python-client"} <= shared
    assert {name: pins[name] for name in shared} == {name: locked[name] for name in shared}
    closure = _dependency_closure(packages, {"httpx", "space-python-client"})
    assert {"httpx", "space-python-client"} <= closure
    assert not closure - set(pins), f"locked dependencies missing from lab/tools/requirements.txt: {sorted(closure - set(pins))}"
    # control: a marker that excludes linux python 3.12 is ignored, one that includes it is followed
    sample = {"a": {"dependencies": [{"name": "b"}, {"name": "c", "marker": "sys_platform == 'win32'"},
                                      {"name": "d", "marker": "python_full_version < '3.10'"},
                                      {"name": "e", "marker": "python_version >= '3.11'"}]},
              "b": {}, "c": {}, "d": {}, "e": {}}
    assert _dependency_closure(sample, {"a"}) == {"a", "b", "e"}
