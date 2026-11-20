/**
 * F4's operation behind SCORETech Identity (F5-C, lab/identity/walk.sh).
 *
 * `@operation-setup`: the three fixture users that stand for the lab's owner, member and viewer sign in once and choose
 * their usernames, keeping Identity's SSO cookies for the walk. The harness then moves the seeded `lab-main` memberships of
 * `lab-owner`, `lab-member` and `lab-viewer` to them, and runs `e2e/live/13-operation.spec.ts` unchanged with
 * `LAB_SIGN_IN=identity` (e2e/live/support.ts signs each role in through Identity).
 */
import { expect, test } from '@playwright/test';

import { answerWithCode, api, email, landed, startSignIn, storagePath, username } from './support';

test.describe.configure({ mode: 'serial' });

for (const role of ['opowner', 'opmember', 'opviewer'] as const) {
  test(`@operation-setup ${role}: a first sign-in chooses its username`, async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await startSignIn(page);
    await answerWithCode(page, email(role));
    expect((await landed(page)).pathname).toBe('/sso/identity/username');
    const done = await api(page).complete(username(role));
    expect(done.status()).toBe(201);
    await context.storageState({ path: storagePath(role) });
    await context.close();
  });
}
