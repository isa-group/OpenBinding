import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platformApi, type VerifierVerdict } from '../../api/platform';
import { DigestBadge } from './DigestBadge';

vi.mock('../../api/platform', () => ({ platformApi: { verifierCheck: vi.fn() } }));

const DIGEST = `sha256-${'ab12'.repeat(16)}`;

const verdict = (overrides: Partial<VerifierVerdict> = {}): VerifierVerdict => ({
  status: 'verified', digest: DIGEST, matches: true, verified_at: '2026-10-09T10:00:00Z', ...overrides,
});

async function open() {
  render(<DigestBadge digest={DIGEST} kind="case" />);
  fireEvent.click(screen.getByRole('button', { name: /sha256-/ }));
  return screen.findByRole('dialog');
}

describe('DigestBadge', () => {
  beforeEach(() => {
    vi.mocked(platformApi.verifierCheck).mockReset();
  });

  it('asks the verifier with the fields of its contract, not with target_kind / target_digest', async () => {
    vi.mocked(platformApi.verifierCheck).mockResolvedValue(verdict({
      entities: [{ entity_type: 'case', id: 'case-1', title_or_name: 'Checkout flow' }],
    }));
    const dialog = await open();

    expect(await screen.findByText('Authoritative Integrity Verified')).toBeInTheDocument();
    expect(platformApi.verifierCheck).toHaveBeenCalledWith({ digest: DIGEST, kind: 'case', document: undefined });
    expect(dialog).toHaveTextContent('Checkout flow');
  });

  it.each([
    ['computed', 'Computed, not on record'],
    ['mismatch', 'Digest does not match'],
    ['not_found', 'Nothing found'],
  ] as const)('says %s as it is, never as verified', async (status, title) => {
    vi.mocked(platformApi.verifierCheck).mockResolvedValue(verdict({ status, matches: false }));
    await open();

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByText('Authoritative Integrity Verified')).toBeNull();
  });

  it('says it could not verify when the check fails, and claims nothing', async () => {
    vi.mocked(platformApi.verifierCheck).mockRejectedValue(new Error('offline'));
    await open();

    expect(await screen.findByText('Could not verify')).toBeInTheDocument();
    expect(screen.getByText(/nothing was checked/)).toBeInTheDocument();
    expect(screen.queryByText(/Verified/i)).toBeNull();
  });
});
