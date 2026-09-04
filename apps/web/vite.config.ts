import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// Ассеты RNNoise обязаны лежать под СТАБИЛЬНЫМИ именами — по той же причине, что и vad-worklet.js
// (см. комментарий в build ниже): они догружаются лениво, при первом включении микрофона, то есть
// возможно через сутки после загрузки страницы. Импорт через `?url` давал имя с хешем, и деплой
// превращал его в 404: addModule/loadRnnoise реджектили, шумодав молча отключался до перезагрузки.
// Копируем из node_modules сами, а не кладём копию третьей стороны в public/ — иначе она разъедется
// с версией пакета при первом же обновлении.
const RNNOISE_ASSETS: Record<string, string> = {
  'rnnoise-worklet.js': '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js',
  'rnnoise.wasm': '@sapphi-red/web-noise-suppressor/rnnoise.wasm',
  'rnnoise_simd.wasm': '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm',
};

function rnnoiseStableAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const read = (spec: string) => readFileSync(require.resolve(spec));
  return {
    name: 'rnnoise-stable-assets',
    // dev-сервер отдаёт те же пути, что и прод — иначе шумодав в dev тихо не поднимался бы
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = (req.url || '').split('?')[0].replace(/^\//, '');
        const spec = RNNOISE_ASSETS[name];
        if (!spec) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(read(spec));
      });
    },
    generateBundle() {
      for (const [fileName, spec] of Object.entries(RNNOISE_ASSETS)) {
        this.emitFile({ type: 'asset', fileName, source: read(spec) });
      }
    },
  };
}

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
    plugins: [react(), rnnoiseStableAssets()],
    define: { __APP_VERSION__: JSON.stringify(webVersion) },
    build: {
      outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500,
      // AudioWorklet-модуль VAD переехал в public/vad-worklet.js: помимо CSP (data:-URL для script-src
      // запрещён) имя файла обязано ПЕРЕЖИВАТЬ деплой — хешированный ассет давал 404 на addModule во
      // вкладке, открытой до выкатки, и гейт активации голосом молча откатывался на rAF.
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
