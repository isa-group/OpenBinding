# Experiment Report

**Generated**: 2026-02-10 17:54:56

**Total**: 27 | **Passed**: 27 | **Failed**: 0

![Progress](https://geps.dev/progress/100?dangerColor=d9534f&warningColor=f0ad4e&successColor=5cb85c)

## Summary

| Instance | Obj | Soft | MiniZinc | RandomSearch | Binding Match | Binding Space Size | Result |
|---|---|---|---|---|---|---|---|
| benatallah2002-selfserv-tra... | SINGLE | False | 🟢 200 | 🟢 200 | ✅ MATCH | 64 | ✅ PASS (Both Solved) |
| benatallah2002-selfserv-tra... | MULTI | False | 🔴 422 | 🔴 422 | - | - | ✅ PASS (Both Rejected) |
| benatallah2002-selfserv-tra... | SINGLE | False | 🟢 200 | 🟢 200 | ✅ MATCH | 64 | ✅ PASS (Both Solved) |
| benatallah2002-selfserv-tra... | SINGLE | True | 🔴 422 | 🟢 200 | - | 64 | ✅ PASS (MZN Reject, RS Solve) |
| bultan2003-warehouse-exampl... | SINGLE | False | 🟢 200 | 🟢 200 | ✅ MATCH | 1 | ✅ PASS (Both Solved) |
| bultan2003-warehouse-exampl... | MULTI | False | 🔴 422 | 🔴 422 | - | - | ✅ PASS (Both Rejected) |
| bultan2003-warehouse-exampl... | SINGLE | False | 🟢 200 | 🟢 200 | ✅ MATCH | 1 | ✅ PASS (Both Solved) |
| bultan2003-warehouse-exampl... | SINGLE | True | 🔴 422 | 🟢 200 | - | 1 | ✅ PASS (MZN Reject, RS Solve) |
| cremaschi2018-textbook-acce... | SINGLE | False | 🟢 200 | 🟢 200 | ✅ MATCH | 1 | ✅ PASS (Both Solved) |
| cremaschi2018-textbook-acce... | MULTI | False | 🔴 422 | 🔴 422 | - | - | ✅ PASS (Both Rejected) |
| cremaschi2018-textbook-acce... | SINGLE | False | 🟢 200 | 🟢 200 | ✅ MATCH | 1 | ✅ PASS (Both Solved) |
| cremaschi2018-textbook-acce... | SINGLE | True | 🔴 422 | 🟢 200 | - | 1 | ✅ PASS (MZN Reject, RS Solve) |
| netedu2020-transport-agency... | SINGLE | False | 🟢 200 | 🟢 200 | ✅ MATCH | 1 | ✅ PASS (Both Solved) |
| netedu2020-transport-agency... | SINGLE | False | 🟢 200 | 🟢 200 | ✅ MATCH | 1 | ✅ PASS (Both Solved) |
| netedu2020-transport-agency... | SINGLE | False | 🟢 200 | 🟢 200 | ✅ MATCH | 1 | ✅ PASS (Both Solved) |
| parejo2013-goods-ordering_c... | SINGLE | False | 🟢 200 | 🟢 200 | ✅ MATCH | 128 | ✅ PASS (Both Solved) |
| parejo2013-goods-ordering_m... | MULTI | False | 🔴 422 | 🔴 422 | - | - | ✅ PASS (Both Rejected) |
| parejo2013-goods-ordering_s... | SINGLE | False | 🟢 200 | 🟢 200 | ✅ MATCH | 128 | ✅ PASS (Both Solved) |
| parejo2013-goods-ordering_soft | SINGLE | True | 🔴 422 | 🟢 200 | - | 128 | ✅ PASS (MZN Reject, RS Solve) |
| pautasso2009-restful-ecomme... | SINGLE | False | 🟢 200 | 🟢 200 | ⚠️ DIFF | 8192 | ✅ PASS (Both Solved) |
| pautasso2009-restful-ecomme... | MULTI | False | 🔴 422 | 🔴 422 | - | - | ✅ PASS (Both Rejected) |
| pautasso2009-restful-ecomme... | SINGLE | False | 🟢 200 | 🟢 200 | ⚠️ DIFF | 8192 | ✅ PASS (Both Solved) |
| pautasso2009-restful-ecomme... | SINGLE | True | 🔴 422 | 🟢 200 | - | 8192 | ✅ PASS (MZN Reject, RS Solve) |
| zhang2014-entertainment-pla... | SINGLE | False | 🟢 200 | 🟢 200 | ⚠️ DIFF | 2 | ✅ PASS (Both Solved) |
| zhang2014-entertainment-pla... | MULTI | True | 🔴 422 | 🔴 422 | - | - | ✅ PASS (Both Rejected) |
| zhang2014-entertainment-pla... | SINGLE | True | 🔴 422 | 🟢 200 | - | 2 | ✅ PASS (MZN Reject, RS Solve) |
| zhang2014-entertainment-pla... | SINGLE | True | 🔴 422 | 🟢 200 | - | 2 | ✅ PASS (MZN Reject, RS Solve) |

## Detailed Results

### benatallah2002-selfserv-travel-solution-cts-itas_complex.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 1.47s | See below |
| **Random Search** | 🟢 200 | 0.10s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_attractions_search": "svc_ass_1",
  "t_flight_booking_domestic": "svc_dfbs_2",
  "t_flight_booking_international": "svc_ifbs_2",
  "t_travel_insurance": "svc_tis_2",
  "t_accommodation_booking": "svc_abs_2",
  "t_car_rental_booking": "svc_crs_2"
}
```
**Aggregated Features**:
```json
{
  "availability": 0.977766742353457,
  "cost_usd": 1860.0,
  "latency_ms": 1060.0
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_car_rental_booking": "svc_crs_2",
  "t_flight_booking_international": "svc_ifbs_2",
  "t_attractions_search": "svc_ass_1",
  "t_accommodation_booking": "svc_abs_2",
  "t_flight_booking_domestic": "svc_dfbs_2",
  "t_travel_insurance": "svc_tis_2"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1060.0,
  "cost_usd": 1860.0,
  "availability": 0.9777667423534558
}
```

</details>

---
### benatallah2002-selfserv-travel-solution-cts-itas_multi.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.03s | See below |
| **Random Search** | 🔴 422 | 0.02s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'SINGLE' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'SINGLE' was expected",
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
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'SINGLE' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'SINGLE' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### benatallah2002-selfserv-travel-solution-cts-itas_single.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 1.08s | See below |
| **Random Search** | 🟢 200 | 0.07s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_attractions_search": "svc_ass_1",
  "t_flight_booking_domestic": "svc_dfbs_2",
  "t_flight_booking_international": "svc_ifbs_2",
  "t_travel_insurance": "svc_tis_2",
  "t_accommodation_booking": "svc_abs_1",
  "t_car_rental_booking": "svc_crs_1"
}
```
**Aggregated Features**:
```json
{
  "availability": 0.973061920122625,
  "cost_usd": 1692.0,
  "latency_ms": 1155.0
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_car_rental_booking": "svc_crs_1",
  "t_flight_booking_international": "svc_ifbs_2",
  "t_attractions_search": "svc_ass_1",
  "t_accommodation_booking": "svc_abs_1",
  "t_flight_booking_domestic": "svc_dfbs_2",
  "t_travel_insurance": "svc_tis_2"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1155.0,
  "cost_usd": 1692.0,
  "availability": 0.9730619201226238
}
```

