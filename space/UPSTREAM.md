# Things to report upstream

Found while integrating OpenBinding with SPACE 1.0.0 and `space-python-client`
0.1.0. None of them is worked around by patching a dependency: OpenBinding runs
both unmodified. They are recorded here so they can be reported as issues or
pull requests, and so that whoever moves the pinned versions knows what to
re-check.

Ordered by how much damage they do quietly.

---

## 1. Consuming while evaluating loses all but one update

**Where** `isa-group/space` — `dist/utils/feature-evaluation/featureEvaluation.js:27`

```js
await Promise.all(
  limits.map(limit =>
    contractService._applyExpectedConsumption(options.userId, limit, expectedConsumption[limit])
  )
);
```

**What happens** Each `_applyExpectedConsumption` reads the contract, changes one
usage level, and writes the document back. Run concurrently over several limits,
they overlap: every one of them starts from the same pre-update contract, and the
last write to land discards the others.

**Reproduction** With a feature whose expression reads two limits:

```
POST /api/v1/features/{userId}/openbinding-solve
{"openbinding-tasksLimit": 1, "openbinding-concurrentTasksLimit": 1}
```

The response reports both as consumed. The contract afterwards shows one of them
incremented and the other untouched — and *which* one varies between identical
calls.

**Why it matters** The response says the accounting happened, so nothing looks
wrong. A service metering usage this way under-charges by an amount that depends
on timing, which is the hardest kind of discrepancy to notice or reproduce.

**Suggested fix** Apply the increments in one update rather than one per limit —
a single `$inc` over the contract covering every limit at once, or an
`updateOne` with all the paths. `PUT /contracts/{userId}/usageLevels` already
takes a whole map and does the right thing; evaluation could reuse it.

**What OpenBinding does meanwhile** Asks with `evaluate` (refusals are correct
and unaffected) and records consumption itself with a single
`PUT .../usageLevels`. Independently sound, so the workaround is not wasted work
if this is fixed.

---

## 2. `expectedConsumption` cannot express "check this, charge nothing"

**Where** `isa-group/space` — `featureEvaluation.js:126`

```js
function _updateUsageLevel(currentUsageLevel, expectedConsumption) {
    if (!expectedConsumption) {
        return undefined;
    }
    return currentUsageLevel + expectedConsumption;
}
```

**What happens** `0` is falsy, so a consumption of zero is indistinguishable from
one that was never supplied. The caller then gets
`INVALID_EXPECTED_CONSUMPTION: No expectedConsumption value was provided for
limit '…'`, because SPACE also requires that if any limit an expression reads is
given a figure, all of them must be.

**Why it matters** The two rules together make a common case unexpressible: a
limit that should be *checked* before an operation but only *charged* once the
real cost is known. Metered compute is exactly that — nobody knows how long a
solve takes until it has taken it.

**Suggested fix** `if (expectedConsumption === undefined || expectedConsumption === null)`.
A zero is a meaningful value, not a missing one.

**What OpenBinding does meanwhile** Leaves `solverTimeLimit` out of the `solve`
expression entirely and checks its headroom itself.

---

## 3. The Python client sends `phone: null`, which SPACE rejects

**Where** `Alex-GF/space-python-client` — `space_client/types/models.py`,
`UserContact.to_dict`

**What happens** An unset optional field is serialised as JSON `null` rather than
omitted. SPACE validates `userContact.phone` with express-validator's
`.optional().isString()`, and `.optional()` by default treats only `undefined` as
absent — an explicit `null` is present and fails the type check.

**Reproduction**

```python
client.contracts.add_contract(ContractToCreate(
    user_contact=UserContact(user_id=uid, username=uid, email="a@example.org"),
    billing_period=BillingPeriodToCreate(auto_renew=True, renewal_days=30),
    contracted_services={"svc": "1.0.0"},
    subscription_plans={"svc": "PLAN"},
))
# -> None; SPACE answered 422 "The userContact.phone field must be a string"
```

Passing `phone=""` succeeds.

**Why it matters** Creating a contract without a phone number is the ordinary
case, and it fails. The client returns `None` rather than raising, so the caller
sees a contract that silently did not get created.

**Suggested fix** Omit `None` fields from `to_dict()` rather than emitting them.
Alternatively, SPACE could use `.optional({ nullable: true })`. Either side fixes
it; doing both would be better.

**What OpenBinding does meanwhile** Passes `phone=""` explicitly, with a comment
saying why.

---

## 4. The Python client is synchronous, with no async variant

**Where** `Alex-GF/space-python-client` — `space_client/space_client.py:36`,
`httpx.Client`; there is not an `async def` in the package.

**Why it matters** The obvious consumers of a pricing client are web backends,
and in Python those are increasingly asynchronous — FastAPI, Starlette, Litestar,
aiohttp. Calling a blocking client from a coroutine stalls the whole event loop
for the duration of the request, so every other request in flight waits on it.
That is worst precisely where SPACE is most useful: a service whose requests are
long-running, where one blocked loop delays work that has nothing to do with
pricing.

