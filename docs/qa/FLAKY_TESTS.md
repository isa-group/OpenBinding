# Flaky tests

## `LibArtifact.test.tsx` · "starts a draft from a sealed version, keeping its content and links"

**Symptom.** Failed once under `vitest run` and passed on rerun. A green rerun is not a fix, so the cause was looked for.

**Reproduced.** Yes, on 2 of 15 runs of the file (`vitest run src/pages/Library/LibArtifact.test.tsx` in a loop), and again on 1 of 15 in a second loop. The failures were always in this test; the other 15 tests in the file never failed. `--sequence.shuffle` over `src/pages/Library` (136 tests) did not fail, so test order is not involved.

**Cause (demonstrated).** The default output filter hid the failing assertion. A temporary wrapper around each assertion after "Create draft" labelled the failure, and the only one that failed in the failing run was the last:

```
expect(screen.getByRole('tab', { name: /^Drafts/ })).toHaveAttribute('aria-selected', 'true')
```

The toast text, `lib.content`, `lib.createDraft` and the "Open the editor" link had all passed before it. The component calls `setTab('drafts')`, which is `setSearchParams`, and then `setToast(...)`. React Router v7 applies the navigation inside `React.startTransition`, while `setToast` is an ordinary update. The toast can therefore commit one render before the router state that selects the tab. `findByText('Draft created from version 3.')` resolves on that first commit, and the synchronous `getByRole('tab')` that follows reads the tab before it has switched. Whether the two commits land together depends on timing, which is why it only failed sometimes.

The cause is in the test, not the component: the user-visible result (toast, then the Drafts tab selected a moment later) is correct. Mocks are reset in `beforeEach`, there are no timers, storage, `Date` or random values involved, and the mocked fetches resolve in a fixed order, so none of those contributed.

**Fix.** In `frontend/src/pages/Library/LibArtifact.test.tsx` the last assertion now waits for the selected tab:

```
expect(await screen.findByRole('tab', { name: /^Drafts/, selected: true })).toBeInTheDocument();
```

It still asserts the same thing (the Drafts tab ends up selected) and the default `findBy` timeout is kept; it only stops assuming the tab commits in the same render as the toast. The component is unchanged.

**Verification.**

- Before the fix: 3 failures in 30 runs of the file, all at the `aria-selected` assertion.
- After the fix: 0 failures in 30 runs of the file (two loops of 15), and `--sequence.shuffle` over `src/pages/Library` passed (9 files, 136 tests). `pnpm lint` and `git diff --check` are clean.
- Not run: the complete frontend suite, because no registered check runs it.
- The rate was low to begin with, so a clean loop is evidence, not proof. The proof is the demonstrated cause above and the removal of the assumption it depends on.

**Not changed.** Other tests in the file click a tab and then read it with a synchronous `getBy`. `fireEvent` runs inside `act`, which flushes the transition before it returns, and none of them failed in 60 runs, so they were left as they are. If one fails, use the same fix: `findByRole(..., { selected: true })`.