</details>

---
### benatallah2002-selfserv-travel-solution-cts-itas_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.03s | See below |
| **Random Search** | 🟢 200 | 0.07s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"MiniZinc engine does not support soft constraints (hard=False)\", \"path\": \"constraints[0].hard\", \"code\": \"unsupported_soft_constraint\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "unsupported_soft_constraint",
        "message": "MiniZinc engine does not support soft constraints (hard=False)",
        "path": "constraints[0].hard",
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
  "t_car_rental_booking": "svc_crs_2",
  "t_flight_booking_international": "svc_ifbs_2",
  "t_attractions_search": "svc_ass_1",
  "t_accommodation_booking": "svc_abs_2",
  "t_flight_booking_domestic": "svc_dfbs_2",
  "t_travel_insurance": "svc_tis_2"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1060.0,
  "cost_usd": 1860.0,
  "availability": 0.9777667423534558
}
```

</details>

---
### bultan2003-warehouse-example_complex.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 1.10s | See below |
| **Random Search** | 🟢 200 | 0.21s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_authorize": "c_authorize_store_v1",
  "t_ok": "c_ok_bank_v1",
  "t_order1": "c_order1_store_v1",
  "t_receipt1": "c_receipt1_wh1_v1",
  "t_bill1": "c_bill1_wh1_v1",
  "t_payment1": "c_payment1_bank_v1",
  "t_order2": "c_order2_store_v1",
  "t_receipt2": "c_receipt2_wh2_v1",
  "t_bill2": "c_bill2_wh2_v1",
  "t_payment2": "c_payment2_bank_v1"
}
```
**Aggregated Features**:
```json
{
  "availability": 0.9821423419551,
  "cost_usd": 0.18,
  "latency_ms": 343.0
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_payment1": "c_payment1_bank_v1",
  "t_ok": "c_ok_bank_v1",
  "t_payment2": "c_payment2_bank_v1",
  "t_bill2": "c_bill2_wh2_v1",
  "t_authorize": "c_authorize_store_v1",
  "t_order2": "c_order2_store_v1",
  "t_order1": "c_order1_store_v1",
  "t_bill1": "c_bill1_wh1_v1",
  "t_receipt1": "c_receipt1_wh1_v1",
  "t_receipt2": "c_receipt2_wh2_v1"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1315.0,
  "cost_usd": 0.8200000000000001,
  "availability": 0.9211879907772421
}
```

