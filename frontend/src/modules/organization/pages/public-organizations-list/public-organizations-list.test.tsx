import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderModule } from '../../../../test/moduleKit';
import PublicOrganizationsPage from '.';

const item = (slug: string, name: string) => ({
  id: `org-${slug}`,
  slug,
  name,
  description: '',
  avatar: { url: null, kind: null, bg_color: null, fg_color: null },
  public_compositions: 1,
});

afterEach(() => vi.unstubAllGlobals());

describe('/organizations', () => {
  it('lists the public root organizations with a count, and searches them', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const q = new URL(url, 'http://x').searchParams.get('q');
      const items = q
        ? [item('isa-demo', 'ISA Demo Group')]
        : [item('isa-demo', 'ISA Demo Group'), item('lab-other', 'Lab Other')];
      return new Response(JSON.stringify({ items, total: items.length }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderModule(<PublicOrganizationsPage />, { user: null, entry: '/organizations' });
    expect(await screen.findByText('2 organizations')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Lab Other/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search organizations' }), {
      target: { value: 'isa' },
    });
    expect(await screen.findByText('1 organization')).toBeInTheDocument();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('q=isa');
  });

  it('says so when the list fails, and tries again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [item('isa-demo', 'ISA Demo Group')], total: 1 }))
      );
    vi.stubGlobal('fetch', fetchMock);
    renderModule(<PublicOrganizationsPage />, { user: null });
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('1 organization')).toBeInTheDocument();
  });
});
