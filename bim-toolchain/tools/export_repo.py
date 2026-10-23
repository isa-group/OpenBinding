"""Export ``bim-toolchain/`` from a clone of OpenBinding as a new, self-contained git repository (stdlib and git only).

Run it from a clone of OpenBinding (on the Mac, with the repository checked out and committed)::

    python3 bim-toolchain/tools/export_repo.py --output ../bim-toolchain-export

It writes a new repository with the *committed* contents of ``bim-toolchain/`` at its root and ONE commit, authored by
the identity that ``git config user.name`` / ``user.email`` give in the clone you run it from; its message is neutral and
cites the commit of OpenBinding it was exported from.  It carries no history, creates no remote, no tag and pushes nothing:
publishing is a separate step (``docs/DELIVERY.md``).

Before anything is written it checks the staged tree and refuses (exit 1, nothing created) if any check fails:

* no configuration, credentials, logs, datasets or tooling markers of OpenBinding (``EXCLUDED``);
* a scan for secrets (private keys, cloud and VCS tokens, credentials in URLs, assigned secrets), which never prints one;
* the license inventory: ``licenses.json`` coherent, one SPDX identifier everywhere, the four ``NOTICE.md`` and the ``LICENSE`` of each package equal to the root ones, ``license-files`` in every pyproject;
* no file that is not the holder's own: nothing under a ``vendor`` directory except what ``licenses.json`` declares, no
  binary files;
* no reference that leaves the repository (a Markdown link that resolves outside it);
* the OMG BPMN XSDs: the repository never carries the five files, so the export refuses a committed tree that versions
  one of them or whose ``licenses.json`` does not say ``present_in_tree: false``, and never copies them; the exported
  workflows and builds download them with a verified SHA-256 (``tools/xsd_inventory.py --ensure``);
* self-containment: the exported tree, copied somewhere else, passes ``pytest -m 'not openbinding_corpus'`` from scratch with
  no corpus and no skipped test (``--skip-self-test`` turns this off; in that copy the OMG files are downloaded with the
  verified download, which is what a real build does).
"""

from __future__ import annotations

import argparse
import fnmatch
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Callable

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import xsd_inventory  # noqa: E402

TREE = "bim-toolchain"
SPDX = "CC-BY-4.0"
#: Directory names that never travel.
EXCLUDED_DIRECTORIES = frozenset({
    "dist", ".venv", ".verify-venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", "node_modules", ".git",
    "datasets", "logs", ".idea", ".vscode",
})
#: Files that never travel: bootstrap markers of the extraction, credentials, logs, caches, local databases.
EXCLUDED_FILES = (
    ".extraction-bootstrap", ".copied", ".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "*.p12", "*.pfx",
    "*.secret", ".netrc", "credentials*", "*.log", "*.pyc", "*.sqlite", "*.sqlite3", "*.db", ".DS_Store",
)
SECRET_PATTERNS: dict[str, re.Pattern[str]] = {
    "private key block": re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----"),
    "AWS access key id": re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    "GitHub token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b"),
    "Slack token": re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    "Google API key": re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    "JSON Web Token": re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    "credentials in a URL": re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@[^\s/]+"),
    "assigned secret": re.compile(
        r"""(?i)\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*[:=]\s*["'][A-Za-z0-9/+_=-]{16,}["']"""
    ),
}
MARKDOWN_LINK = re.compile(r"\]\(([^)\s]+)\)")
SUITES = ("packages/bim-core/tests", "packages/bim-service/tests", "packages/bim-client/tests", "tools")


class ExportError(RuntimeError):
    """The export cannot be made; the message says why."""


def progress(message: str) -> None:
    print(f"[export_repo] {message}", file=sys.stderr, flush=True)


def git(*arguments: str, cwd: Path, check: bool = True, input_bytes: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(["git", *arguments], cwd=cwd, capture_output=True, input=input_bytes, check=False)
    if check and result.returncode != 0:
        raise ExportError(f"git {' '.join(arguments)} failed: {result.stderr.decode('utf-8', 'replace').strip()}")
    return result


# --- the source -------------------------------------------------------------------------------------------


def source_toplevel(path: Path) -> Path:
    return Path(git("rev-parse", "--show-toplevel", cwd=path).stdout.decode().strip())


def extract_committed_tree(top: Path, target: Path) -> str:
    """Extract the committed ``bim-toolchain/`` of ``top`` into ``target`` (without that prefix); return the commit."""
    commit = git("rev-parse", "HEAD", cwd=top).stdout.decode().strip()
    archive = git("archive", "--format=tar", "HEAD", TREE, cwd=top).stdout
    target.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar.getmembers():
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != TREE:
                raise ExportError(f"{member.name}: outside {TREE}/")
            relative = PurePosixPath(*parts[1:])
            if not parts[1:]:
                continue
            if ".." in relative.parts or relative.is_absolute() or not (member.isfile() or member.isdir()):
                raise ExportError(f"{member.name}: not a plain file or directory inside {TREE}/")
            destination = target / Path(*relative.parts)
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            handle = tar.extractfile(member)
            assert handle is not None
            destination.write_bytes(handle.read())
            destination.chmod(0o755 if member.mode & 0o111 else 0o644)
    return commit


def excluded(relative: PurePosixPath) -> bool:
    if any(part in EXCLUDED_DIRECTORIES or part.endswith(".egg-info") for part in relative.parts[:-1]):
        return True
    name = relative.name
    return name in EXCLUDED_DIRECTORIES or any(fnmatch.fnmatch(name, pattern) for pattern in EXCLUDED_FILES)


def files_of(root: Path) -> list[str]:
    return sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file())


