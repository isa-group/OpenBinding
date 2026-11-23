import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../core/api/http';
import type { CompositionView } from '../../../core/api/types';
import { useCardComposition } from './hooks';

const api = vi.hoisted(() => ({ get: vi.fn(), allVersions: vi.fn() }));
vi.mock('../../../core/utils/composition/api', () => ({ compositionsApi: api, languageApi: {} }));

const composition = { id: 'c-1', slug: 'tomatometer', name: 'TomatoMeter' } as CompositionView;

describe('the composition card page’s state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ value: composition, etag: 'W/"3"' });
    api.allVersions.mockResolvedValue([]);
  });

  it('keeps the composition on show when a quiet re-read fails', async () => {
    const { result } = renderHook(() => useCardComposition('isa-demo', 'tomatometer'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    api.get.mockRejectedValue(new HttpError(503, 'Service Unavailable'));
    act(() => result.current.refresh());
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(result.current.state.status).toBe('ready');
  });

  it('says a failure of a re-read someone asked for', async () => {
    const { result } = renderHook(() => useCardComposition('isa-demo', 'tomatometer'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    api.get.mockRejectedValue(new HttpError(503, 'Service Unavailable'));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state.status).toBe('error'));
  });

  it('says a missing composition even on a quiet re-read', async () => {
    const { result } = renderHook(() => useCardComposition('isa-demo', 'tomatometer'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    api.get.mockRejectedValue(new HttpError(404, 'Not Found'));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.state.status).toBe('missing'));
  });
});
