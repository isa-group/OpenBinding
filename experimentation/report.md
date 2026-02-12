# Experiment Report

**Generated**: 2026-02-12 12:04:10

**Total**: 48 | **Passed**: 46 | **Failed**: 2

![Progress](https://geps.dev/progress/95?dangerColor=d9534f&warningColor=f0ad4e&successColor=5cb85c)

## Summary

| Instance | Obj | Soft | MiniZinc | RandomSearch | ManyHeuristic | Binding Match | Binding Space Size | Result |
|---|---|---|---|---|---|---|---|---|
| benatallah2002-selfserv-tra... | MANY | False | 🔴 422 | 🔴 422 | 🟢 200 | - | - | ❌ FAIL (MANY NoSol) |
| benatallah2002-selfserv-tra... | MANY | True | 🔴 422 | 🔴 422 | 🟢 200 | - | - | ✅ PASS (MZN/RS Reject, MANY Solve) |
| benatallah2002-selfserv-tra... | MONO | False | 🟢 200 | 🟢 200 | 🔴 422 | ⚠️ DIFF (HEUR) | 1000000 | ✅ PASS (Both Solved) |
| benatallah2002-selfserv-tra... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1000000 | ✅ PASS (MZN Reject, RS Solve) |
| benatallah2002-selfserv-tra... | MONO | False | 🟢 200 | 🟢 200 | 🔴 422 | ⚠️ RS NoSol | 1000000 | ✅ PASS (MZN Solved, RS NoSol) |
| benatallah2002-selfserv-tra... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1000000 | ✅ PASS (MZN Reject, RS Solve) |
| benatallah2002-selfserv-tra... | MULTI | False | 🔴 422 | 🔴 422 | 🔴 422 | - | - | ✅ PASS (All Rejected) |
| benatallah2002-selfserv-tra... | MULTI | True | 🔴 422 | 🔴 422 | 🔴 422 | - | - | ✅ PASS (All Rejected) |
| bultan2003-warehouse-exampl... | MANY | False | 🔴 422 | 🔴 422 | 🟢 200 | - | - | ✅ PASS (MZN/RS Reject, MANY Solve) |
| bultan2003-warehouse-exampl... | MANY | True | 🔴 422 | 🔴 422 | 🟢 200 | - | - | ✅ PASS (MZN/RS Reject, MANY Solve) |
| bultan2003-warehouse-exampl... | MONO | False | 🟢 200 | 🟢 200 | 🔴 422 | ⚠️ MZN NoSol | 1048576 | ✅ PASS (Both Solved) |
| bultan2003-warehouse-exampl... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1048576 | ✅ PASS (MZN Reject, RS Solve) |
| bultan2003-warehouse-exampl... | MONO | False | 🟢 200 | 🟢 200 | 🔴 422 | ⚠️ MZN NoSol | 1048576 | ✅ PASS (Both Solved) |
| bultan2003-warehouse-exampl... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1048576 | ✅ PASS (MZN Reject, RS Solve) |
| bultan2003-warehouse-exampl... | MULTI | False | 🔴 422 | 🔴 422 | 🔴 422 | - | - | ✅ PASS (All Rejected) |
| bultan2003-warehouse-exampl... | MULTI | True | 🔴 422 | 🔴 422 | 🔴 422 | - | - | ✅ PASS (All Rejected) |
| cremaschi2018-textbook-acce... | MANY | False | 🔴 422 | 🔴 422 | 🟢 200 | - | - | ✅ PASS (MZN/RS Reject, MANY Solve) |
| cremaschi2018-textbook-acce... | MANY | True | 🔴 422 | 🔴 422 | 🟢 200 | - | - | ✅ PASS (MZN/RS Reject, MANY Solve) |
| cremaschi2018-textbook-acce... | MONO | False | 🟢 200 | 🟢 200 | 🔴 422 | ⚠️ DIFF (HEUR) | 1000000 | ✅ PASS (Both Solved) |
| cremaschi2018-textbook-acce... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1000000 | ✅ PASS (MZN Reject, RS Solve) |
| cremaschi2018-textbook-acce... | MONO | False | 🟢 200 | 🟢 200 | 🔴 422 | ⚠️ RS NoSol | 1000000 | ✅ PASS (MZN Solved, RS NoSol) |
| cremaschi2018-textbook-acce... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1000000 | ✅ PASS (MZN Reject, RS Solve) |
| cremaschi2018-textbook-acce... | MULTI | False | 🔴 422 | 🔴 422 | 🔴 422 | - | - | ✅ PASS (All Rejected) |
| cremaschi2018-textbook-acce... | MULTI | True | 🔴 422 | 🔴 422 | 🔴 422 | - | - | ✅ PASS (All Rejected) |
| netedu2020-transport-agency... | MANY | False | 🔴 422 | 🔴 422 | 🟢 200 | - | - | ✅ PASS (MZN/RS Reject, MANY Solve) |
| netedu2020-transport-agency... | MANY | True | 🔴 422 | 🔴 422 | 🟢 200 | - | - | ✅ PASS (MZN/RS Reject, MANY Solve) |
| netedu2020-transport-agency... | MONO | False | 🟢 200 | 🟢 200 | 🔴 422 | ⚠️ DIFF (HEUR) | 1000000 | ✅ PASS (Both Solved) |
| netedu2020-transport-agency... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1000000 | ✅ PASS (MZN Reject, RS Solve) |
| netedu2020-transport-agency... | MONO | False | 🟢 200 | 🟢 200 | 🔴 422 | ⚠️ DIFF (HEUR) | 1000000 | ✅ PASS (Both Solved) |
| netedu2020-transport-agency... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1000000 | ✅ PASS (MZN Reject, RS Solve) |
| netedu2020-transport-agency... | MULTI | False | 🔴 422 | 🔴 422 | 🔴 422 | - | - | ✅ PASS (All Rejected) |
| netedu2020-transport-agency... | MULTI | True | 🔴 422 | 🔴 422 | 🔴 422 | - | - | ✅ PASS (All Rejected) |
| pautasso2009-restful-ecomme... | MANY | False | 🔴 422 | 🔴 422 | 🟢 200 | - | - | ❌ FAIL (MANY NoSol) |
| pautasso2009-restful-ecomme... | MANY | True | 🔴 422 | 🔴 422 | 🟢 200 | - | - | ✅ PASS (MZN/RS Reject, MANY Solve) |
| pautasso2009-restful-ecomme... | MONO | False | 🟢 200 | 🟢 200 | 🔴 422 | ✅ No Sol | 1594323 | ✅ PASS (MZN Solved, RS NoSol) |
| pautasso2009-restful-ecomme... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1594323 | ✅ PASS (MZN Reject, RS Solve) |
| pautasso2009-restful-ecomme... | MONO | False | 🟢 200 | 🟢 200 | 🔴 422 | ✅ No Sol | 1594323 | ✅ PASS (MZN Solved, RS NoSol) |
| pautasso2009-restful-ecomme... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1594323 | ✅ PASS (MZN Reject, RS Solve) |
| pautasso2009-restful-ecomme... | MULTI | False | 🔴 422 | 🔴 422 | 🔴 422 | - | - | ✅ PASS (All Rejected) |
| pautasso2009-restful-ecomme... | MULTI | True | 🔴 422 | 🔴 422 | 🔴 422 | - | - | ✅ PASS (All Rejected) |
| zhang2014-entertainment-pla... | MANY | True | 🔴 422 | 🔴 422 | 🟢 200 | - | - | ✅ PASS (MZN/RS Reject, MANY Solve) |
| zhang2014-entertainment-pla... | MANY | True | 🔴 422 | 🔴 422 | 🟢 200 | - | - | ✅ PASS (MZN/RS Reject, MANY Solve) |
| zhang2014-entertainment-pla... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1000000 | ✅ PASS (MZN Reject, RS Solve) |
| zhang2014-entertainment-pla... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1000000 | ✅ PASS (MZN Reject, RS Solve) |
| zhang2014-entertainment-pla... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1000000 | ✅ PASS (MZN Reject, RS Solve) |
| zhang2014-entertainment-pla... | MONO | True | 🔴 422 | 🟢 200 | 🔴 422 | - | 1000000 | ✅ PASS (MZN Reject, RS Solve) |
| zhang2014-entertainment-pla... | MULTI | True | 🔴 422 | 🔴 422 | 🔴 422 | - | - | ✅ PASS (All Rejected) |
| zhang2014-entertainment-pla... | MULTI | True | 🔴 422 | 🔴 422 | 🔴 422 | - | - | ✅ PASS (All Rejected) |

## Detailed Results

### benatallah2002-selfserv-travel-solution-cts-itas_many_hard.json ![Fail](https://img.shields.io/badge/Result-FAIL-critical)

- **Objective**: `MANY`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.12s | See below |
| **Random Search** | 🔴 422 | 0.11s | See below |

| **Many Heuristic** | 🟢 200 | 0.45s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "solutions": [],
  "provenance": {
    "engine_id": "many-heuristic",
    "execution_time_ms": 0.0,
    "metadata": {
      "error": "No feasible solution found after 100000 iterations."
    }
  }
}
```

</details>

---
### benatallah2002-selfserv-travel-solution-cts-itas_many_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MANY`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.11s | See below |
| **Random Search** | 🔴 422 | 0.12s | See below |

