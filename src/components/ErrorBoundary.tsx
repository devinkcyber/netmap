import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors anywhere below it so a single failure (a bad
 * note, an unexpected data shape) shows a recoverable message instead of a blank
 * page. Vault files and stored data are never touched by a render error.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('netmap: unhandled render error', error, info);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-app p-8 text-ink-1">
        <div className="max-w-md rounded-none border border-line bg-panel p-6 text-center shadow-2xl">
          <h1 className="font-display text-lg font-semibold">Something went wrong</h1>
          <p className="mt-2 text-xs text-ink-2">
            netmap hit an unexpected error and stopped rendering. Your vault files and stored scan data are untouched.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-none bg-well p-2 text-left font-mono text-[12px] text-danger">
            {error.message}
          </pre>
          <div className="mt-4 flex justify-center gap-2">
            <button className="btn-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button className="btn" onClick={() => this.setState({ error: null })}>
              Try to continue
            </button>
          </div>
        </div>
      </div>
    );
  }
}