</details>

---
### bultan2003-warehouse-example_multi.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.07s | See below |
| **Random Search** | 🔴 422 | 0.05s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'SINGLE' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'SINGLE' was expected",
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
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'SINGLE' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'SINGLE' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### bultan2003-warehouse-example_single.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 1.10s | See below |
| **Random Search** | 🟢 200 | 0.12s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_authorize": "c_authorize_store_v1",
  "t_ok": "c_ok_bank_v1",
  "t_order1": "c_order1_store_v1",
  "t_receipt1": "c_receipt1_wh1_v1",
  "t_bill1": "c_bill1_wh1_v1",
  "t_payment1": "c_payment1_bank_v1",
  "t_order2": "c_order2_store_v1",
  "t_receipt2": "c_receipt2_wh2_v1",
  "t_bill2": "c_bill2_wh2_v1",
  "t_payment2": "c_payment2_bank_v1"
}
```
**Aggregated Features**:
```json
{
  "availability": 0.9821423419551,
  "cost_usd": 0.18,
  "latency_ms": 343.0
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_payment1": "c_payment1_bank_v1",
  "t_ok": "c_ok_bank_v1",
  "t_payment2": "c_payment2_bank_v1",
  "t_bill2": "c_bill2_wh2_v1",
  "t_authorize": "c_authorize_store_v1",
  "t_order2": "c_order2_store_v1",
  "t_order1": "c_order1_store_v1",
  "t_bill1": "c_bill1_wh1_v1",
  "t_receipt1": "c_receipt1_wh1_v1",
  "t_receipt2": "c_receipt2_wh2_v1"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1315.0,
  "cost_usd": 0.8200000000000001,
  "availability": 0.9211879907772421
}
```

</details>

---
### bultan2003-warehouse-example_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.04s | See below |
| **Random Search** | 🟢 200 | 0.07s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"MiniZinc engine does not support soft constraints (hard=False)\", \"path\": \"constraints[0].hard\", \"code\": \"unsupported_soft_constraint\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "unsupported_soft_constraint",
        "message": "MiniZinc engine does not support soft constraints (hard=False)",
        "path": "constraints[0].hard",
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
  "t_payment1": "c_payment1_bank_v1",
  "t_ok": "c_ok_bank_v1",
  "t_payment2": "c_payment2_bank_v1",
  "t_bill2": "c_bill2_wh2_v1",
  "t_authorize": "c_authorize_store_v1",
  "t_order2": "c_order2_store_v1",
  "t_order1": "c_order1_store_v1",
  "t_bill1": "c_bill1_wh1_v1",
  "t_receipt1": "c_receipt1_wh1_v1",
  "t_receipt2": "c_receipt2_wh2_v1"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1315.0,
  "cost_usd": 0.8200000000000001,
  "availability": 0.9211879907772421
}
```

</details>