| **Many Heuristic** | 🟢 200 | 25.98s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1301.98, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_accommodation_booking_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_accommodation_booking'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 927.58, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_accommodation_booking', 't_attractions_search'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_accommodation_booking', 't_car_rental_booking'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1301.98, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_accommodation_booking_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_accommodation_booking'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 927.58, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_accommodation_booking', 't_attractions_search'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_accommodation_booking', 't_car_rental_booking'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Binding Solution**:
```json
{
  "t_car_rental_booking": "t_car_rental_booking_gen_3",
  "t_flight_booking_international": "t_flight_booking_international_gen_5",
  "t_attractions_search": "t_attractions_search_gen_4",
  "t_accommodation_booking": "t_accommodation_booking_gen_2",
  "t_flight_booking_domestic": "t_flight_booking_domestic_gen_2",
  "t_travel_insurance": "t_travel_insurance_gen_2"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1292.419,
  "cost_usd": 1631.925,
  "availability": 0.9729703676946407,
  "gen_feat_1": 1348.8470000000002,
  "gen_feat_2": 0.08071788735113516,
  "gen_feat_3": 1341.9470000000001
}
```

</details>

---
### benatallah2002-selfserv-travel-solution-cts-itas_mono_one_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 2.16s | See below |
| **Random Search** | 🟢 200 | 0.84s | See below |

