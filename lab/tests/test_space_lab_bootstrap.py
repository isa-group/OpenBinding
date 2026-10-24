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

import ast
import asyncio
import fnmatch
import importlib.util
import json
import logging
import re
import sys
import tomllib
import urllib.parse
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
OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567"
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
SPHERE_SAMPLE_KEY = "sphere-sample-key"
UV_LOCK = ROOT / "openbinding-gateway" / "uv.lock"
IN_PROGRESS = ("queued", "checking", "applying")


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


HEAD_EQUALS_COMMIT = re.compile(
    r"(?:test|\[)\s+\"?(?:\$\(\s*git[^)]*rev-parse\s+HEAD\s*\)|`\s*git[^`]*rev-parse\s+HEAD\s*`)\"?"
    rf"\s+==?\s+[\"']?{COMMIT}[\"']?(?:\s+\])?")
PACKAGE_COPY = "COPY --from=source --chown=1000:1000 /src/api/package.json ./"
PUBLIC_RUN = "RUN mkdir -p public/static/pricings && chown -R 1000:1000 public"


def rule_space_runtime(text: str) -> str | None:
    """The final stage reproduces two upstream steps: api/package.json ("type": "module") and a writable public/."""
    items = final_stage(text)
    users = [i for i, (name, _) in enumerate(items) if name == "USER"]
    if not users:
        return "the final stage has no USER"
    before = items[:users[-1]]
    if not any(name == "COPY" and "--from=source" in args.split() and "--chown=1000:1000" in args.split()
               and args.split()[-2:] == ["/src/api/package.json", "./"] for name, args in before):
        return "the final stage must copy /src/api/package.json from source (owned by 1000:1000) before USER"
    steps = [c.strip() for name, args in before if name == "RUN" for c in args.split("&&")]
    if "mkdir -p public/static/pricings" not in steps or "chown -R 1000:1000 public" not in steps or \
            steps.index("mkdir -p public/static/pricings") > steps.index("chown -R 1000:1000 public"):
        return "the final stage must mkdir -p public/static/pricings and chown -R 1000:1000 public before USER"
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
    for c in cmds:
        if re.search(r"\bgit\b.*\b(?:fetch|checkout|rev-parse)\b", c):
            if [h for h in re.findall(r"\b[0-9a-f]{40}\b", c) if h != COMMIT]:
                return f"a commit other than the pinned one is named in {c!r}"
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
    for c in checks:
        if not HEAD_EQUALS_COMMIT.fullmatch(c):
            return f"the HEAD verification must be test/[ with = or == against the literal commit: {c!r}"
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
    for rule in (rule_space_commit, lambda t: rule_from_lines(t, [GIT_IMAGE, API_IMAGE]), rule_pnpm, rule_expose,
                 rule_space_runtime):
        message = rule(text)
        if message:
            return message
    froms = [args for name, args in instructions(text) if name == "FROM"]
    if not froms[-1].startswith("node:21.1-slim@"):
        return "the final (api) stage must be node:21.1-slim"
    return None


def rule_space_hygiene(text: str) -> str | None:
    return rule_no_secret(text) or rule_user(text)


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

