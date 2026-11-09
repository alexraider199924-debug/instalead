import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false
  },
  server: {
    // host: true binds the dev server to 0.0.0.0 instead of localhost, so it's
    // reachable from another device — over a Tailscale/VPN link or the LAN —
    // not just the machine it runs on. This is what lets you open the panel
    // from a laptop far away while the bot keeps running on the home PC.
    host: true,
    port: 5173,
    strictPort: true,
    // Local development only. Production is served as static files by Nginx.
    allowedHosts: true,
    // The browser only ever talks to this dev server; it proxies /api to the
    // backend locally on the same machine, so the backend never needs to be
    // exposed to the network itself.
    proxy: {
      '/api': 'http://localhost:3002'
    }
  }
});