---
### cremaschi2018-textbook-access_complex.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 1.07s | See below |
| **Random Search** | 🟢 200 | 0.04s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_books": "c_google_books_api",
  "t_market": "c_amazon_market_api",
  "t_library": "c_opac_library_api",
  "t_geocoding": "c_google_geocoding_api",
  "t_transit": "c_google_transit_api",
  "t_archive": "c_archive_api"
}
```
**Aggregated Features**:
```json
{
  "availability": 0.927048054413251,
  "cost_usd": 0.0034,
  "latency_ms": 1350.0
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_geocoding": "c_google_geocoding_api",
  "t_market": "c_amazon_market_api",
  "t_books": "c_google_books_api",
  "t_library": "c_opac_library_api",
  "t_archive": "c_archive_api",
  "t_transit": "c_google_transit_api"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1350.0,
  "cost_usd": 0.0033999999999999994,
  "availability": 0.9270480544132499
}
```

</details>

---
### cremaschi2018-textbook-access_multi.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.02s | See below |
| **Random Search** | 🔴 422 | 0.02s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'SINGLE' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'SINGLE' was expected",
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
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'SINGLE' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'SINGLE' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### cremaschi2018-textbook-access_single.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 1.07s | See below |
| **Random Search** | 🟢 200 | 0.04s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_books": "c_google_books_api",
  "t_market": "c_amazon_market_api",
  "t_library": "c_opac_library_api",
  "t_geocoding": "c_google_geocoding_api",
  "t_transit": "c_google_transit_api",
  "t_archive": "c_archive_api"
}
```
**Aggregated Features**:
```json
{
  "availability": 0.927048054413251,
  "cost_usd": 0.0034,
  "latency_ms": 1350.0
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_geocoding": "c_google_geocoding_api",
  "t_market": "c_amazon_market_api",
  "t_books": "c_google_books_api",
  "t_library": "c_opac_library_api",
  "t_archive": "c_archive_api",
  "t_transit": "c_google_transit_api"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1350.0,
  "cost_usd": 0.0033999999999999994,
  "availability": 0.9270480544132499
}
```

</details>

---
### cremaschi2018-textbook-access_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.02s | See below |
| **Random Search** | 🟢 200 | 0.04s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"MiniZinc engine does not support soft constraints (hard=False)\", \"path\": \"constraints[0].hard\", \"code\": \"unsupported_soft_constraint\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "unsupported_soft_constraint",
        "message": "MiniZinc engine does not support soft constraints (hard=False)",
        "path": "constraints[0].hard",
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
  "t_geocoding": "c_google_geocoding_api",
  "t_market": "c_amazon_market_api",
  "t_books": "c_google_books_api",
  "t_library": "c_opac_library_api",
  "t_archive": "c_archive_api",
  "t_transit": "c_google_transit_api"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 1350.0,
  "cost_usd": 0.0033999999999999994,
  "availability": 0.9270480544132499
}
```

</details>

---
### netedu2020-transport-agency_complex.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 1.07s | See below |
| **Random Search** | 🟢 200 | 0.03s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_get_country_from_location": "c_get_country_from_location",
  "t_get_transport_company": "c_get_transport_company",
  "t_get_closest_city": "c_get_closest_city",
  "t_get_local_subsidiary": "c_get_local_subsidiary",
  "t_get_vehicle": "c_get_vehicle",
  "t_make_arrangements": "c_make_arrangements"
}
```
**Aggregated Features**:
```json
{
  "cost": 6.0
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_get_country_from_location": "c_get_country_from_location",
  "t_get_closest_city": "c_get_closest_city",
  "t_make_arrangements": "c_make_arrangements",
  "t_get_local_subsidiary": "c_get_local_subsidiary",
  "t_get_vehicle": "c_get_vehicle",
  "t_get_transport_company": "c_get_transport_company"
}
```
**Aggregated Features**:
```json
{
  "cost": 6.0
}
```

</details>

