import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// USE_PROD_BACKEND=true в apps/web/.env.local → dev-фронт ходит на прод-бэк (локальный бэк не нужен)
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const useProd = env.USE_PROD_BACKEND === 'true';
  const target = useProd
    ? (env.PROD_API_URL || 'https://138-16-170-21.sslip.io')
    : 'http://localhost:3000';
  if (command === 'serve') {
    console.log(`[dev] API proxy → ${target}  ${useProd ? '(ПРОД)' : '(локальный бэк)'}`);
  }
  return {
    plugins: [react()],
    build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
    server: {
      host: '127.0.0.1', // IPv4-loopback явно (иначе Node на Windows биндит только IPv6 [::1] → refused)
      proxy: {
        // /api, /twirp на бэк; голос/LiveKit — напрямую по wss из токена
        '/api': { target, changeOrigin: true, secure: true },
        '/twirp': { target, changeOrigin: true, secure: true },
      },
    },
  };
});
