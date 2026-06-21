import { defineConfig } from "vite";

export default defineConfig({
  root: "src/ui",
  publicDir: "public",
  build: {
    outDir: "../../dist-ui",
    emptyOutDir: true,
  },
});
