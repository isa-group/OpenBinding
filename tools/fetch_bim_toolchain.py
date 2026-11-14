"""Fetch what OpenBinding uses of the pinned bim-toolchain release: its wheels, and its test kit.

The BIM language is not in this repository. The gateway installs ``bim-core`` and ``bim-client`` (and, for the
tests, ``bim-service``) from the wheels of a release of javiercavlop/bim-toolchain; ``openbinding-gateway/uv.lock``
pins their versions and SHA-256, and resolves them from the flat index ``openbinding-gateway/.bim-wheels/``, which
this tool fills. While the repository is private GitHub serves release assets only through its API with a token, so
the wheels cannot be plain URLs in the lock; every file written here is checked against the SHA-256 of the lock
(or, with ``--bootstrap``, of the release's ``SHA256SUMS``) before it is kept.

    python3 tools/fetch_bim_toolchain.py --wheels                  # openbinding-gateway/.bim-wheels/, as uv.lock pins
    python3 tools/fetch_bim_toolchain.py --wheels --bootstrap v0.3.0   # a new release, before `uv lock`
    python3 tools/fetch_bim_toolchain.py                           # the test kit into .bim-toolchain/
    python3 tools/fetch_bim_toolchain.py --print                   # the repository and the tag of the lock

The test kit is the release's ``tools/``, ``golden/``, ``contracts/`` and test fixtures, checked out from the tag of
the locked version **without** the code of ``packages/*/src`` (only the resources of ``bim_core``): the code under
test is always the installed release. The consumer
contract of OpenBinding (the corpus tier of the toolchain run against this repository's corpus, ``baseline_core.py
--check`` and the gateway's BIM consumer tests) reads it; ``BIM_TOOLCHAIN_ROOT`` points the tests to another checkout.

The token: ``BIM_TOOLCHAIN_TOKEN``, else ``GH_TOKEN``/``GITHUB_TOKEN``, else ``gh auth token``; none is needed once the
repository is public. It is sent only to api.github.com, and never written anywhere.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "openbinding-gateway" / "uv.lock"
WHEELS = ROOT / "openbinding-gateway" / ".bim-wheels"
OWNER_REPOSITORY = "javiercavlop/bim-toolchain"
REPOSITORY = f"https://github.com/{OWNER_REPOSITORY}.git"
API = f"https://api.github.com/repos/{OWNER_REPOSITORY}"
DESTINATION = ROOT / ".bim-toolchain"
PACKAGES = ("bim-core", "bim-client", "bim-service")
#: Everything but the code of the packages (non-cone sparse checkout patterns, later ones win). The resources of
#: bim_core (schemas, the engine contract, vendored files) are data, not code: the corpus tier compares OpenBinding's
#: copies with them (test_boundary.py), and with no ``__init__.py`` beside them they never shadow the installed package.
SPARSE = ("/*", "!/packages/*/src/", "/packages/bim-core/src/bim_core/resources/")


class FetchError(Exception):
    pass


def locked_wheels(lock: Path = LOCK) -> tuple[str, dict[str, str]]:
    """The version of the toolchain packages in the lock and {wheel file name: sha256}."""
    packages = {item["name"]: item for item in tomllib.loads(lock.read_text(encoding="utf-8"))["package"]}
    present = [packages[name] for name in PACKAGES if name in packages]
    versions = {item["version"] for item in present}
    if len(versions) != 1 or not {"bim-core", "bim-client"} <= {item["name"] for item in present}:
        raise FetchError(f"{lock}: bim-core and bim-client must be locked at one version, found {sorted(versions)}")
    wheels = {}
    for item in present:
        for wheel in item.get("wheels", []):
            name = Path(wheel.get("filename") or wheel.get("path") or wheel.get("url", "")).name
            algorithm, _, digest = wheel["hash"].partition(":")
            if algorithm != "sha256" or not name.endswith(".whl"):
                raise FetchError(f"{lock}: unexpected wheel entry of {item['name']}: {wheel}")
            wheels[name] = digest
    if not wheels:
        raise FetchError(f"{lock}: no wheel is pinned for {', '.join(PACKAGES)} (run with --bootstrap first)")
    return versions.pop(), wheels


def token() -> str | None:
    for variable in ("BIM_TOOLCHAIN_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        if os.environ.get(variable):
            return os.environ[variable]
    if shutil.which("gh"):
        done = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, check=False)
        if done.returncode == 0 and done.stdout.strip():
            return done.stdout.strip()
    return None


def api(path_or_url: str, *, accept: str = "application/vnd.github+json") -> bytes:
    url = path_or_url if path_or_url.startswith("https://") else f"{API}/{path_or_url}"
    if not url.startswith("https://api.github.com/"):
        raise FetchError(f"refusing to send the token to {url}")
    request = urllib.request.Request(url, headers={"Accept": accept, "X-GitHub-Api-Version": "2022-11-28"})
    secret = token()
    if secret:
        # Unredirected: the asset endpoint redirects to a signed URL on another host, which must not receive it.
        request.add_unredirected_header("Authorization", f"Bearer {secret}")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    except OSError as error:
        hint = "" if secret else " (no token: set BIM_TOOLCHAIN_TOKEN or log in with gh)"
        raise FetchError(f"GET {url}: {error}{hint}") from error


def release_assets(tag: str) -> dict[str, int]:
    release = json.loads(api(f"releases/tags/{tag}"))
    return {asset["name"]: asset["id"] for asset in release["assets"]}


def fetch_wheels(into: Path, tag: str, expected: dict[str, str] | None) -> list[str]:
    """Download the wheels of ``tag`` into ``into``, each verified; ``expected`` None reads the release's SHA256SUMS."""
    assets = release_assets(tag)
    if expected is None:
        if "SHA256SUMS" not in assets:
            raise FetchError(f"release {tag} has no SHA256SUMS")
        sums = api(f"releases/assets/{assets['SHA256SUMS']}", accept="application/octet-stream").decode()
        expected = {
            name: digest
            for digest, name in (line.split() for line in sums.splitlines() if line.strip())
            if name.endswith(".whl") and name.split("-", 1)[0].replace("_", "-") in PACKAGES
        }
    into.mkdir(parents=True, exist_ok=True)
    written = []
    for name, digest in sorted(expected.items()):
        target = into / name
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == digest:
            continue
        if name not in assets:
            raise FetchError(f"release {tag} has no asset {name}")
        data = api(f"releases/assets/{assets[name]}", accept="application/octet-stream")
        found = hashlib.sha256(data).hexdigest()
        if found != digest:
            raise FetchError(f"{name}: SHA-256 {found}, the pin is {digest}; nothing written")
        with tempfile.NamedTemporaryFile(dir=into, delete=False) as handle:
            handle.write(data)
        os.replace(handle.name, target)
        written.append(name)
    return written