| **Many Heuristic** | 🔴 422 | 0.10s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_attractions_search": "t_attractions_search_gen_2",
  "t_flight_booking_domestic": "t_flight_booking_domestic_gen_3",
  "t_flight_booking_international": "t_flight_booking_international_gen_1",
  "t_travel_insurance": "svc_tis_2",
  "t_accommodation_booking": "t_accommodation_booking_gen_8",
  "t_car_rental_booking": "t_car_rental_booking_gen_2"
}
```
**Aggregated Features**:
```json
{
  "availability": 0.29988,
  "cost_usd": 1601.213,
  "gen_feat_1": 1357.25,
  "gen_feat_2": 0.01507608825824881,
  "gen_feat_3": 1356.785,
  "latency_ms": 1285.7569999999998
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_car_rental_booking": "svc_crs_2",
  "t_flight_booking_international": "svc_ifbs_2",
  "t_attractions_search": "t_attractions_search_gen_2",
  "t_accommodation_booking": "t_accommodation_booking_gen_8",
  "t_flight_booking_domestic": "svc_dfbs_2",
  "t_travel_insurance": "svc_tis_2"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1128.07,
  "cost_usd": 1682.8200000000002,
  "availability": 0.98761823424,
  "gen_feat_1": 1347.81,
  "gen_feat_2": 0.0866291739183,
  "gen_feat_3": 1359.16
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### benatallah2002-selfserv-travel-solution-cts-itas_mono_one_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.10s | See below |
| **Random Search** | 🟢 200 | 0.78s | See below |

| **Many Heuristic** | 🔴 422 | 0.11s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1301.98, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_accommodation_booking_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_accommodation_booking'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 927.58, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_accommodation_booking', 't_attractions_search'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_accommodation_booking', 't_car_rental_booking'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1301.98, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_accommodation_booking_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_accommodation_booking'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 927.58, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_accommodation_booking', 't_attractions_search'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_accommodation_booking', 't_car_rental_booking'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_car_rental_booking": "t_car_rental_booking_gen_2",
  "t_flight_booking_international": "t_flight_booking_international_gen_3",
  "t_attractions_search": "t_attractions_search_gen_6",
  "t_accommodation_booking": "t_accommodation_booking_gen_6",
  "t_flight_booking_domestic": "t_flight_booking_domestic_gen_3",
  "t_travel_insurance": "t_travel_insurance_gen_5"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1339.023,
  "cost_usd": 1618.713,
  "availability": 1.0,
  "gen_feat_1": 1363.038,
  "gen_feat_2": 0.08515209015332184,
  "gen_feat_3": 1337.4050000000002
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### benatallah2002-selfserv-travel-solution-cts-itas_mono_utility_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 2.21s | See below |
| **Random Search** | 🟢 200 | 0.94s | See below |

| **Many Heuristic** | 🔴 422 | 0.10s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_attractions_search": "t_attractions_search_gen_2",
  "t_flight_booking_domestic": "t_flight_booking_domestic_gen_3",
  "t_flight_booking_international": "t_flight_booking_international_gen_7",
  "t_travel_insurance": "svc_tis_2",
  "t_accommodation_booking": "t_accommodation_booking_gen_8",
  "t_car_rental_booking": "t_car_rental_booking_gen_8"
}
```
**Aggregated Features**:
```json
{
  "availability": 0.29988,
  "cost_usd": 1593.3509999999999,
  "gen_feat_1": 1363.183,
  "gen_feat_2": 0.015413767884388389,
  "gen_feat_3": 1354.689,
  "latency_ms": 1289.883
}
```

---
#### Random Search
**Response**:
```json
{
  "solutions": [],
  "provenance": {
    "engine_id": "random-search",
    "execution_time_ms": 0.0,
    "metadata": {
      "error": "No feasible solution found after 100000 iterations."
    }
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### benatallah2002-selfserv-travel-solution-cts-itas_mono_utility_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.11s | See below |
| **Random Search** | 🟢 200 | 0.79s | See below |

| **Many Heuristic** | 🔴 422 | 0.12s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1301.98, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_accommodation_booking_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_accommodation_booking'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 927.58, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_accommodation_booking', 't_attractions_search'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_accommodation_booking', 't_car_rental_booking'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1301.98, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_accommodation_booking_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_accommodation_booking'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 927.58, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_accommodation_booking', 't_attractions_search'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_accommodation_booking', 't_car_rental_booking'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_car_rental_booking": "t_car_rental_booking_gen_8",
  "t_flight_booking_international": "t_flight_booking_international_gen_7",
  "t_attractions_search": "t_attractions_search_gen_2",
  "t_accommodation_booking": "t_accommodation_booking_gen_8",
  "t_flight_booking_domestic": "t_flight_booking_domestic_gen_3",
  "t_travel_insurance": "t_travel_insurance_gen_7"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1312.499,
  "cost_usd": 1587.311,
  "availability": 0.999776,
  "gen_feat_1": 1360.3709999999999,
  "gen_feat_2": 0.08701002110300539,
  "gen_feat_3": 1353.529
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### benatallah2002-selfserv-travel-solution-cts-itas_multi_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.11s | See below |
| **Random Search** | 🔴 422 | 0.18s | See below |

| **Many Heuristic** | 🔴 422 | 0.10s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### benatallah2002-selfserv-travel-solution-cts-itas_multi_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.10s | See below |
| **Random Search** | 🔴 422 | 0.10s | See below |

| **Many Heuristic** | 🔴 422 | 0.10s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1301.98, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_accommodation_booking_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_accommodation_booking'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 927.58, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_accommodation_booking', 't_attractions_search'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_accommodation_booking', 't_car_rental_booking'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1301.98, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_accommodation_booking_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_accommodation_booking'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 927.58, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_accommodation_booking', 't_attractions_search'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_accommodation_booking', 't_car_rental_booking'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### bultan2003-warehouse-example_many_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MANY`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.31s | See below |
| **Random Search** | 🔴 422 | 0.28s | See below |

| **Many Heuristic** | 🟢 200 | 5.54s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Binding Solution**:
```json
{
  "t_payment1": "t_payment1_gen_1",
  "t_ok": "c_ok_bank_v1",
  "t_payment2": "c_payment2_bank_v1",
  "t_bill2": "t_bill2_gen_2",
  "t_authorize": "t_authorize_gen_2",
  "t_order2": "t_order2_gen_2",
  "t_order1": "c_order1_store_v1",
  "t_bill1": "t_bill1_gen_3",
  "t_receipt1": "t_receipt1_gen_1",
  "t_receipt2": "t_receipt2_gen_1"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1323.07,
  "cost_usd": 0.8200000000000001,
  "availability": 0.7854076157452324,
  "gen_feat_1": 8483.310000000001,
  "gen_feat_2": 2.74254397351582e-13,
  "gen_feat_3": 8542.39
}
```

</details>

---
### bultan2003-warehouse-example_many_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MANY`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.29s | See below |
| **Random Search** | 🔴 422 | 0.26s | See below |

| **Many Heuristic** | 🟢 200 | 32.95s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1318.72, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_authorize_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_authorize'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.01, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_authorize', 't_bill1'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_authorize', 't_payment2'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1318.72, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_authorize_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_authorize'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.01, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_authorize', 't_bill1'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_authorize', 't_payment2'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Binding Solution**:
```json
{
  "t_payment1": "t_payment1_gen_2",
  "t_ok": "t_ok_gen_2",
  "t_payment2": "t_payment2_gen_3",
  "t_bill2": "t_bill2_gen_1",
  "t_authorize": "c_authorize_store_v1",
  "t_order2": "t_order2_gen_3",
  "t_order1": "t_order1_gen_1",
  "t_bill1": "t_bill1_gen_3",
  "t_receipt1": "c_receipt1_wh1_v1",
  "t_receipt2": "t_receipt2_gen_1"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1318.72,
  "cost_usd": 0.7450000000000001,
  "availability": 0.636445063004079,
  "gen_feat_1": 8470.460000000001,
  "gen_feat_2": 2.403736559720548e-13,
  "gen_feat_3": 8499.91
}
```

</details>

---
### bultan2003-warehouse-example_mono_one_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 24.54s | See below |
| **Random Search** | 🟢 200 | 1.52s | See below |

| **Many Heuristic** | 🔴 422 | 0.29s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "solutions": [],
  "provenance": {
    "engine_id": "minizinc-csp",
    "execution_time_ms": 0.0,
    "metadata": {}
  },
  "diagnostics": {
    "warnings": [
      "Option 'iterations_count' is not supported by MiniZinc engine"
    ],
    "binding_space": {
      "cardinality": "1048576",
      "log10_cardinality": 6.020599913279624,
      "per_task_counts": {
        "t_authorize": 4,
        "t_ok": 4,
        "t_order1": 4,
        "t_receipt1": 4,
        "t_bill1": 4,
        "t_payment1": 4,
        "t_order2": 4,
        "t_receipt2": 4,
        "t_bill2": 4,
        "t_payment2": 4
      },
      "empty_tasks": []
    }
  }
}
```
**MiniZinc No-Solution Analysis (based on RS binding)**:
```json
{
  "binding": {
    "t_payment1": "t_payment1_gen_2",
    "t_ok": "c_ok_bank_v1",
    "t_payment2": "c_payment2_bank_v1",
    "t_bill2": "t_bill2_gen_3",
    "t_authorize": "t_authorize_gen_1",
    "t_order2": "c_order2_store_v1",
    "t_order1": "c_order1_store_v1",
    "t_bill1": "t_bill1_gen_1",
    "t_receipt1": "t_receipt1_gen_2",
    "t_receipt2": "t_receipt2_gen_1"
  },
  "aggregated_features": {
    "latency_ms": 1322.8799999999999,
    "cost_usd": 0.77,
    "availability": 0.9686616388059096,
    "gen_feat_1": 8573.23,
    "gen_feat_2": 2.6119565004449756e-13,
    "gen_feat_3": 8567.359999999999
  },
  "aggregated_features_scaled": {
    "latency_ms": 0.26457600000000003,
    "cost_usd": 0.00077,
    "availability": 0.9686616388059096,
    "gen_feat_1": 8.57323,
    "gen_feat_2": 2.6119565004449756e-13,
    "gen_feat_3": 8.56736
  },
  "aggregated_features_mzn_scaled": {
    "latency_ms": 0.117954,
    "cost_usd": 0.00031999999999999997,
    "availability": 0.9833143761389193,
    "gen_feat_1": 4.0329999999999995,
    "gen_feat_2": 4.029334544069859e-06,
    "gen_feat_3": 4.0354399999999995
  },
  "node_qos_mzn_scaled": {
    "n_root_seq": {
      "kind": "SEQ",
      "latency_ms": 0.117954,
      "cost_usd": 0.00031999999999999997,
      "availability": 0.9833143761389193,
      "gen_feat_1": 4.0329999999999995,
      "gen_feat_2": 4.029334544069859e-06,
      "gen_feat_3": 4.0354399999999995
    },
    "n_authorize": {
      "kind": "TASK",
      "latency_ms": 0.011206,
      "cost_usd": 1e-05,
      "availability": 0.9942,
      "gen_feat_1": 0.50618,
      "gen_feat_2": 0.499392,
      "gen_feat_3": 0.51416
    },
    "n_ok": {
      "kind": "TASK",
      "latency_ms": 0.009,
      "cost_usd": 1e-05,
      "availability": 0.999,
      "gen_feat_1": 0.5,
      "gen_feat_2": 0.5,
      "gen_feat_3": 0.5
    },
    "n_parallel_orders": {
      "kind": "AND",
      "latency_ms": 0.097748,
      "cost_usd": 0.0003,
      "availability": 0.9900409121039359,
      "gen_feat_1": 3.02682,
      "gen_feat_2": 1.6136960720515582e-05,
      "gen_feat_3": 3.02128
    },
    "n_loop_wh1": {
      "kind": "LOOP",
      "latency_ms": 0.091972,
      "cost_usd": 0.00014,
      "availability": 0.996004,
      "gen_feat_1": 2.98076,
      "gen_feat_2": 0.004024886875005128,
      "gen_feat_3": 3.02128
    },
    "n_wh1_iter_seq": {
      "kind": "SEQ",
      "latency_ms": 0.045986,
      "cost_usd": 7e-05,
      "availability": 0.998,
      "gen_feat_1": 1.49038,
      "gen_feat_2": 0.06344199614612649,
      "gen_feat_3": 1.51064
    },
    "n_order1": {
      "kind": "TASK",
      "latency_ms": 0.013,
      "cost_usd": 2e-05,
      "availability": 0.998,
      "gen_feat_1": 0.5,
      "gen_feat_2": 0.5,
      "gen_feat_3": 0.5
    },
    "n_wh1_after_order": {
      "kind": "AND",
      "latency_ms": 0.032986,
      "cost_usd": 4.9999999999999996e-05,
      "availability": 1.0,
      "gen_feat_1": 0.99038,
      "gen_feat_2": 0.12688399229225297,
      "gen_feat_3": 1.01064
    },
    "n_receipt1": {
      "kind": "TASK",
      "latency_ms": 0.015556,
      "cost_usd": 1e-05,
      "availability": 1.0,
      "gen_feat_1": 0.5120800000000001,
      "gen_feat_2": 0.510897,
      "gen_feat_3": 0.48677
    },
    "n_wh1_billpay": {
      "kind": "SEQ",
      "latency_ms": 0.032986,
      "cost_usd": 3.9999999999999996e-05,
      "availability": 1.0,
      "gen_feat_1": 0.99038,
      "gen_feat_2": 0.24835532855400003,
      "gen_feat_3": 1.01064
    },
    "n_bill1": {
      "kind": "TASK",
      "latency_ms": 0.014846000000000002,
      "cost_usd": 1e-05,
      "availability": 1.0,
      "gen_feat_1": 0.49945999999999996,
      "gen_feat_2": 0.510726,
      "gen_feat_3": 0.50743
    },
    "n_payment1": {
      "kind": "TASK",
      "latency_ms": 0.01814,
      "cost_usd": 2.9999999999999997e-05,
      "availability": 1.0,
      "gen_feat_1": 0.49092,
      "gen_feat_2": 0.486279,
      "gen_feat_3": 0.5032099999999999
    },
    "n_loop_wh2": {
      "kind": "LOOP",
      "latency_ms": 0.097748,
      "cost_usd": 0.00015999999999999999,
      "availability": 0.9940129880039998,
      "gen_feat_1": 3.02682,
      "gen_feat_2": 0.004009295471315581,
      "gen_feat_3": 3.02028
    },
    "n_wh2_iter_seq": {
      "kind": "SEQ",
      "latency_ms": 0.048874,
      "cost_usd": 7.999999999999999e-05,
      "availability": 0.9970019999999999,
      "gen_feat_1": 1.51341,
      "gen_feat_2": 0.0633189977125,
      "gen_feat_3": 1.51014
    },
    "n_order2": {
      "kind": "TASK",
      "latency_ms": 0.014,
      "cost_usd": 2e-05,
      "availability": 0.998,
      "gen_feat_1": 0.5,
      "gen_feat_2": 0.5,
      "gen_feat_3": 0.5
    },
    "n_wh2_after_order": {
      "kind": "AND",
      "latency_ms": 0.034874,
      "cost_usd": 5.9999999999999995e-05,
      "availability": 0.999,
      "gen_feat_1": 1.01341,
      "gen_feat_2": 0.126637995425,
      "gen_feat_3": 1.01014
    },
    "n_receipt2": {
      "kind": "TASK",
      "latency_ms": 0.016584,
      "cost_usd": 1e-05,
      "availability": 1.0,
      "gen_feat_1": 0.49435,
      "gen_feat_2": 0.50285,
      "gen_feat_3": 0.50712
    },
    "n_wh2_billpay": {
      "kind": "SEQ",
      "latency_ms": 0.034874,
      "cost_usd": 4.9999999999999996e-05,
      "availability": 0.999,
      "gen_feat_1": 1.01341,
      "gen_feat_2": 0.2518405,
      "gen_feat_3": 1.01014
    },
    "n_bill2": {
      "kind": "TASK",
      "latency_ms": 0.015874,
      "cost_usd": 2e-05,
      "availability": 1.0,
      "gen_feat_1": 0.5134099999999999,
      "gen_feat_2": 0.503681,
      "gen_feat_3": 0.51014
    },
    "n_payment2": {
      "kind": "TASK",
      "latency_ms": 0.019,
      "cost_usd": 2.9999999999999997e-05,
      "availability": 0.999,
      "gen_feat_1": 0.5,
      "gen_feat_2": 0.5,
      "gen_feat_3": 0.5
    }
  },
  "qos_ub": {
    "latency_ms": 1.5004199999999999,
    "cost_usd": 1.0,
    "availability": 1.0,
    "gen_feat_1": 50.837900000000005,
    "gen_feat_2": 1.0,
    "gen_feat_3": 50.860299999999995
  },
  "bound_violations": [
    {
      "constraint_id": "gen_c_global_latency_ms_1",
      "scope": "GLOBAL",
      "attribute_id": "latency_ms",
      "current": 1322.8799999999999,
      "op": "<=",
      "value": 1318.72
    }
  ],
  "mzn_scaled_bound_violations": [
    {
      "constraint_id": "gen_c_global_latency_ms_1",
      "scope": "GLOBAL",
      "attribute_id": "latency_ms",
      "current_scaled": 0.26457600000000003,
      "op": "<=",
      "value_scaled": 0.263744
    }
  ],
  "mzn_loop_scaled_bound_violations": [],
  "qos_ub_violations": [],
  "qos_ub_node_violations": [],
  "dependency_violations": [],
  "notes": []
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_payment1": "t_payment1_gen_2",
  "t_ok": "c_ok_bank_v1",
  "t_payment2": "c_payment2_bank_v1",
  "t_bill2": "t_bill2_gen_3",
  "t_authorize": "t_authorize_gen_1",
  "t_order2": "c_order2_store_v1",
  "t_order1": "c_order1_store_v1",
  "t_bill1": "t_bill1_gen_1",
  "t_receipt1": "t_receipt1_gen_2",
  "t_receipt2": "t_receipt2_gen_1"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1322.8799999999999,
  "cost_usd": 0.77,
  "availability": 0.9686616388059096,
  "gen_feat_1": 8573.23,
  "gen_feat_2": 2.6119565004449756e-13,
  "gen_feat_3": 8567.359999999999
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### bultan2003-warehouse-example_mono_one_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.28s | See below |
| **Random Search** | 🟢 200 | 1.30s | See below |

| **Many Heuristic** | 🔴 422 | 0.25s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1318.72, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_authorize_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_authorize'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.01, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_authorize', 't_bill1'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_authorize', 't_payment2'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1318.72, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_authorize_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_authorize'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.01, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_authorize', 't_bill1'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_authorize', 't_payment2'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_payment1": "t_payment1_gen_2",
  "t_ok": "t_ok_gen_2",
  "t_payment2": "c_payment2_bank_v1",
  "t_bill2": "t_bill2_gen_3",
  "t_authorize": "t_authorize_gen_3",
  "t_order2": "c_order2_store_v1",
  "t_order1": "c_order1_store_v1",
  "t_bill1": "t_bill1_gen_3",
  "t_receipt1": "t_receipt1_gen_2",
  "t_receipt2": "t_receipt2_gen_1"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1324.6999999999998,
  "cost_usd": 0.77,
  "availability": 0.9752879401287323,
  "gen_feat_1": 8568.939999999999,
  "gen_feat_2": 2.72244988682062e-13,
  "gen_feat_3": 8564.019999999999
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### bultan2003-warehouse-example_mono_utility_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 168.14s | See below |
| **Random Search** | 🟢 200 | 1.45s | See below |

| **Many Heuristic** | 🔴 422 | 0.28s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "solutions": [],
  "provenance": {
    "engine_id": "minizinc-csp",
    "execution_time_ms": 0.0,
    "metadata": {}
  },
  "diagnostics": {
    "warnings": [
      "Option 'iterations_count' is not supported by MiniZinc engine"
    ],
    "binding_space": {
      "cardinality": "1048576",
      "log10_cardinality": 6.020599913279624,
      "per_task_counts": {
        "t_authorize": 4,
        "t_ok": 4,
        "t_order1": 4,
        "t_receipt1": 4,
        "t_bill1": 4,
        "t_payment1": 4,
        "t_order2": 4,
        "t_receipt2": 4,
        "t_bill2": 4,
        "t_payment2": 4
      },
      "empty_tasks": []
    }
  }
}
```
**MiniZinc No-Solution Analysis (based on RS binding)**:
```json
{
  "binding": {
    "t_payment1": "t_payment1_gen_1",
    "t_ok": "t_ok_gen_2",
    "t_payment2": "c_payment2_bank_v1",
    "t_bill2": "t_bill2_gen_3",
    "t_authorize": "t_authorize_gen_1",
    "t_order2": "c_order2_store_v1",
    "t_order1": "c_order1_store_v1",
    "t_bill1": "t_bill1_gen_1",
    "t_receipt1": "t_receipt1_gen_3",
    "t_receipt2": "t_receipt2_gen_1"
  },
  "aggregated_features": {
    "latency_ms": 1324.1999999999998,
    "cost_usd": 0.8200000000000001,
    "availability": 0.9696312700759856,
    "gen_feat_1": 8562.99,
    "gen_feat_2": 2.3732296002486986e-13,
    "gen_feat_3": 8563.97
  },
  "aggregated_features_scaled": {
    "latency_ms": 0.26484,
    "cost_usd": 0.00082,
    "availability": 0.9696312700759856,
    "gen_feat_1": 8.56299,
    "gen_feat_2": 2.3732296002486986e-13,
    "gen_feat_3": 8.56397
  },
  "aggregated_features_mzn_scaled": {
    "latency_ms": 0.118218,
    "cost_usd": 0.00033999999999999997,
    "availability": 0.984298674813733,
    "gen_feat_1": 4.02276,
    "gen_feat_2": 3.837127743106285e-06,
    "gen_feat_3": 4.03355
  },
  "node_qos_mzn_scaled": {
    "n_root_seq": {
      "kind": "SEQ",
      "latency_ms": 0.118218,
      "cost_usd": 0.00033999999999999997,
      "availability": 0.984298674813733,
      "gen_feat_1": 4.02276,
      "gen_feat_2": 3.837127743106285e-06,
      "gen_feat_3": 4.03355
    },
    "n_authorize": {
      "kind": "TASK",
      "latency_ms": 0.011206,
      "cost_usd": 1e-05,
      "availability": 0.9942,
      "gen_feat_1": 0.50618,
      "gen_feat_2": 0.499392,
      "gen_feat_3": 0.51416
    },
    "n_ok": {
      "kind": "TASK",
      "latency_ms": 0.009264,
      "cost_usd": 1e-05,
      "availability": 1.0,
      "gen_feat_1": 0.48976,
      "gen_feat_2": 0.491295,
      "gen_feat_3": 0.49911
    },
    "n_parallel_orders": {
      "kind": "AND",
      "latency_ms": 0.097748,
      "cost_usd": 0.00031999999999999997,
      "availability": 0.9900409121039359,
      "gen_feat_1": 3.02682,
      "gen_feat_2": 1.5639480846096922e-05,
      "gen_feat_3": 3.02028
    },
    "n_loop_wh1": {
      "kind": "LOOP",
      "latency_ms": 0.092724,
      "cost_usd": 0.00015999999999999999,
      "availability": 0.996004,
      "gen_feat_1": 2.96936,
      "gen_feat_2": 0.003900805255683762,
      "gen_feat_3": 3.01508
    },
    "n_wh1_iter_seq": {
      "kind": "SEQ",
      "latency_ms": 0.046362,
      "cost_usd": 7.999999999999999e-05,
      "availability": 0.998,
      "gen_feat_1": 1.48468,
      "gen_feat_2": 0.062456426856519434,
      "gen_feat_3": 1.50754
    },
    "n_order1": {
      "kind": "TASK",
      "latency_ms": 0.013,
      "cost_usd": 2e-05,
      "availability": 0.998,
      "gen_feat_1": 0.5,
      "gen_feat_2": 0.5,
      "gen_feat_3": 0.5
    },
    "n_wh1_after_order": {
      "kind": "AND",
      "latency_ms": 0.033362,
      "cost_usd": 5.9999999999999995e-05,
      "availability": 1.0,
      "gen_feat_1": 0.98468,
      "gen_feat_2": 0.12491285371303887,
      "gen_feat_3": 1.00754
    },
    "n_receipt1": {
      "kind": "TASK",
      "latency_ms": 0.016022,
      "cost_usd": 2e-05,
      "availability": 1.0,
      "gen_feat_1": 0.50814,
      "gen_feat_2": 0.486315,
      "gen_feat_3": 0.48994
    },
    "n_wh1_billpay": {
      "kind": "SEQ",
      "latency_ms": 0.033362,
      "cost_usd": 3.9999999999999996e-05,
      "availability": 1.0,
      "gen_feat_1": 0.98468,
      "gen_feat_2": 0.256855852098,
      "gen_feat_3": 1.00754
    },
    "n_bill1": {
      "kind": "TASK",
      "latency_ms": 0.014846000000000002,
      "cost_usd": 1e-05,
      "availability": 1.0,
      "gen_feat_1": 0.49945999999999996,
      "gen_feat_2": 0.510726,
      "gen_feat_3": 0.50743
    },
    "n_payment1": {
      "kind": "TASK",
      "latency_ms": 0.018516,
      "cost_usd": 2.9999999999999997e-05,
      "availability": 1.0,
      "gen_feat_1": 0.48522000000000004,
      "gen_feat_2": 0.502923,
      "gen_feat_3": 0.50011
    },
    "n_loop_wh2": {
      "kind": "LOOP",
      "latency_ms": 0.097748,
      "cost_usd": 0.00015999999999999999,
      "availability": 0.9940129880039998,
      "gen_feat_1": 3.02682,
      "gen_feat_2": 0.004009295471315581,
      "gen_feat_3": 3.02028
    },
    "n_wh2_iter_seq": {
      "kind": "SEQ",
      "latency_ms": 0.048874,
      "cost_usd": 7.999999999999999e-05,
      "availability": 0.9970019999999999,
      "gen_feat_1": 1.51341,
      "gen_feat_2": 0.0633189977125,
      "gen_feat_3": 1.51014
    },
    "n_order2": {
      "kind": "TASK",
      "latency_ms": 0.014,
      "cost_usd": 2e-05,
      "availability": 0.998,
      "gen_feat_1": 0.5,
      "gen_feat_2": 0.5,
      "gen_feat_3": 0.5
    },
    "n_wh2_after_order": {
      "kind": "AND",
      "latency_ms": 0.034874,
      "cost_usd": 5.9999999999999995e-05,
      "availability": 0.999,
      "gen_feat_1": 1.01341,
      "gen_feat_2": 0.126637995425,
      "gen_feat_3": 1.01014
    },
    "n_receipt2": {
      "kind": "TASK",
      "latency_ms": 0.016584,
      "cost_usd": 1e-05,
      "availability": 1.0,
      "gen_feat_1": 0.49435,
      "gen_feat_2": 0.50285,
      "gen_feat_3": 0.50712
    },
    "n_wh2_billpay": {
      "kind": "SEQ",
      "latency_ms": 0.034874,
      "cost_usd": 4.9999999999999996e-05,
      "availability": 0.999,
      "gen_feat_1": 1.01341,
      "gen_feat_2": 0.2518405,
      "gen_feat_3": 1.01014
    },
    "n_bill2": {
      "kind": "TASK",
      "latency_ms": 0.015874,
      "cost_usd": 2e-05,
      "availability": 1.0,
      "gen_feat_1": 0.5134099999999999,
      "gen_feat_2": 0.503681,
      "gen_feat_3": 0.51014
    },
    "n_payment2": {
      "kind": "TASK",
      "latency_ms": 0.019,
      "cost_usd": 2.9999999999999997e-05,
      "availability": 0.999,
      "gen_feat_1": 0.5,
      "gen_feat_2": 0.5,
      "gen_feat_3": 0.5
    }
  },
  "qos_ub": {
    "latency_ms": 1.5004199999999999,
    "cost_usd": 1.0,
    "availability": 1.0,
    "gen_feat_1": 50.837900000000005,
    "gen_feat_2": 1.0,
    "gen_feat_3": 50.860299999999995
  },
  "bound_violations": [
    {
      "constraint_id": "gen_c_global_latency_ms_1",
      "scope": "GLOBAL",
      "attribute_id": "latency_ms",
      "current": 1324.1999999999998,
      "op": "<=",
      "value": 1318.72
    }
  ],
  "mzn_scaled_bound_violations": [
    {
      "constraint_id": "gen_c_global_latency_ms_1",
      "scope": "GLOBAL",
      "attribute_id": "latency_ms",
      "current_scaled": 0.26484,
      "op": "<=",
      "value_scaled": 0.263744
    }
  ],
  "mzn_loop_scaled_bound_violations": [],
  "qos_ub_violations": [],
  "qos_ub_node_violations": [],
  "dependency_violations": [],
  "notes": []
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_payment1": "t_payment1_gen_1",
  "t_ok": "t_ok_gen_2",
  "t_payment2": "c_payment2_bank_v1",
  "t_bill2": "t_bill2_gen_3",
  "t_authorize": "t_authorize_gen_1",
  "t_order2": "c_order2_store_v1",
  "t_order1": "c_order1_store_v1",
  "t_bill1": "t_bill1_gen_1",
  "t_receipt1": "t_receipt1_gen_3",
  "t_receipt2": "t_receipt2_gen_1"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1324.1999999999998,
  "cost_usd": 0.8200000000000001,
  "availability": 0.9696312700759856,
  "gen_feat_1": 8562.99,
  "gen_feat_2": 2.3732296002486986e-13,
  "gen_feat_3": 8563.97
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### bultan2003-warehouse-example_mono_utility_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.25s | See below |
| **Random Search** | 🟢 200 | 1.27s | See below |

| **Many Heuristic** | 🔴 422 | 0.23s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1318.72, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_authorize_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_authorize'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.01, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_authorize', 't_bill1'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_authorize', 't_payment2'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1318.72, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_authorize_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_authorize'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.01, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_authorize', 't_bill1'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_authorize', 't_payment2'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_payment1": "t_payment1_gen_1",
  "t_ok": "t_ok_gen_3",
  "t_payment2": "c_payment2_bank_v1",
  "t_bill2": "t_bill2_gen_3",
  "t_authorize": "t_authorize_gen_3",
  "t_order2": "c_order2_store_v1",
  "t_order1": "c_order1_store_v1",
  "t_bill1": "t_bill1_gen_1",
  "t_receipt1": "t_receipt1_gen_3",
  "t_receipt2": "t_receipt2_gen_1"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1322.56,
  "cost_usd": 0.8200000000000001,
  "availability": 0.9752879401287323,
  "gen_feat_1": 8591.96,
  "gen_feat_2": 2.5007884399532516e-13,
  "gen_feat_3": 8577.419999999998
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### bultan2003-warehouse-example_multi_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.26s | See below |
| **Random Search** | 🔴 422 | 0.24s | See below |

| **Many Heuristic** | 🔴 422 | 0.28s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### bultan2003-warehouse-example_multi_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.26s | See below |
| **Random Search** | 🔴 422 | 0.27s | See below |

| **Many Heuristic** | 🔴 422 | 0.25s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1318.72, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_authorize_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_authorize'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.01, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_authorize', 't_bill1'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_authorize', 't_payment2'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1318.72, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_authorize_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_authorize'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.01, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_authorize', 't_bill1'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_authorize', 't_payment2'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### cremaschi2018-textbook-access_many_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MANY`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.07s | See below |
| **Random Search** | 🔴 422 | 0.07s | See below |

| **Many Heuristic** | 🟢 200 | 0.98s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Binding Solution**:
```json
{
  "t_geocoding": "t_geocoding_gen_3",
  "t_market": "t_market_gen_2",
  "t_books": "t_books_gen_7",
  "t_library": "t_library_gen_6",
  "t_archive": "t_archive_gen_6",
  "t_transit": "t_transit_gen_6"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1336.0,
  "cost_usd": 0.0,
  "availability": 0.9103450359483279,
  "gen_feat_1": 1990.6499999999999,
  "gen_feat_2": 0.016177752000527006,
  "gen_feat_3": 2026.61
}
```

</details>

---
### cremaschi2018-textbook-access_many_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MANY`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.07s | See below |
| **Random Search** | 🔴 422 | 0.07s | See below |

| **Many Heuristic** | 🟢 200 | 14.26s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1357.94, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_archive_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_archive'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_books', 't_geocoding'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_archive', 't_books'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1357.94, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_archive_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_archive'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_books', 't_geocoding'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_archive', 't_books'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Binding Solution**:
```json
{
  "t_geocoding": "t_geocoding_gen_6",
  "t_market": "t_market_gen_8",
  "t_books": "t_books_gen_1",
  "t_library": "t_library_gen_2",
  "t_archive": "t_archive_gen_5",
  "t_transit": "t_transit_gen_6"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1332.98,
  "cost_usd": 0.0,
  "availability": 0.9099815467393042,
  "gen_feat_1": 2010.15,
  "gen_feat_2": 0.01668334975676384,
  "gen_feat_3": 2003.82
}
```

</details>

---
### cremaschi2018-textbook-access_mono_one_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 2.15s | See below |
| **Random Search** | 🟢 200 | 0.67s | See below |

| **Many Heuristic** | 🔴 422 | 0.08s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_books": "c_google_books_api",
  "t_market": "t_market_gen_1",
  "t_library": "t_library_gen_1",
  "t_geocoding": "c_google_geocoding_api",
  "t_transit": "t_transit_gen_8",
  "t_archive": "t_archive_gen_5"
}
```
**Aggregated Features**:
```json
{
  "availability": 0.0,
  "cost_usd": 0.0021,
  "gen_feat_1": 1990.24,
  "gen_feat_2": 0.0,
  "gen_feat_3": 2025.06,
  "latency_ms": 1337.42
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_geocoding": "c_google_geocoding_api",
  "t_market": "t_market_gen_1",
  "t_books": "c_google_books_api",
  "t_library": "t_library_gen_8",
  "t_archive": "t_archive_gen_5",
  "t_transit": "t_transit_gen_8"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1344.35,
  "cost_usd": 0.0021,
  "availability": 0.9871024462000001,
  "gen_feat_1": 1971.94,
  "gen_feat_2": 0.014823842982264065,
  "gen_feat_3": 2010.23
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### cremaschi2018-textbook-access_mono_one_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.08s | See below |
| **Random Search** | 🟢 200 | 0.64s | See below |

| **Many Heuristic** | 🔴 422 | 0.11s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1357.94, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_archive_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_archive'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_books', 't_geocoding'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_archive', 't_books'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1357.94, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_archive_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_archive'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_books', 't_geocoding'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_archive', 't_books'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_geocoding": "t_geocoding_gen_7",
  "t_market": "t_market_gen_9",
  "t_books": "t_books_gen_5",
  "t_library": "t_library_gen_8",
  "t_archive": "t_archive_gen_5",
  "t_transit": "t_transit_gen_8"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1338.19,
  "cost_usd": 0.0,
  "availability": 0.997048,
  "gen_feat_1": 1956.6599999999999,
  "gen_feat_2": 0.014732872713510647,
  "gen_feat_3": 2006.8899999999999
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### cremaschi2018-textbook-access_mono_utility_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 2.13s | See below |
| **Random Search** | 🟢 200 | 0.64s | See below |

| **Many Heuristic** | 🔴 422 | 0.07s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_books": "c_google_books_api",
  "t_market": "t_market_gen_9",
  "t_library": "t_library_gen_8",
  "t_geocoding": "c_google_geocoding_api",
  "t_transit": "t_transit_gen_8",
  "t_archive": "t_archive_gen_5"
}
```
**Aggregated Features**:
```json
{
  "availability": 0.0,
  "cost_usd": 0.0021,
  "gen_feat_1": 1971.94,
  "gen_feat_2": 0.0,
  "gen_feat_3": 2010.23,
  "latency_ms": 1344.35
}
```

---
#### Random Search
**Response**:
```json
{
  "solutions": [],
  "provenance": {
    "engine_id": "random-search",
    "execution_time_ms": 0.0,
    "metadata": {
      "error": "No feasible solution found after 100000 iterations."
    }
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### cremaschi2018-textbook-access_mono_utility_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.08s | See below |
| **Random Search** | 🟢 200 | 0.51s | See below |

| **Many Heuristic** | 🔴 422 | 0.07s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1357.94, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_archive_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_archive'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_books', 't_geocoding'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_archive', 't_books'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1357.94, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_archive_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_archive'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_books', 't_geocoding'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_archive', 't_books'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_geocoding": "t_geocoding_gen_7",
  "t_market": "t_market_gen_9",
  "t_books": "t_books_gen_5",
  "t_library": "t_library_gen_8",
  "t_archive": "t_archive_gen_5",
  "t_transit": "t_transit_gen_8"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1338.19,
  "cost_usd": 0.0,
  "availability": 0.997048,
  "gen_feat_1": 1956.6599999999999,
  "gen_feat_2": 0.014732872713510647,
  "gen_feat_3": 2006.8899999999999
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### cremaschi2018-textbook-access_multi_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.07s | See below |
| **Random Search** | 🔴 422 | 0.07s | See below |

| **Many Heuristic** | 🔴 422 | 0.07s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### cremaschi2018-textbook-access_multi_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.08s | See below |
| **Random Search** | 🔴 422 | 0.08s | See below |

| **Many Heuristic** | 🔴 422 | 0.08s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1357.94, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_archive_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_archive'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_books', 't_geocoding'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_archive', 't_books'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1357.94, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_archive_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_archive'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_books', 't_geocoding'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_archive', 't_books'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### netedu2020-transport-agency_many_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MANY`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.05s | See below |
| **Random Search** | 🔴 422 | 0.07s | See below |

| **Many Heuristic** | 🟢 200 | 0.49s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Binding Solution**:
```json
{
  "t_get_country_from_location": "t_get_country_from_location_gen_2",
  "t_get_closest_city": "t_get_closest_city_gen_4",
  "t_make_arrangements": "t_make_arrangements_gen_8",
  "t_get_local_subsidiary": "t_get_local_subsidiary_gen_4",
  "t_get_vehicle": "c_get_vehicle",
  "t_get_transport_company": "t_get_transport_company_gen_6"
}
```
**Aggregated Features**:
```json
{
  "cost": 5.99,
  "gen_feat_1": 2984.35,
  "gen_feat_2": 0.01670215031980321,
  "gen_feat_3": 3007.71
}
```

</details>

---
### netedu2020-transport-agency_many_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MANY`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.06s | See below |
| **Random Search** | 🔴 422 | 0.06s | See below |

| **Many Heuristic** | 🟢 200 | 4.00s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 6.01, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_get_closest_city_gen_feat_1_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_get_closest_city'], 'attribute_id': 'gen_feat_1', 'op': '<=', 'value': 497.52, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_get_closest_city', 't_get_country_from_location'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_get_closest_city', 't_make_arrangements'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 6.01, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_get_closest_city_gen_feat_1_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_get_closest_city'], 'attribute_id': 'gen_feat_1', 'op': '<=', 'value': 497.52, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_get_closest_city', 't_get_country_from_location'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_get_closest_city', 't_make_arrangements'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Binding Solution**:
```json
{
  "t_get_country_from_location": "t_get_country_from_location_gen_1",
  "t_get_closest_city": "t_get_closest_city_gen_1",
  "t_make_arrangements": "t_make_arrangements_gen_7",
  "t_get_local_subsidiary": "t_get_local_subsidiary_gen_4",
  "t_get_vehicle": "c_get_vehicle",
  "t_get_transport_company": "t_get_transport_company_gen_7"
}
```
**Aggregated Features**:
```json
{
  "cost": 6.029999999999999,
  "gen_feat_1": 3004.34,
  "gen_feat_2": 0.017272189035961963,
  "gen_feat_3": 2985.21
}
```

</details>

---
### netedu2020-transport-agency_mono_one_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 2.11s | See below |
| **Random Search** | 🟢 200 | 0.33s | See below |

| **Many Heuristic** | 🔴 422 | 0.04s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_get_country_from_location": "t_get_country_from_location_gen_2",
  "t_get_transport_company": "t_get_transport_company_gen_2",
  "t_get_closest_city": "t_get_closest_city_gen_4",
  "t_get_local_subsidiary": "t_get_local_subsidiary_gen_7",
  "t_get_vehicle": "t_get_vehicle_gen_2",
  "t_make_arrangements": "t_make_arrangements_gen_3"
}
```
**Aggregated Features**:
```json
{
  "cost": 5.9,
  "gen_feat_1": 2979.77,
  "gen_feat_2": 0.01635108076074883,
  "gen_feat_3": 2981.58
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_get_country_from_location": "t_get_country_from_location_gen_2",
  "t_get_closest_city": "t_get_closest_city_gen_4",
  "t_make_arrangements": "t_make_arrangements_gen_3",
  "t_get_local_subsidiary": "t_get_local_subsidiary_gen_7",
  "t_get_vehicle": "t_get_vehicle_gen_3",
  "t_get_transport_company": "t_get_transport_company_gen_3"
}
```
**Aggregated Features**:
```json
{
  "cost": 5.9,
  "gen_feat_1": 2982.92,
  "gen_feat_2": 0.016539281124164595,
  "gen_feat_3": 3002.41
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### netedu2020-transport-agency_mono_one_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.05s | See below |
| **Random Search** | 🟢 200 | 0.28s | See below |

| **Many Heuristic** | 🔴 422 | 0.05s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 6.01, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_get_closest_city_gen_feat_1_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_get_closest_city'], 'attribute_id': 'gen_feat_1', 'op': '<=', 'value': 497.52, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_get_closest_city', 't_get_country_from_location'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_get_closest_city', 't_make_arrangements'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 6.01, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_get_closest_city_gen_feat_1_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_get_closest_city'], 'attribute_id': 'gen_feat_1', 'op': '<=', 'value': 497.52, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_get_closest_city', 't_get_country_from_location'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_get_closest_city', 't_make_arrangements'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_get_country_from_location": "t_get_country_from_location_gen_2",
  "t_get_closest_city": "t_get_closest_city_gen_3",
  "t_make_arrangements": "t_make_arrangements_gen_3",
  "t_get_local_subsidiary": "t_get_local_subsidiary_gen_7",
  "t_get_vehicle": "t_get_vehicle_gen_6",
  "t_get_transport_company": "t_get_transport_company_gen_3"
}
```
**Aggregated Features**:
```json
{
  "cost": 5.880000000000001,
  "gen_feat_1": 3024.57,
  "gen_feat_2": 0.016939678748017963,
  "gen_feat_3": 3017.37
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### netedu2020-transport-agency_mono_utility_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 2.10s | See below |
| **Random Search** | 🟢 200 | 0.34s | See below |

| **Many Heuristic** | 🔴 422 | 0.06s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_get_country_from_location": "t_get_country_from_location_gen_2",
  "t_get_transport_company": "t_get_transport_company_gen_2",
  "t_get_closest_city": "t_get_closest_city_gen_4",
  "t_get_local_subsidiary": "t_get_local_subsidiary_gen_4",
  "t_get_vehicle": "t_get_vehicle_gen_2",
  "t_make_arrangements": "t_make_arrangements_gen_7"
}
```
**Aggregated Features**:
```json
{
  "cost": 5.99,
  "gen_feat_1": 2967.9399999999996,
  "gen_feat_2": 0.01700032920258602,
  "gen_feat_3": 2979.2000000000003
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_get_country_from_location": "t_get_country_from_location_gen_2",
  "t_get_closest_city": "t_get_closest_city_gen_4",
  "t_make_arrangements": "t_make_arrangements_gen_7",
  "t_get_local_subsidiary": "t_get_local_subsidiary_gen_4",
  "t_get_vehicle": "t_get_vehicle_gen_2",
  "t_get_transport_company": "c_get_transport_company"
}
```
**Aggregated Features**:
```json
{
  "cost": 6.01,
  "gen_feat_1": 2962.16,
  "gen_feat_2": 0.017050594354743806,
  "gen_feat_3": 2991.7000000000003
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### netedu2020-transport-agency_mono_utility_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.06s | See below |
| **Random Search** | 🟢 200 | 0.29s | See below |

| **Many Heuristic** | 🔴 422 | 0.05s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 6.01, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_get_closest_city_gen_feat_1_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_get_closest_city'], 'attribute_id': 'gen_feat_1', 'op': '<=', 'value': 497.52, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_get_closest_city', 't_get_country_from_location'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_get_closest_city', 't_make_arrangements'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 6.01, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_get_closest_city_gen_feat_1_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_get_closest_city'], 'attribute_id': 'gen_feat_1', 'op': '<=', 'value': 497.52, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_get_closest_city', 't_get_country_from_location'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_get_closest_city', 't_make_arrangements'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_get_country_from_location": "t_get_country_from_location_gen_1",
  "t_get_closest_city": "t_get_closest_city_gen_4",
  "t_make_arrangements": "t_make_arrangements_gen_7",
  "t_get_local_subsidiary": "t_get_local_subsidiary_gen_4",
  "t_get_vehicle": "t_get_vehicle_gen_2",
  "t_get_transport_company": "t_get_transport_company_gen_5"
}
```
**Aggregated Features**:
```json
{
  "cost": 6.02,
  "gen_feat_1": 2981.29,
  "gen_feat_2": 0.01678403681377613,
  "gen_feat_3": 2955.27
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### netedu2020-transport-agency_multi_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.05s | See below |
| **Random Search** | 🔴 422 | 0.05s | See below |

| **Many Heuristic** | 🔴 422 | 0.05s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### netedu2020-transport-agency_multi_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.05s | See below |
| **Random Search** | 🔴 422 | 0.05s | See below |

| **Many Heuristic** | 🔴 422 | 0.05s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 6.01, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_get_closest_city_gen_feat_1_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_get_closest_city'], 'attribute_id': 'gen_feat_1', 'op': '<=', 'value': 497.52, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_get_closest_city', 't_get_country_from_location'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_get_closest_city', 't_make_arrangements'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 6.01, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_get_closest_city_gen_feat_1_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_get_closest_city'], 'attribute_id': 'gen_feat_1', 'op': '<=', 'value': 497.52, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_get_closest_city', 't_get_country_from_location'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_get_closest_city', 't_make_arrangements'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### pautasso2009-restful-ecommerce_many_hard.json ![Fail](https://img.shields.io/badge/Result-FAIL-critical)

