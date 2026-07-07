import { useEffect, useRef } from 'react';

// центровая линия логотипа «P» (замкнутый контур в системе 512×512; узлы cyan/magenta/pink — станции)
const PTS: [number, number][] = [
  [141, 178], [141, 150], [142, 126], [150, 113], [184, 104], [246, 101], [312, 105], [362, 123],
  [389, 152], [398, 183], [400, 213], [399, 245], [394, 272], [382, 293], [361, 308], [324, 320],
  [288, 328], [253, 333], [229, 338], [216, 350], [210, 370], [207, 396], [204, 410], [196, 423],
  [177, 431], [156, 430], [143, 422], [140, 409], [140, 300],
];

// центростремительный Catmull-Rom (alpha=0.5) — ровные скругления без овершутов
function sample(pts: [number, number][], per = 22) {
  const n = pts.length, out: [number, number][] = [], A = 0.5;
  const g = (i: number) => pts[((i % n) + n) % n];
  const tj = (ti: number, pa: [number, number], pb: [number, number]) =>
    ti + Math.pow(Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1e-4, A);
  for (let i = 0; i < n; i++) {
    const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
    const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
    for (let k = 0; k < per; k++) {
      const t = t1 + (t2 - t1) * k / per;
      const l = (a: number, b: number, pa: number[], pb: number[], c: number) =>
        ((b - t) / ((b - a) || 1e-9)) * pa[c] + ((t - a) / ((b - a) || 1e-9)) * pb[c];
      const A1 = [l(t0, t1, p0, p1, 0), l(t0, t1, p0, p1, 1)];
      const A2 = [l(t1, t2, p1, p2, 0), l(t1, t2, p1, p2, 1)];
      const A3 = [l(t2, t3, p2, p3, 0), l(t2, t3, p2, p3, 1)];
      const B1 = [l(t0, t2, A1, A2, 0), l(t0, t2, A1, A2, 1)];
      const B2 = [l(t1, t3, A2, A3, 0), l(t1, t3, A2, A3, 1)];
      out.push([l(t1, t2, B1, B2, 0), l(t1, t2, B1, B2, 1)]);
    }
  }
  out.push([out[0][0], out[0][1]]);
  let len = 0; const cum = [0];
  for (let i = 1; i < out.length; i++) { len += Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]); cum.push(len); }
  return { pts: out, cum, len };
}

// циклическая палитра (cyan→purple→magenta→purple→cyan) — течёт по замкнутому контуру без шва
function palette(t: number) {
  t = ((t % 1) + 1) % 1;
  const st = [[0, 84, 214, 255], [0.28, 150, 120, 242], [0.55, 255, 98, 198], [0.8, 150, 120, 242], [1, 84, 214, 255]];
  for (let i = 1; i < st.length; i++) {
    if (t <= st[i][0]) {
      const a = st[i - 1], b = st[i], f = (t - a[0]) / (b[0] - a[0]);
      return `rgb(${a[1] + (b[1] - a[1]) * f | 0},${a[2] + (b[2] - a[2]) * f | 0},${a[3] + (b[3] - a[3]) * f | 0})`;
    }
  }
  return 'rgb(84,214,255)';
}

/** Анимированный лоадер-логотип: «P» с потоковым градиентом и тремя огоньками, едущими по букве.
 *  size — размер в CSS-px; speedMs — длительность полного обхода контура (больше = медленнее/спокойнее). */
