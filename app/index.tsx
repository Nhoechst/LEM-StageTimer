import { Component, StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { DatabaseProvider } from "./lib/database";

class StartupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main role="alert" className="mx-auto max-w-lg p-8">
          <h1>LEM-Time could not start</h1>
          <p>Your saved data has not been cleared. Reload the page to try again.</p>
          <button className="mt-4 rounded bg-blue-700 px-4 py-2 text-white" onClick={() => window.location.reload()}>
            Reload
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById("root");
if (!container) throw new Error("LEM-Time root element is missing");
const root = createRoot(container);
root.render(
  <StrictMode>
    <StartupBoundary>
      <DatabaseProvider><App /></DatabaseProvider>
    </StartupBoundary>
  </StrictMode>
);