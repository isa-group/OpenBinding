"""The ``citation`` of the resolver and the verifier, built from recorded facts only.

The routes find the cited element (title, slug, digest, resolvable kind, created date, recorded usernames) and the
live publication record of the exact version, and pass them in; this module does no I/O and keeps no state. What
is not recorded is not made up: no DOI, venue or author is invented, and the year is the first recorded date. The
link is the element's public permanent link on the frontend's origin.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date
from types import MappingProxyType
from typing import Any, Mapping, Optional, Protocol
from urllib.parse import quote

from ..models.platform import ReplicationCitation

#: The kinds ``GET /v1/resolve/{kind}/{digest}`` accepts; each one has the public route ``/resolve/:kind/:digest``.
RESOLVABLE_KINDS: frozenset[str] = frozenset(
    {
        "case-revision",
        "resource-revision",
        "collection-revision",
        "report",
        "artifact",
        "engine",
        "dialect",
        "registered-resource",
        "instance-snapshot",
        "binding-ir",
    }
)

DOI_RESOLVER = "https://doi.org/"
#: ``10.``, 4 to 9 ASCII digits, ``/`` and a suffix without whitespace or control characters.
DOI = re.compile(r"10\.[0-9]{4,9}/[^\s\x00-\x1f\x7f-\x9f]+")

BADGE_IMAGE = (
    "[![OpenBinding Verified](https://img.shields.io/badge/OpenBinding-Verified_Integrity-00E599"
    "?style=flat-square&logo=shield)]"
)

#: Classic BibTeX counts every brace, ``\{`` included, when it looks for the end of a field, so braces are removed
#: rather than escaped. The other characters TeX reads as markup are escaped.
BIBTEX_ESCAPES = MappingProxyType(
    {
        ord("{"): None,
        ord("}"): None,
        ord("\\"): r"\textbackslash{}",
        ord("&"): r"\&",
        ord("%"): r"\%",
        ord("$"): r"\$",
        ord("#"): r"\#",
        ord("_"): r"\_",
        ord("^"): r"\textasciicircum{}",
        ord("~"): r"\textasciitilde{}",
    }
)
#: Control characters and line separators: a field stays on its line, so no value can start a new entry.
LINE_BREAKS = re.compile(r"[\x00-\x1f\x7f-\x9f\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}]")
UNSAFE_KEY = re.compile(r"[^A-Za-z0-9_.:-]")

MIN_YEAR = 1000
MAX_YEAR = 9999


class PublicationRecord(Protocol):
    """What the builder reads of an ``ArtifactPublication`` or a report ``Publication``."""

    citation: Optional[Mapping[str, Any]]
    published_at: Optional[date]


# [impl->req~resolver-verifier-citation-no-invented-metadata~1]
def valid_doi(value: object) -> Optional[str]:
    """The recorded DOI without its ``https://doi.org/`` prefix, or ``None`` unless it is a well-formed DOI."""
    if not isinstance(value, str):
        return None
    doi = value.removeprefix(DOI_RESOLVER)
    return doi if DOI.fullmatch(doi) else None


# [impl->req~resolver-verifier-citation-no-invented-metadata~1]
def valid_venue(value: object) -> Optional[str]:
    return value if isinstance(value, str) and value.strip() else None


# [impl->req~resolver-verifier-citation-no-invented-metadata~1]
def valid_authors(value: object) -> Optional[list[str]]:
    """The non-blank names of a recorded list, or ``None`` when there is none."""
    if not isinstance(value, (list, tuple)):
        return None
    names = [name for name in value if isinstance(name, str) and name.strip()]
    return names or None


# [impl->req~resolver-verifier-citation-year~1]
def valid_year(value: object) -> Optional[int]:
    """A four-digit integer year; ``True`` is an ``int`` to Python but not a year.

    The range also keeps a huge recorded integer out of ``str()``, which refuses integers of more than 4300 digits.
    """
    if not isinstance(value, int) or isinstance(value, bool):
        return None
    return value if MIN_YEAR <= value <= MAX_YEAR else None


def _live(publication: Optional[PublicationRecord]) -> Optional[PublicationRecord]:
    """A withdrawn publication is no longer asserted by its publisher, so it is not cited."""
    if publication is None or getattr(publication, "withdrawn", False) is True:
        return None
    return publication


def _recorded(publication: Optional[PublicationRecord]) -> Mapping[str, Any]:
    citation = getattr(publication, "citation", None)
    return citation if isinstance(citation, Mapping) else {}