- **Objective**: `MANY`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.13s | See below |
| **Random Search** | 🔴 422 | 0.20s | See below |

| **Many Heuristic** | 🟢 200 | 0.61s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "solutions": [],
  "provenance": {
    "engine_id": "many-heuristic",
    "execution_time_ms": 0.0,
    "metadata": {
      "error": "No feasible solution found after 100000 iterations."
    }
  },
  "diagnostics": {
    "warnings": [
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[0].hard'",
        "details": {
          "path": "constraints[0].hard",
          "value": true
        }
      },
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[1].hard'",
        "details": {
          "path": "constraints[1].hard",
          "value": true
        }
      },
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[2].hard'",
        "details": {
          "path": "constraints[2].hard",
          "value": true
        }
      }
    ]
  }
}
```

</details>

---
### pautasso2009-restful-ecommerce_many_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MANY`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.12s | See below |
| **Random Search** | 🔴 422 | 0.12s | See below |

| **Many Heuristic** | 🟢 200 | 51.57s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'bind_shop_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_create_order', 't_add_item', 't_remove_item', 't_get_amount', 't_checkout', 't_list_confirmed', 't_ship_order', 't_update_shipment', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'bind_catalog_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_request_quote', 't_get_quote'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'bind_payment_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_charge_payment', 't_refund_payment'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 2060.44, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_add_item_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_add_item'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.4\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_add_item', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.5\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_add_item', 't_charge_payment'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.6\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'bind_shop_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_create_order', 't_add_item', 't_remove_item', 't_get_amount', 't_checkout', 't_list_confirmed', 't_ship_order', 't_update_shipment', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'bind_catalog_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_request_quote', 't_get_quote'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'bind_payment_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_charge_payment', 't_refund_payment'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 2060.44, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_add_item_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_add_item'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.4",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_add_item', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.5",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_add_item', 't_charge_payment'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.6",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Binding Solution**:
```json
{
  "t_add_item": "c_shopB_add_item",
  "t_remove_item": "c_shopB_remove_item",
  "t_update_shipment": "c_shopA_update_shipment",
  "t_charge_payment": "t_charge_payment_gen_1",
  "t_create_order": "t_create_order_gen_1",
  "t_get_amount": "c_shopB_get_amount",
  "t_cancel_order": "t_cancel_order_gen_1",
  "t_request_quote": "c_catalogA_request_quote",
  "t_checkout": "c_shopA_checkout",
  "t_get_quote": "c_catalogB_get_quote",
  "t_refund_payment": "c_paymentA_refund",
  "t_list_confirmed": "c_shopA_list_confirmed",
  "t_ship_order": "t_ship_order_gen_1"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 2077.08275,
  "cost_usd": 0.07035975,
  "availability": 0.9502990614557736,
  "gen_feat_1": 6388.60635,
  "gen_feat_2": 0.0005387195502929085,
  "gen_feat_3": 6385.5465
}
```

