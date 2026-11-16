// Adapted from SPHERE frontend/src/modules/core/components/error-boundary/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's stale-chunk reload (utils/chunk-reload.ts) and a default fallback, a neutral page with a
// reload and a way home, so the boundary can wrap every route.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError, takeChunkReload } from '../../utils/chunk-reload';
import ScreenFailed from './screen-failed';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown in place of the subtree once it has thrown; a neutral page with a reload and a way home by default. */
  fallback?: (error: Error, reload: () => void) => ReactNode;
  /**
   * Value the boundary watches to know the input has changed: when it does,
   * the subtree is given another chance to render.
   */
  resetKey?: unknown;
  /** Reloads the page; replaceable because a test page cannot reload. */
  reload?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps a throwing subtree from taking the whole application down with it.
 *
 * React unmounts the entire tree when a render throws, which turns any bug in
 * one panel into a blank page, so the panels that render user-provided content
 * are wrapped in one of these. A stale lazy chunk (a deploy replaced it while the
 * tab was open) reloads the page by itself, once per session.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (isChunkLoadError(error) && takeChunkReload()) {
      this.reload();
      return;
    }
    console.error('Unhandled error in a rendered subtree', error, info.componentStack);
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps): void {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private reload = () => {
    (this.props.reload ?? (() => window.location.reload()))();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return this.props.fallback ? (
      this.props.fallback(error, this.reload)
    ) : (
      <ScreenFailed reload={this.reload} />
    );
  }
}
