// 红果短剧 8.4 正式版：前端构建配置，运行版本由 package.json 提供。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), {
    name: 'development-csp',
    apply: 'serve',
    // React Refresh injects an inline preamble only in the development server.
    transformIndexHtml: html => html.replace("script-src 'self' blob: 'wasm-unsafe-eval';", "script-src 'self' blob: 'wasm-unsafe-eval' 'unsafe-inline';")
      .replace("connect-src 'self'", "connect-src 'self' ws: wss:"),
  }],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist-react',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/scheduler/')) {
            return 'vendor-react';
          }
          if (id.includes('/src/i18n/')) return 'i18n';
          return undefined;
        },
      },
    },
  },
});