</details>

---
### pautasso2009-restful-ecommerce_mono_one_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 2.20s | See below |
| **Random Search** | 🟢 200 | 1.58s | See below |

| **Many Heuristic** | 🔴 422 | 0.12s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "solutions": [],
  "provenance": {
    "engine_id": "minizinc-csp",
    "execution_time_ms": 203.0,
    "metadata": {
      "solver": "gecode",
      "time_sec": 0.203
    }
  },
  "diagnostics": {
    "warnings": [
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[0].hard'",
        "details": {
          "path": "constraints[0].hard",
          "value": true
        }
      },
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[1].hard'",
        "details": {
          "path": "constraints[1].hard",
          "value": true
        }
      },
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[2].hard'",
        "details": {
          "path": "constraints[2].hard",
          "value": true
        }
      },
      "Option 'iterations_count' is not supported by MiniZinc engine"
    ],
    "binding_space": {
      "cardinality": "1594323",
      "log10_cardinality": 6.202576311355613,
      "per_task_counts": {
        "t_create_order": 3,
        "t_request_quote": 3,
        "t_get_quote": 3,
        "t_add_item": 3,
        "t_remove_item": 3,
        "t_get_amount": 3,
        "t_checkout": 3,
        "t_charge_payment": 3,
        "t_list_confirmed": 3,
        "t_ship_order": 3,
        "t_update_shipment": 3,
        "t_cancel_order": 3,
        "t_refund_payment": 3
      },
      "empty_tasks": []
    }
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "solutions": [],
  "provenance": {
    "engine_id": "random-search",
    "execution_time_ms": 0.0,
    "metadata": {
      "error": "No feasible solution found after 100000 iterations."
    }
  },
  "diagnostics": {
    "warnings": [
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[0].hard'",
        "details": {
          "path": "constraints[0].hard",
          "value": true
        }
      },
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[1].hard'",
        "details": {
          "path": "constraints[1].hard",
          "value": true
        }
      },
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[2].hard'",
        "details": {
          "path": "constraints[2].hard",
          "value": true
        }
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### pautasso2009-restful-ecommerce_mono_one_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.12s | See below |
| **Random Search** | 🟢 200 | 1.24s | See below |

