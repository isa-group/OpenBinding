# Tasks: validate-public-origin-format

Capability: `gateway-api`. Requirements: `req~gateway-api-public-origin-format~1`,
`req~gateway-api-cors-origin-format~1`, `req~gateway-api-origin-error-masking~1`.

## 1. Acceptance tests (test-designer)

- [x] 1.1 Write failing tests from the delta scenarios in `openbinding-gateway/tests/test_public_origin.py`, each tagged
      `[utest->req~gateway-api-public-origin-format~1]`, `[utest->req~gateway-api-cors-origin-format~1]` or
      `[utest->req~gateway-api-origin-error-masking~1]`; masking tests assert on `str()` of the raised exception.
- Files: `openbinding-gateway/tests/test_public_origin.py`.
- Check: red-before run of the new test file (the tests fail before 2.1).

## 2. Implementation (implementer), after 1

- [x] 2.1 Add `_require_origin` and the masking helper to `core/settings.py`; validate `PUBLIC_BASE_URL` and
      `FRONTEND_URL` (one trailing `/` allowed) and each non-`*` entry of `CORS_ALLOW_ORIGINS` (no trailing `/`) in
      every `APP_ENV`; keep `closed_cors_in_production` unchanged; make sure the rendered `ValidationError` does not
      echo the raw input. Tag the code `[impl->req~...~1]` for the three requirements.
- Files: `openbinding-gateway/src/openbinding_gateway/core/settings.py`.
- Checks: gateway test suite (including `tests/test_b2_cors.py`, `tests/test_prod_insecure_flags.py` and the new tests),
  ruff, OpenAPI snapshot check (must be unchanged).
- Size: about 80–120 diff lines.

## 3. Documentation (implementer or doc-steward), with 2

- [x] 3.1 Document the accepted shapes, the canonical-form limitation of CORS entries and the masked error in the
      gateway's configuration documentation (`.env.example` comments or the gateway README, wherever the variables are
      described).

## 4. Archive (after merge)

- [ ] 4.1 `openspec archive validate-public-origin-format --yes`, then `openspec validate --all --strict` and the trace.