---
### netedu2020-transport-agency_single.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 1.07s | See below |
| **Random Search** | 🟢 200 | 0.03s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_get_country_from_location": "c_get_country_from_location",
  "t_get_transport_company": "c_get_transport_company",
  "t_get_closest_city": "c_get_closest_city",
  "t_get_local_subsidiary": "c_get_local_subsidiary",
  "t_get_vehicle": "c_get_vehicle",
  "t_make_arrangements": "c_make_arrangements"
}
```
**Aggregated Features**:
```json
{
  "cost": 6.0
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_get_country_from_location": "c_get_country_from_location",
  "t_get_closest_city": "c_get_closest_city",
  "t_make_arrangements": "c_make_arrangements",
  "t_get_local_subsidiary": "c_get_local_subsidiary",
  "t_get_vehicle": "c_get_vehicle",
  "t_get_transport_company": "c_get_transport_company"
}
```
**Aggregated Features**:
```json
{
  "cost": 6.0
}
```

</details>

---
### netedu2020-transport-agency_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 1.07s | See below |
| **Random Search** | 🟢 200 | 0.04s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_get_country_from_location": "c_get_country_from_location",
  "t_get_transport_company": "c_get_transport_company",
  "t_get_closest_city": "c_get_closest_city",
  "t_get_local_subsidiary": "c_get_local_subsidiary",
  "t_get_vehicle": "c_get_vehicle",
  "t_make_arrangements": "c_make_arrangements"
}
```
**Aggregated Features**:
```json
{
  "cost": 6.0
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_get_country_from_location": "c_get_country_from_location",
  "t_get_closest_city": "c_get_closest_city",
  "t_make_arrangements": "c_make_arrangements",
  "t_get_local_subsidiary": "c_get_local_subsidiary",
  "t_get_vehicle": "c_get_vehicle",
  "t_get_transport_company": "c_get_transport_company"
}
```
**Aggregated Features**:
```json
{
  "cost": 6.0
}
```

</details>

---
### parejo2013-goods-ordering_complex.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 1.08s | See below |
| **Random Search** | 🟢 200 | 0.04s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t1": "s1_B",
  "t2": "s2_A",
  "t3": "s3_C",
  "t4": "s4_C",
  "t5": "s5_E",
  "t6": "s6_G",
  "t7": "s7_I"
}
```
**Aggregated Features**:
```json
{
  "cost_usd": 0.123,
  "exec_time_s": 1.34
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t4": "s4_C",
  "t5": "s5_E",
  "t6": "s6_G",
  "t7": "s7_I",
  "t1": "s1_B",
  "t2": "s2_A",
  "t3": "s3_C"
}
```
**Aggregated Features**:
```json
{
  "cost_usd": 0.123,
  "exec_time_s": 1.34
}
```

</details>

---
### parejo2013-goods-ordering_multi.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.03s | See below |
| **Random Search** | 🔴 422 | 0.02s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'SINGLE' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'SINGLE' was expected",
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
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'SINGLE' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'SINGLE' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### parejo2013-goods-ordering_single.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 1.07s | See below |
| **Random Search** | 🟢 200 | 0.18s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t1": "s1_B",
  "t2": "s2_A",
  "t3": "s3_C",
  "t4": "s4_C",
  "t5": "s5_E",
  "t6": "s6_G",
  "t7": "s7_I"
}
```
**Aggregated Features**:
```json
{
  "cost_usd": 0.123,
  "exec_time_s": 1.34
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t4": "s4_C",
  "t5": "s5_E",
  "t6": "s6_G",
  "t7": "s7_I",
  "t1": "s1_B",
  "t2": "s2_A",
  "t3": "s3_C"
}
```
**Aggregated Features**:
```json
{
  "cost_usd": 0.123,
  "exec_time_s": 1.34
}
```

</details>

---
### parejo2013-goods-ordering_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.03s | See below |
| **Random Search** | 🟢 200 | 0.04s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"MiniZinc engine does not support soft constraints (hard=False)\", \"path\": \"constraints[0].hard\", \"code\": \"unsupported_soft_constraint\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "unsupported_soft_constraint",
        "message": "MiniZinc engine does not support soft constraints (hard=False)",
        "path": "constraints[0].hard",
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
  "t4": "s4_C",
  "t5": "s5_E",
  "t6": "s6_G",
  "t7": "s7_I",
  "t1": "s1_B",
  "t2": "s2_A",
  "t3": "s3_C"
}
```
**Aggregated Features**:
```json
{
  "cost_usd": 0.123,
  "exec_time_s": 1.34
}
```

</details>

---
### pautasso2009-restful-ecommerce_complex.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 5.16s | See below |
| **Random Search** | 🟢 200 | 0.07s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_create_order": "c_shopB_create_order",
  "t_request_quote": "c_catalogB_request_quote",
  "t_get_quote": "c_catalogB_get_quote",
  "t_add_item": "c_shopB_add_item",
  "t_remove_item": "c_shopB_remove_item",
  "t_get_amount": "c_shopB_get_amount",
  "t_checkout": "c_shopB_checkout",
  "t_charge_payment": "c_paymentB_charge",
  "t_list_confirmed": "c_shopB_list_confirmed",
  "t_ship_order": "c_shopB_ship_order",
  "t_update_shipment": "c_shopB_update_shipment",
  "t_cancel_order": "c_shopB_cancel_order",
  "t_refund_payment": "c_paymentB_refund"
}
```
**Aggregated Features**:
```json
{
  "availability": 0.986477032487391,
  "cost_usd": 0.06233,
  "latency_ms": 2458.425
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_add_item": "c_shopB_add_item",
  "t_remove_item": "c_shopA_remove_item",
  "t_update_shipment": "c_shopB_update_shipment",
  "t_charge_payment": "c_paymentB_charge",
  "t_create_order": "c_shopB_create_order",
  "t_get_amount": "c_shopB_get_amount",
  "t_cancel_order": "c_shopB_cancel_order",
  "t_request_quote": "c_catalogB_request_quote",
  "t_checkout": "c_shopB_checkout",
  "t_get_quote": "c_catalogB_get_quote",
  "t_refund_payment": "c_paymentA_refund",
  "t_list_confirmed": "c_shopB_list_confirmed",
  "t_ship_order": "c_shopB_ship_order"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 2451.675,
  "cost_usd": 0.06248,
  "availability": 0.9857948987897087
}
```

