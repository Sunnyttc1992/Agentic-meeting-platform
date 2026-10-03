import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createDevelopmentPlatform } from "./server/development.js";
import { createHttpHandler } from "./server/http.js";
import { isLoopbackRequest, isMeetingApiPath, rejectNonLoopback } from "./server/local-only.js";

function developmentApi() {
  return {
    name: "development-meeting-api",
    configureServer(server) {
      const handler = createHttpHandler(createDevelopmentPlatform());
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (isMeetingApiPath(pathname)) return isLoopbackRequest(request) ? handler(request, response) : rejectNonLoopback(response);
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
