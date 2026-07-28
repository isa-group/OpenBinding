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

def pytest_addoption(parser):
    """Allow running specific engines if needed, though we default to checking both."""
    parser.addoption("--engine", action="append", default=[], help="Specific engine to test (minizinc-csp or random-search)")

@pytest.fixture(scope="session")
def target_engines(request):
    engines = request.config.getoption("--engine")
    if not engines:
        return ["minizinc-csp", "random-search"]
    return engines

# Shared summary stats for generated instances


def pytest_generate_tests(metafunc):
    """Parametrize tests with 'engine' fixture automatically."""
    if "engine" in metafunc.fixturenames:
        engines = metafunc.config.getoption("--engine")
        if not engines:
            engines = ["minizinc-csp", "random-search"]
        metafunc.parametrize("engine", engines)