**Suggested improvement** The library already uses `httpx`, which ships
`AsyncClient` with the same request API. An `AsyncSpaceClient` mirroring the
existing surface would be mostly mechanical, and could share the model, cache and
event code as-is. Publishing both from one package (as `httpx`, `redis-py` and
`elasticsearch-py` all do) would suit either kind of caller.

**What OpenBinding does meanwhile** Runs every client call in a worker thread via
`anyio.to_thread.run_sync`. Correct, and it costs a thread hop per call — fine at
our request rates, not what you would choose at higher ones.

---

## 5. The parser is a specification version behind

**Where** `pricing4ts` 0.10.3 (bundled by SPACE 1.0.0) —
`dist/server/utils/version-manager.js`

```js
exports.PRICING2YAML_VERSIONS = ["1.0", "1.1", "2.0", "2.1", "3.0"];
```

**What happens** The current Pricing2Yaml specification is **3.1**. Declaring it
is refused outright:

```
Pricing parsing error: Unsupported version: 3.1.
Please, visit the changelogs of Pricing2Yaml to check the supported versions.
```

**Why it matters** A pricing cannot declare the version of the specification it
was actually written against. Anyone following the current specification writes
a document their SPACE instance rejects, and the error points at the changelog
rather than at the parser being behind.

There is a second, separate confusion nearby: the published specification page
for 3.1 states "Supported value: `3.0`" for `syntaxVersion`, which is a
documentation bug. So a reader gets told 3.0 by the docs, and a writer following
the version number gets refused by the parser.

**Suggested fix** Add `"3.1"` to `PRICING2YAML_VERSIONS`, with an updater entry
if 3.1 changes anything structural. Separately, correct the `syntaxVersion`
value on the 3.1 specification page.

**What OpenBinding does meanwhile** Declares `3.0`, with a comment in
`pricing/openbinding.yml` saying why. Nothing in the document uses 3.1 syntax,
so the declaration is the only thing that changes when the version list grows.

---

## 6. `add_contract` reports success for a contract SPACE refused

**Where:** `space-python-client`, `contracts.add_contract`.

**What happens:** the method returns `None` whether SPACE created the contract
or rejected it. A 400 is not raised, not logged, and not distinguishable from a
successful call by any return value.

**How it was found:** the plans in this pricing were renamed - `BASIC` became
`FREE` - and the gateway kept asking for a pricing version that still declared
the old names. SPACE answered every contract creation with

```
400 {"error":"Invalid subscription: Error: Plan FREE for service openbinding not found in the request organization"}
```

and the gateway logged nothing, reported every registration as successful, and
produced accounts with no contract at all. `GET /v1/users/me/usage` returned an
empty limit list, which reads as "this plan has no limits" rather than as a
failure. It went unnoticed until somebody counted the contracts in MongoDB.

**Why it matters:** every other failure in the client raises. This one is the
single call where silence and success are the same value, and it is the call
that establishes whether a user is entitled to anything.

**Suggested fix:** raise on a non-2xx, as the other methods do; or return the
created contract so the caller can tell.

**What this repository does instead:** reads the contract back immediately after
creating it (`SpacePricingGate.create_contract`) and raises `PricingUnavailable`
when it is absent, with a message naming the likely cause. No local patch to the
client.

---

## 7. A database outage is reported as `401 Unauthorized`

**Where:** SPACE 1.0.0, any endpoint, when MongoDB is unreachable.

**What happens:** the API keeps answering, its healthcheck keeps passing, and
every authenticated request comes back as

```
401 {"error":"Operation `users.findOne()` buffering timed out after 10000ms"}
```

The status code says the credential was wrong. The body says Mongoose could not
reach the database. Only the body is true.

**How it was found:** `bootstrap_space.py` reported "SPACE rejected those
administrator credentials" against an instance whose password was correct. The
container had been up for fifteen hours, reporting healthy, with its `mongodb`
container stopped the whole time.

**Why it matters:** the wrong status sends whoever is debugging to look for a
password, and the healthcheck actively confirms that the service is fine. Two
signals agreeing on the wrong answer is expensive.

**Suggested fix:** answer `503` for a database timeout, and make the healthcheck
depend on the database connection rather than only on the HTTP listener.

**What this repository does instead:** `space/connect.sh` looks for
`buffering timed out` in the body and says what it actually means.

---

## 8. Smaller things, worth mentioning if a PR is opened anyway

- **Deleting a service leaves its pricings behind.** `DELETE /services/{name}`
  and even `DELETE /services` (prune) return success, but re-registering the same
  service and version then fails with a MongoDB duplicate-key error on
  `_serviceName_1_version_1__organizationId_1`. The rows have to be removed by
  hand. It makes an idempotent bootstrap script harder to write than it should be.

- **Limit names are qualified in one direction only.** Feature evaluation expects
  `openbinding-tasksLimit`; the body of a usage-level update expects
  `tasksLimit`, nested under the service. Both are defensible, but the asymmetry
  is undocumented and getting it wrong on the update path is accepted silently
  with no change made.

- **Plans must repeat their features.** A plan relying on the top-level
  `defaultValue`s is rejected with "The plan must be an object of type Plan"
  (`pricing-validators.js:555`, which tests only for the presence of a `features`
  key). The specification presents plan-level `features` as optional overrides,
  so either the validator or the documentation is wrong.
