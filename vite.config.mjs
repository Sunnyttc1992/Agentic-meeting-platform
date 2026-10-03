import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createDevelopmentPlatform } from "./server/development.js";
import { openLocalDurableStorage } from "./server/adapters/sqlite.js";
import { createHttpHandler } from "./server/http.js";
import { isLoopbackRequest, isMeetingApiPath, rejectNonLoopback } from "./server/local-only.js";

function developmentApi() {
  return {
    name: "development-meeting-api",
    configureServer(server) {
      // Opened on the first API request, so tooling and tests that start Vite
      // without calling the API never create or lock a database. A separate
      // data folder from `npm run preview` keeps the two servers from
      // recovering (failing) each other's in-flight jobs at startup.
      let handler = null;
      const api = () => (handler ??= createDevelopmentPlatform({
        storage: openLocalDurableStorage({ directory: process.env.MEETING_DATA_DIR ?? ".data/vite-dev" }).storage,
      }).then((platform) => createHttpHandler(platform)));
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (isMeetingApiPath(pathname)) return isLoopbackRequest(request) ? api().then((handle) => handle(request, response)) : rejectNonLoopback(response);
        next();
      });
    },
  };
}

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [developmentApi(), react()],
});
