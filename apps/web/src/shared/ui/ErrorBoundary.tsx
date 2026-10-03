import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { hasError: boolean; error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 24, background: "#0d1117", color: "#c9d1d9" }}>
          <h1 style={{ color: "#f85149", marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: "#8b949e", marginBottom: 16, maxWidth: 480, textAlign: "center" }}>
            An unexpected error occurred. Try reloading the page.
          </p>
          <pre style={{ fontSize: 12, color: "#8b949e", maxWidth: 600, overflow: "auto", whiteSpace: "pre-wrap", marginBottom: 16 }}>
            {this.state.error?.message}
          </pre>
          <button onClick={() => window.location.reload()} style={{ background: "#21262d", color: "#c9d1d9", border: "1px solid #30363d", padding: "8px 16px", borderRadius: 6, cursor: "pointer" }}>
            Reload Page
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
