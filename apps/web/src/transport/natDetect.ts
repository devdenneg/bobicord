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
    return await probeSameSocket(stunUrls.slice(0, 2));
  } catch { return false; }
}

/**
 * ОДИН RTCPeerConnection с обоими STUN-серверами. Это принципиально: ICE-агент опрашивает их
 * с одного и того же локального сокета (общий `relatedPort` = base), поэтому разные внешние
 * порты означают именно симметричность.
 *
 * Раньше здесь было два независимых PC — по одному на сервер. У каждого свой локальный порт, а
 * ЛЮБОЙ NAT отображает разные локальные порты на разные внешние. Проба возвращала true почти
 * для каждого браузера за NAT (ловилось живьём: symNat=true у всех веб-зрителей подряд).
 *
 * Браузер схлопывает одинаковые srflx-кандидаты (совпали ip+port+type), поэтому при конусном
 * NAT придёт ОДИН кандидат на оба сервера, а при симметричном — два с разными портами.
 */
function probeSameSocket(stunUrls: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let pc: RTCPeerConnection;
    try { pc = new RTCPeerConnection({ iceServers: stunUrls.map((urls) => ({ urls })) }); }
    catch { resolve(false); return; }

    // base-порт -> внешние порты, которые увидели разные серверы.
    const byBase = new Map<number, Set<number>>();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { pc.close(); } catch { /**/ }
      // Симметричный = хотя бы один base отобразился в ДВА разных внешних порта.
      for (const ports of byBase.values()) if (ports.size >= 2) { resolve(true); return; }
      resolve(false); // один srflx (конусный) либо ни одного (неопределённо) — не помечаем ложно
    };

    pc.onicecandidate = (e) => {
      if (!e.candidate) { finish(); return; } // end-of-candidates: гатеринг завершён
      const c = e.candidate;
      if (c.type !== 'srflx' || c.port == null) return;
      const base = c.relatedPort ?? -1; // нет relatedPort — валим всё в одну корзину
      let set = byBase.get(base);
      if (!set) { set = new Set(); byBase.set(base, set); }
      set.add(c.port);
      if (set.size >= 2) finish(); // ответ уже известен, ждать остальные кандидаты незачем
    };
    pc.createDataChannel('nat-probe');
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => finish());
    setTimeout(finish, 3000); // гатеринг двух серверов, с запасом к прежним 2.5с
  });
}
