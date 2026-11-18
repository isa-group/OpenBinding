"""A ``from`` that misstates a generated candidate's provenance cannot be sealed; a missing one is only a warning;
on a candidate no import generated, nothing is said."""

from __future__ import annotations

import pytest
import yaml

from _b1_helpers import gate  # noqa: F401
from compositions._sphere import BINDING, YAML, compositions, generated_problem

pytestmark = pytest.mark.asyncio


async def _derived_document(api_client, headers, base, revision="tomatometer-email@2", binding=BINDING) -> dict:
    draft = await api_client.post(
        f"{base}/derive", headers=headers,
        json={"revision": revision, "binding": binding, "version": "1.0.0", "seal": False},
    )
    assert draft.status_code == 200, draft.text
    return yaml.safe_load(draft.json()["content"])


def _found(body) -> list[tuple[str, str, str]]:
    return [(item["code"], item["severity"], item["path"]) for item in body["diagnostics"]]


async def test_a_mismatched_from_is_refused_on_check_and_seal(api_client, registration, db_session, gate):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    document = await _derived_document(api_client, headers, base)
    for key, value in (("plan", "SCALE"), ("version", "6ade36454b2b5b01c587db3e"), ("sphere", "danruilop1/sendgrid")):
        wrong = yaml.safe_load(yaml.safe_dump(document))
        wrong["binding"]["dailySummary"]["from"][key] = value
        source = yaml.safe_dump(wrong, sort_keys=False)
        checked = await api_client.post(f"{base}/versions/check", content=source.encode(), headers={**headers, **YAML})
        assert checked.status_code == 200, checked.text
        assert checked.json()["valid"] is False
        assert ("c2y_provenance_mismatch", "error", f"binding.dailySummary.from.{key}") in _found(checked.json())
        sealed = await api_client.post(f"{base}/versions", content=source.encode(), headers={**headers, **YAML})
        assert sealed.status_code == 422, sealed.text
    addons = yaml.safe_load(yaml.safe_dump(document))
    addons["binding"]["dailySummary"]["from"]["addons"] = ["dedicatedIp"]
    checked = await api_client.post(f"{base}/versions/check", content=yaml.safe_dump(addons).encode(),
                                    headers={**headers, **YAML})
    assert ("c2y_provenance_mismatch", "error", "binding.dailySummary.from.addons") in _found(checked.json())


async def test_without_from_a_generated_candidate_is_valid_with_a_warning(api_client, registration, db_session, gate):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    document = await _derived_document(api_client, headers, base)
    del document["binding"]["dailySummary"]["from"]
    source = yaml.safe_dump(document, sort_keys=False).encode()
    checked = await api_client.post(f"{base}/versions/check", content=source, headers={**headers, **YAML})
    assert checked.json()["valid"] is True
    assert ("c2y_provenance_missing", "warning", "binding.dailySummary") in _found(checked.json())
    sealed = await api_client.post(f"{base}/versions", content=source, headers={**headers, **YAML})
    assert sealed.status_code == 201, sealed.text


async def test_a_package_only_problem_is_not_checked(api_client, registration, db_session, gate):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    hand = {**BINDING, "dailySummary": "email.selfhosted.postfix"}
    document = await _derived_document(api_client, headers, base, revision="tomatometer-email@1", binding=hand)
    document["binding"]["dailySummary"]["from"] = {"sphere": "acme/mail", "version": "v1", "plan": "Pro"}
    checked = await api_client.post(f"{base}/versions/check", content=yaml.safe_dump(document).encode(),
                                    headers={**headers, **YAML})
    assert checked.json()["valid"] is True, checked.json()["diagnostics"]
    assert not any(code.startswith("c2y_provenance") for code, _, _ in _found(checked.json()))
    # The hand-made candidate of the generated revision has no provenance either.
    generated = await _derived_document(api_client, headers, base, binding=hand)
    assert "from" not in generated["binding"]["dailySummary"]
    checked = await api_client.post(f"{base}/versions/check", content=yaml.safe_dump(generated).encode(),
                                    headers={**headers, **YAML})
    assert not any(code.startswith("c2y_provenance") for code, _, _ in _found(checked.json()))