| **Many Heuristic** | 🔴 422 | 0.13s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'bind_shop_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_create_order', 't_add_item', 't_remove_item', 't_get_amount', 't_checkout', 't_list_confirmed', 't_ship_order', 't_update_shipment', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'bind_catalog_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_request_quote', 't_get_quote'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'bind_payment_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_charge_payment', 't_refund_payment'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1866.14, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_add_item_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_add_item'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.4\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_add_item', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.5\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_add_item', 't_refund_payment'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.6\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'bind_shop_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_create_order', 't_add_item', 't_remove_item', 't_get_amount', 't_checkout', 't_list_confirmed', 't_ship_order', 't_update_shipment', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'bind_catalog_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_request_quote', 't_get_quote'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'bind_payment_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_charge_payment', 't_refund_payment'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1866.14, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_add_item_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_add_item'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.4",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_add_item', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.5",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_add_item', 't_refund_payment'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.6",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_add_item": "c_shopB_add_item",
  "t_remove_item": "c_shopB_remove_item",
  "t_update_shipment": "t_update_shipment_gen_1",
  "t_charge_payment": "c_paymentB_charge",
  "t_create_order": "c_shopB_create_order",
  "t_get_amount": "c_shopA_get_amount",
  "t_cancel_order": "c_shopB_cancel_order",
  "t_request_quote": "c_catalogB_request_quote",
  "t_checkout": "c_shopB_checkout",
  "t_get_quote": "c_catalogB_get_quote",
  "t_refund_payment": "c_paymentB_refund",
  "t_list_confirmed": "c_shopA_list_confirmed",
  "t_ship_order": "c_shopB_ship_order"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 2416.13235,
  "cost_usd": 0.06203,
  "availability": 0.9858829983915486,
  "gen_feat_1": 6379.902550000001,
  "gen_feat_2": 0.000535443476956177,
  "gen_feat_3": 6384.24595
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### pautasso2009-restful-ecommerce_mono_utility_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 2.23s | See below |
| **Random Search** | 🟢 200 | 1.48s | See below |

