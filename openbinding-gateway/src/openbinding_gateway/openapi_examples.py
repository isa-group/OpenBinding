"""Response bodies shown in the generated API documentation.

Kept out of main.py so that reading the routes does not mean scrolling past a
hundred lines of literals.
"""

_HEALTH_EXAMPLE = {"status": "ok"}

#: Two built-in engines and one registered by a user, because the shapes differ
#: and a caller has to be able to tell them apart: a federated entry says who
#: owns it, whether it has been published, and when it last passed conformance.
_ENGINES_EXAMPLE = [
    {
        "id": "minizinc-csp",
        "capabilities": {
            "qos_features_supported": ["*"],
            "composition_nodes_supported": ["TASK", "SEQ", "AND", "XOR", "LOOP", "ELEMENT"],
            "objective_types_supported": ["MONO"],
            "constraints_supported": [
                "attribute_bound",
                "dependency",
                "resource_capacity",
                "latency_transition",
            ],
            "type": "EXACT",
            "schema_version": "v1",
        },
        "federated": False,
        "active": True,
    },
    {
        "id": "random-search",
        "capabilities": {
            "qos_features_supported": ["*"],
            "composition_nodes_supported": ["TASK", "SEQ", "AND", "XOR", "LOOP"],
            "objective_types_supported": ["MONO"],
            "constraints_supported": [
                "attribute_bound",
                "dependency",
                "resource_capacity",
                "latency_transition",
            ],
            "type": "HEURISTIC",
            "schema_version": "v1",
        },
        "federated": False,
        "active": True,
    },
    {
        "id": "alice~tabu",
        "capabilities": {
            "qos_features_supported": ["*"],
            "composition_nodes_supported": ["TASK", "SEQ"],
            "objective_types_supported": ["MONO"],
            "constraints_supported": ["attribute_bound"],
            "type": "HEURISTIC",
            "schema_version": "v1",
        },
        "federated": True,
        "owner": "alice",
        "visibility": "public",
        "status": "active",
        "verified_at": "2026-07-30T09:14:11Z",
        "active": True,
    },
]

_BINDING_SPACE_EXAMPLE = {
    "cardinality": "4",
    "log10_cardinality": 0.6020599913,
    "per_task_counts": {"t1": 2, "t2": 2},
    "empty_tasks": [],
}

_ANALYZE_VALIDATED_EXAMPLE = {
    "status": "validated",
    "binding_space": _BINDING_SPACE_EXAMPLE,
    "warnings": None,
    "provenance": {"engine_id": "random-search", "execution_time_ms": 12.3},
}

_ANALYZE_FAILED_EXAMPLE = {
    "status": "failed",
    "error": "Validation failed",
    "warnings": [
        {
            "code": "missing_candidates",
            "message": "Missing candidates for tasks: t2",
            "details": {"path": "candidates", "constraint_id": None, "stage": None},
        }
    ],
    "provenance": {"engine_id": "random-search", "execution_time_ms": 4.8},
}

_JOB_QUEUED_EXAMPLE = {"job_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "status": "queued"}

_JOB_COMPLETED_EXAMPLE = {
    "job_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "status": "completed",
    "result": {
        "feasibility": "FEASIBLE",
        "solutions": [
            {
                "objective_value": 0.0,
                "binding": {"t1": "s2", "t2": "s4"},
                "aggregated_features": {"cost": 20.0, "time": 60.0},
                "violations": [],
            }
        ],
        "provenance": {
            "engine_id": "random-search",
            "execution_time_ms": 123.4,
            "metadata": {"solver": "Random-Search", "version": "0.0.1-SNAPSHOT", "iterations_count": 1000},
        },
        "diagnostics": {
            "binding_space": _BINDING_SPACE_EXAMPLE,
            "warnings": ["Option 'foo' ignored by engine"],
        },
    },
}

_JOB_FAILED_EXAMPLE = {
    "job_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "status": "failed",
    "error": "Job not found on engine",
}
