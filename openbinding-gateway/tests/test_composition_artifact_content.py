"""A composition is a sealed artifact, and this is the seam where its content is accepted.

Phase F2 makes a composition a first-class stored entity. Before this, the library's
content validator had no branch for one: ``validate_content`` dispatches on the kind, and
its text path validated everything but a ``Dataset`` as BPMN XML, so a Composition2Yaml
document came back as *"select an installed XML validator"* -- a refusal about a contract,
for a document that needs no contract at all.

Two decisions are pinned here, both with a reason that outlives the code.

**The content is the source text, not a projection of the model.** A composition could have
been stored as JSON, and the rest of the library would have been happier: ``canonical_json``
would give the digest and the existing JSON path would have taken it unchanged. It is
refused anyway, because the source is what a version's ``contentDigest`` has to cover for
the version to be citable, and a JSON body is the model with the comments and the key order
already gone. Section 12 of ``docs/COMPOSITION2YAML.md`` records that a round trip through
the model loses them; storing the projection would make that loss permanent at the moment
of saving rather than at the moment of editing.

**The line endings are normalised, and that is load-bearing here.** The text path already
did it for XML. For a composition it decides identity: without it the same document authored
on Windows seals under a different ``contentDigest`` from the one authored on macOS, and two
versions that are the same composition would be two different versions. The last test
measures that rather than asserting it.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from openbinding_gateway.artifacts import validate_content
from openbinding_gateway.models.artifacts import DraftContent

#: A composition small enough to read and complete enough to parse: every mandatory section
#: of section 2's document structure, and nothing else.
SOURCE = """
composition: fleet
version: "1.0.0"
properties:
  cost:
    unit: USD/month
    direction: minimize
    domain: {min: 0, max: 100}
    aggregate:
      sequence: sum
      parallel: sum
      exclusive: weightedSum
      repeat: scale
      selection: sum
tasks:
  pick: {open: true, requires: service/pick}
workflow:
  sequence: [{task: pick}]
candidates:
  rows:
    - {id: c_pick, provides: service/pick, properties: {cost: 10}}
goals:
  - property: cost
"""


def _validate(body, media_type: str = "application/yaml") -> tuple[bytes, list[dict]]:
    return validate_content("Composition", DraftContent(content=body, media_type=media_type))


def _refusal(body, media_type: str = "application/yaml") -> tuple[int, str]:
    with pytest.raises(HTTPException) as raised:
        _validate(body, media_type)
    detail = raised.value.detail
    code = detail.get("code") if isinstance(detail, dict) else ""
    return raised.value.status_code, code


@pytest.mark.parametrize("media_type", ["application/yaml", "text/yaml"])
def test_a_composition_is_accepted_as_yaml(media_type: str) -> None:
    """Both spellings: RFC 9512 registered ``application/yaml``, and the older ``text/yaml``."""
    content, contracts = _validate(SOURCE, media_type)
    assert content.decode().strip().startswith("composition: fleet")
    assert contracts == [], "a composition names no installed contract: it is not a resource"


def test_the_stored_bytes_are_the_source_the_author_wrote() -> None:
    """Not a re-serialisation. The document comes back out as it went in."""
    content, _contracts = _validate(SOURCE)
    assert content.decode() == SOURCE, "the source is stored, not a projection of the model"


def test_a_document_that_is_not_a_composition_is_refused_by_name() -> None:
    """``invalid_composition``, not a contract error: the reason is about the document."""
    assert _refusal("composition: fleet\n") == (422, "invalid_composition")
    assert _refusal("{not: [valid") == (422, "invalid_composition")


def test_json_is_refused_with_the_reason_rather_than_as_a_missing_contract() -> None:
    """The refusal has to say what to send.

    Without the explicit branch this fell through to the resource path and came back as
    ``resource_contract`` -- "select exactly one installed Dialect" -- which is true of a BIM
    resource document and says nothing to somebody holding a composition.
    """
    status, code = _refusal({"composition": "fleet"}, "application/json")
    assert (status, code) == (422, "invalid_content")


def test_another_text_media_type_is_refused() -> None:
    """Otherwise a composition could be stored as ``text/plain`` and nothing would parse it."""
    assert _refusal(SOURCE, "text/plain") == (422, "invalid_content")


def test_the_same_composition_authored_on_windows_stores_the_same_bytes() -> None:
    """Which is what makes a version's identity a property of the document, not of the editor.

    ``contentDigest`` is ``digest_bytes(content)`` over exactly what this returns, so a CRLF
    document that stored its own bytes would seal as a second version of a composition that
    had not changed.
    """
    unix, _ = _validate(SOURCE)
    windows, _ = _validate(SOURCE.replace("\n", "\r\n"))
    old_mac, _ = _validate(SOURCE.replace("\n", "\r"))
    assert unix == windows == old_mac
    assert b"\r" not in unix


def test_an_unfinished_composition_cannot_be_sealed() -> None:
    """Where completeness is enforced, because a sealed version is citable and has to compile.

    ``parse`` lets a draft be unfinished -- the diff compares drafts and the editor loads one
    at every keystroke -- so this, the one gate library content passes through, is where an
    open task with no market stops being acceptable.
    """
    draft = SOURCE.replace("provides: service/pick", "provides: service/other")
    status, code = _refusal(draft)
    assert (status, code) == (422, "incomplete_composition")


def test_the_refusal_names_what_is_missing() -> None:
    """With the code and the path, so the caller knows what to finish."""
    draft = SOURCE.replace("provides: service/pick", "provides: service/other")
    with pytest.raises(HTTPException) as raised:
        _validate(draft)
    detail = raised.value.detail
    message = detail.get("error", "") if isinstance(detail, dict) else str(detail)
    assert "c2y_candidate_unmatched" in message
    assert "pick" in message
