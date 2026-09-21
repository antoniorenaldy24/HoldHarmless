import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * SSOT §14 gives the dashboard port 3000. The core's REST + WebSocket API is
 * proxied from here so the browser talks to one origin and no CORS layer has to
 * exist. §11: the dashboard reads the event log and holds no state — every path
 * below is a read, except the two writes §11 explicitly permits.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
      '/events': { target: 'ws://127.0.0.1:3001', ws: true },
    },
  },
});
