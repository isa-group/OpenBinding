import { createHmac } from 'node:crypto';

/**
 * The lab's deterministic feed key of one environment, the TypeScript twin of `feed_key_for` in
 * openbinding-gateway/tools/seed_lab.py: HMAC-SHA256 of `openbinding-lab-seed:feedkey:<org>/<composition>/<environment>` under
 * the seed password, `obe_<8 hex>_<rest>`. Whoever holds the password (the seed, smoke_lab, the `e2e` service) derives the same
 * key, so the live walks read the feed as an application does without any file. src/test/labFeedKey.test.ts holds it to the
 * Python test's fixed vector.
 */
export function labFeedKey(
  password: string,
  organization: string,
  composition: string,
  environment: string
): string {
  const digest = createHmac('sha256', password)
    .update(`openbinding-lab-seed:feedkey:${organization}/${composition}/${environment}`)
    .digest('hex');
  return `obe_${digest.slice(0, 8)}_${digest.slice(8)}`;
}

/**
 * Mailpit's web root inside the lab's compose network (the `e2e` service reaches it by name; it publishes no port), or
 * `LAB_MAILPIT_URL`: the Identity walk, on the host's network, reads it through the lab's read-only `/mailpit/` location.
 */
export const MAILPIT = process.env.LAB_MAILPIT_URL ?? 'http://mailpit:8025/mailpit';

/**
 * The lab's feed consumer, TomatoMeter's stand-in, inside the compose network: `GET /state`, `POST /send`; or
 * `LAB_FEED_CONSUMER_URL`, where compose.lab-identity.json publishes it on the loopback for the Identity walk.
 */
export const FEED_CONSUMER = process.env.LAB_FEED_CONSUMER_URL ?? 'http://feed-consumer:8090';