FROM {API_IMAGE}
WORKDIR /app
COPY --from=api /app/dist ./dist
{PACKAGE_COPY}
{PUBLIC_RUN}
EXPOSE 3000
USER 1000:1000
CMD ["pnpm", "start"]
"""

SAMPLE_TOOL = f"""FROM {PYTHON_IMAGE}
WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY space_lab_bootstrap.py ./space_lab_bootstrap.py
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
    "secret-shaped literal": _append_final("ENV GREETING=sk-AAAAAAAAAAAAAAAAAAAA"),
    "other repository": _swap("SCORELabUS/space.git", "someone/space.git"),
    "ADD of a tag": _swap("WORKDIR /src", "WORKDIR /src\nADD https://github.com/SCORELabUS/space.git#v1.7.1 /x"),
    "final stage on the git image": _swap(f"FROM {API_IMAGE}\nWORKDIR /app\nCOPY --from=api",
                                          f"FROM {GIT_IMAGE}\nWORKDIR /app\nCOPY --from=api"),
    "verification neutralised by ||": _swap(f'= "{COMMIT}"', f'= "{COMMIT}" || true'),
    "verification neutralised by ;": _swap(f'= "{COMMIT}"', f'= "{COMMIT}"; true'),
    "verification inverted": _swap(f')" = "{COMMIT}"', f')" != "{COMMIT}"'),
    "fetch of another commit": _swap(f"space.git {COMMIT}", f"space.git {OTHER_COMMIT}"),
    "fetch of two commits": _swap(f"space.git {COMMIT}", f"space.git {COMMIT} {OTHER_COMMIT}"),
    "checkout of another commit": _swap("checkout FETCH_HEAD", f"checkout {OTHER_COMMIT}"),
    "package.json not copied": _swap(PACKAGE_COPY + "\n", ""),
    "package.json not owned by the user": _swap(PACKAGE_COPY, "COPY --from=source /src/api/package.json ./"),
    "pricings directory not created": _swap(PUBLIC_RUN + "\n", ""),
    "pricings directory not chowned": _swap(" && chown -R 1000:1000 public", ""),
    "runtime steps after USER": lambda text: text.replace(f"{PACKAGE_COPY}\n{PUBLIC_RUN}\nEXPOSE 3000\nUSER 1000:1000\n",
                                                           f"EXPOSE 3000\nUSER 1000:1000\n{PACKAGE_COPY}\n{PUBLIC_RUN}\n"),
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
    "secret-shaped literal": _swap("WORKDIR /app", "ENV GREETING=sk-AAAAAAAAAAAAAAAAAAAA\nWORKDIR /app"),
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


def _from_space(text: str) -> str | None:
    return rule_from_lines(text, [GIT_IMAGE, API_IMAGE])


def _from_tool(text: str) -> str | None:
    return rule_from_lines(text, [PYTHON_IMAGE])


# (rule, sample, mutations, labels): each listed mutation must be refused by that rule alone, not by a neighbour
ALONE_CONTROLS = [
    (_from_space, SAMPLE_SPACE, SPACE_MUTATIONS, ["tag-only FROM", "short digest", "other base image"]),
    (rule_no_secret, SAMPLE_SPACE, SPACE_MUTATIONS, ["secret ARG", "secret ENV", "secret-shaped literal"]),
    (rule_user, SAMPLE_SPACE, SPACE_MUTATIONS,
     ["root user", "uid zero", "user by name", "gid zero", "no gid", "no user"]),
    (rule_space_commit, SAMPLE_SPACE, SPACE_MUTATIONS,
     ["tag instead of the commit", "branch instead of the commit", "git clone", "checkout of a tag", "no verification",
      "variable in the verification", "verification neutralised by ||", "verification neutralised by ;",
      "verification inverted", "fetch of another commit", "fetch of two commits", "checkout of another commit", "other repository", "ADD of a tag"]),
    (rule_space_dockerfile, SAMPLE_SPACE, SPACE_MUTATIONS, ["final stage on the git image"]),
    (rule_pnpm, SAMPLE_SPACE, SPACE_MUTATIONS,
     ["unpinned pnpm", "pnpm major only", "pnpm install without frozen lockfile", "second install not frozen"]),
    (rule_expose, SAMPLE_SPACE, SPACE_MUTATIONS, ["wrong port"]),
    (rule_space_runtime, SAMPLE_SPACE, SPACE_MUTATIONS,
     ["package.json not copied", "package.json not owned by the user", "pricings directory not created",
      "pricings directory not chowned", "runtime steps after USER"]),
    (_from_tool, SAMPLE_TOOL, TOOL_MUTATIONS, ["tag-only FROM", "short digest"]),
    (rule_no_secret, SAMPLE_TOOL, TOOL_MUTATIONS, ["secret ARG", "secret-shaped literal"]),
    (rule_user, SAMPLE_TOOL, TOOL_MUTATIONS, ["root user", "user by name"]),
    (rule_tool_dockerfile, SAMPLE_TOOL, TOOL_MUTATIONS,
     ["pip install of a package name", "package next to the requirements", "tool not copied", "requirements not copied",
      "source relative to the repository root", "extra file copied", "entrypoint elsewhere"]),
]


def test_control_each_dockerfile_rule_refuses_its_mutations_alone():
    # [utest->req~lab-space-image-pinned-commit~1]
    for rule, sample, mutations, labels in ALONE_CONTROLS:
        assert rule(sample) is None, f"{rule.__name__}: the conforming sample must pass"
        for label in labels:
            mutated = mutations[label](sample)
            assert mutated != sample, label
            assert rule(mutated), f"{rule.__name__}: {label} was not refused by this rule alone"


