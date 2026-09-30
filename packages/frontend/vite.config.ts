import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 4100,
    cors: true,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "connect-src 'self' ws: wss: http://127.0.0.1:*",
        "img-src 'self' data: blob:",
        "font-src 'self' data: https://fonts.gstatic.com",
        "frame-src 'self' https://www.openstreetmap.org",
        "object-src 'none'",
        "base-uri 'self'",
      ].join("; "),
    },
    proxy: {
      "/api/langgraph": {
        target: "http://127.0.0.1:2024",
        changeOrigin: true,
        rewrite: (path) => path.replace(new RegExp("^/api/langgraph"), ""),
      },
      "/threads": {
        target: "http://127.0.0.1:2024",
        changeOrigin: true,
      },
    },
  },
});