</details>

---
### pautasso2009-restful-ecommerce_multi.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.04s | See below |
| **Random Search** | 🔴 422 | 0.03s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'SINGLE' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'SINGLE' was expected",
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
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'SINGLE' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'SINGLE' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### pautasso2009-restful-ecommerce_single.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 1.09s | See below |
| **Random Search** | 🟢 200 | 0.07s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_create_order": "c_shopB_create_order",
  "t_request_quote": "c_catalogB_request_quote",
  "t_get_quote": "c_catalogB_get_quote",
  "t_add_item": "c_shopB_add_item",
  "t_remove_item": "c_shopB_remove_item",
  "t_get_amount": "c_shopB_get_amount",
  "t_checkout": "c_shopB_checkout",
  "t_charge_payment": "c_paymentB_charge",
  "t_list_confirmed": "c_shopB_list_confirmed",
  "t_ship_order": "c_shopB_ship_order",
  "t_update_shipment": "c_shopB_update_shipment",
  "t_cancel_order": "c_shopB_cancel_order",
  "t_refund_payment": "c_paymentB_refund"
}
```
**Aggregated Features**:
```json
{
  "availability": 0.986477032487391,
  "cost_usd": 0.06233,
  "latency_ms": 2458.425
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_add_item": "c_shopB_add_item",
  "t_remove_item": "c_shopA_remove_item",
  "t_update_shipment": "c_shopB_update_shipment",
  "t_charge_payment": "c_paymentB_charge",
  "t_create_order": "c_shopB_create_order",
  "t_get_amount": "c_shopA_get_amount",
  "t_cancel_order": "c_shopB_cancel_order",
  "t_request_quote": "c_catalogB_request_quote",
  "t_checkout": "c_shopB_checkout",
  "t_get_quote": "c_catalogB_get_quote",
  "t_refund_payment": "c_paymentB_refund",
  "t_list_confirmed": "c_shopB_list_confirmed",
  "t_ship_order": "c_shopB_ship_order"
}
```
**Aggregated Features**:
```json
{
  "latency_ms": 2441.925,
  "cost_usd": 0.062432,
  "availability": 0.9852908903811113
}
```

</details>

---
### pautasso2009-restful-ecommerce_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.03s | See below |
| **Random Search** | 🟢 200 | 0.06s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"MiniZinc engine does not support soft constraints (hard=False)\", \"path\": \"constraints[0].hard\", \"code\": \"unsupported_soft_constraint\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "unsupported_soft_constraint",
        "message": "MiniZinc engine does not support soft constraints (hard=False)",
        "path": "constraints[0].hard",
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
  "t_update_shipment": "c_shopB_update_shipment",
  "t_charge_payment": "c_paymentB_charge",
  "t_create_order": "c_shopB_create_order",
  "t_get_amount": "c_shopB_get_amount",
  "t_cancel_order": "c_shopA_cancel_order",
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
  "latency_ms": 2439.875,
  "cost_usd": 0.06238725,
  "availability": 0.985489567990405
}
```

</details>

