// Keeps one broken view from blanking the whole window.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Changing this (for example the route) clears a caught error. */
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  resetKey: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      JSON.stringify({ event: "view_crashed", message: error.message, stack: info.componentStack }),
    );
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="page" role="alert">
        <h1>This view stopped working</h1>
        <p>{this.state.error.message}</p>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-12)" }}>
          <button type="button" className="k-btn" onClick={this.retry}>
            Try again
          </button>
          <a href="#/library">Go to the library</a>
        </div>
      </section>
    );
  }
}
