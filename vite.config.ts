import { defineConfig, type Plugin } from "vite";
import { createApiMiddleware } from "./src/server";

function apiPlugin(): Plugin {
  return {
    name: "decodoku-api",
    configureServer(server) {
      server.middlewares.use(createApiMiddleware());
    }
  };
}

export default defineConfig({
  plugins: [apiPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});
