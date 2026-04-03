import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        Buffer: true,
        process: true,
      },
    }),
  ],
  resolve: {
    dedupe: ["react", "react-dom", "wagmi", "@tanstack/react-query", "viem"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      },
      "/agent": {
        target: "http://127.0.0.1:8790",
        changeOrigin: true
      }
    },
    fs: {
      allow: ["../.."]
    }
  }
});
