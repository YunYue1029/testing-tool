import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During dev the React app runs on 5173 and proxies /api to the Express server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 127.0.0.1, not localhost: the server binds IPv4 loopback by default and
      // "localhost" can resolve to ::1 first, which nothing is listening on.
      '/api': 'http://127.0.0.1:3000',
    },
  },
});