| **Many Heuristic** | 🔴 422 | 0.10s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "solutions": [],
  "provenance": {
    "engine_id": "minizinc-csp",
    "execution_time_ms": 0.0,
    "metadata": {}
  },
  "diagnostics": {
    "warnings": [
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[0].hard'",
        "details": {
          "path": "constraints[0].hard",
          "value": true
        }
      },
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[1].hard'",
        "details": {
          "path": "constraints[1].hard",
          "value": true
        }
      },
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[2].hard'",
        "details": {
          "path": "constraints[2].hard",
          "value": true
        }
      },
      "Option 'iterations_count' is not supported by MiniZinc engine"
    ],
    "binding_space": {
      "cardinality": "1594323",
      "log10_cardinality": 6.202576311355613,
      "per_task_counts": {
        "t_create_order": 3,
        "t_request_quote": 3,
        "t_get_quote": 3,
        "t_add_item": 3,
        "t_remove_item": 3,
        "t_get_amount": 3,
        "t_checkout": 3,
        "t_charge_payment": 3,
        "t_list_confirmed": 3,
        "t_ship_order": 3,
        "t_update_shipment": 3,
        "t_cancel_order": 3,
        "t_refund_payment": 3
      },
      "empty_tasks": []
    }
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "solutions": [],
  "provenance": {
    "engine_id": "random-search",
    "execution_time_ms": 0.0,
    "metadata": {
      "error": "No feasible solution found after 100000 iterations."
    }
  },
  "diagnostics": {
    "warnings": [
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[0].hard'",
        "details": {
          "path": "constraints[0].hard",
          "value": true
        }
      },
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[1].hard'",
        "details": {
          "path": "constraints[1].hard",
          "value": true
        }
      },
      {
        "code": "DEFAULT_APPLIED",
        "message": "Applied default for 'constraints[2].hard'",
        "details": {
          "path": "constraints[2].hard",
          "value": true
        }
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### pautasso2009-restful-ecommerce_mono_utility_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.12s | See below |
| **Random Search** | 🟢 200 | 1.35s | See below |

| **Many Heuristic** | 🔴 422 | 0.13s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'bind_shop_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_create_order', 't_add_item', 't_remove_item', 't_get_amount', 't_checkout', 't_list_confirmed', 't_ship_order', 't_update_shipment', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'bind_catalog_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_request_quote', 't_get_quote'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'bind_payment_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_charge_payment', 't_refund_payment'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 2259.82, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_add_item_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_add_item'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.4\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_add_item', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.5\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_add_item', 't_charge_payment'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.6\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'bind_shop_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_create_order', 't_add_item', 't_remove_item', 't_get_amount', 't_checkout', 't_list_confirmed', 't_ship_order', 't_update_shipment', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'bind_catalog_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_request_quote', 't_get_quote'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'bind_payment_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_charge_payment', 't_refund_payment'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 2259.82, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_add_item_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_add_item'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.4",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_add_item', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.5",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_add_item', 't_charge_payment'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.6",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_add_item": "c_shopB_add_item",
  "t_remove_item": "c_shopB_remove_item",
  "t_update_shipment": "t_update_shipment_gen_1",
  "t_charge_payment": "c_paymentB_charge",
  "t_create_order": "c_shopB_create_order",
  "t_get_amount": "c_shopB_get_amount",
  "t_cancel_order": "c_shopB_cancel_order",
  "t_request_quote": "c_catalogB_request_quote",
  "t_checkout": "c_shopB_checkout",
  "t_get_quote": "t_get_quote_gen_1",
  "t_refund_payment": "c_paymentA_refund",
  "t_list_confirmed": "c_shopB_list_confirmed",
  "t_ship_order": "c_shopB_ship_order"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 2295.14235,
  "cost_usd": 0.060565249999999994,
  "availability": 0.9874786465055755,
  "gen_feat_1": 6379.083550000001,
  "gen_feat_2": 0.0005341248336548596,
  "gen_feat_3": 6368.70595
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### pautasso2009-restful-ecommerce_multi_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.12s | See below |
| **Random Search** | 🔴 422 | 0.14s | See below |

| **Many Heuristic** | 🔴 422 | 0.17s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### pautasso2009-restful-ecommerce_multi_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.12s | See below |
| **Random Search** | 🔴 422 | 0.13s | See below |

| **Many Heuristic** | 🔴 422 | 0.13s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'bind_shop_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_create_order', 't_add_item', 't_remove_item', 't_get_amount', 't_checkout', 't_list_confirmed', 't_ship_order', 't_update_shipment', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'bind_catalog_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_request_quote', 't_get_quote'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'bind_payment_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_charge_payment', 't_refund_payment'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1866.14, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_add_item_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_add_item'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.4\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_add_item', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.5\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_add_item', 't_refund_payment'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.6\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'bind_shop_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_create_order', 't_add_item', 't_remove_item', 't_get_amount', 't_checkout', 't_list_confirmed', 't_ship_order', 't_update_shipment', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'bind_catalog_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_request_quote', 't_get_quote'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'bind_payment_mono_provider', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_charge_payment', 't_refund_payment'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_latency_ms_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'latency_ms', 'op': '<=', 'value': 1866.14, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_add_item_cost_usd_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_add_item'], 'attribute_id': 'cost_usd', 'op': '<=', 'value': 0.0, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.4",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_add_item', 't_cancel_order'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.5",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_add_item', 't_refund_payment'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.6",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### zhang2014-entertainment-planner-running-example_many_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MANY`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.31s | See below |
| **Random Search** | 🔴 422 | 0.23s | See below |

| **Many Heuristic** | 🟢 200 | 0.73s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Binding Solution**:
```json
{
  "t_movie": "t_movie_gen_49",
  "t_shopping": "t_shopping_gen_54",
  "t_dining": "t_dining_gen_34"
}
```
**Aggregated Features**:
```json
{
  "cost": 49.34,
  "time": 238.23,
  "distance": 1742.48,
  "gen_feat_1": 1484.24,
  "gen_feat_2": 0.127654928693071,
  "gen_feat_3": 1470.56
}
```

</details>

---
### zhang2014-entertainment-planner-running-example_many_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MANY`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.21s | See below |
| **Random Search** | 🔴 422 | 0.20s | See below |

| **Many Heuristic** | 🟢 200 | 4.78s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_within_2km', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'distance', 'op': '<=', 'value': 2000, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 50.07, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_dining_time_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_dining'], 'attribute_id': 'time', 'op': '<=', 'value': 59.79, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.4\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_dining', 't_shopping'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.5\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_dining', 't_movie'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.6\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_within_2km', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'distance', 'op': '<=', 'value': 2000, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 50.07, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_dining_time_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_dining'], 'attribute_id': 'time', 'op': '<=', 'value': 59.79, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.4",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_dining', 't_shopping'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.5",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_dining', 't_movie'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.6",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Binding Solution**:
```json
{
  "t_movie": "t_movie_gen_75",
  "t_shopping": "t_shopping_gen_8",
  "t_dining": "t_dining_gen_70"
}
```
**Aggregated Features**:
```json
{
  "cost": 49.37,
  "time": 238.52999999999997,
  "distance": 1745.08,
  "gen_feat_1": 1485.29,
  "gen_feat_2": 0.12341086186106176,
  "gen_feat_3": 1512.32
}
```