export function LogoLoader({ size = 180, speedMs = 3000 }: { size?: number; speedMs?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const DEV = Math.round(size * dpr);
    cv.width = DEV; cv.height = DEV;
    const K = DEV / 512;
    const W = 512, H = 512;
    // offscreen: трубка (sc) рисуется непрозрачно; хвост кометы (tc) накапливается
    const sc = document.createElement('canvas'); sc.width = DEV; sc.height = DEV; const sg = sc.getContext('2d')!;
    const tc = document.createElement('canvas'); tc.width = DEV; tc.height = DEV; const tg = tc.getContext('2d')!;
    // вписываем контур в канвас (bbox + запас под штрих/свечение), «запекая» fit в сами точки —
    // так «P» заполняет лого при любом size, а рисование идёт простым scale(K) без runtime-трансформов
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const p of PTS) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }
    const pad = 22, bw = (maxx - minx) + pad * 2, bh = (maxy - miny) + pad * 2, fit = Math.min(W / bw, H / bh);
    const ox = (W - bw * fit) / 2 - (minx - pad) * fit, oy = (H - bh * fit) / 2 - (miny - pad) * fit;
    const fitted = PTS.map(([x, y]) => [x * fit + ox, y * fit + oy] as [number, number]);
    ctx.scale(K, K); sg.scale(K, K); tg.scale(K, K);
    const P = sample(fitted);

    const at = (d: number): [number, number] => {
      d = ((d % P.len) + P.len) % P.len;
      let lo = 0, hi = P.cum.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (P.cum[m] < d) lo = m + 1; else hi = m; }
      const i = Math.max(1, lo), a = P.cum[i - 1], b = P.cum[i], f = (d - a) / (b - a || 1);
      const p = P.pts[i - 1], q = P.pts[i];
      return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
    };
    const drawFlow = (phase: number) => {
      const pts = P.pts, cum = P.cum, L = P.len;
      sg.clearRect(0, 0, W, H);
      sg.lineCap = 'round'; sg.lineJoin = 'round'; sg.lineWidth = 16; sg.globalAlpha = 1;
      for (let i = 1; i < pts.length; i++) {
        sg.strokeStyle = palette(cum[i] / L - phase);
        sg.beginPath(); sg.moveTo(pts[i - 1][0], pts[i - 1][1]); sg.lineTo(pts[i][0], pts[i][1]); sg.stroke();
      }
    };

    const SPEED = P.len / speedMs, COMETS = 3;
    let raf = 0, t0: number | null = null;
    const frame = (ts: number) => {
      if (t0 === null) t0 = ts;
      const head = (ts - t0) * SPEED;
      const headsD: number[] = []; for (let c = 0; c < COMETS; c++) headsD.push(head + c * P.len / COMETS);

      // хвост кометы: затухание через destination-out (уменьшаем alpha к прозрачному —
      // НЕ заливаем чёрным, иначе накопленный alpha при 'lighter' даёт чёрный фон)
      tg.globalCompositeOperation = 'destination-out';
      tg.fillStyle = 'rgba(0,0,0,0.16)'; tg.fillRect(0, 0, W, H);
      tg.globalCompositeOperation = 'lighter';
      for (const d of headsD) {
        for (let k = 0; k < 5; k++) {
          const dd = d - k * 3.4, p = at(dd), a = 1 - k / 5, r = (5.5 - k * 0.7) * 2.4;
          const gr = tg.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
          gr.addColorStop(0, `rgba(255,255,255,${0.85 * a})`);
          gr.addColorStop(0.4, `rgba(180,210,255,${0.5 * a})`);
          gr.addColorStop(1, 'rgba(0,0,0,0)');
          tg.fillStyle = gr; tg.beginPath(); tg.arc(p[0], p[1], r, 0, 7); tg.fill();
        }
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, W, H);
      // штрих: потоковый градиент (мягкое неон-свечение через blur + чёткая трубка)
      drawFlow(head / P.len);
      ctx.filter = 'blur(5px)'; ctx.globalAlpha = 0.8; ctx.drawImage(sc, 0, 0, W, H);
      ctx.filter = 'none'; ctx.globalAlpha = 1; ctx.drawImage(sc, 0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(tc, 0, 0, W, H); ctx.globalCompositeOperation = 'source-over';
      // головы точек
      for (const d of headsD) {
        const p = at(d);
        ctx.globalCompositeOperation = 'lighter';
        const gr = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], 22);
        gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(0.28, 'rgba(190,215,255,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(p[0], p[1], 22, 0, 7); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p[0], p[1], 6.5, 0, 7); ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size, speedMs]);
  return <canvas ref={ref} style={{ width: size, height: size, display: 'block' }} aria-label="Загрузка" role="img" />;
}
