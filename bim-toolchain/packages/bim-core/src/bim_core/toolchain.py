"""Digest of the installed toolchain.

The bundle digest covers every Python module and every data file that can change
how a package is lowered or evaluated.  It is computed from the bytes of the
installed package, walked with ``importlib.resources``, in a stable order.
"""

from __future__ import annotations

from functools import lru_cache
from importlib.resources.abc import Traversable
from typing import Iterator

from .assets import package_root
from .canonical import digest, digest_bytes

_IGNORED = {"__pycache__"}


def _walk(node: Traversable, prefix: str = "") -> Iterator[tuple[str, Traversable]]:
    for child in sorted(node.iterdir(), key=lambda item: item.name):
        if child.name in _IGNORED or child.name.endswith(".pyc"):
            continue
        path = prefix + child.name
        if child.is_dir():
            yield from _walk(child, path + "/")
        elif child.is_file():
            yield path, child


def bundle_members(root: Traversable) -> dict[str, str]:
    """``{relative path: sha256 of the bytes}`` of every ``.py`` file and all of ``resources/``."""
    members = {
        path: digest_bytes(node.read_bytes())
        for path, node in _walk(root)
        if path.endswith(".py") or path.startswith("resources/")
    }
    return dict(sorted(members.items()))


def bundle_digest(root: Traversable) -> str:
    """Digest of the members of the package tree rooted at ``root``."""
    return digest(bundle_members(root))


@lru_cache(maxsize=1)
def compiler_bundle_digest() -> str:
    """Digest every installed file that can change lowering or evaluation.

    The installed package is immutable while a process runs, so the result is
    memoised; call ``compiler_bundle_digest.cache_clear()`` after changing files.
    """
    return bundle_digest(package_root())