def stage_tree(original: Path, stage: Path) -> list[str]:
    """Copy ``original`` to ``stage`` without the excluded files; return the paths that were left out."""
    left_out = []
    for relative in files_of(original):
        if excluded(PurePosixPath(relative)):
            left_out.append(relative)
            continue
        source, destination = original / relative, stage / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    return left_out


# --- the OMG XSDs: never in the tree -----------------------------------------------------------------------


def committed_xsd_problems(original: Path) -> list[str]:
    """Why the committed tree cannot be exported: it versions one of the five OMG files, or does not declare that it does not."""
    try:
        section = xsd_inventory.load_licenses(original)["omg_bpmn_xsd"]
    except (OSError, ValueError, KeyError) as exc:
        return [f"licenses.json cannot be read: {exc}"]
    problems = []
    versioned = [name for name in section["files"] if (original / section["directory"] / name).is_file()]
    if versioned:
        problems.append(
            f"the committed tree versions the OMG BPMN XSDs ({', '.join(sorted(versioned))}); the repository never carries "
            f"them: `git rm --cached` them, they are downloaded and verified at build time (docs/OMG_XSD_RIGHTS.md)"
        )
    if section.get("present_in_tree") is not False:
        problems.append('licenses.json: omg_bpmn_xsd.present_in_tree must be false (the files are downloaded, never versioned)')
    return problems


# --- the checks on the staged tree ---------------------------------------------------------------------------


def text_of(path: Path) -> str | None:
    try:
        return path.read_bytes().decode("utf-8")
    except UnicodeDecodeError:
        return None


def scan_secrets(stage: Path) -> list[str]:
    """``path:line: kind`` for every line that looks like a secret; the secret itself is never reported."""
    found = []
    for relative in files_of(stage):
        text = text_of(stage / relative)
        if text is None:
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            for kind, pattern in SECRET_PATTERNS.items():
                if pattern.search(line):
                    found.append(f"{relative}:{number}: {kind}")
    return found


def license_problems(stage: Path) -> list[str]:
    """The license inventory of the staged tree."""
    problems: list[str] = []
    try:
        licenses = xsd_inventory.load_licenses(stage)
    except (OSError, ValueError) as exc:
        return [f"licenses.json cannot be read: {exc}"]
    own = licenses.get("own_material", {})
    if own.get("spdx") != SPDX:
        problems.append(f"licenses.json: own_material.spdx is {own.get('spdx')!r}, expected {SPDX!r}")
    for name in ("LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md", "docs/LICENSING.md"):
        if not (stage / name).is_file():
            problems.append(f"{name} is missing")
    if (stage / "LICENSE").is_file() and not (stage / "LICENSE").read_text(encoding="utf-8").startswith("Attribution 4.0 International"):
        problems.append("LICENSE is not the text of Creative Commons Attribution 4.0 International")
    root_notice = (stage / "NOTICE.md").read_bytes() if (stage / "NOTICE.md").is_file() else None
    root_license = (stage / "LICENSE").read_bytes() if (stage / "LICENSE").is_file() else None
    packages = sorted(path for path in (stage / "packages").glob("*") if path.is_dir())
    if not packages:
        problems.append("packages/ is missing or empty")
    for package in packages:
        notice = package / "NOTICE.md"
        if not notice.is_file() or notice.read_bytes() != root_notice:
            problems.append(f"{package.name}/NOTICE.md is missing or not a copy of NOTICE.md")
        license_copy = package / "LICENSE"
        if root_license is None or not license_copy.is_file() or license_copy.read_bytes() != root_license:
            problems.append(f"{package.name}/LICENSE is missing or not a copy of LICENSE")
        pyproject = package / "pyproject.toml"
        text = pyproject.read_text(encoding="utf-8") if pyproject.is_file() else ""
        if not re.search(r'^license-files\s*=\s*\[\s*"LICENSE"\s*,\s*"NOTICE\.md"\s*\]\s*$', text, re.MULTILINE):
            problems.append(f'{package.name}/pyproject.toml does not declare license-files = ["LICENSE", "NOTICE.md"]')
        if not re.search(rf'^license\s*=\s*"{re.escape(SPDX)}"\s*$', text, re.MULTILINE):
            problems.append(f"{package.name}/pyproject.toml does not declare license = \"{SPDX}\"")
        if "Private :: Do Not Upload" not in text:
            problems.append(f"{package.name}/pyproject.toml lost the classifier Private :: Do Not Upload")
    section = licenses.get("omg_bpmn_xsd", {})
    problems += [f"licenses.json: {item}" for item in xsd_inventory.clearance_problems(section)]
    if section.get("present_in_tree") is not False:
        problems.append("licenses.json: present_in_tree must be false (the OMG XSDs are downloaded, never versioned)")
    present = [name for name in section.get("files", []) if (stage / section.get("directory", "") / name).is_file()]
    if present:
        problems.append(f"the OMG XSDs are in the tree ({', '.join(sorted(present))}): the repository never carries them")
    return problems


