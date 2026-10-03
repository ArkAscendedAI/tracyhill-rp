import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // React + react-query in their own chunk: they change
        // only on a dependency bump, so browsers keep them cached across deploys.
        manualChunks: { vendor: ["react", "react-dom", "@tanstack/react-query"] },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 3010,
    proxy: {
      // Dev/e2e only (prod serves the SPA from the API itself). The string
      // shorthand implies changeOrigin: true, which rewrote Host to :4010 while
      // the browser's Origin stayed :3010 — the API's CSRF Origin/Host check then
      // answered every login "cross-origin request blocked", which is why the
      // rewritten Playwright suite had never been seen green: preserve
      // the browser's Host so the same-origin check holds through the proxy.
      "/api": { target: "http://127.0.0.1:4010", changeOrigin: false },
    },
  },
});
