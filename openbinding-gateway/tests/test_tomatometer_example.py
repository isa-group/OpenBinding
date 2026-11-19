"""``examples/tomatometer/composition.yaml`` is the document the lab seals as ``lab-main/tomatometer`` 1.0.0 (F4 B4).

``tools/dump_examples.py`` instantiates the TomatoMeter composition template in an organization ``lab-main`` (in
process, on the recorded SPHERE and the installed toolchain) and reads 1.0.0's stored bytes: they must equal the
checked-in file, so the example and the seed cannot drift. The stateless validation accepts the file, and the values
are what the toolchain sums: 499 + 9.99 is 508.99 for 1.0.0, while for the 1.1.0 the seed derives 20 + 9.99 is the
float 29.990000000000002, the premise of the margins' ``float-noise`` golden (margins quantize it to 29.990000).
"""

from __future__ import annotations

import os
import subprocess
import sys

import pytest
import yaml

from _paths import TOOLS_DIR
from _repo import REPO_ROOT

EXAMPLE = REPO_ROOT / "examples" / "tomatometer" / "composition.yaml"


@pytest.fixture(scope="module")
def produced(tmp_path_factory):
    out = tmp_path_factory.mktemp("examples")
    done = subprocess.run(
        [sys.executable, str(TOOLS_DIR / "dump_examples.py"), "--out", str(out), "--switch"],
        capture_output=True, text=True, env=dict(os.environ), timeout=600,
    )
    assert done.returncode == 0, done.stdout[-2000:] + done.stderr[-4000:]
    return {"1.0.0": (out / "composition.yaml").read_bytes(), "1.1.0": (out / "composition-1.1.0.yaml").read_bytes()}


def test_the_template_reproduces_the_example_byte_for_byte(produced):
    assert produced["1.0.0"] == EXAMPLE.read_bytes()


def test_the_example_is_the_flagship_document():
    document = yaml.safe_load(EXAMPLE.read_text(encoding="utf-8"))
    assert document["composition"] == "tomatometer" and document["version"] == "1.0.0"
    assert document["kind"] == "application"
    assert document["problem"]["ref"] == "lab-main/problems/tomatometer-email@3"
    assert document["problem"]["compilation"].startswith("sha256-")
    assert document["workflow"] == {"seq": ["login", {"and": ["dailySummary", "export"]}, "quotes"]}
    binding = document["binding"]
    assert {task: entry["candidate"] for task, entry in binding.items()} == {
        "login": "auth.builtin.local", "dailySummary": "email.brevo.professional",
        "export": "storage.dropbox.plus", "quotes": "quotes.zenquotes.free",
    }
    assert binding["dailySummary"]["from"] == {
        "sphere": "danruilop1/brevo", "version": "6ade2d444b2b5b01c587d80d", "plan": "PROFESSIONAL",
    }
    assert binding["export"]["from"] == {"sphere": "atenea/dropbox", "version": "687e4b68102baa50f3a5c7b7", "plan": "PLUS"}
    assert document["offering"] == {"sphere": "sphere/tomatometer"}
    assert document["evidence"]["manual"] is True


def test_the_subscription_is_what_the_toolchain_sums(produced):
    """1.0.0's sum is exact; 1.1.0's carries the toolchain's float noise, which the margins quantize away."""
    first = yaml.safe_load(produced["1.0.0"])
    switched = yaml.safe_load(produced["1.1.0"])
    assert first["values"]["subscription"] == {"value": 508.99, "unit": "USD/month"}
    assert switched["values"]["subscription"] == {"value": 29.990000000000002, "unit": "USD/month"}
    assert switched["binding"]["dailySummary"]["candidate"] == "email.resend.pro"
    assert switched["binding"]["dailySummary"]["from"] == {
        "sphere": "danruilop1/resend", "version": "6ade2d254b2b5b01c587d7ee", "plan": "PRO",
    }
    assert {task: entry for task, entry in switched["binding"].items() if task != "dailySummary"} == {
        task: entry for task, entry in first["binding"].items() if task != "dailySummary"
    }


@pytest.mark.asyncio
async def test_the_stateless_validation_accepts_the_example(api_client):
    checked = await api_client.post(
        "/v1/compositions/validate", content=EXAMPLE.read_bytes(), headers={"content-type": "application/yaml"},
    )
    assert checked.status_code == 200, checked.text
    assert checked.json()["valid"] is True, checked.json()