def git(*arguments: str, cwd: Path | None = None) -> None:
    subprocess.run(["git", *arguments], cwd=cwd, check=True)


def fetch_kit(destination: Path, tag: str) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    git("clone", "--quiet", "--depth", "1", "--branch", tag, "--filter=blob:none", "--no-checkout", REPOSITORY,
        str(destination))
    git("sparse-checkout", "set", "--no-cone", *SPARSE, cwd=destination)
    git("checkout", "--quiet", tag, cwd=destination)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--wheels", action="store_true", help="fetch the wheels into the flat index of the gateway")
    parser.add_argument("--bootstrap", metavar="TAG", help="with --wheels: the wheels of TAG, verified by its SHA256SUMS")
    parser.add_argument("--lock", type=Path, default=LOCK)
    parser.add_argument("--into", type=Path, default=WHEELS, help="with --wheels: the flat index directory")
    parser.add_argument("--destination", type=Path, default=DESTINATION, help="the test kit checkout")
    parser.add_argument("--print", action="store_true", help="print the repository and the tag of the lock")
    args = parser.parse_args(argv)
    try:
        if args.wheels and args.bootstrap:
            written = fetch_wheels(args.into, args.bootstrap, None)
            print(f"{args.into}: {args.bootstrap}, {len(written)} wheel(s) written, verified by SHA256SUMS")
            return 0
        version, wheels = locked_wheels(args.lock)
        tag = f"v{version}"
        if args.print:
            print(f"{REPOSITORY} {tag}")
        elif args.wheels:
            written = fetch_wheels(args.into, tag, wheels)
            print(f"{args.into}: {tag}, {len(wheels)} wheel(s) as {args.lock.name} pins, {len(written)} written")
        else:
            fetch_kit(args.destination, tag)
            print(f"{args.destination}: {REPOSITORY} {tag}, without the code of packages/*/src")
    except FetchError as error:
        print(f"fetch_bim_toolchain: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
