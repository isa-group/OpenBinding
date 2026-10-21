"""What the gateway costs the BIM port is bounded, and checked by counting calls rather than by timing them.

Going through ``BimPort`` instead of calling ``bim_core`` objects made every operation verify and copy the IR it is
given, so the number of port calls per gateway operation is the thing that must not grow: the static descriptors
(capabilities, protocol, Profiles, Dialects, schemas) are asked once per port, a compilation is one ``compile``, the
re-evaluation of an answer is one ``reevaluate`` and a batch of bindings is one ``evaluate_many`` per 500.
"""

from __future__ import annotations

from collections import Counter

from _repo import REPO_ROOT
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.generator.package import evaluate_features
from openbinding_gateway.integrations import bim, packages
from openbinding_gateway.services.snapshots import compile_package
from bim_client import InProcessBim

DEMO = REPO_ROOT / "examples" / "demo" / "01_simple_seq"
BINDING = {
    "t1": {"resource": "catalog", "id": "c1a"},
    "t2": {"resource": "catalog", "id": "c2a"},
    "t3": {"resource": "catalog", "id": "c3a"},
}
ANSWER = {
    "termination": "OPTIMAL",
    "solutions": [{"decision": {"kind": "binding", "binding": BINDING}, "features": {"latency": -999}}],
}
ROUNDS = 8


class CountingPort:
    """A port that counts what it is asked."""

    def __init__(self, port) -> None:
        self._port = port
        self.calls: Counter[str] = Counter()

    def __getattr__(self, name):
        target = getattr(self._port, name)
        if not callable(target):
            return target

        def counted(*args, **kwargs):
            self.calls[name] += 1
            return target(*args, **kwargs)

        return counted


def test_the_suite_runs_on_the_in_process_port() -> None:
    assert get_settings().bim_mode == "inproc"
    assert isinstance(bim.get_bim(), InProcessBim)


def test_static_descriptors_are_asked_once_per_port() -> None:
    port = CountingPort(InProcessBim())
    with bim.bim_override(port):
        for _ in range(50):
            bim.toolchain_digest()
            bim.package_limits()
            bim.capabilities()
            bim.protocol_digest()
            bim.protocol_info()
            bim.profile_entries()
            bim.profile_manifests()
            bim.dialect_entries()
            bim.dialect_manifests()
            bim.schema_document("BindingProblem")

    assert port.calls == Counter(capabilities=1, protocol=1, profiles=1, dialects=1, schema=1)


async def test_compiling_and_reevaluating_the_demo_costs_one_call_each() -> None:
    archive = packages.zip_directory(DEMO)
    port = CountingPort(InProcessBim())
    with bim.bim_override(port):
        for _ in range(ROUNDS):
            compilation = await compile_package(archive)
            reevaluated = await bim.abim().reevaluate(compilation.ir, ANSWER)
            assert reevaluated["solutions"][0]["features"]["latency"] != -999

    assert port.calls["compile"] == ROUNDS
    assert port.calls["reevaluate"] == ROUNDS
    assert set(port.calls) <= {"compile", "reevaluate"}


def test_a_thousand_bindings_are_three_requests_and_the_compilation_is_not_repeated() -> None:
    ir = InProcessBim().compile(packages.zip_directory(DEMO))["ir"]
    port = CountingPort(InProcessBim())
    with bim.bim_override(port):
        values = evaluate_features(ir, [BINDING] * 1200)

    assert len(values) == 1200
    assert port.calls == Counter(evaluate_many=3)
