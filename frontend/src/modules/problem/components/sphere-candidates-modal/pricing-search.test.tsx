import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../core/api/http';
import type { SphereApi, SpherePricingSearch } from '../../api/sphereApi';
import mailgun from '../../../../test/fixtures/sphere/search.mailgun.json';
import PricingSearch from './pricing-search';

const page = mailgun as SpherePricingSearch;
const empty: SpherePricingSearch = { ...page, pricings: [], total: 0 };

function renderSearch(searchPricings: SphereApi['searchPricings']) {
  const onChoose = vi.fn();
  const api = { searchPricings } as unknown as SphereApi;
  render(<PricingSearch org="isa-demo" api={api} chosen={null} onChoose={onChoose} />);
  return { onChoose };
}

afterEach(() => vi.useRealTimers());

describe('PricingSearch', () => {
  it('lists SPHERE’s pricings by name, owner, latest version and collection, never by id', async () => {
    const searchPricings = vi.fn().mockResolvedValue(page);
    renderSearch(searchPricings);
    const list = screen.getByRole('listbox', { name: 'SPHERE pricings' });
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(3));
    expect(searchPricings).toHaveBeenCalledWith(
      'isa-demo',
      expect.objectContaining({ sort: 'name', limit: 24 }),
      expect.any(AbortSignal)
    );
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent(
      /Mailgun.*danvelcam PERSONAL · latest 2026-10-31 · .* · Email APIs Pricing Intelligence/
    );
    expect(list.textContent).not.toMatch(/[0-9a-f]{24}/);
  });

  it('asks once, 300 ms after the last key, and never sends an upper price bound', async () => {
    const searchPricings = vi.fn().mockResolvedValue(page);
    renderSearch(searchPricings);
    await waitFor(() => expect(searchPricings).toHaveBeenCalledTimes(1));
    const box = screen.getByRole('combobox', { name: 'Search SPHERE pricings by name' });
    fireEvent.change(box, { target: { value: 'mail' } });
    fireEvent.change(box, { target: { value: 'mailgun' } });
    await waitFor(() =>
      expect(searchPricings).toHaveBeenLastCalledWith(
        'isa-demo',
        expect.objectContaining({ q: 'mailgun' }),
        expect.any(AbortSignal)
      )
    );
    expect(searchPricings).toHaveBeenCalledTimes(2);
    for (const [, params] of searchPricings.mock.calls)
      expect(params).not.toHaveProperty('maxPrice');
  });

  it('moves through the rows with the arrow keys and chooses one with Enter', async () => {
    const { onChoose } = renderSearch(vi.fn().mockResolvedValue(page));
    const box = screen.getByRole('combobox', { name: 'Search SPHERE pricings by name' });
    const options = () => within(screen.getByRole('listbox')).getAllByRole('option');
    await waitFor(() => expect(options()).toHaveLength(3));
    await new Promise(resolve => setTimeout(resolve, 400));
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(options()[2]).toHaveAttribute('aria-selected', 'true');
    expect(box.getAttribute('aria-activedescendant')).toBe(options()[2].id);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChoose).toHaveBeenCalledWith({ row: page.pricings[2], registry: null });
  });

  it('says when nothing matches', async () => {
    renderSearch(vi.fn().mockResolvedValue(empty));
    expect(await screen.findByText('No SPHERE pricing matches these filters.')).toBeInTheDocument();
  });

  it('waits for SPHERE’s Retry-After when it is busy, then asks once more', async () => {
    const busy = Object.assign(new HttpError(429, 'HTTP 429: SPHERE is busy.'), {
      code: 'sphere_busy',
      retryAfter: 1,
    });
    const searchPricings = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue(page);
    renderSearch(searchPricings);
    expect(await screen.findByText('SPHERE is busy; trying again in 1 s.')).toBeInTheDocument();
    await waitFor(() => expect(searchPricings).toHaveBeenCalledTimes(2), { timeout: 2500 });
    await waitFor(() =>
      expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(3)
    );
  });

  it('offers the operator’s registries and the minimum price on SPHERE’s scale', async () => {
    const searchPricings = vi
      .fn()
      .mockResolvedValue({ ...page, registries: ['score-mirror'] } as SpherePricingSearch);
    renderSearch(searchPricings);
    const registry = await screen.findByRole('combobox', { name: 'Registry' });
    fireEvent.change(registry, { target: { value: 'score-mirror' } });
    await waitFor(() =>
      expect(searchPricings).toHaveBeenLastCalledWith(
        'isa-demo',
        expect.objectContaining({ registry: 'score-mirror' }),
        expect.any(AbortSignal)
      )
    );
    expect(screen.getByRole('combobox', { name: 'Minimum price at least' })).toHaveValue('');
  });
});
