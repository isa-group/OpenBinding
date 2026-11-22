import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import ResourceListView from '.';

type Item = { id: string; name: string };

function draw(
  fetchItems: (
    params: Record<string, string>,
    signal: AbortSignal
  ) => Promise<{ items: Item[]; total: number }>,
  keys: { refreshKey?: number; quietKey?: number } = {}
) {
  const view = (next: { refreshKey?: number; quietKey?: number }) => (
    <MemoryRouter>
      <ResourceListView<Item>
        fetchItems={fetchItems}
        renderItem={item => <span>{item.name}</span>}
        itemKey={item => item.id}
        title="Compositions"
        subtitle="Yours"
        noun={['composition', 'compositions']}
        ownerFilter={false}
        {...next}
      />
    </MemoryRouter>
  );
  const drawn = render(view(keys));
  return {
    ...drawn,
    again: (next: { refreshKey?: number; quietKey?: number }) => drawn.rerender(view(next)),
  };
}

describe('reading a list again', () => {
  it('reads it again in place on a quiet key: the items stay, nothing says loading, a failure keeps them', async () => {
    let answer: Promise<{ items: Item[]; total: number }> = Promise.resolve({
      items: [{ id: '1', name: 'TomatoMeter' }],
      total: 1,
    });
    const fetchItems = vi.fn(() => answer);
    const { again } = draw(fetchItems);
    expect(await screen.findByText('TomatoMeter')).toBeInTheDocument();
    expect(screen.getByText('1 composition found')).toBeInTheDocument();

    let settle: (value: { items: Item[]; total: number }) => void = () => {};
    answer = new Promise(resolve => {
      settle = resolve;
    });
    again({ quietKey: 1 });
    await waitFor(() => expect(fetchItems).toHaveBeenCalledTimes(2));
    expect(screen.getByText('TomatoMeter')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).toBeNull();
    settle({ items: [{ id: '1', name: 'TomatoMeter (1 upstream change)' }], total: 1 });
    expect(await screen.findByText('TomatoMeter (1 upstream change)')).toBeInTheDocument();

    answer = Promise.reject(new Error('offline'));
    again({ quietKey: 2 });
    await waitFor(() => expect(fetchItems).toHaveBeenCalledTimes(3));
    expect(screen.getByText('TomatoMeter (1 upstream change)')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the loading state again on a refresh key', async () => {
    const fetchItems = vi.fn((): Promise<{ items: Item[]; total: number }> =>
      Promise.resolve({ items: [{ id: '1', name: 'TomatoMeter' }], total: 1 })
    );
    const { again } = draw(fetchItems);
    expect(await screen.findByText('TomatoMeter')).toBeInTheDocument();
    fetchItems.mockImplementation(() => new Promise(() => {}));
    again({ refreshKey: 1 });
    expect(await screen.findByText('Loading...')).toBeInTheDocument();
  });
});
