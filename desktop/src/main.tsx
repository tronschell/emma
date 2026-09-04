import "./boot";
import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installBenchHook } from "./bench";

installBenchHook();

export class RootBoundary extends Component<{ children: ReactNode }, { failed: string }> {
  state = { failed: "" };
  static getDerivedStateFromError(error: unknown): { failed: string } {
    const said = error instanceof Error ? error.stack || error.message : String(error);
    return { failed: said.trim() || "The window stopped drawing and said nothing about why." };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="root-failure" role="alert">
      <h1>Emma stopped drawing this window</h1>
      <p>Every thread, note and artifact is on disk and untouched. Reloading brings the window back.</p>
      <button type="button" onClick={() => window.location.reload()}>Reload the window</button>
      <pre>{this.state.failed}</pre>
    </div>;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </StrictMode>,
);
