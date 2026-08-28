import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'youtube.ts'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { parseYouTubeVideo } = await import('data:text/javascript,' + encodeURIComponent(code));

const ID = 'dQw4w9WgXcQ';
let passed = 0;
let failed = 0;

function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) console.log('  actual:', actual, '\n  expected:', expected);
  ok ? passed++ : failed++;
}

function truthy(name, value) {
  const ok = Boolean(value);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  ok ? passed++ : failed++;
}

// Разбор ссылки проверяем через parseYouTubeVideo — единственную оставшуюся точку входа: её
// результат идёт в карточку предпросмотра ссылки в чате.
const idOf = (input) => parseYouTubeVideo(input)?.videoId ?? null;

equal('watch URL', idOf(`https://www.youtube.com/watch?v=${ID}&t=42s`), ID);
equal('short youtu.be URL', idOf(`https://youtu.be/${ID}?si=test`), ID);
equal('Shorts URL', idOf(`https://youtube.com/shorts/${ID}`), ID);
equal('live URL', idOf(`https://m.youtube.com/live/${ID}?feature=share`), ID);
equal('embed URL', idOf(`https://music.youtube.com/embed/${ID}`), ID);
equal('bare video id is accepted', idOf(ID), ID);

equal('lookalike host is rejected', idOf(`https://youtube.com.evil.example/watch?v=${ID}`), null);
equal('id with an appended payload is rejected', idOf(`https://youtube.com/watch?v=${ID}extra`), null);
equal('encoded slash in id is rejected', idOf(`https://youtu.be/${ID}%2Fbad`), null);
equal('unrelated YouTube route is rejected', idOf(`https://youtube.com/channel/${ID}`), null);
equal('non-HTTP protocol is rejected', idOf(`javascript://youtube.com/watch?v=${ID}`), null);

const video = parseYouTubeVideo(`https://youtu.be/${ID}`);
truthy('preview metadata is returned', video);
equal('canonical preview URL', video?.canonicalUrl, `https://www.youtube.com/watch?v=${ID}`);
equal('safe thumbnail URL', video?.thumbnailUrl, `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);

console.log(`\n${passed}/${passed + failed} PASS`);
process.exit(failed ? 1 : 0);
