# Errors: one problem document for every 422

Every `422` the gateway sends — a request Pydantic refuses, a route that refuses a
value it understood, the BIM compiler refusing a package, the pricing linter
refusing a document — has the same body. It follows RFC 9457 (problem details),
extended with a stable `code` and a list of `diagnostics`. OpenAPI names it
`Problem`; each finding is a `Diagnostic`.

```json
{
  "type": "https://openbinding.dev/problems/validation_error",
  "title": "validation_error",
  "status": 422,
  "code": "validation_error",
  "detail": "Request validation failed: /spec/limits/maxTasks: Input should be greater than 0 (+1 more)",
  "diagnostics": [
    {
      "code": "greater_than",
      "message": "Input should be greater than 0",
      "in": "body",
      "pointer": "/spec/limits/maxTasks",
      "loc": ["body", "spec", "limits", "maxTasks"],
      "context": {"gt": 0}
    }
  ]
}
```

## Problem

| Field | Type | Meaning |
|---|---|---|
| `type` | string | `https://openbinding.dev/problems/<code>` |
| `title` | string | **Same value as `code`.** `/v1/validate` and the other BIM routes always did this and clients read `title` as the code; it is kept. |
| `status` | integer | the HTTP status (`422`) |
| `code` | string | stable, machine-readable. `validation_error` when the request itself is malformed (types, required fields, ranges, JSON syntax); a specific code (`weak_password`, `invalid_instance`, `invalid_pricing`, `checksum_mismatch`, …) when a route refuses a value it understood. |
| `detail` | string | one-line, human-readable summary. For request validation: `Request validation failed: <pointer or parameter>: <message>` plus `(+N more)`. |
| `diagnostics` | array | **always present and never empty on a 422.** A refusal that names no finer detail has one diagnostic restating `code`/`detail`. |

A route may add fields of its own beside these (for example `conflicts` on
`incompatible_target_engines`, or `valid`/`errors`/`warnings`/`plans`/`add_ons`
on `invalid_pricing`). They never replace a canonical key; if one tried to, it is
kept under `extra`.

## Diagnostic

| Field | Present | Meaning |
|---|---|---|
| `code` | always | for request validation, the Pydantic error type (`missing`, `string_type`, `greater_than_equal`, `too_short`, `extra_forbidden`, `json_invalid`, …); otherwise the route's or the compiler's finding code |
| `message` | always | human-readable |
| `pointer` | when a field is at fault | RFC 6901 JSON Pointer (`/spec/limits/maxTasks`, `/features/0`; keys are escaped with `~0`/`~1`). Into the request body for validation errors; into `resource` for compiler findings; into the YAML for pricing. |
| `in` | request validation | `body`, `query`, `path`, `header` or `cookie` |
| `parameter` | `in` ≠ `body` | the query/path/header/cookie parameter (`limit`, `proposal_id`) |
| `resource` | compiler findings | the package file the finding is about |
| `span` | when known | position in the source text: `{"offset": 12}` for malformed JSON; `{"line", "column"}` for documents |
| `hint` / `fix` | when known | what to do / a concrete replacement (`"This field is required."`, the JSON parser's reason) |
| `loc` | request validation | the raw Pydantic location (`["body", "features", 0]`), nothing lost |
| `context` | request validation | the limits that were exceeded (`{"ge": 1}`, `{"max_length": 64}`) — scalars only |
| `related`, `bpmnElement`, `irPath` | compiler findings | unchanged |

The value the client sent is **never** echoed back (it may be a password or a
token); FastAPI's `input` is dropped on purpose.

A diagnostic that arrives with only a code, or only a message, is completed
(`message` = code, or `code` = the problem's code); one that already has both is
passed through untouched, so the compiler keeps every field it had.

## Where it comes from

One place decides the wire shape: `openbinding_gateway/models/problem.py` for the
document and `main.py` for the handlers.

| Source | Handler |
|---|---|
| FastAPI/Pydantic refuses the request (`RequestValidationError`) | `request_validation_error` → `validation_error`, one diagnostic per Pydantic error |
| a route raises `api_error(422, …)` / `HTTPException(422, …)` | `http_error` → the route's `code`; its `error`/`message` becomes `detail`; its `diagnostics` are normalised |
| the BIM compiler refuses a package (`CompileError`) | the route's own `invalid_instance`; any route that does not catch it is covered by `compile_error` |
| a BIM route that returns its refusal instead of raising (`_problem`, `_error_from_http`) | the same `problem_response` helper |
| a pricing document is invalid | `invalid_pricing` (below) |

Routes keep raising `api_error(422, code, message)`; they need not know the shape.

### Media type

BIM routes (`/v1/validate`, `/v1/instances`, `/v1/jobs`, `/v1/engines`,
`/v1/resources`, … — the prefixes in `_BIM_PATH_PREFIXES`) answer
`application/problem+json`, as they always did. The platform routes
(accounts, organizations, projects, studies, artifacts, pricing, generator, …)
keep `application/json`. The body is identical; only the media type differs, and
the OpenAPI document declares the right one per path. Nothing was changed here
on purpose: switching the platform routes would be harmless to a JSON client but
is not needed.

## The other statuses

`400`, `401`, `402`, `403`, `404`, `409`, `429`, `503`, … keep the shape they
had; nothing was removed.

* **Platform routes** (everything outside the BIM prefixes) answer
  `{"detail": {"code", "error", …extra}}`. Every coded failure now also carries
  the canonical keys beside it: `type`, `title`, `status`, `code` (the same
  value as `detail.code`). `detail` stays an **object** here — turning it into a
  string would break every client that reads `detail.code` — so this is the one
  deliberate difference from `Problem`: read `code`/`status` at the top level
  everywhere; read `detail` as a string only on 422 and on BIM routes.
  Failures with a plain-string `detail` (`{"detail": "Not Found"}`) are unchanged.
* **BIM routes** answer `Problem` (`type`, `title`, `status`, `code`, `detail`,
  optional `diagnostics`, plus route-specific fields such as `quota`).

## Pricing validation

`POST /v1/admin/pricing/validate`:

* a valid document → `200` with the validation view (`valid: true`, `version`,
  `digest`, `syntax_version`, `plans`, `add_ons`, `errors: []`, `warnings`);
* an invalid one → **`422`**, `code: "invalid_pricing"`, with the unified problem
  **and** the same validation view fields (`valid: false`, `errors`, …) in the
  body, so a client that reads the view from the 422 keeps working.

Each message of `errors` has exactly one diagnostic with the same `message`.
`pointer` is a JSON Pointer into the YAML when the message names a field:

| `code` | Example `pointer` |
|---|---|
| `invalid_field` | `/saasName`, `/plans`, `/plans/PRO/usageLimits/maxTimeoutSeconds` |
| `secret_in_document` | `/apiToken` (one diagnostic per secret-shaped key; the value is never repeated) |
| `invalid_yaml`, `invalid_root`, `document_too_large` | none (the document as a whole) |

`POST /v1/admin/pricing/drafts` refuses an invalid document with the same
`invalid_pricing` diagnostics. There is no other pricing validation endpoint.
Until this change an invalid document answered `200` with `valid: false` from
`/validate`; the decision is `422`, documented here and in the OpenAPI document.
