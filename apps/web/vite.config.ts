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
  // Версия веб-бандла для диага: без неё сессии браузерных зрителей нельзя привязать к
  // деплою (сервер пишет appVersion, а клиент раньше слал пустую строку). Нативный
  // клиент берёт свою версию из Rust (hwinfo.rs, CARGO_PKG_VERSION).
  const webVersion = env.VITE_BUILD || process.env.npm_package_version || 'dev';
  return {
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(webVersion) },
    build: {
      outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500,
      // AudioWorklet-модуль (vad-worklet) ОБЯЗАН быть отдельным same-origin файлом: CSP в Caddyfile
      // разрешает script-src/worker-src только 'self' (+blob), но НЕ data:. Маленький воркет Vite по
      // умолчанию инлайнит как data:-URL — тогда addModule() падает на CSP и VAD молча отваливается
      // в фоновый баг (микрофон гейтится в тишину на неактивной вкладке). Форсим отдельный файл.
      assetsInlineLimit: (filePath: string) => (filePath.endsWith('vad-worklet.js') ? false : undefined),
      // Вторая точка входа — окно кастомного нативного уведомления (лёгкая страница, без React-бандла).
      rollupOptions: { input: { main: 'index.html', notif: 'notif.html' } },
    },
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