# -- the build context: every host COPY must survive the .dockerignore of the declared context -----------------------

SPACE_CONTEXT = ROOT / "lab" / "space"  # `docker build lab/space` (the repository root also works: no host COPY)
TOOL_CONTEXT = ROOT / "lab" / "tools"  # `docker build -f lab/tools/Dockerfile lab/tools`
SAMPLE_IGNORE = ["*", "!requirements.txt", "!space_lab_bootstrap.py"]


def test_every_host_copy_survives_the_ignore_rules_of_its_context():
    # [utest->req~lab-space-image-pinned-commit~1]
    for dockerfile, context in ((SPACE_DOCKERFILE, SPACE_CONTEXT), (TOOL_DOCKERFILE, TOOL_CONTEXT)):
        ignore = context / ".dockerignore"
        assert ignore.is_file(), f"{ignore.relative_to(ROOT)} does not exist"
        text = _read(dockerfile)
        assert rule_context_copies(text, ignore.read_text(encoding="utf-8").splitlines()) is None
        for source in host_copy_sources(text):
            assert (context / source).is_file(), f"{source} is not in {context.relative_to(ROOT)}"
    assert host_copy_sources(_read(TOOL_DOCKERFILE)), "the tool image copies nothing from its context"
    assert not (ROOT / "lab" / "tools" / "Dockerfile.dockerignore").exists(), "a Dockerfile.dockerignore is forbidden"


def test_control_the_context_matcher_refuses_excluded_copies():
    # [utest->req~lab-space-image-pinned-commit~1]
    assert rule_context_copies(SAMPLE_TOOL, SAMPLE_IGNORE) is None
    assert host_copy_sources(SAMPLE_TOOL) == ["requirements.txt", "space_lab_bootstrap.py"]
    assert host_copy_sources(SAMPLE_SPACE) == []  # COPY --from reads another stage, not the context
    assert rule_context_copies(SAMPLE_TOOL, ["*"]), "everything excluded must be refused"
    assert rule_context_copies(SAMPLE_TOOL, ["*", "!requirements.txt"]), "an excluded tool source must be refused"
    assert rule_context_copies(SAMPLE_TOOL, ["*", "!space_lab_bootstrap.py"]), "an excluded requirements file must be refused"
    assert rule_context_copies(SAMPLE_TOOL, ["requirements.txt", "!requirements.txt", "space_lab_bootstrap.py"])
    old = SAMPLE_TOOL.replace("COPY requirements.txt", "COPY lab/tools/requirements.txt")
    assert rule_context_copies(old, SAMPLE_IGNORE), "a repository-root path is not in the lab/tools context"
    assert rule_context_copies(SAMPLE_TOOL.replace("COPY space_lab_bootstrap.py", "COPY secrets.env"), SAMPLE_IGNORE)


# -- the fake SPACE ---------------------------------------------------------------------------------------------------


