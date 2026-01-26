# API Changes - Common Output Model

## Summary
We have normalized the API output format for `/v1/solve` to ensure consistency across different engines (MiniZinc, Many-OBJ, etc.).

## New Response Structure
The `result` object in the job response now strictly follows this structure:

```json
{
  "solutions": [
    {
      "is_feasible": true,
      "objective_value": 120.5,
      "binding": {
        "task_1": "candidate_a",
        "task_2": "candidate_b"
      },
      "aggregated_features": {
        "cost": 100.5,
        "reliability": 0.99
      },
      "violations": []
    }
  ],
  "provenance": {
    "engine_id": "minizinc-csp",
    "execution_time_ms": 1500,
    "metadata": {
       "additional_info": "..."
    }
  },
  "diagnostics": { ... } // Optional
}
```

## Key Changes
1.  **Solutions List**: The key `solution` is now `solutions` (array) to support multiple solutions (e.g. Pareto fronts).
2.  **Naming**: `selection` -> `binding`. `metrics` -> `aggregated_features`.
3.  **Provenance**: Solver metadata (`engine_id`, `time`, etc.) is now grouped under `provenance`, separate from the solution data.
4.  **Input Schema**: The OpenAPI Specification (Swagger) for `/v1/solve` now explicitly includes the Universal JSON Schema definition for the `instance` field.

## Implementation Details
- **Gateway Models**: Updated `SolveResponse`, `Solution`, `Provenance` in `src/openbinding_gateway/models/api.py`.
- **Plugins**: Updated `transform_response` in `minizinc_csp.py` and `many_obj.py` to map engine-specific outputs to the new format.
- **Router**: Updated `router.py` to construct the new `SolveResponse`.
