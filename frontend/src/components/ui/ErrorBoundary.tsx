import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError, takeChunkReload } from './chunkReload';
import { ErrorState } from './ErrorState';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** The boundary recovers when this changes (the path, so that navigating away from a broken screen works). */
  resetKey?: string;
  /** Reloads the page; replaceable because a test page cannot reload. */
  reload?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps one broken screen from blanking the whole application: it says so, offers a reload and a way home.
 * A stale lazy chunk reloads the page by itself, once per session, because a fresh load fetches the new files.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (isChunkLoadError(error) && takeChunkReload()) {
      this.reload();
      return;
    }
    console.error('A screen failed to render', error, info.componentStack);
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private reload = () => {
    (this.props.reload ?? (() => window.location.reload()))();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ErrorState
        layout="page"
        status="Error"
        title="Something went wrong"
        actions={(
          <>
            <button type="button" className="ui-state-action is-primary" onClick={this.reload}>Reload</button>
            <a className="ui-state-action is-link" href="/">Go to the home page</a>
          </>
        )}
      >
        This screen couldn’t be shown. Reload the page; if it happens again, go back to the home page.
      </ErrorState>
    );
  }
}
