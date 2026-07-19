import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'youtube.ts'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { parseVideoId, parseYouTubeVideo } = await import('data:text/javascript,' + encodeURIComponent(code));

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

equal('watch URL', parseVideoId(`https://www.youtube.com/watch?v=${ID}&t=42s`), ID);
equal('short youtu.be URL', parseVideoId(`https://youtu.be/${ID}?si=test`), ID);
equal('Shorts URL', parseVideoId(`https://youtube.com/shorts/${ID}`), ID);
equal('live URL', parseVideoId(`https://m.youtube.com/live/${ID}?feature=share`), ID);
equal('embed URL', parseVideoId(`https://music.youtube.com/embed/${ID}`), ID);
equal('bare video id remains valid for Watch Together', parseVideoId(ID), ID);

equal('lookalike host is rejected', parseVideoId(`https://youtube.com.evil.example/watch?v=${ID}`), null);
equal('id with an appended payload is rejected', parseVideoId(`https://youtube.com/watch?v=${ID}extra`), null);
equal('encoded slash in id is rejected', parseVideoId(`https://youtu.be/${ID}%2Fbad`), null);
equal('unrelated YouTube route is rejected', parseVideoId(`https://youtube.com/channel/${ID}`), null);
equal('non-HTTP protocol is rejected', parseVideoId(`javascript://youtube.com/watch?v=${ID}`), null);

const video = parseYouTubeVideo(`https://youtu.be/${ID}`);
truthy('preview metadata is returned', video);
equal('canonical preview URL', video?.canonicalUrl, `https://www.youtube.com/watch?v=${ID}`);
equal('safe thumbnail URL', video?.thumbnailUrl, `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);

console.log(`\n${passed}/${passed + failed} PASS`);
process.exit(failed ? 1 : 0);
