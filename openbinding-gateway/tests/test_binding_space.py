import pytest
from unittest.mock import MagicMock, patch
from openbinding_gateway.validation.analysis import generate_binding_space_subset
from fastapi.testclient import TestClient
from openbinding_gateway.main import app

# === Logic Tests ===

def test_generate_subset_logic():
    # Setup: 2 tasks, 3 candidates each. Total = 9.
    instance = {
        "tasks": [{"id": "t1"}, {"id": "t2"}],
        "candidates": [
            {"id": "c1_1", "task_id": "t1"},
            {"id": "c1_2", "task_id": "t1"},
            {"id": "c1_3", "task_id": "t1"},
            {"id": "c2_1", "task_id": "t2"},
            {"id": "c2_2", "task_id": "t2"},
            {"id": "c2_3", "task_id": "t2"}
        ]
    }
    
    # Check total size
    subset = generate_binding_space_subset(instance, 0, 100)
    assert subset["total_combinations"] == "9"
    assert len(subset["bindings"]) == 9
    
    # Check ordering. Last task varies fastest.
    # 0 -> 0, 0
    # 1 -> 0, 1
    # 2 -> 0, 2
    # 3 -> 1, 0
    b0 = subset["bindings"][0]
    assert b0 == {"t1": "c1_1", "t2": "c2_1"}
    
    b1 = subset["bindings"][1]
    assert b1 == {"t1": "c1_1", "t2": "c2_2"}
    
    b3 = subset["bindings"][3]
    assert b3 == {"t1": "c1_2", "t2": "c2_1"}

def test_generate_subset_pagination():
    instance = {
        "tasks": [{"id": "t1"}, {"id": "t2"}],
        "candidates": [
            {"id": "c1_1", "task_id": "t1"},
            {"id": "c1_2", "task_id": "t1"},
            {"id": "c2_1", "task_id": "t2"},
            {"id": "c2_2", "task_id": "t2"}
        ]
    }
    # Total 4: (0,0), (0,1), (1,0), (1,1)
    
    # Page 1: 2 items
    p1 = generate_binding_space_subset(instance, offset=0, limit=2)
    assert len(p1["bindings"]) == 2
    assert p1["bindings"][0] == {"t1": "c1_1", "t2": "c2_1"}
    assert p1["bindings"][1] == {"t1": "c1_1", "t2": "c2_2"}
    
    # Page 2: 2 items
    p2 = generate_binding_space_subset(instance, offset=2, limit=2)
    assert len(p2["bindings"]) == 2
    assert p2["bindings"][0] == {"t1": "c1_2", "t2": "c2_1"}
    assert p2["bindings"][1] == {"t1": "c1_2", "t2": "c2_2"}
    
    # Page out of bounds
    p3 = generate_binding_space_subset(instance, offset=10, limit=2)
    assert p3["total_combinations"] == "4"
    assert p3["bindings"] == []

# === Endpoint Tests ===

client = TestClient(app)

@pytest.fixture
def mock_registry():
    with patch("openbinding_gateway.registry.engine.EngineRegistry.get_plugin") as mock:
        mock.return_value = MagicMock()
        yield mock

@pytest.fixture
def mock_pipeline():
    with patch("openbinding_gateway.main.pipeline") as mock:
        # Assume valid
        mock.validate_general_schema.return_value = []
        mock.validate_full.return_value = []
        yield mock

def test_binding_space_endpoint(mock_registry, mock_pipeline):
    payload = {
        "engine_id": "mock_engine",
        "instance": {
            "tasks": [{"id": "t1"}, {"id": "t2"}],
            "candidates": [
                {"id": "c1", "task_id": "t1"},
                {"id": "c2", "task_id": "t2"}
            ]
        },
        "offset": 0,
        "limit": 10
    }
    
    response = client.post("/v1/analyze/binding-space", json=payload)
    assert response.status_code == 200
    data = response.json()
    
    assert data["total_combinations"] == "1"
    assert len(data["bindings"]) == 1
    assert data["bindings"][0] == {"t1": "c1", "t2": "c2"}
    assert data["offset"] == 0
    assert data["limit"] == 10

def test_binding_space_endpoint_validation_error(mock_registry):
    # Missing engine_id or instance
    payload = {"offset": 0}
    response = client.post("/v1/analyze/binding-space", json=payload)
    assert response.status_code == 422
