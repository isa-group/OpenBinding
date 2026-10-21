# bim-service: rotation, saturation and bounded memory

Local, in-process validation (ASGI app driven by `httpx.ASGITransport`, `starlette.testclient` or direct ASGI calls).
New tests are in `bim-toolchain/packages/bim-service/tests/test_rotation_and_saturation.py`; properties already
covered by an existing test are cited, not duplicated. Paths below are relative to
`bim-toolchain/packages/bim-service/tests/`.

## Mechanisms found in the code

* **Tokens** (`auth.py`): the file is read once, in `create_app()` -> `load_authenticator()`. There is no reload on
  request, mtime or signal; retiring a token needs a restart (as `docs/SERVICE.md` already says). Comparison:
  SHA-256 of presented and stored tokens, `hmac.compare_digest` against every stored digest with no early exit.
* **Slots** (`runtime.py`): `threading.BoundedSemaphore(max_concurrency)` polled every <= 10 ms until
  `acquire_timeout_ms`, then 503 `service_busy` + `Retry-After`. The slot (and the tenant share) is released when the
  worker thread ends, not when the request times out or is cancelled; release also happens on a failed wait.
* **Body size** (`middleware.py`): `BodyLimitMiddleware` refuses a declared `Content-Length` over the limit without
  reading, and counts streamed chunks, cutting off at the first one that crosses the limit.

## Property -> test -> result

Result = what the last run of the registered checks showed (full bim-service + bim-client suite: 418 passed; the new
file: 20 passed, three consecutive runs, 1.5 s each, no flakiness observed).

| Property | Test | Result |
| --- | --- | --- |
| Two tokens valid at once, old and new accepted | existing `test_service_auth.py::test_both_tokens_are_accepted_during_a_rotation`, `test_service_documents.py::test_either_token_of_a_rotation_is_accepted` | pass |
| File with 3 tokens, repeated token, empty file, short/non-ASCII token rejected at start | existing `test_service_auth.py::test_a_tokens_file_that_is_not_acceptable_stops_the_start` | pass |
| Order of the two tokens in the file is irrelevant | `test_swapping_the_order_in_the_file_changes_nothing` | pass |
| After removing the old token, a running process still accepts it; a restarted one gives 401 (reload = restart only) | `test_retiring_the_old_token_takes_effect_on_restart_only` | pass |
| Retired token gets the same 401 (status, headers, body) as a never-valid or near-miss token; no token in the response | `test_a_retired_token_is_indistinguishable_from_any_wrong_token` | pass |
| Constant-time comparison | existing `test_service_auth.py::test_every_accepted_token_is_compared_in_constant_time` (spies `hmac.compare_digest`: called once per stored token, no early exit) plus code reading of `Authenticator.authorize`. Timing was **not** measured | pass (by call count and reading) |
| Empty / blank token, token with inner spaces not valid | `test_an_empty_or_blank_token_is_never_valid`, `test_a_token_with_spaces_inside_does_not_match_and_blank_headers_are_401`; existing `test_anything_but_an_accepted_token_is_refused` (`Bearer`, `Bearer `) | pass |
| Tokens not logged | existing `test_service_auth.py::test_tokens_never_reach_the_logs` | pass |
| N concurrent requests > slots: excess get 503 `service_busy` + `Retry-After` after the acquire timeout; never more than `slots` operations at once; health answers meanwhile; service serves afterwards (10 requests, 2 slots, 100 ms) | `test_n_concurrent_requests_over_the_slots_get_503_busy_and_the_service_recovers` | pass |
| 1 slot, 1 excess request: 503 and recovery | existing `test_service_limits.py::test_no_free_slot_within_the_wait_is_a_503_with_retry_after` | pass |
| Waiting that succeeds inside the timeout | existing `test_service_limits.py::test_a_request_that_finds_a_slot_within_the_wait_is_served` | pass |
| Per-tenant 429; rejected requests do not leak tenant share | existing `test_a_tenant_over_its_share_gets_429_while_others_are_served`, `test_a_rejected_request_does_not_leak_a_tenant_slot` | pass |
| Operation timeout keeps the slot until the thread ends, then it returns | existing `test_an_operation_that_runs_out_of_time_is_a_503_and_keeps_its_slot_until_it_ends` | pass |
| No slot/tenant loss when the operation raises (4 failures, 1 slot, 1 share, then 200) | `test_slots_survive_operations_that_raise` | pass |
| No loss on cancellation: a cancelled waiter and a cancelled running request (slot returns when the thread ends) | `test_cancelling_a_waiter_and_a_running_request_returns_slot_and_tenant_share` | pass |
| Waiters that time out release the tenant share (`Gate` level) | `test_a_timed_out_waiter_for_a_slot_releases_the_tenant_share` | pass |
| Body limit applied before reading (declared length) / while streaming | existing `test_service_limits.py::test_a_declared_length_over_the_limit_is_refused_without_reading_a_byte`, `test_a_body_that_outgrows_the_limit_while_streaming_is_cut_off`, `test_a_body_of_exactly_the_limit_is_accepted` | pass |
| Request of ~1 MiB (limit 1 MiB): `tracemalloc` peak < 32x the limit; accepted by the size check (not 413/500) | `test_a_request_near_the_limit_stays_within_a_multiple_of_the_limit` | pass |
| 6 repeated near-limit requests retain < 4x the limit afterwards | `test_repeated_requests_near_the_limit_do_not_accumulate` | pass |
| 64 MiB offered in 64 KiB chunks against a 1 MiB limit: 413, at most limit/chunk + 2 chunks read, `tracemalloc` peak < 4x the limit | `test_a_stream_far_over_the_limit_never_gets_buffered` | pass |
| Identical concurrent requests give identical results (16 compiles, 16 evaluations, 4 slots) | `test_identical_concurrent_requests_give_identical_answers`; sequential determinism in existing `test_service_api.py::test_compilation_is_deterministic` and `test_service_documents.py::test_the_answers_are_deterministic_and_carry_the_trace` | pass |