---
### zhang2014-entertainment-planner-running-example_complex.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `False`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🟢 200 | 1.08s | See below |
| **Random Search** | 🟢 200 | 0.03s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Binding Solution**:
```json
{
  "t_dining": "c_dining_autre_saison",
  "t_shopping": "c_shopping_local",
  "t_movie": "c_movie_the_help_banque_scotia"
}
```
**Aggregated Features**:
```json
{
  "cost": 50.0,
  "distance": 1700.0,
  "time": 240.0
}
```

---
#### Random Search
**Binding Solution**:
```json
{
  "t_movie": "c_movie_the_help_banque_scotia",
  "t_shopping": "c_shopping_local",
  "t_dining": "c_dining_seven_night_club"
}
```
**Aggregated Features**:
```json
{
  "cost": 50.0,
  "time": 240.0,
  "distance": 1800.0
}
```

</details>

---
### zhang2014-entertainment-planner-running-example_multi.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `MULTI`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.02s | See below |
| **Random Search** | 🔴 422 | 0.01s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'SINGLE' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'SINGLE' was expected",
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
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"'SINGLE' was expected\", \"path\": \"objective.type\", \"code\": \"specialization_schema_invalid\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "specialization_schema_invalid",
        "message": "'SINGLE' was expected",
        "path": "objective.type",
        "constraint_id": null
      }
    ]
  }
}
```

</details>

---
### zhang2014-entertainment-planner-running-example_single.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.01s | See below |
| **Random Search** | 🟢 200 | 0.03s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"MiniZinc engine does not support soft constraints (hard=False)\", \"path\": \"constraints[1].hard\", \"code\": \"unsupported_soft_constraint\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"MiniZinc engine does not support soft constraints (hard=False)\", \"path\": \"constraints[2].hard\", \"code\": \"unsupported_soft_constraint\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "unsupported_soft_constraint",
        "message": "MiniZinc engine does not support soft constraints (hard=False)",
        "path": "constraints[1].hard",
        "constraint_id": null
      },
      {
        "code": "unsupported_soft_constraint",
        "message": "MiniZinc engine does not support soft constraints (hard=False)",
        "path": "constraints[2].hard",
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
  "t_movie": "c_movie_the_help_banque_scotia",
  "t_shopping": "c_shopping_local",
  "t_dining": "c_dining_seven_night_club"
}
```
**Aggregated Features**:
```json
{
  "cost": 50.0,
  "time": 240.0,
  "distance": 1800.0
}
```

</details>

---
### zhang2014-entertainment-planner-running-example_soft.json ![Pass](https://img.shields.io/badge/Result-PASS-success)

- **Objective**: `SINGLE`
- **Soft Constraints**: `True`

| Engine | Status | Time | Result |
|---|---|---|---|
| **MiniZinc CSP** | 🔴 422 | 0.01s | See below |
| **Random Search** | 🟢 200 | 0.03s | See below |

<details><summary><b>View Engine Responses</b></summary>

#### MiniZinc CSP
**Response**:
```json
{
  "detail": {
    "error": "The problem has semantic or logical errors: [{\"constraint_id\": null, \"message\": \"MiniZinc engine does not support soft constraints (hard=False)\", \"path\": \"constraints[0].hard\", \"code\": \"unsupported_soft_constraint\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"MiniZinc engine does not support soft constraints (hard=False)\", \"path\": \"constraints[1].hard\", \"code\": \"unsupported_soft_constraint\", \"penalty\": null, \"description\": null}, {\"constraint_id\": null, \"message\": \"MiniZinc engine does not support soft constraints (hard=False)\", \"path\": \"constraints[2].hard\", \"code\": \"unsupported_soft_constraint\", \"penalty\": null, \"description\": null}]",
    "violations": [
      {
        "code": "unsupported_soft_constraint",
        "message": "MiniZinc engine does not support soft constraints (hard=False)",
        "path": "constraints[0].hard",
        "constraint_id": null
      },
      {
        "code": "unsupported_soft_constraint",
        "message": "MiniZinc engine does not support soft constraints (hard=False)",
        "path": "constraints[1].hard",
        "constraint_id": null
      },
      {
        "code": "unsupported_soft_constraint",
        "message": "MiniZinc engine does not support soft constraints (hard=False)",
        "path": "constraints[2].hard",
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
  "t_movie": "c_movie_the_help_banque_scotia",
  "t_shopping": "c_shopping_local",
  "t_dining": "c_dining_autre_saison"
}
```
**Aggregated Features**:
```json
{
  "cost": 50.0,
  "time": 240.0,
  "distance": 1700.0
}
```

</details>

---
