"""Verified download of the five OMG BPMN 2.0.2 XSDs, and the hatchling build hook that runs it before every build.

The repository does not version the files (``.gitignore``); the distributions do carry them (wheel, sdist, SDK, images),
because every build puts them in place first.  The bytes are always the ones declared here (SHA-256), so ``compilerDigest``,
which covers ``resources/``, is the same whichever way the files arrived.

    python3 hatch_build.py --ensure [--directory DIR]    # nothing to do if the five files are there and verify

This module is deliberately outside ``src/bim_core``: ``bim_core`` never downloads anything when it is used, and
``compilerDigest`` covers every ``.py`` file below ``src/bim_core``.  Only the standard library is needed (the hook base
class is imported from hatchling when hatchling is the one loading this file).

``licenses.json`` of the toolchain declares the same origin and digests; ``tools/test_xsd_inventory.py`` fails if they differ.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import os
import shlex
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Callable, Mapping

try:
    from hatchling.builders.hooks.plugin.interface import BuildHookInterface
except ImportError:  # run as a script, without hatchling
    BuildHookInterface = object  # type: ignore[assignment,misc]

SOURCE_BASE = "https://www.omg.org/spec/BPMN/20100501/"
SHA256: Mapping[str, str] = {
    "BPMN20.xsd": "a07c159cb0594573dd7c97b1370dd116112378f377e43c89a8bf512ac5030705",
    "BPMNDI.xsd": "f0dff1cd559d1514d8ebfc8c646f58402bcaced27ec22e2aa6456c2dcc80b038",
    "DC.xsd": "a2f90e5ad9bb48c6915e4e034b4e27ac838264a1d4f27bfc70dbdfc69351312d",
    "DI.xsd": "8220b179c175572df74e08a51bffabe957867962035cee7b5fee0b6acb4c4498",
    "Semantic.xsd": "c4318842f7d2bbc262d7954c9452c501db16f0868eac0b8732ec5d7fb384d9a7",
}
#: Where the files go, relative to the directory of this file (the project directory of ``bim-core``).
RELATIVE_DIRECTORY = "src/bim_core/resources/vendor/omg/bpmn/2.0.2"
HERE = Path(__file__).resolve().parent
DIRECTORY = HERE / RELATIVE_DIRECTORY
#: The largest file served is about 62 KB; anything much bigger is not what is expected and is not read.
MAX_BYTES = 1024 * 1024

Opener = Callable[[str], bytes]


class FetchError(RuntimeError):
    """The files cannot be put in place: a download that failed, or bytes that are not the declared ones."""


class NetworkError(FetchError):
    """The source could not be reached (no network, refused, timed out)."""


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def urlopen(url: str) -> bytes:
    """The bytes served at an https URL."""
    if not url.startswith("https://"):
        raise FetchError(f"{url}: only https downloads are made")
    try:
        with urllib.request.urlopen(url, timeout=60) as response:  # noqa: S310 (https only, checked above)
            data = response.read(MAX_BYTES + 1)
    except (OSError, http.client.HTTPException) as exc:
        raise NetworkError(f"{url}: {exc}") from exc
    if len(data) > MAX_BYTES:
        raise FetchError(f"{url}: more than {MAX_BYTES} bytes; not what is expected")
    return data


def problems(directory: Path = DIRECTORY, digests: Mapping[str, str] | None = None) -> list[str]:
    """What keeps ``directory`` from holding the five files with the declared bytes (empty when it does)."""
    found = []
    for name, declared in sorted((SHA256 if digests is None else digests).items()):
        path = Path(directory) / name
        if not path.is_file():
            found.append(f"{name}: missing")
        elif sha256_hex(path.read_bytes()) != declared:
            found.append(f"{name}: SHA-256 is not the declared {declared}")
    return found


def download(
    directory: Path = DIRECTORY,
    *,
    opener: Opener | None = None,
    source_base: str = SOURCE_BASE,
    digests: Mapping[str, str] | None = None,
) -> list[str]:
    """Download the files from ``source_base`` into ``directory``; nothing is written unless every one is the declared bytes.

    All five are read and compared first; only then are they written, each to a temporary file that replaces its target
    (``os.replace``), so a failure leaves the directory as it was.  Returns the names written.
    """
    wanted = dict(SHA256 if digests is None else digests)
    read = opener or urlopen
    downloaded: dict[str, bytes] = {}
    for name in sorted(wanted):
        url = f"{source_base}{name}"
        data = read(url)
        found = sha256_hex(data)
        if found != wanted[name]:
            raise FetchError(f"{url}: SHA-256 {found} is not the declared {wanted[name]}; nothing was written")
        downloaded[name] = data
    target = Path(directory)
    target.mkdir(parents=True, exist_ok=True)
    temporaries: list[tuple[Path, Path]] = []
    try:
        for name, data in downloaded.items():
            descriptor, temporary = tempfile.mkstemp(dir=target, prefix=f".{name}.", suffix=".part")
            temporaries.append((Path(temporary), target / name))
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
            os.chmod(temporary, 0o644)
        for temporary, destination in temporaries:
            os.replace(temporary, destination)
    finally:
        for temporary, _ in temporaries:
            temporary.unlink(missing_ok=True)
    return sorted(downloaded)


def command_for(directory: Path) -> str:
    """The exact command that puts the files in ``directory``."""
    return f"python3 {shlex.quote(str(Path(__file__).resolve()))} --ensure --directory {shlex.quote(str(directory))}"


def ensure(
    directory: Path = DIRECTORY,
    *,
    opener: Opener | None = None,
    source_base: str = SOURCE_BASE,
    digests: Mapping[str, str] | None = None,
    command: str | None = None,
) -> bool:
    """Make sure ``directory`` holds the five files with the declared bytes; True if they had to be downloaded.

    Without network the error says which command to run where there is network (``command``, or this script).
    """
    pending = problems(directory, digests)
    if not pending:
        return False
    try:
        download(directory, opener=opener, source_base=source_base, digests=digests)
    except NetworkError as exc:
        raise FetchError(
            f"{exc}\nThe OMG BPMN 2.0.2 XSDs are not in {directory} ({'; '.join(pending)}) and could not be downloaded.\n"
            f"With network access run: {command or command_for(Path(directory))}"
        ) from exc
    return True


class OmgXsdBuildHook(BuildHookInterface):  # type: ignore[misc,valid-type]
    """Puts the five XSDs in place, verified, before every build (wheel, sdist, editable)."""

    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        directory = Path(self.root) / RELATIVE_DIRECTORY
        if ensure(directory):
            self.app.display_info(f"downloaded and verified the OMG BPMN 2.0.2 XSDs into {directory}")


def get_build_hook() -> type:
    return OmgXsdBuildHook


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--ensure", action="store_true", required=True, help="download the files unless they are there and verify")
    parser.add_argument("--directory", type=Path, default=DIRECTORY, help=f"where they go (default: {RELATIVE_DIRECTORY} next to this file)")
    arguments = parser.parse_args(argv)
    try:
        downloaded = ensure(arguments.directory)
    except FetchError as exc:
        print(f"hatch_build: {exc}", file=sys.stderr)
        return 1
    print(
        f"OMG BPMN 2.0.2 XSDs: {'downloaded and verified into' if downloaded else 'already present and verified in'} "
        f"{arguments.directory}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