</details>

---
### zhang2014-entertainment-planner-running-example_mono_one_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.18s | See below |
| **Random Search** | 🟢 200 | 0.60s | See below |

| **Many Heuristic** | 🔴 422 | 0.18s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_movie": "t_movie_gen_92",
  "t_shopping": "t_shopping_gen_47",
  "t_dining": "t_dining_gen_90"
}
```
**Aggregated Features**:
```json
{
  "cost": 48.709999999999994,
  "time": 241.07,
  "distance": 1744.3,
  "gen_feat_1": 1491.76,
  "gen_feat_2": 0.12513207296593443,
  "gen_feat_3": 1502.74
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### zhang2014-entertainment-planner-running-example_mono_one_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.19s | See below |
| **Random Search** | 🟢 200 | 0.55s | See below |

| **Many Heuristic** | 🔴 422 | 0.20s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'c_within_2km', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'distance', 'op': '<=', 'value': 2000, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 50.07, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_dining_time_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_dining'], 'attribute_id': 'time', 'op': '<=', 'value': 59.79, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.4\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_dining', 't_shopping'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.5\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_dining', 't_movie'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.6\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_within_2km', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'distance', 'op': '<=', 'value': 2000, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 50.07, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_dining_time_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_dining'], 'attribute_id': 'time', 'op': '<=', 'value': 59.79, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.4",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_dining', 't_shopping'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.5",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_dining', 't_movie'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.6",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_movie": "t_movie_gen_52",
  "t_shopping": "t_shopping_gen_47",
  "t_dining": "t_dining_gen_23"
}
```
**Aggregated Features**:
```json
{
  "cost": 48.56,
  "time": 239.94,
  "distance": 1679.04,
  "gen_feat_1": 1481.8,
  "gen_feat_2": 0.1218078120493523,
  "gen_feat_3": 1473.95
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### zhang2014-entertainment-planner-running-example_mono_utility_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.21s | See below |
| **Random Search** | 🟢 200 | 0.66s | See below |

| **Many Heuristic** | 🔴 422 | 0.22s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_movie": "t_movie_gen_34",
  "t_shopping": "t_shopping_gen_37",
  "t_dining": "t_dining_gen_44"
}
```
**Aggregated Features**:
```json
{
  "cost": 49.980000000000004,
  "time": 235.16,
  "distance": 1663.09,
  "gen_feat_1": 1494.8,
  "gen_feat_2": 0.13385978664750445,
  "gen_feat_3": 1494.98
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### zhang2014-entertainment-planner-running-example_mono_utility_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MONO`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.32s | See below |
| **Random Search** | 🟢 200 | 0.59s | See below |

| **Many Heuristic** | 🔴 422 | 0.20s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"{'id': 'c_within_2km', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'distance', 'op': '<=', 'value': 2000, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 50.07, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_dining_time_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_dining'], 'attribute_id': 'time', 'op': '<=', 'value': 59.79, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.4\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_dining', 't_shopping'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.5\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_dining', 't_movie'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.6\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_within_2km', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'distance', 'op': '<=', 'value': 2000, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 50.07, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_dining_time_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_dining'], 'attribute_id': 'time', 'op': '<=', 'value': 59.79, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.4",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_dining', 't_shopping'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.5",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_dining', 't_movie'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.6",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_movie": "t_movie_gen_88",
  "t_shopping": "t_shopping_gen_8",
  "t_dining": "t_dining_gen_44"
}
```
**Aggregated Features**:
```json
{
  "cost": 50.160000000000004,
  "time": 233.43,
  "distance": 1660.59,
  "gen_feat_1": 1472.47,
  "gen_feat_2": 0.1343835796979068,
  "gen_feat_3": 1496.0100000000002
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### zhang2014-entertainment-planner-running-example_multi_hard.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.18s | See below |
| **Random Search** | 🔴 422 | 0.23s | See below |

| **Many Heuristic** | 🔴 422 | 0.18s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### zhang2014-entertainment-planner-running-example_multi_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.19s | See below |
| **Random Search** | 🔴 422 | 0.19s | See below |

| **Many Heuristic** | 🔴 422 | 0.20s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_within_2km', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'distance', 'op': '<=', 'value': 2000, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.0\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.1\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.2\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 50.07, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.3\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_local_t_dining_time_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_dining'], 'attribute_id': 'time', 'op': '<=', 'value': 59.79, 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.4\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_dining', 't_shopping'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.5\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_dining', 't_movie'], 'hard': False} is not valid under any of the given schemas\", \"path\": \"constraints.6\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_within_2km', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'distance', 'op': '<=', 'value': 2000, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.0",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_time_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'time', 'op': '<=', 'value': 240, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.1",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'c_cost_budget', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 100, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.2",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_global_cost_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'GLOBAL', 'attribute_id': 'cost', 'op': '<=', 'value': 50.07, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.3",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_local_t_dining_time_1', 'kind': 'ATTRIBUTE_BOUND', 'scope': 'LOCAL', 'tasks': ['t_dining'], 'attribute_id': 'time', 'op': '<=', 'value': 59.79, 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.4",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_same_1', 'kind': 'DEPENDENCY', 'type': 'SAME_PROVIDER', 'tasks': ['t_dining', 't_shopping'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.5",
        "constraint_id": null
      },
      {
        "code": "specialization_schema_invalid",
        "message": "{'id': 'gen_c_dep_diff_1', 'kind': 'DEPENDENCY', 'type': 'DIFFERENT_PROVIDER', 'tasks': ['t_dining', 't_movie'], 'hard': False} is not valid under any of the given schemas",
        "path": "constraints.6",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Random Search
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MONO' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MONO' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

---
#### Many Heuristic
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'MANY' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"stage\": \"specialization_schema\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'MANY' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