def foreign_files(stage: Path) -> list[str]:
    """Files that are not the holder's own: unknown ``vendor`` content and anything that is not text."""
    problems = []
    try:
        section = xsd_inventory.load_licenses(stage)["omg_bpmn_xsd"]
        declared = {f"{section['directory']}/{name}" for name in section["files"]} | {f"{section['directory']}/README.md"}
    except (OSError, ValueError, KeyError):
        declared = set()
    for relative in files_of(stage):
        parts = PurePosixPath(relative).parts
        if "vendor" in parts[:-1] and relative not in declared:
            problems.append(f"{relative}: vendored file that licenses.json does not declare")
        elif text_of(stage / relative) is None:
            problems.append(f"{relative}: not a text file (binary content is not own material)")
    return problems


def outside_references(stage: Path) -> list[str]:
    """Markdown links whose target resolves outside the repository."""
    problems = []
    root = Path(os.path.normpath(stage))
    for relative in files_of(stage):
        if not relative.endswith(".md"):
            continue
        text = text_of(stage / relative)
        if text is None:
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            for target in MARKDOWN_LINK.findall(line):
                if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith("#"):
                    continue
                resolved = Path(os.path.normpath((stage / relative).parent / target.split("#", 1)[0]))
                if resolved != root and root not in resolved.parents:
                    problems.append(f"{relative}:{number}: link {target!r} leaves the repository")
    return problems


def self_test(stage: Path, *, fetch_xsd: bool = False, opener: Callable[[str], bytes] | None = None) -> list[str]:
    """Copy the staged tree elsewhere and run the suite without the corpus from scratch.

    With ``fetch_xsd`` the five OMG files, which the tree does not carry, are downloaded into the copy by the verified
    download of ``xsd_inventory`` (``opener`` replaces the network in tests); a digest that is not the declared one is a problem.
    """
    with tempfile.TemporaryDirectory(prefix="export-self-test-") as directory:
        copy = Path(directory) / "repo"
        shutil.copytree(stage, copy)
        if fetch_xsd:
            section = xsd_inventory.load_licenses(copy)["omg_bpmn_xsd"]
            try:
                xsd_inventory.fetch(copy / section["directory"], copy, opener=opener)
            except xsd_inventory.FetchError as exc:
                return [f"the OMG XSDs could not be downloaded into the copy: {exc}"]
        empty = Path(directory) / "no-corpus"
        empty.mkdir()
        sources = os.pathsep.join(str(copy / "packages" / name / "src") for name in ("bim-core", "bim-service", "bim-client"))
        env = {key: value for key, value in os.environ.items() if not key.startswith("BIM_") and key != "PYTHONPATH"}
        env.update({"BIM_CORPUS_ROOT": str(empty), "BIM_NESTED_RUN": "1", "PYTHONPATH": sources, "PYTHONDONTWRITEBYTECODE": "1"})
        command = [sys.executable, "-m", "pytest", "--rootdir", str(copy), "-p", "no:cacheprovider",
                   "-m", "not openbinding_corpus", "-rs", "-q", *SUITES]
        result = subprocess.run(command, cwd=copy, env=env, capture_output=True, text=True, check=False)
        output = result.stdout + result.stderr
        skipped = [line for line in output.splitlines() if line.startswith("SKIPPED")]
        problems = []
        if result.returncode != 0:
            problems.append("the suite of the exported tree failed:\n" + "\n".join(output.strip().splitlines()[-25:]))
        if skipped:
            problems.append(f"{len(skipped)} test groups were skipped:\n" + "\n".join(skipped[:10]))
        return problems


