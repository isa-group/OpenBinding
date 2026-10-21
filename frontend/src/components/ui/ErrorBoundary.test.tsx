import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_RELOAD_KEY, isChunkLoadError } from './chunkReload';
import { ErrorBoundary } from './ErrorBoundary';

function Broken({ message = 'render failed' }: { message?: string }): never {
  throw new Error(message);
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows its children while nothing fails', () => {
    render(<ErrorBoundary><p>All good</p></ErrorBoundary>);
    expect(screen.getByText('All good')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('replaces a screen that throws while rendering with a neutral message, a reload and a way home', () => {
    const reload = vi.fn();
    render(<ErrorBoundary reload={reload}><Broken /></ErrorBoundary>);

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute('href', '/');
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('recovers when the key changes, so leaving a broken screen works', () => {
    const { rerender } = render(<ErrorBoundary resetKey="/a"><Broken /></ErrorBoundary>);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    rerender(<ErrorBoundary resetKey="/b"><p>Another screen</p></ErrorBoundary>);
    expect(screen.getByText('Another screen')).toBeInTheDocument();
  });

  it('recognises the errors of a lazy chunk that no longer exists', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/Home-abc.js'))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error('Loading chunk 7 failed.'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('reloads once per session for a chunk error, then shows the message', () => {
    const reload = vi.fn();
    const chunkError = 'Failed to fetch dynamically imported module: https://x/assets/Home-abc.js';

    const first = render(<ErrorBoundary reload={reload}><Broken message={chunkError} /></ErrorBoundary>);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBe('1');
    first.unmount();

    render(<ErrorBoundary reload={reload}><Broken message={chunkError} /></ErrorBoundary>);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('does not reload for a chunk error when the session storage is blocked', () => {
    const reload = vi.fn();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<ErrorBoundary reload={reload}><Broken message="Failed to fetch dynamically imported module: x" /></ErrorBoundary>);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });
});
