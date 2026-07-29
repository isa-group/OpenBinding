import pytest
from unittest.mock import MagicMock, patch
from openbinding_gateway.validation.analysis import compute_binding_space_summary, generate_warnings
from openbinding_gateway.models.api import BindingSpaceSummary
from fastapi.testclient import TestClient
from openbinding_gateway.main import app, _content_length_too_large
import json

# === Unit Tests for Analysis Logic ===

def test_compute_binding_space_simple():
    instance = {
        "tasks": [{"id": "t1"}, {"id": "t2"}],
        "candidates": [
            {"id": "c1", "task_ids": ["t1"]},
            {"id": "c2", "task_ids": ["t1"]},
            {"id": "c3", "task_ids": ["t2"]}
        ]
    }
    summary = compute_binding_space_summary(instance)
    assert summary.cardinality == "2" # 2 * 1
    assert summary.per_task_counts == {"t1": 2, "t2": 1}
    assert summary.empty_tasks == []
    assert summary.log10_cardinality > 0.3 # log10(2) approx 0.301

def test_compute_binding_space_empty_task():
    instance = {
        "tasks": [{"id": "t1"}, {"id": "t2"}],
        "candidates": [
            {"id": "c1", "task_ids": ["t1"]}
        ]
    }
    summary = compute_binding_space_summary(instance)
    assert summary.cardinality == "0"
    assert summary.per_task_counts == {"t1": 1, "t2": 0}
    assert "t2" in summary.empty_tasks
    assert summary.log10_cardinality == 0.0

def test_generate_warnings():
    summary = BindingSpaceSummary(
        cardinality="0",
        log10_cardinality=0.0,
        per_task_counts={"t1": 0},
        empty_tasks=["t1"]
    )
    warnings = generate_warnings(summary)
    assert len(warnings) == 1
    assert warnings[0].code == "EMPTY_TASK"
    assert warnings[0].details["empty_task_ids"] == ["t1"]

def test_generate_warnings_explosion():
    summary = BindingSpaceSummary(
        cardinality="10000000000",
        log10_cardinality=10.0,
        per_task_counts={"t1": 10},
        empty_tasks=[]
    )
    warnings = generate_warnings(summary)
    assert len(warnings) >= 1
    codes = [w.code for w in warnings]
    assert "COMBINATORIAL_EXPLOSION" in codes

# === Integration Tests for Endpoints ===

client = TestClient(app)

@pytest.fixture
def mock_registry():
    with patch("openbinding_gateway.registry.engine.EngineRegistry.get_plugin") as mock:
        mock.return_value = MagicMock()
        mock.return_value.transform_request.return_value = ({}, [])
        mock.return_value.transform_response.return_value = {"solutions": [], "provenance": {"engine_id": "mock"}}
        yield mock

@pytest.fixture
def mock_pipeline():
    with patch("openbinding_gateway.main.pipeline") as mock:
        mock.validate_general_schema.return_value = []
        mock.validate_full.return_value = ([], [])
        yield mock

@pytest.fixture
def mock_router():
    with patch("openbinding_gateway.main.router") as mock:
        # Mock JobResponse
        from openbinding_gateway.models.api import JobResponse, JobStatus
        
        # Create an async mock function
        async def mock_route_solve(*args, **kwargs):
            return JobResponse(job_id="test_job", status=JobStatus.QUEUED)
        
        mock.route_solve = mock_route_solve
        yield mock

def test_analyze_endpoint(mock_registry, mock_pipeline):
    payload = {
        "engine_id": "mock_engine",
        "instance": {
            "tasks": [{"id": "t1"}],
            "candidates": [{"id": "c1", "task_ids": ["t1"]}]
        }
    }
    response = client.post("/v1/analyze", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "validated"
    assert data["binding_space"]["cardinality"] == "1"
    assert data["binding_space"]["per_task_counts"]["t1"] == 1

def test_solve_endpoint_verbose(mock_registry, mock_pipeline, mock_router):
    payload = {
        "engine_id": "mock_engine",
        "instance": {
            "tasks": [{"id": "t1"}],
            "candidates": [{"id": "c1", "task_ids": ["t1"]}]
        },
        "verbose": True
    }
    
    response = client.post("/v1/solve", json=payload)
    assert response.status_code == 202
    
    # Verify job response structure
    data = response.json()
    assert "job_id" in data
    assert data["job_id"] == "test_job"

def test_solve_endpoint_not_verbose(mock_registry, mock_pipeline, mock_router):
    payload = {
        "engine_id": "mock_engine",
        "instance": {
            "tasks": [{"id": "t1"}],
            "candidates": [{"id": "c1", "task_ids": ["t1"]}]
        },
        "verbose": False
    }
    
    response = client.post("/v1/solve", json=payload)
    assert response.status_code == 202
    
    # Verify job response structure
    data = response.json()
    assert "job_id" in data
    assert data["job_id"] == "test_job"


def test_content_length_too_large_helper():
    assert _content_length_too_large("100", 50) is True
    assert _content_length_too_large("50", 50) is False
    assert _content_length_too_large(None, 50) is False
    assert _content_length_too_large("invalid", 50) is False


def test_solve_rejects_oversized_content_length_header(mock_registry, mock_pipeline):
    payload = {
        "engine_id": "mock_engine",
        "instance": {
            "tasks": [{"id": "t1"}],
            "candidates": [{"id": "c1", "task_ids": ["t1"]}]
        },
        "verbose": False
    }

    with patch("openbinding_gateway.main.MAX_SOLVE_BODY_BYTES", 1):
        response = client.post("/v1/solve", json=payload)

    assert response.status_code == 413
    # The body is a structured error now rather than a bare string: every
    # failure carries a machine-readable code, so a client can tell this from a
    # spent quota without matching on prose.
    detail = response.json()["detail"]
    assert detail["code"] == "payload_too_large"
    assert "Request body is too large" in detail["error"]


def test_solve_rejects_oversized_transformed_payload(mock_pipeline):
    oversized_payload = {"blob": "x" * 5000}

    with patch("openbinding_gateway.main.router") as mocked_router, \
         patch("openbinding_gateway.main.MAX_SOLVE_BODY_BYTES", 10 * 1024 * 1024), \
         patch("openbinding_gateway.routing.router.MAX_ENGINE_PAYLOAD_BYTES", 1024), \
         patch("openbinding_gateway.registry.engine.EngineRegistry.get_plugin") as mock_plugin_getter, \
         patch("openbinding_gateway.registry.engine.EngineRegistry.get_url", return_value="http://mock-engine"):
        plugin = MagicMock()
        plugin.transform_request.return_value = (oversized_payload, [])
        mock_plugin_getter.return_value = plugin

        from openbinding_gateway.routing.router import Router
        mocked_router.route_solve = Router().route_solve

        payload = {
            "engine_id": "mock_engine",
            "instance": {
                "tasks": [{"id": "t1"}],
                "candidates": [{"id": "c1", "task_ids": ["t1"]}]
            },
            "verbose": False
        }

        response = client.post("/v1/solve", json=payload)

    assert response.status_code == 413
    # The body is a structured error now rather than a bare string: every
    # failure carries a machine-readable code, so a client can tell this from a
    # spent quota without matching on prose.
    detail = response.json()["detail"]
    assert detail["code"] == "payload_too_large"
    assert "Request body is too large" in detail["error"]
