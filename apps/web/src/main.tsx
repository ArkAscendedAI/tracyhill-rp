import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./app/App";
import { AppProviders } from "./app/AppProviders";
import { ErrorBoundary } from "./shared/ui/ErrorBoundary";
import "./styles/base.css";
import "./styles/tokens.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AppProviders>
        <App />
      </AppProviders>
    </ErrorBoundary>
  </React.StrictMode>,
);
