import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifierEntity } from '../../api/platform';
import { VerifyResult } from './VerifyResult';
import { VERDICTS } from './verifyModel';

const D1 = `sha256-${'a1'.repeat(32)}`;
const D2 = `sha256-${'b2'.repeat(32)}`;
const ID = '3f2b8c1e-0000-4000-8000-123456789abc';
const entity = (extra: Partial<VerifierEntity> = {}): VerifierEntity => ({ entity_type: 'study_run', id: ID, title_or_name: 'Travel run', ...extra });

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

describe('VerifyResult', () => {
  // [utest->req~verify-result~1]
  it.each(['verified', 'computed', 'mismatch', 'not_found'] as const)('shows the %s verdict with its wording', (status) => {
    render(<VerifyResult verdict={{ status, digest: D1, detail: 'because' }} />);

    const region = screen.getByRole('region', { name: 'Verdict' });
    expect(within(region).getByText(VERDICTS[status].title)).toBeInTheDocument();
    expect(within(region).getByText(VERDICTS[status].text)).toBeInTheDocument();
    expect(within(region).getByText('because')).toBeInTheDocument();
  });

  // [utest->req~verify-result~1]
  it('shows the given and recorded sides of a verified fingerprint, one copy button each', async () => {
    render(<VerifyResult verdict={{ status: 'verified', digest: D1, entities: [entity()] }} given={D1} />);

    expect(screen.getByText('Fingerprint you gave')).toBeInTheDocument();
    expect(screen.getByText('Recorded by OpenBinding')).toBeInTheDocument();
    expect(screen.getAllByText(D1)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^Copy / })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Copy recorded by openbinding' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(D1));
  });

  // [utest->req~verify-result~1]
  it('shows the computed and expected sides of a mismatch', () => {
    render(<VerifyResult verdict={{ status: 'mismatch', digest: D2 }} computed={D1} />);

    expect(screen.getByText('Computed in your browser').nextElementSibling).toHaveTextContent(D1);
    expect(screen.getByText('Fingerprint you expected').nextElementSibling).toHaveTextContent(D2);
    expect(screen.queryByText('Your browser and the server disagree')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Copy / })).toHaveLength(2);
  });

  // [utest->req~verify-result~1]
  it('says nothing is recorded, without a copy button for it', () => {
    render(<VerifyResult verdict={{ status: 'computed', digest: D1 }} computed={D1} />);

    expect(screen.getByText('nothing recorded')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Copy / })).toHaveLength(1);
  });

  // [utest->req~verify-result~1]
  it('warns when the browser and the server disagree', () => {
    render(<VerifyResult verdict={{ status: 'computed', digest: D2 }} computed={D1} />);

    expect(screen.getByText('Your browser and the server disagree')).toBeInTheDocument();
  });

  // [utest->req~verify-result~1]
  it('does not warn when they agree or nothing was computed in the browser', () => {
    const { unmount } = render(<VerifyResult verdict={{ status: 'verified', digest: D1 }} computed={D1} />);
    expect(screen.queryByText('Your browser and the server disagree')).not.toBeInTheDocument();
    unmount();
    render(<VerifyResult verdict={{ status: 'verified', digest: D1 }} given={D1} />);
    expect(screen.queryByText('Your browser and the server disagree')).not.toBeInTheDocument();
  });

  // [utest->req~verify-result~1]
  it('names matches with a kind chip and never shows an entity identifier', () => {
    const { container } = render(
      <VerifyResult
        verdict={{ status: 'verified', digest: D1, entities: [entity(), entity({ title_or_name: null, slug: 'travel-slug', entity_type: 'case' }), entity({ title_or_name: ' ', slug: null, entity_type: 'engine' })] }}
      />,
    );

    expect(screen.getByText('Travel run')).toBeInTheDocument();
    expect(screen.getByText('study run')).toBeInTheDocument();
    expect(screen.getByText('travel-slug')).toBeInTheDocument();
    expect(screen.getByText('unnamed element')).toBeInTheDocument();
    expect(container.textContent).not.toContain(ID);
  });

  // [utest->req~verify-result~1]
  it('links matches through renderLink or hrefOf, and shows the name alone otherwise', () => {
    const entities = [entity()];
    const verdict = { status: 'verified', digest: D1, entities } as const;
    const { unmount } = render(<VerifyResult verdict={verdict} hrefOf={() => '/runs/travel'} />);
    expect(screen.getByRole('link', { name: 'Travel run' })).toHaveAttribute('href', '/runs/travel');
    unmount();

    const second = render(<VerifyResult verdict={verdict} hrefOf={() => '/ignored'} renderLink={(_e, label) => <a href="/routed">{label}</a>} />);
    expect(screen.getByRole('link', { name: 'Travel run' })).toHaveAttribute('href', '/routed');
    second.unmount();

    render(<VerifyResult verdict={verdict} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  // [utest->req~verify-result~1]
  it('renders the citation slot', () => {
    render(<VerifyResult verdict={{ status: 'verified', digest: D1 }} citation={<p>citation here</p>} />);

    expect(screen.getByText('citation here')).toBeInTheDocument();
  });

  // [utest->req~verify-result~1]
  it('has no hard-coded hex colour in its stylesheet', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/VerifyResult/VerifyResult.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
