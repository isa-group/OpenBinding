"""The identifier patterns of a Composition2Yaml document.

A document names tasks, properties and candidates by the ids of the problem it describes, so
it accepts exactly the ids the container accepts: :data:`SYMBOL` and :data:`NAME` are the
container's own patterns, not a convention of this package. The rest are the document's own
grammar: its slug, its semver label, the reference to a problem and a compilation, and the
SPHERE coordinates of an offering or a provenance.

Each pattern is compiled once and always matched with ``fullmatch``: a ``$`` under
``re.search`` also accepts a trailing newline, and an id with a newline in it is not an id.
Digits are spelled ``[0-9]``, because ``\\d`` also matches the digits of every other script.
"""

from __future__ import annotations

import re

_SYMBOL = r"[A-Za-z][A-Za-z0-9_.-]{0,127}"
_SLUG = r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?"
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_DIGEST = r"sha256-[0-9a-f]{64}"
_NUMBER = r"(?:0|[1-9][0-9]*)"
_PRERELEASE = r"(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"

#: Task, feature and candidate ids; the container's own pattern for a map key.
SYMBOL = re.compile(rf"^{_SYMBOL}$")
#: Document names; the container's own pattern for ``metadata.name``.
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

#: A composition's slug: the platform's own slug (``models/platform.py``).
SLUG = re.compile(rf"^{_SLUG}$")
#: A UUID, lower case, as the platform writes them.
UUID = re.compile(rf"^{_UUID}$")
#: A document's own label: Semantic Versioning 2.0.0.
SEMVER = re.compile(
    rf"^{_NUMBER}\.{_NUMBER}\.{_NUMBER}"
    rf"(?:-{_PRERELEASE}(?:\.{_PRERELEASE})*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
#: The longest label a document may carry.
MAX_SEMVER_CHARS = 64
#: A candidate as a binding names it: its id, or ``<resource>/<id>`` when two catalogs give
#: the same task that id.
CANDIDATE = re.compile(rf"^{_SYMBOL}(?:/{_SYMBOL})?$")
#: A problem revision: ``<organization>/problems/<problem>@<revision>``, the organization and
#: problem by slug or UUID, the revision by number, UUID or digest.
REF = re.compile(
    rf"^(?P<organization>{_SLUG}|{_UUID})/problems/(?P<problem>{_SLUG}|{_UUID})"
    rf"@(?P<revision>[1-9][0-9]{{0,8}}|{_UUID}|{_DIGEST})$"
)
#: A compilation digest, as the toolchain writes it.
DIGEST = re.compile(rf"^{_DIGEST}$")
#: A pricing in SPHERE: ``owner/name``.
PRICING = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
#: A SPHERE registry alias, defined in the deployment's ``SPHERE_REGISTRIES``.
ALIAS = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")
#: A SPHERE pricing version id.
VERSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
#: A plan or add-on name: one to 128 characters, none of them a control character.
PLAN = re.compile(r"^[^\x00-\x1f\x7f-\x9f]{1,128}$")
#: A unit: any non-empty string, exactly the container's feature unit (``minLength: 1``).
UNIT = re.compile(r".+", re.DOTALL)
#: The form of a ``syntaxVersion``: ``<major>.<minor>``.
SYNTAX_VERSION = re.compile(r"^[0-9]+\.[0-9]+$")
