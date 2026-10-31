// 红果短剧 5.2：前端构建配置，运行版本由 package.json 提供。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), {
    name: 'development-csp',
    apply: 'serve',
    // React Refresh injects an inline preamble only in the development server.
    transformIndexHtml: html => html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
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
  },
});
