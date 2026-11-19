"""tools/fetch_bim_toolchain.py --wheels: wheels already in the flat index with the lock's SHA-256 need no GitHub.

The gateway image copies any wheels of the build context's openbinding-gateway/.bim-wheels/ before it runs the tool,
so a builder who fetched them once (or was handed them) builds without BIM_TOOLCHAIN_TOKEN.
"""

from __future__ import annotations

import hashlib
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _tool():
    spec = importlib.util.spec_from_file_location("fetch_bim_toolchain_under_test", ROOT / "tools" / "fetch_bim_toolchain.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_present_wheels_with_the_pinned_digest_ask_github_nothing(tmp_path, monkeypatch):
    tool = _tool()
    wheel = tmp_path / "bim_core-0.2.0-py3-none-any.whl"
    wheel.write_bytes(b"a wheel")
    pinned = {wheel.name: hashlib.sha256(b"a wheel").hexdigest()}

    def no_github(tag):
        raise AssertionError("GitHub was asked although every wheel is present")

    monkeypatch.setattr(tool, "release_assets", no_github)
    monkeypatch.setattr(tool, "token", lambda: None)
    assert tool.fetch_wheels(tmp_path, "v0.2.0", pinned) == []


def test_a_missing_or_altered_wheel_still_goes_to_the_release(tmp_path, monkeypatch):
    tool = _tool()
    (tmp_path / "bim_core-0.2.0-py3-none-any.whl").write_bytes(b"altered")
    pinned = {"bim_core-0.2.0-py3-none-any.whl": hashlib.sha256(b"a wheel").hexdigest()}
    asked = []

    def assets(tag):
        asked.append(tag)
        raise tool.FetchError("no network here")

    monkeypatch.setattr(tool, "release_assets", assets)
    with pytest.raises(tool.FetchError):
        tool.fetch_wheels(tmp_path, "v0.2.0", pinned)
    assert asked == ["v0.2.0"]


def test_the_gateway_image_copies_the_context_wheels_before_fetching():
    dockerfile = (ROOT / "openbinding-gateway" / "Dockerfile").read_text(encoding="utf-8")
    joined = dockerfile.replace("\\\n", " ")
    fetch = next(line for line in joined.splitlines() if "fetch_bim_toolchain.py --wheels" in line)
    assert "--mount=type=bind,source=openbinding-gateway,target=/tmp/gateway-context" in fetch
    assert fetch.index("cp /tmp/gateway-context/.bim-wheels/*.whl .bim-wheels/") < fetch.index("python /tmp/fetch_bim_toolchain.py")
