from pathlib import Path
import pytest
import requests
import time
import json

@pytest.fixture(scope="session")
def gateway_url():
    """URL for the Gateway API. Assumes running in Docker or local port 8000."""
    # In Docker, tests run inside 'gateway' container, so localhost:8000 is self.
    # But usually we want to call the API via HTTP interface.
    return "http://localhost:8000"

@pytest.fixture
def wait_for_job(gateway_url):
    """Helper to poll for job completion."""
    def _wait(job_id, timeout=60):
        start = time.time()
        while time.time() - start < timeout:
            try:
                r = requests.get(f"{gateway_url}/v1/jobs/{job_id}")
                if r.status_code == 200:
                    job = r.json()
                    status = job["status"]
                    if status in ["completed", "failed"]:
                        return job
            except requests.RequestException:
                pass
            time.sleep(0.5)
        return {"status": "timeout", "error": f"Job {job_id} timed out"}
    return _wait

# Every engine the compose stack runs. Tests that a given engine cannot serve
# (an objective type it does not support, say) skip themselves; leaving an
# engine out of this list instead means it is never exercised end to end,
# which is how evolutionary-heuristics and many-heuristic went uncovered.
ALL_ENGINES = [
    "minizinc-csp",
    "random-search",
    "evolutionary-heuristics",
    "many-heuristic",
]


def pytest_addoption(parser):
    parser.addoption(
        "--engine",
        action="append",
        default=[],
        help=f"Engine to test; repeatable. Defaults to all of {', '.join(ALL_ENGINES)}.",
    )


def _selected_engines(config):
    return config.getoption("--engine") or ALL_ENGINES


@pytest.fixture(scope="session")
def target_engines(request):
    return _selected_engines(request.config)


def pytest_generate_tests(metafunc):
    """Parametrize tests with the 'engine' fixture automatically."""
    if "engine" in metafunc.fixturenames:
        metafunc.parametrize("engine", _selected_engines(metafunc.config))


INTEGRATION_DIR = Path(__file__).parent


def pytest_collection_modifyitems(items):
    """Everything under this directory needs the live compose stack.

    Marking the whole directory in one place beats repeating the marker in
    each module, and a conftest-level `pytestmark` would not have applied.
    The hook is global, so items outside this directory are left alone.
    """
    for item in items:
        if INTEGRATION_DIR in Path(str(item.fspath)).parents:
            item.add_marker(pytest.mark.integration)


@pytest.fixture(scope="session")
def engine_capabilities(gateway_url):
    """What each engine says it can do, straight from /v1/engines."""
    import requests

    response = requests.get(f"{gateway_url}/v1/engines", timeout=30)
    response.raise_for_status()
    return {entry["id"]: entry.get("capabilities", {}) for entry in response.json()}


@pytest.fixture(autouse=True)
def skip_when_the_engine_cannot_serve_the_objective(request, engine_capabilities):
    """Skip rather than fail when a test's objective is out of an engine's reach.

    Every engine now runs the whole integration suite, and they legitimately
    support different objective types: many-heuristic solves MANY only, the
    others MONO. A 422 for an objective the engine never claimed to support is
    correct behaviour, not a failure - but it is also not a result, so the
    test skips.
    """
    engine = request.node.callspec.params.get("engine") if hasattr(request.node, "callspec") else None
    if engine is None:
        return

    supported = set(engine_capabilities.get(engine, {}).get("objective_types_supported") or [])
    wanted = getattr(request.module, "OBJECTIVE_TYPE", "MONO")
    if supported and wanted not in supported:
        pytest.skip(f"{engine} supports {sorted(supported)}, this module builds {wanted} instances")
