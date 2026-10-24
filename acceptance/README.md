# Acceptance tests

Executable acceptance tests derived from the OpenSpec requirements and the public interfaces only.

## Layout

- `acceptance/api/<capability>/test_<slug>.py`: API tests (pytest). Runner configuration: `acceptance/api/pytest.ini` and `acceptance/api/conftest.py`.
- `acceptance/ui/<capability>/<slug>.spec.ts`: UI tests (Playwright). Runner configuration: `frontend/playwright.acceptance.config.ts` (`testDir` `../acceptance/ui`).

## Running

API runner, from the repository root (job `lab`):

```
openbinding-gateway/.venv/bin/python -m pytest -c acceptance/api/pytest.ini acceptance/api
```

UI runner, from `frontend/` (job `frontend`):

```
pnpm exec playwright test --config playwright.acceptance.config.ts --pass-with-no-tests
```

Both exit 0 while there are no tests (the API runner also exits 0 when `-k` selects nothing). Any other
exit status is kept.

## Rules

- Only the test-designer writes tests under `acceptance/` (gate G4).
- Tests are derived from the specs and the public interfaces only, never from the implementation.
- Every test carries a `[utest->req~name~rev]` tag.