def verify_stage(stage: Path, *, run_self_test: bool, opener: Callable[[str], bytes] | None = None) -> list[str]:
    problems = [f"secret: {item}" for item in scan_secrets(stage)]
    problems += [f"license: {item}" for item in license_problems(stage)]
    problems += [f"not own material: {item}" for item in foreign_files(stage)]
    problems += [f"reference: {item}" for item in outside_references(stage)]
    for required in ("pyproject.toml", "packages", "tools", "README.md"):
        if not (stage / required).exists():
            problems.append(f"{required} is missing from the root of the exported tree")
    if run_self_test and not problems:
        progress("self-containment: running the suite without the corpus on a copy (this takes a few minutes)")
        problems += [f"self-containment: {item}" for item in self_test(stage, fetch_xsd=True, opener=opener)]
    return problems


# --- the new repository --------------------------------------------------------------------------------------


def identity(top: Path) -> tuple[str, str]:
    name = git("config", "user.name", cwd=top, check=False).stdout.decode().strip()
    email = git("config", "user.email", cwd=top, check=False).stdout.decode().strip()
    if not name or not email:
        raise ExportError("git user.name and user.email are not configured here: run `git config user.name ...` and `git config user.email ...`")
    return name, email


def commit_message(commit: str) -> str:
    return (
        f"Import bim-toolchain from OpenBinding at {commit}\n\n"
        f"Source: the committed contents of {TREE}/ at commit {commit} of the OpenBinding repository. "
        "No history is carried over.\n"
        "OMG BPMN XSD files: not versioned (downloaded and SHA-256 verified at build time).\n"
    )


def create_repository(output: Path, stage: Path, identity_pair: tuple[str, str], message: str) -> dict[str, Any]:
    output.mkdir(parents=True, exist_ok=True)
    git("init", "-q", cwd=output)
    git("symbolic-ref", "HEAD", "refs/heads/main", cwd=output)
    for relative in files_of(stage):
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(stage / relative, destination)
    git("add", "-A", "--force", cwd=output)
    name, email = identity_pair
    git("-c", f"user.name={name}", "-c", f"user.email={email}", "commit", "-q", "--no-gpg-sign", "-F", "-",
        cwd=output, input_bytes=message.encode("utf-8"))
    tracked = [item for item in git("ls-files", "-z", cwd=output).stdout.decode().split("\0") if item]
    if sorted(tracked) != files_of(stage):
        raise ExportError("the commit does not contain exactly the staged files (an ignore rule dropped some?)")
    return {
        "commit": git("rev-parse", "HEAD", cwd=output).stdout.decode().strip(),
        "tree": git("rev-parse", "HEAD^{tree}", cwd=output).stdout.decode().strip(),
        "files": len(tracked),
    }


def export(arguments: argparse.Namespace, opener: Callable[[str], bytes] | None = None) -> dict[str, Any]:
    output = arguments.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise ExportError(f"{output} exists and is not empty")
    top = source_toplevel(arguments.source.resolve())
    if not arguments.allow_dirty and git("status", "--porcelain", "--untracked-files=no", "--", TREE, cwd=top).stdout.strip():
        raise ExportError(f"{TREE}/ has uncommitted changes: only the committed contents are exported; commit them or pass --allow-dirty")
    identity_pair = identity(top)
    with tempfile.TemporaryDirectory(prefix="export-repo-") as directory:
        work = Path(directory)
        original, stage = work / "original", work / "stage"
        commit = extract_committed_tree(top, original)
        refused = committed_xsd_problems(original)
        if refused:
            raise ExportError("the export was refused:\n- " + "\n- ".join(refused))
        left_out = stage_tree(original, stage)
        problems = verify_stage(stage, run_self_test=not arguments.skip_self_test, opener=opener)
        if problems:
            raise ExportError("the export was refused:\n- " + "\n- ".join(problems))
        created = create_repository(output, stage, identity_pair, commit_message(commit))
    return {
        "output": str(output),
        "sourceCommit": commit,
        "xsd": "not versioned: downloaded and verified at build time",
        "leftOut": left_out,
        "selfTest": "skipped" if arguments.skip_self_test else "passed",
        **created,
    }


def main(argv: list[str] | None = None, opener: Callable[[str], bytes] | None = None) -> int:
    """``opener`` replaces the network of the self-containment run (the tests inject one; a real run downloads)."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--output", type=Path, required=True, help="the directory of the new repository (absent or empty)")
    parser.add_argument("--source", type=Path, default=TOOLS, help="a path inside the OpenBinding clone (default: this checkout)")
    parser.add_argument("--skip-self-test", action="store_true", help="do not run the suite on the exported tree")
    parser.add_argument("--allow-dirty", action="store_true", help="export the committed contents although the working tree differs")
    arguments = parser.parse_args(argv)
    try:
        summary = export(arguments, opener)
    except ExportError as exc:
        print(f"export_repo: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
