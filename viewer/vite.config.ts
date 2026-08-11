import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  publicDir: `${here}public`,
  server: {
    port: 5180,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.API_PORT ?? 5181}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: `${here}../dist`,
    emptyOutDir: true,
    target: "es2022",
  },
});
