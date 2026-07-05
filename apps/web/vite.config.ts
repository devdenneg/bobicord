import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// прод-бэкенд для локальной разработки (npm run dev)
const API_TARGET = process.env.VITE_API_TARGET || 'https://138-16-170-21.sslip.io';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
  server: {
    proxy: {
      // /api, /twirp, /rtc идут на прод (голос/LiveKit — напрямую по wss из токена)
      '/api': { target: API_TARGET, changeOrigin: true, secure: true },
      '/twirp': { target: API_TARGET, changeOrigin: true, secure: true },
    },
  },
});
