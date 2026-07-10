// Evolution-TZ Э3 — best-effort определение симметричного NAT.
// Симметричный NAT мапит один и тот же локальный порт на РАЗНЫЕ внешние порты для
// разных удалённых адресов — значит relay через этот узел недостижим для третьей
// стороны. Проверяем это, сравнивая srflx-порт от двух независимых STUN-серверов;
// если порты разные — узел за симметричным NAT и должен быть помечен листом
// (CLAUDE.md: браузер и так всегда лист; задел на будущего нативного ретранслятора).
//
// «Независимых» = РАЗНЫЕ ХОСТЫ. Два адреса одного сервера дадут одинаковый порт даже
// за симметричным NAT (мапинг per-destination-IP) — детект молча выродится в «нет NAT».
// Список приходит из серверного `welcome` (свой coturn + Google), см. treeVideo.ts.
export const FALLBACK_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

/** STUN-URI из iceServers, по одному на хост (детекту нужны разные адресаты, не разные порты). */
export function stunUrlsByHost(iceServers: RTCIceServer[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of iceServers) {
    for (const u of Array.isArray(s.urls) ? s.urls : [s.urls]) {
      if (typeof u !== 'string' || !u.startsWith('stun:')) continue;
      const host = u.slice(5).split(':')[0].split('?')[0];
      if (!host || seen.has(host)) continue;
      seen.add(host);
      out.push(u);
    }
  }
  return out;
}

export async function detectSymmetricNat(stunUrls: string[] = FALLBACK_STUN): Promise<boolean> {
  if (stunUrls.length < 2) return false;
  try {
    const ports = await Promise.all(stunUrls.slice(0, 2).map(srflxPort));
    if (ports.some((p) => p == null)) return false; // неопределённо — не помечаем ложно
    return ports[0] !== ports[1];
  } catch { return false; }
}

function srflxPort(stunUrl: string): Promise<number | null> {
  return new Promise((resolve) => {
    let pc: RTCPeerConnection;
    try { pc = new RTCPeerConnection({ iceServers: [{ urls: stunUrl }] }); } catch { resolve(null); return; }
    let done = false;
    const finish = (port: number | null) => {
      if (done) return;
      done = true;
      try { pc.close(); } catch { /**/ }
      resolve(port);
    };
    pc.onicecandidate = (e) => {
      if (!e.candidate) { finish(null); return; }
      if (e.candidate.type === 'srflx' && e.candidate.port != null) finish(e.candidate.port);
    };
    pc.createDataChannel('nat-probe');
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => finish(null));
    setTimeout(() => finish(null), 2500);
  });
}