class FakeSpace:
    """A stateful in-memory SPACE served through ``httpx.MockTransport``; it records every call and every violation
    (a host other than SPACE_URL's, any SPHERE key header, an unknown key or the wrong key for a route).

    The shapes follow SPACE at ef4dc894 as read from its source (MEDIUM confidence, unverified live):
    ``GET /organizations`` answers the admin ``{"data": [...], "pagination": {...}}`` (``orgs_shape="data"``: only
    ``data``; ``"list"``: a bare list) filtered by ``q`` and paged by ``limit`` (default 10, max 50) and ``offset``; a
    created organization carries a first key of scope ALL; a service created from SPHERE carries ``source`` and the
    ``sphere`` sub-document; the synchronization status is ``configuration.status`` (``sync_shape="top"``: top level).
    """

    def __init__(self, *, host="space-api", port=3000, admin_user=ADMIN_USER, admin_key=ADMIN_KEY, pricings=None,
                 sync_script=("queued", "checking", "applying", "ready"), created_name="openbinding",
                 echo_on_error=False, fail_service_post=False, orgs_shape="admin", id_field="id", sync_shape="nested",
                 hide_management_values=False, redirect_organizations=None):
        self.host, self.port, self.admin_user, self.admin_key = host, port, admin_user, admin_key
        self.organizations: list[dict] = []
        self.services: dict[str, dict] = {}
        self.sync_status: dict[str, str] = {}
        self.sync_script = list(sync_script)
        self.pricings = pricings if pricings is not None else [{"version": "1.0.0", "id": "p1"}, {"version": "1.1.0", "id": "p2"}]
        self.created_name = created_name
        self.echo_on_error = echo_on_error
        self.fail_service_post = fail_service_post
        self.orgs_shape, self.id_field, self.sync_shape = orgs_shape, id_field, sync_shape
        self.hide_management_values = hide_management_values
        self.redirect_organizations = redirect_organizations
        self.requests: list[tuple[str, str]] = []
        self.queries: list[tuple[str, str, dict]] = []
        self.sent: list[str] = []
        self.violations: list[str] = []
        self.issued_keys: list[str] = []
        self.all_keys: list[str] = []
        self.key_posts = 0
        self.org_seq = 0
        self.sync_polls = 0

    # state helpers
    def add_organization(self, *, with_key: bool = False, name: str = "openbinding", org_id: str | None = None) -> dict:
        self.org_seq += 1
        all_key = f"all-key-sample-{self.org_seq:03d}-YY88"
        self.all_keys.append(all_key)
        org = {self.id_field: org_id or f"65a1b2c3d4e5f6a7b8c9{self.org_seq:04d}", "name": name,
               "owner": self.admin_user, "apiKeys": [{"key": all_key, "scope": "ALL"}]}
        if with_key:
            self._new_key(org)
        self.organizations.append(org)
        return org

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

    def _new_key(self, org: dict) -> str:
        key = f"mgmt-key-sample-{len(self.issued_keys) + 1:03d}-ZZ99"
        org["apiKeys"].append({"key": key, "scope": "MANAGEMENT"})
        self.issued_keys.append(key)
        return key

    def _org_view(self, org: dict) -> dict:
        view = json.loads(json.dumps(org))
        if self.hide_management_values:
            for entry in view["apiKeys"]:
                if entry["scope"] == "MANAGEMENT":
                    entry.pop("key")
        return view

    @property
    def secrets(self) -> list[str]:
        return [ADMIN_PASSWORD, self.admin_key, *self.issued_keys, *self.all_keys]

    def count(self, method: str, fragment: str = "", exact: bool = False) -> int:
        return sum(1 for m, p in self.requests if m == method and (p == fragment if exact else fragment in p))

    def changes(self) -> list[tuple[str, str]]:
        """Every request other than a GET, apart from the authentication."""
        return [(m, p) for m, p in self.requests if m != "GET" and not (m == "POST" and p.endswith("/users/authenticate"))]

    # transport
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.host != self.host or request.url.port != self.port:
            self.violations.append(f"request to {request.url.host}:{request.url.port}")
            return httpx.Response(599, json={"error": "foreign host"})
        for name in request.headers:
            if "sphere" in name.lower():
                self.violations.append(f"SPHERE header {name}")
        method, path = request.method, request.url.path
        self.requests.append((method, path))
        self.queries.append((method, path, dict(request.url.params)))
        self.sent.append(f"{request.url} {dict(request.headers)} {request.content.decode('utf-8', 'replace')}")
        body = json.loads(request.content) if request.content else {}
        if path == "/api/v1/users/authenticate" and method == "POST":
            if body.get("username") == self.admin_user and body.get("password") == ADMIN_PASSWORD:
                return httpx.Response(200, json={"username": self.admin_user, "apiKey": self.admin_key, "role": "ADMIN"})
            return httpx.Response(401, json={"error": "bad credentials"})
        # Which key each route takes is an assumption of these tests (UNVERIFIED against a live v1.7.1): the admin key
        # on the organization routes, the organization's MANAGEMENT key on the service and pricing routes.  So is the
        # visibility of key values in GET /organizations (``hide_management_values`` simulates the opposite).
        key = request.headers.get("x-api-key")
        wanted = self.admin_key if path.startswith("/api/v1/organizations") else None
        if wanted is not None and key != wanted:
            self.violations.append(f"not the admin key on {method} {path}")
            return httpx.Response(401, json={"error": "admin key required"})
        if wanted is None and key not in self.issued_keys:
            self.violations.append(f"not a MANAGEMENT key on {method} {path}")
            return httpx.Response(401, json={"error": "MANAGEMENT key required"})
        return self._route(method, request.url.raw_path.decode("ascii").split("?", 1)[0], path,
                           dict(request.url.params), body)

    def _route(self, method: str, raw: str, path: str, params: dict, body: dict) -> httpx.Response:
        if path == "/api/v1/organizations":
            if method == "GET":
                if self.redirect_organizations:
                    return httpx.Response(302, headers={"location": self.redirect_organizations})
                found = [o for o in self.organizations if params.get("q", "").lower() in o["name"].lower()]
                limit = min(int(params.get("limit", 10)), 50)
                offset = int(params.get("offset", 0))
                page = [self._org_view(o) for o in found[offset:offset + limit]]
                if self.orgs_shape == "list":
                    return httpx.Response(200, json=page)
                if self.orgs_shape == "data":
                    return httpx.Response(200, json={"data": page})
                return httpx.Response(200, json={"data": page, "pagination": {
                    "offset": offset, "limit": limit, "total": len(found), "page": offset // limit + 1,
                    "pages": -(-len(found) // limit)}})
            if method == "POST":
                if body.get("name") != "openbinding" or body.get("owner") != self.admin_user:
                    return httpx.Response(400, json={"error": "bad organization"})
                org = self.add_organization()
                return httpx.Response(201, json=self._org_view(org))
        match = re.fullmatch(r"/api/v1/organizations/([^/]+)/api-keys", raw)
        if match and method == "POST":
            org_id = urllib.parse.unquote(match.group(1))
            org = next((o for o in self.organizations if o[self.id_field] == org_id), None)
            if org is None or body.get("scope") != "MANAGEMENT":
                return httpx.Response(400, json={"error": "bad key request"})
            self.key_posts += 1
            self._new_key(org)
            return httpx.Response(200, json=json.loads(json.dumps(org)))
        match = re.fullmatch(r"/api/v1/organizations/([^/]+)", raw)
        if match and method in ("PUT", "PATCH", "DELETE"):
            org_id = urllib.parse.unquote(match.group(1))
            org = next((o for o in self.organizations if o[self.id_field] == org_id), None)
            if org is None:
                return httpx.Response(404, json={"error": "not found"})
            if method == "DELETE":
                self.organizations.remove(org)
                return httpx.Response(204)
            org.update(body)
            return httpx.Response(200, json=self._org_view(org))
        if path == "/api/v1/services" and method == "GET":
            return httpx.Response(200, json=json.loads(json.dumps(list(self.services.values()))))
        if path == "/api/v1/services" and method == "POST":
            if self.fail_service_post:
                text = f"service failed for key {self.issued_keys[-1] if self.issued_keys else self.admin_key} password {ADMIN_PASSWORD}" \
                    if self.echo_on_error else "service failed"
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
    # SPACE gives a new organization a key of scope ALL; the tool adds exactly one MANAGEMENT key
    assert [k["scope"] for k in fake.organizations[0]["apiKeys"]] == ["ALL", "MANAGEMENT"]
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
    assert fake.count("POST", "/api/v1/services", exact=True) == 1


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
    fake, contracts = FakeSpace(pricings=pricings), FakeContracts()
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
    _assert_aborted(tool, FakeSpace(pricings={"activePricings": {}, "archivedPricings": {"2.0.0": {}}}),
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
    assert len(fake.organizations) == 1
    assert [k["scope"] for k in fake.organizations[0]["apiKeys"]].count("MANAGEMENT") == 1


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
    assert not re.search(r"(?:getenv|environ)[^\n]*SPHERE_", code), "reads a SPHERE_* variable"
    assert not re.search(r"""open\([^)]*['"][rwxab+t]+['"]|\.write_text\(|\.write_bytes\(|Path\([^)]*\)\.write|os\.write\(|\.write\(""",
                         code), "the tool writes to a file"
    assert not re.search(r"\bos\.open\(|\.touch\(|FileHandler\b", code), "the tool creates a file"
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
        assert SPHERE_SAMPLE_KEY not in haystack + "\n".join(fake.sent), "the SPHERE key was used"
        assert list(tmp_path.iterdir()) == [], "the tool wrote a file"

    # a successful run through main; a SPHERE key in the environment is never read nor sent
    fake, contracts = FakeSpace(), FakeContracts()
    environ = {"SPACE_URL": SPACE_URL, "SPACE_ADMIN_USER": ADMIN_USER, "SPACE_ADMIN_PASSWORD": ADMIN_PASSWORD,
               "SPHERE_API_KEY": SPHERE_SAMPLE_KEY}

    async def fake_bootstrap(config, **kwargs):
        return await real(config, transport=fake.transport(), contracts=contracts, sleep=Sleeps())

    real = tool.bootstrap
    monkeypatch.setattr(tool, "bootstrap", fake_bootstrap)
    assert tool.main([], environ) == 0
    out, err = capsys.readouterr()
    assert len(out.strip().splitlines()) == 1 and json.loads(out)["organization"] == "created"
    for secret in [*fake.secrets, SPHERE_SAMPLE_KEY]:
        assert secret not in out and secret not in err
    assert fake.sent and SPHERE_SAMPLE_KEY not in "\n".join(fake.sent + [repr(m) for m in contracts.added])
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
    for secret in [*fake.secrets, SPHERE_SAMPLE_KEY]:
        assert secret not in err
    assert SPHERE_SAMPLE_KEY not in "\n".join(fake.sent)
    assert list(tmp_path.iterdir()) == []


# -- review round 1: realistic SPACE shapes, existing services, contracts, configuration and boundaries -------------


def _error_text(error: BaseException) -> str:
    text = str(error) + repr(error) + "".join(map(str, error.args))
    seen = {id(error)}
    while (error.__cause__ or error.__context__) and id(error.__cause__ or error.__context__) not in seen:
        error = error.__cause__ or error.__context__
        seen.add(id(error))
        text += str(error) + repr(error)
    return text


def test_the_organization_lookup_filters_by_name_and_matches_exactly(tool):
    # [utest->req~lab-space-bootstrap-idempotent~1]
    fake, contracts = FakeSpace(), FakeContracts()
    for index in range(12):  # more than SPACE's default page of 10, all matching the name filter
        fake.add_organization(name=f"openbinding-lab-{index}")
    fake.add_organization(with_key=True)
    report = run(tool, fake, contracts)
    assert report["organization"] == "exists" and report["apiKey"] == "exists"
    assert fake.count("POST", "/api/v1/organizations", exact=True) == 0 and fake.key_posts == 0
    lookups = [params for method, path, params in fake.queries if method == "GET" and path == "/api/v1/organizations"]
    assert lookups == [{"q": "openbinding", "limit": "50"}]


@pytest.mark.parametrize("orgs_shape,id_field", [("admin", "id"), ("admin", "_id"), ("data", "id"), ("list", "_id")])
def test_a_second_run_on_each_organizations_shape_changes_nothing(tool, orgs_shape, id_field):
    # [utest->req~lab-space-bootstrap-idempotent~1]
    fake, contracts = FakeSpace(orgs_shape=orgs_shape, id_field=id_field), FakeContracts(missing="404")
    first = run(tool, fake, contracts)
    assert first["organization"] == "created" and first["service"] == "created"
    fake.requests.clear()
    contracts.added.clear()
    report = run(tool, fake, contracts)
    assert report == {"organization": "exists", "apiKey": "exists", "service": "exists", "synchronization": "skipped",
                      "contracts": {name: "exists" for name in USERS}}
    assert fake.changes() == [] and contracts.added == [] and fake.key_posts == 1


def test_the_organization_id_is_percent_encoded_in_the_key_route(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    fake, contracts = FakeSpace(), FakeContracts()
    fake.add_organization(org_id="org/1 x")
    report = run(tool, fake, contracts)
    assert report["apiKey"] == "created" and fake.key_posts == 1


def test_a_management_key_listed_without_its_value_aborts(tool):
    # [utest->req~lab-space-bootstrap-idempotent~1]
    fake, contracts = FakeSpace(hide_management_values=True), FakeContracts()
    fake.add_organization(with_key=True)
    _assert_aborted(tool, fake, contracts, "apiKey: the organization lists a MANAGEMENT key without its value")
    assert fake.key_posts == 0 and fake.changes() == [], "no key may be minted for a hidden one"


def test_an_existing_service_still_synchronizing_is_polled_until_ready(tool):
    # [utest->req~lab-space-bootstrap-idempotent~1]
    fake, contracts, sleeps = FakeSpace(sync_script=("checking", "applying", "ready")), FakeContracts(), Sleeps()
    fake.add_organization(with_key=True)
    fake.add_service(sync="queued")
    report = run(tool, fake, contracts, sleeps)
    assert report["service"] == "exists" and report["synchronization"] == "ready"
    assert fake.count("POST", "/synchronization/run") == 0 and fake.changes() == []
    assert fake.sync_polls >= 3 and sleeps.calls and set(sleeps.calls) == {5}
    assert len(contracts.added) == 6


@pytest.mark.parametrize("status", ["blocked", "degraded", "failed"])
def test_an_existing_service_with_a_broken_synchronization_aborts(tool, status):
    # [utest->req~lab-space-bootstrap-creates~1]
    fake, contracts = FakeSpace(), FakeContracts()
    fake.add_organization(with_key=True)
    fake.add_service(sync=status)
    _assert_aborted(tool, fake, contracts, f"synchronization.*{status}")
    assert fake.changes() == [], "nothing is created or run for a broken synchronization"


def test_a_top_level_status_and_a_flat_service_are_accepted(tool):
    # [utest->req~lab-space-bootstrap-idempotent~1]
    fake, contracts = FakeSpace(sync_shape="top"), FakeContracts()
    assert run(tool, fake, contracts)["synchronization"] == "ready"
    fake.requests.clear()
    assert run(tool, fake, contracts)["synchronization"] == "skipped" and fake.changes() == []
    fake, contracts = FakeSpace(), FakeContracts()
    fake.add_organization(with_key=True)
    fake.add_service(flat=True)
    report = run(tool, fake, contracts)
    assert report["service"] == "exists" and report["synchronization"] == "skipped" and fake.changes() == []


def test_archived_pricings_are_ignored_in_the_list_shape(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    pricings = [{"version": "1.0.0", "status": "active"}, {"version": "1.1.0"},
                {"version": "2.0.0", "status": "archived"}]
    fake, contracts = FakeSpace(pricings=pricings), FakeContracts()
    run(tool, fake, contracts)
    assert {m.contracted_services["openbinding"] for m in contracts.added} == {"1.1.0"}


def test_a_missing_contract_reported_as_404_is_created(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    fake, contracts = FakeSpace(), FakeContracts(missing="404")
    contracts.preload("lab-admin")
    report = run(tool, fake, contracts)
    assert report["contracts"] == {"lab-admin": "exists", **{name: "created" for name in USERS[1:]}}
    assert {m.user_contact.user_id for m in contracts.added} == {seed_id(n) for n in USERS[1:]}


def test_a_contract_refused_without_an_error_aborts(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    fake, contracts = FakeSpace(), FakeContracts(refuse=True)
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(tool.bootstrap(make_config(tool), transport=fake.transport(), contracts=contracts, sleep=Sleeps()))
    assert str(raised.value) == "contracts: lab-admin not confirmed"
    assert len(contracts.added) == 1, "the bootstrap stops at the first contract it cannot confirm"


def test_a_contract_with_another_plan_is_not_confirmed(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
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


def test_a_contract_lookup_error_names_only_its_type(tool):
    # [utest->req~lab-space-bootstrap-sphere-readonly~1]
    fake = FakeSpace()
    contracts = FakeContracts(error=space_api_error(500, {"error": f"broken for {ADMIN_KEY} {ADMIN_PASSWORD}"}))
    with pytest.raises(tool.BootstrapError) as raised:
        asyncio.run(tool.bootstrap(make_config(tool), transport=fake.transport(), contracts=contracts, sleep=Sleeps()))
    assert str(raised.value) == "contracts: lab-admin failed (SpaceApiError)"
    text = _error_text(raised.value)
    for secret in fake.secrets:
        assert secret not in text
    assert contracts.added == []


def test_the_contracts_client_gets_the_management_key_and_is_closed(tool, monkeypatch):
    # [utest->req~lab-space-bootstrap-creates~1]
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
    assert calls == [(SPACE_URL, fake.issued_keys[-1])], "the SDK must use the MANAGEMENT key, not the admin key"
    assert closed == [True]


@pytest.mark.parametrize("step", ["connect", "close"])
def test_a_failing_contracts_client_names_only_the_exception_type(tool, monkeypatch, step):
    # [utest->req~lab-space-bootstrap-sphere-readonly~1]
    fake, contracts = FakeSpace(), FakeContracts()

    async def close():
        if step == "close":
            raise RuntimeError(f"close failed with {fake.issued_keys[-1]}")

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


def test_another_space_host_and_admin_user(tool):
    # [utest->req~lab-space-bootstrap-creates~1]
    fake, contracts = FakeSpace(host="other-space", admin_user="another-admin", admin_key="admin-key-sample-BBBB2222"), \
        FakeContracts()
    config = tool.Config.from_environ({"SPACE_URL": "http://other-space:3000", "SPACE_ADMIN_USER": "another-admin",
                                       "SPACE_ADMIN_PASSWORD": ADMIN_PASSWORD})
    report = asyncio.run(tool.bootstrap(config, transport=fake.transport(), contracts=contracts, sleep=Sleeps()))
    assert not fake.violations, fake.violations
    assert report["organization"] == "created" and fake.organizations[0]["owner"] == "another-admin"
    assert len(contracts.added) == 6


@pytest.mark.parametrize("url", ["ftp://x", "http://user:pw@host", "http://", "http:///path", "space-api:3000",
                                 "https://:443"])
def test_an_invalid_space_url_is_refused(tool, url):
    # [utest->req~lab-space-bootstrap-creates~1]
    with pytest.raises(tool.BootstrapError) as raised:
        tool.Config.from_environ({"SPACE_URL": url, "SPACE_ADMIN_PASSWORD": "pw"})
    assert url not in str(raised.value) and "user:pw" not in _error_text(raised.value)
    assert str(raised.value).startswith("configuration: SPACE_URL")


@pytest.mark.parametrize("url", ["http://space-api:3000", "https://space.example.org", "http://other-space:3000/"])
def test_a_valid_space_url_is_accepted(tool, url):
    # [utest->req~lab-space-bootstrap-creates~1]
    assert tool.Config.from_environ({"SPACE_URL": url, "SPACE_ADMIN_PASSWORD": "pw"}).space_url == url


def test_a_redirect_is_not_followed_and_proxies_are_not_read(tool):
    # [utest->req~lab-space-bootstrap-sphere-readonly~1]
    fake, contracts = FakeSpace(redirect_organizations="http://elsewhere:3000/api/v1/organizations"), FakeContracts()
    _assert_aborted(tool, fake, contracts, "organization")
    assert fake.count("GET", "/api/v1/organizations") == 1
    code = _source()
    assert "follow_redirects=False" in code and "trust_env=False" in code


def test_main_reports_an_unexpected_error_by_its_type_only(tool, capsys, monkeypatch):
    # [utest->req~lab-space-bootstrap-sphere-readonly~1]
    async def exploding(config, **kwargs):
        raise RuntimeError(f"boom {ADMIN_KEY} {ADMIN_PASSWORD}")

    monkeypatch.setattr(tool, "bootstrap", exploding)
    environ = {"SPACE_URL": SPACE_URL, "SPACE_ADMIN_USER": ADMIN_USER, "SPACE_ADMIN_PASSWORD": ADMIN_PASSWORD}
    assert tool.main([], environ) == 1
    out, err = capsys.readouterr()
    assert out == "" and err == "space_lab_bootstrap: unexpected RuntimeError\n"


def test_control_the_fake_records_and_applies_modifications():
    # [utest->req~lab-space-bootstrap-creates~1]
    fake = FakeSpace()
    fake.add_organization(with_key=True)
    fake.add_service()

    async def modify():
        async with httpx.AsyncClient(base_url=SPACE_URL, transport=fake.transport()) as client:
            headers = {"x-api-key": fake.issued_keys[-1]}
            await client.put("/api/v1/services/openbinding", headers=headers, json={"source": "local"})
            await client.delete("/api/v1/services/openbinding", headers=headers)

    asyncio.run(modify())
    assert fake.changes() == [("PUT", "/api/v1/services/openbinding"), ("DELETE", "/api/v1/services/openbinding")]
    assert fake.services == {} and not fake.violations


def test_the_tool_imports_only_the_standard_library_httpx_and_space_client():
    # [utest->req~lab-space-no-direct-http~1]
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


def _normalise(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def test_the_tool_requirements_follow_the_gateway_lock():
    # [utest->req~lab-space-image-pinned-commit~1]
    locked = {_normalise(p["name"]): p["version"] for p in tomllib.loads(_read(UV_LOCK))["package"] if "version" in p}
    pins = {}
    for raw in _read(REQUIREMENTS).splitlines():
        line = raw.split("#", 1)[0].strip()
        if "==" in line:
            name, version = line.split("==", 1)
            pins[_normalise(name.split("[", 1)[0])] = version.strip()
    shared = set(pins) & set(locked)
    assert {"httpx", "space-python-client"} <= shared
    assert {name: pins[name] for name in shared} == {name: locked[name] for name in shared}