# [impl->req~resolver-verifier-citation-year~1]
def citation_year(created_at: date, publication: Optional[PublicationRecord] = None) -> int:
    """The recorded integer ``year``, else the year of ``published_at``, else the year of the element's creation."""
    publication = _live(publication)
    if publication is not None:
        year = valid_year(_recorded(publication).get("year"))
        if year is not None:
            return year
        if isinstance(publication.published_at, date):
            return publication.published_at.year
    return created_at.year


# [impl->req~resolver-verifier-citation-url~1]
def citation_url(frontend_url: str, kind: Optional[str], digest: str) -> str:
    """The public permanent link of the element on the frontend's origin (``FRONTEND_URL``, never the gateway's).

    Only an element without a resolvable kind (``kind=None``) links to the verifier screen. An unknown kind is a
    programming error: it would link to a page that cannot resolve the element.
    """
    origin = frontend_url.rstrip("/")
    if kind is None:
        return f"{origin}/app/verifier?digest={quote(digest, safe='')}"
    if kind not in RESOLVABLE_KINDS:
        raise ValueError(f"{kind!r} is not a resolvable kind")
    return f"{origin}/resolve/{kind}/{quote(digest, safe='')}"


# [impl->req~resolver-verifier-citation-no-invented-metadata~1]
def bibtex_text(value: str) -> str:
    """``value`` as the text of a BibTeX field: it can close neither the field nor the entry.

    Unicode format characters (bidi overrides and isolates, zero-width characters) are dropped, so the text a reader
    sees is the text the entry holds.
    """
    text = LINE_BREAKS.sub(" ", value)
    text = "".join(char for char in text if unicodedata.category(char) != "Cf")
    return text.translate(BIBTEX_ESCAPES)


# [impl->req~resolver-verifier-citation-no-invented-metadata~1]
def _bibtex(
    *,
    key: str,
    title: str,
    authors: list[str],
    year: int,
    venue: Optional[str],
    doi: Optional[str],
    url: str,
    digest: str,
) -> str:
    # Each name keeps its own braces, so a name containing " and " stays one author.
    fields = [
        ("title", bibtex_text(title)),
        ("author", " and ".join("{" + bibtex_text(name) + "}" for name in authors)),
        ("year", bibtex_text(str(year))),
    ]
    if venue is not None:
        fields.append(("howpublished", bibtex_text(venue)))
    if doi is not None:
        fields.append(("doi", bibtex_text(doi)))
    fields.append(("url", bibtex_text(url)))
    fields.append(("note", bibtex_text(f"Cryptographic SHA-256 Digest: {digest}")))
    body = ",\n".join(f"  {name} = {{{value}}}" for name, value in fields)
    return f"@misc{{{UNSAFE_KEY.sub('', key)},\n{body}\n}}"


# [impl->req~resolver-verifier-citation-no-invented-metadata~1]
# [impl->req~resolver-verifier-citation-year~1]
# [impl->req~resolver-verifier-citation-url~1]
def build_citation(
    *,
    frontend_url: str,
    kind: Optional[str],
    created_at: date,
    title: str,
    slug: str,
    digest: str,
    authors: Optional[list[str]] = None,
    publication: Optional[PublicationRecord] = None,
) -> ReplicationCitation:
    """The citation of one element.

    ``digest`` is the normalised ``sha256-...`` digest, ``created_at`` the creation date of the revision or version
    it identifies, ``authors`` the recorded usernames of its author or owner, and ``publication`` the live
    publication record of that exact version, or ``None``. DOI and venue come only from that record's citation.
    """
    publication = _live(publication)
    recorded = _recorded(publication)
    names = valid_authors(recorded.get("authors")) or valid_authors(authors) or []
    year = citation_year(created_at, publication)
    venue = valid_venue(recorded.get("venue"))
    doi = valid_doi(recorded.get("doi"))
    url = citation_url(frontend_url, kind, digest)
    key = f"{slug}_{digest.removeprefix('sha256-')[:8]}"
    return ReplicationCitation(
        title=title,
        authors=names,
        year=year,
        doi=doi,
        venue=venue,
        url=url,
        bibtex=_bibtex(
            key=key, title=title, authors=names, year=year, venue=venue, doi=doi, url=url, digest=digest
        ),
        markdown_badge=f"{BADGE_IMAGE}({url})",
    )
