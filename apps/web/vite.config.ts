import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    strictPort: true,
    // Cookie/Origin归属后端；开发代理将Origin改成固定后端origin，不放宽服务端CSRF。
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4318",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (outgoing, incoming) => {
            if (incoming.headers.origin === "http://127.0.0.1:5173")
              outgoing.setHeader("Origin", "http://127.0.0.1:4318");
          });
        },
      },
    },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