No defect was found in `bim-service/src`, so there is no `xfail`.

## Notes and limits of the checks

* Memory thresholds are deliberately wide (32x, 4x the 1 MiB limit) and measure Python allocations with `tracemalloc`;
  they catch an unbounded buffer, not a regression of a few copies. The exact peaks were not recorded by the check
  runner, so none is quoted here. RSS (`resource.getrusage`) was not used: it is a high-water mark of the whole test
  process and not usable for a margin.
* The near-limit request carries a base64 payload that is not a ZIP, so the service answers a 4xx package error after
  decoding it. It exercises body reading, JSON parsing and base64 decoding at the limit, not the compiler's memory on
  a large valid package (`BIM_MAX_*` package limits are covered elsewhere).
* A body without `Content-Length` that is read by the application is buffered by `await request.body()` up to the
  limit (`max_body_bytes`, default 32 MiB, plus the copies described above); the bound is the limit, not zero.

## NOT measured

* No real load test: no sockets, no uvicorn, no multi-process (`--workers`), no throughput or latency percentiles.
  Timing assertions only check "waited at least ~80% of the acquire timeout".
* No CPU behaviour of the container: the `cpus` / `pids` limits of the compose file cannot be exercised here, nor the
  interaction of the worker pool with a CPU quota.
* No real container memory (cgroup) limit or OOM behaviour.
* Constant-time property is argued from the code and from the call count, not from a timing measurement.
* Token reload by signal/mtime does not exist, so it is not tested; `bim_client.HttpBim(token_file=...)` re-reading is
  client side and out of scope here.
* `time.monotonic`-based tests depend on the host scheduler; the margins are wide, but a heavily loaded machine could
  still make a 100 ms wait look longer (the assertions only use lower bounds on time).
