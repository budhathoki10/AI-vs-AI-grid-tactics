import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/client",
  publicDir: false,
  // The video encoder is imported only when a reel is made; preparing it up front stops dev mode reloading the page then.
  optimizeDeps: { include: ["mediabunny"] },
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // three.js changes far less often than the app; a separate chunk stays cached across releases.
        codeSplitting: {
          groups: [
            { name: "three", test: /node_modules[\\/]three[\\/]/ },
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    root: ".",
    include: ["src/**/*.test.ts", "server/**/*.test.ts"],
    environment: "node",
  },
});
