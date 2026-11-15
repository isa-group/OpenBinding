"""The identities of a problem revision.

A revision is identified, within its problem, by the toolchain's canonical ``packageDigest``: the
digest of the canonical archive the toolchain makes of a package, not of the bytes uploaded. Two
uploads of the same package (zipped differently, re-zipped by the Workbench, pushed by QACOForge) are
one revision, whatever produced them.
"""

from __future__ import annotations

import re

DIGEST_PATTERN = re.compile(r"^sha256-[0-9a-f]{64}$")


def revision_digest(package_digest: str) -> str:
    """The digest a revision is identified by: the toolchain's ``packageDigest``, unchanged."""
    if not DIGEST_PATTERN.match(package_digest or ""):
        raise ValueError("a packageDigest is a sha256- digest")
    return package_digest


def is_digest(value: str) -> bool:
    return bool(DIGEST_PATTERN.match(value or ""))
