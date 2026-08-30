import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Lazy AudioWorklet/WASM files are content-addressed and precached with their owning build. An old
// tab therefore asks its active worker for the old hash, while a new index loaded under that same
// worker asks the network for a different hash. Stable filenames would mix protocols across a
// staged Service Worker update; hashes also prevent a deploy from 404ing a still-open old client.
function versionedAudioAssets(): {
  plugin: Plugin;
  urls: { rnnoiseWorklet: string; rnnoiseWasm: string; rnnoiseSimdWasm: string; vadWorklet: string };
} {
  const require = createRequire(import.meta.url);
  const read = (spec: string) => readFileSync(require.resolve(spec));
  const sourceAssets = [
    { key: 'rnnoiseWorklet', base: 'rnnoise-worklet', ext: '.js', legacyFileName: 'rnnoise-worklet.js', source: read('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js'), mime: 'text/javascript' },
    { key: 'rnnoiseWasm', base: 'rnnoise', ext: '.wasm', legacyFileName: 'rnnoise.wasm', source: read('@sapphi-red/web-noise-suppressor/rnnoise.wasm'), mime: 'application/wasm' },
    { key: 'rnnoiseSimdWasm', base: 'rnnoise_simd', ext: '.wasm', legacyFileName: 'rnnoise_simd.wasm', source: read('@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm'), mime: 'application/wasm' },
    { key: 'vadWorklet', base: 'vad-worklet', ext: '.js', source: readFileSync(resolve(process.cwd(), 'public', 'vad-worklet.js')), mime: 'text/javascript' },
  ].map((asset) => ({
    ...asset,
    fileName: `${asset.base}.${createHash('sha256').update(asset.source).digest('hex').slice(0, 16)}${asset.ext}`,
  }));
  const byFileName = new Map(sourceAssets.flatMap((asset) => [
    [asset.fileName, asset] as const,
    ...('legacyFileName' in asset ? [[asset.legacyFileName, asset] as const] : []),
  ]));
  const urls = Object.fromEntries(sourceAssets.map((asset) => [asset.key, '/' + asset.fileName])) as {
    rnnoiseWorklet: string; rnnoiseWasm: string; rnnoiseSimdWasm: string; vadWorklet: string;
  };
  const plugin: Plugin = {
    name: 'versioned-audio-assets',
    // dev-сервер отдаёт те же пути, что и прод — иначе шумодав в dev тихо не поднимался бы
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = (req.url || '').split('?')[0].replace(/^\//, '');
        const asset = byFileName.get(name);
        if (!asset) return next();
        res.setHeader('Content-Type', asset.mime);
        res.end(asset.source);
      });
    },
    generateBundle() {
      for (const asset of sourceAssets) {
        this.emitFile({ type: 'asset', fileName: asset.fileName, source: asset.source });
        // Migration bridge for host bundles loaded before content-addressed URLs shipped. Those
        // tabs can request the stable path for the first time after this deploy; keep byte-identical
        // aliases while all new bundles exclusively reference the hashed names above.
        if ('legacyFileName' in asset) {
          this.emitFile({ type: 'asset', fileName: asset.legacyFileName, source: asset.source });
        }
      }
    },
  };
  return { plugin, urls };
}

// sw.js остаётся стабильной точкой регистрации, но в его собранную копию встраивается
// версия и точный список файлов текущего web-бандла. Так даже старый Safari видит
// байтово новый worker и не может незаметно смешать новый shell со старым.
// В precache попадают только файлы текущей сборки и публичные PWA-иконки: API,
// auth-ответы, uploads и любые runtime-запросы здесь принципиально отсутствуют.
function offlineShellManifest(webVersion: string): Plugin {
  const publicShellFiles = [
    'manifest.json', 'icon.png', 'icon-128.png', 'icon-256.png', 'icon-512.png',
    'assets/cat-wallpaper.png',
  ];
  let generatedPrecache: { version: string; urls: string[] } | null = null;

  return {
    name: 'relay-offline-shell-manifest',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url || '').split('?')[0] !== '/sw-precache.js') return next();
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end('self.__RELAY_PRECACHE = { version: "dev", urls: [] };\n');
      });
    },
    generateBundle(_options, bundle) {
      const digest = createHash('sha256');
      digest.update(`relay-shell-v1\0${webVersion}\0`);
      // index.html may be finalized by Vite after user plugins, so hash its source too.
      digest.update(readFileSync(resolve(process.cwd(), 'index.html')));
      // Cache identity also owns install/fetch policy. A worker-only fix must stage a new
      // cache instead of sharing (and potentially deleting) the active release's cache.
      digest.update(readFileSync(resolve(process.cwd(), 'public', 'sw.js')));

      const urls = new Set<string>(['/index.html']);
      for (const [fileName, output] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        if (fileName.endsWith('.map') || fileName === 'sw-precache.js') continue;
        if (output.type !== 'chunk' && !/\.(?:css|html|js|png|webp|wasm|woff2?)$/i.test(fileName)) continue;
        urls.add('/' + fileName.replace(/^\/+/, ''));
        digest.update(`\0${fileName}\0`);
        digest.update(output.type === 'chunk' ? output.code : output.source);
      }
      for (const fileName of publicShellFiles) {
        urls.add('/' + fileName);
        digest.update(`\0${fileName}\0`);
        digest.update(readFileSync(resolve(process.cwd(), 'public', fileName)));
      }

      const version = digest.digest('hex').slice(0, 20);
      generatedPrecache = { version, urls: [...urls].sort() };
    },
    writeBundle(options) {
      if (!generatedPrecache) throw new Error('offline shell manifest was not generated');
      const sourcePath = resolve(process.cwd(), 'public', 'sw.js');
      const marker = 'const BUILD_PRECACHE = null;';
      const source = readFileSync(sourcePath, 'utf8');
      if (!source.includes(marker)) throw new Error('offline shell marker is missing from public/sw.js');
      const builtWorker = source.replace(marker, `const BUILD_PRECACHE = ${JSON.stringify(generatedPrecache)};`);
      writeFileSync(resolve(options.dir || resolve(process.cwd(), 'dist'), 'sw.js'), builtWorker);
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
  const audioAssets = versionedAudioAssets();
  return {
    plugins: [react(), audioAssets.plugin, offlineShellManifest(webVersion)],
    define: {
      __APP_VERSION__: JSON.stringify(webVersion),
      __RNNOISE_WORKLET_URL__: JSON.stringify(audioAssets.urls.rnnoiseWorklet),
      __RNNOISE_WASM_URL__: JSON.stringify(audioAssets.urls.rnnoiseWasm),
      __RNNOISE_SIMD_WASM_URL__: JSON.stringify(audioAssets.urls.rnnoiseSimdWasm),
      __VAD_WORKLET_URL__: JSON.stringify(audioAssets.urls.vadWorklet),
    },
    build: {
      outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500,
      // AudioWorklet-файлы остаются отдельными same-origin ресурсами (CSP запрещает data:), а
      // versionedAudioAssets связывает их content hash с точным host-бандлом и SW-кэшем.
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
