Goal: option 3 of the coordinator (startup validation of PUBLIC_BASE_URL/FRONTEND_URL/CORS origins) plus cleanup of dead deploy/ code.
State: d341d157 and e7371bad integrated; head 0c37c9c. Check passed (426 tests: new test_public_origin, test_b2_cors, settings, CAS, lab/tests).
Decisions: URLs tolerate one trailing '/', CORS entries do not; bare '*' tolerated in dev/test, prod keeps its earlier message; CHANGELOG.md did not exist, created at the root (Keep a Changelog); docker-compose.yml untouched (defaults already valid).
Risks: full gateway suite not run by the worker; CI will cover it.
Next: push, PR, reviewer, lead_ready.
