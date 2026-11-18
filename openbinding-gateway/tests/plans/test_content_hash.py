"""SPHERE's functional content hash, ported (``plans.domain.content_hash``), and the YAML 1.2 loader's limits."""

from __future__ import annotations

import hashlib
import json

import pytest

from openbinding_gateway.modules.plans.domain import yaml12
from openbinding_gateway.modules.plans.domain.content_hash import functional_hash, js_json, js_number
from openbinding_gateway.modules.plans.domain.errors import PricingInvalid
from sphere_recorded import SFX


def _recorded_pairs() -> list[tuple[str, str, str]]:
    pairs = []
    for manifest_path in sorted(SFX.glob("*/manifest.json")):
        manifest = json.loads(manifest_path.read_text())
        for entry in manifest["versions"]:
            path = manifest_path.parent / f"{entry['versionId']}.yml"
            if path.exists():
                pairs.append((manifest["pricingId"], entry["versionId"], entry["contentHash"]))
    return pairs


PAIRS = _recorded_pairs()


def test_the_recorded_set_has_enough_versions() -> None:
    assert len(PAIRS) >= 25


@pytest.mark.parametrize(("pricing_id", "version_id", "content_hash"), PAIRS)
def test_the_port_matches_sphere_on_every_recorded_version(pricing_id: str, version_id: str, content_hash: str) -> None:
    raw = (SFX / pricing_id / f"{version_id}.yml").read_bytes()
    assert functional_hash(raw) == content_hash
    # The bytes are a different digest: the YAML route's ETag.
    assert hashlib.sha256(raw).hexdigest() != content_hash


def test_a_rename_keeps_the_hash() -> None:
    mailgun = SFX / "6ade364540e55445692b0eda" / "6ade36454b2b5b01c587db3d.yml"
    renamed = (SFX / "derived" / "mailgun-renamed.yml").read_bytes()
    assert renamed != mailgun.read_bytes()
    assert functional_hash(renamed) == functional_hash(mailgun.read_bytes())
    assert functional_hash((SFX / "derived" / "mailgun-scale.yml").read_bytes()) != functional_hash(mailgun.read_bytes())


def test_javascript_key_order_puts_integer_keys_first() -> None:
    assert js_json({"b": 1, "100000": 2, "50000": 3, "a": 4, "01": 5}) == '{"50000":3,"100000":2,"01":5,"a":4,"b":1}'
    assert js_json({"4294967295": 1, "7": 2}) == '{"7":2,"4294967295":1}'


def test_yaml_1_1_traps_are_strings_as_in_js_yaml() -> None:
    document = yaml12.load("a: yes\nb: on\nc: 1:30\nd: 2026-10\ne: 0x1F\nf: True\ng: 2026-10-22\n")
    assert document["a"] == "yes" and document["b"] == "on" and document["c"] == "1:30"
    assert document["d"] == "2026-10" and document["e"] == 31 and document["f"] is True
    assert js_json(document["g"]) == '"2026-10-22T00:00:00.000Z"'
    assert js_json(yaml12.load("t: 2026-10-22T10:11:12.5Z")["t"]) == '"2026-10-22T10:11:12.500Z"'


def test_numbers_are_written_as_javascript_writes_them() -> None:
    assert js_json(yaml12.load("a: 1.0\nb: .inf\nc: -.inf\nd: .nan\ne: 1e21\nf: 0.00001\ng: 2.5\n")) == (
        '{"a":1,"b":null,"c":null,"d":null,"e":1e+21,"f":0.00001,"g":2.5}'
    )
    assert js_number(1e-7) == "1e-7" and js_number(123456789012345680000.0) == "123456789012345680000"
    assert js_number(1e16) == "10000000000000000" and js_number(-0.5) == "-0.5"


def test_non_ascii_text_is_kept() -> None:
    assert js_json({"name": "Ingeniería – ñ"}) == '{"name":"Ingeniería – ñ"}'


def test_saas_name_is_dropped_only_at_the_top() -> None:
    one = "saasName: A\nplans:\n  p:\n    saasName: x\n"
    two = "saasName: B\nplans:\n  p:\n    saasName: x\n"
    three = "saasName: B\nplans:\n  p:\n    saasName: y\n"
    assert functional_hash(one) == functional_hash(two) != functional_hash(three)


def test_an_alias_bomb_is_refused() -> None:
    lines = ["a0: &a0 [x, x]"]
    for i in range(1, 30):
        lines.append(f"a{i}: &a{i} [*a{i - 1}, *a{i - 1}]")
    with pytest.raises(PricingInvalid) as caught:
        yaml12.load("\n".join(lines))
    assert caught.value.code == "yaml_limits"


def test_too_many_aliases_are_refused() -> None:
    text = "a: &a 1\nb: [" + ", ".join(["*a"] * 51) + "]\n"
    with pytest.raises(PricingInvalid) as caught:
        yaml12.load(text)
    assert caught.value.code == "yaml_limits"


def test_a_65_deep_document_is_refused() -> None:
    with pytest.raises(PricingInvalid) as caught:
        yaml12.load("a: " + "[" * 65 + "]" * 65)
    assert caught.value.code == "yaml_limits"
    assert yaml12.load("a: " + "[" * 60 + "]" * 60) is not None


def test_more_than_200000_nodes_are_refused() -> None:
    with pytest.raises(PricingInvalid) as caught:
        yaml12.load("a: [" + ",".join(["1"] * 200_001) + "]")
    assert caught.value.code == "yaml_limits"


def test_an_oversize_document_is_refused() -> None:
    with pytest.raises(PricingInvalid) as caught:
        yaml12.load(b"a: " + b"x" * (5 * 1024 * 1024))
    assert caught.value.code == "yaml_limits"


def test_not_yaml_is_invalid() -> None:
    with pytest.raises(PricingInvalid) as caught:
        functional_hash("a: [unclosed")
    assert caught.value.code == "yaml_invalid"
    with pytest.raises(PricingInvalid):
        functional_hash("- a list\n")
