import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../../auth/hooks/useAuth';
import type { Notification } from '../api/notificationsApi';
import { NotificationsProvider } from '../contexts/notificationsProvider';
import upstream from '../../../test/fixtures/core/upstream.notifications.json';
import { useNotificationsContext } from './useNotificationsContext';
import { UPSTREAM_REFRESH_WINDOW_MS, useUpstreamRefresh } from './useUpstreamRefresh';

const [told] = upstream as unknown as Notification[];
type Context = ReturnType<typeof useNotificationsContext>;
const held: { context?: Context } = {};
const publish = (notification: Notification) => held.context?.publish(notification);
const subscribe: Context['subscribe'] = (kind, listener) =>
  held.context?.subscribe(kind, listener) ?? (() => {});

function Page({
  org,
  composition,
  onContext,
}: {
  org?: string;
  composition?: string;
  onContext: (context: Context) => void;
}) {
  const context = useNotificationsContext();
  useEffect(() => onContext(context), [context, onContext]);
  const count = useUpstreamRefresh(org, composition);
  return <output data-testid="count">{count}</output>;
}

const draw = (org?: string, composition?: string) =>
  render(
    <AuthContext.Provider
      value={{ user: null, fetchWithInterceptor: vi.fn() } as unknown as AuthContextValue}
    >
      <NotificationsProvider>
        <Page
          org={org}
          composition={composition}
          onContext={context => {
            held.context = context;
          }}
        />
      </NotificationsProvider>
    </AuthContext.Provider>
  );

const count = () => screen.getByTestId('count').textContent;

describe('reacting to live notifications', () => {
  it('hands a notification to the listeners of its kind until they stop listening', () => {
    draw();
    const heard = vi.fn();
    const other = vi.fn();
    const stop = subscribe('UpstreamEvent', heard);
    subscribe('CompositionAdopted', other);
    act(() => publish(told));
    expect(heard).toHaveBeenCalledWith(told);
    expect(other).not.toHaveBeenCalled();
    stop();
    act(() => publish(told));
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('counts an upstream event about the composition shown, and none about another', () => {
    draw('fixtures', 'tomatometer');
    expect(count()).toBe('0');
    act(() => publish(told));
    expect(count()).toBe('1');
    act(() =>
      publish({ ...told, payload: { ...told.payload, composition: 'order-desk' } } as Notification)
    );
    act(() =>
      publish({ ...told, payload: { ...told.payload, organization: 'lab-other' } } as Notification)
    );
    act(() => publish({ ...told, kind: 'CompositionAdopted' } as Notification));
    expect(count()).toBe('1');
  });

  it('counts every upstream event when it names no composition, a burst once more after the window', () => {
    vi.useFakeTimers();
    try {
      draw();
      act(() => publish(told));
      expect(count()).toBe('1');
      for (const composition of ['order-desk', 'shop', 'blog'])
        act(() => publish({ ...told, payload: { ...told.payload, composition } } as Notification));
      expect(count()).toBe('1');
      act(() => vi.advanceTimersByTime(UPSTREAM_REFRESH_WINDOW_MS));
      expect(count()).toBe('2');
      act(() => vi.advanceTimersByTime(UPSTREAM_REFRESH_WINDOW_MS));
      expect(count()).toBe('2');
      act(() => publish(told));
      expect(count()).toBe('3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays at zero outside the notifications provider', () => {
    function Bare() {
      return <output data-testid="bare">{useUpstreamRefresh('fixtures')}</output>;
    }
    render(<Bare />);
    expect(screen.getByTestId('bare')).toHaveTextContent('0');
  });
});
