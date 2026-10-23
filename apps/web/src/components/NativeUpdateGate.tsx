import { nativeUpdateController } from '../nativeUpdate';
import type { NativeUpdateState } from '../nativeUpdateController';
import { LogoLoader } from './LogoLoader';
import './NativeUpdateGate.css';

// Иконки инлайном: гейт рендерится до входа и в тесте собирается с минимальным набором импортов.
const GLYPH = {
  check: <><path d="M5.6 9.4a6.9 6.9 0 0 1 12.6 1.6" /><path d="m16.4 9.6 2 2 2-2" /><path d="M18.4 14.6a6.9 6.9 0 0 1-12.6-1.6" /><path d="m7.6 14.4-2-2-2 2" /></>,
  download: <><path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" /><path d="M12 3.5v11" /><path d="m7.8 10.6 4.2 4.2 4.2-4.2" /></>,
  warn: <><path d="M10.6 4.3 2.9 17.6a1.6 1.6 0 0 0 1.4 2.4h15.4a1.6 1.6 0 0 0 1.4-2.4L13.4 4.3a1.6 1.6 0 0 0-2.8 0Z" /><path d="M12 9.5v4.5" /><circle cx="12" cy="17" r=".6" /></>,
};
function Glyph({ name }: { name: keyof typeof GLYPH }) {
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPH[name]}</svg>;
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

export function NativeUpdateGate({ state }: { state: NativeUpdateState }) {
  const busy = ['checking', 'downloading', 'installing', 'restarting'].includes(state.phase);
  const percent = state.total ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : null;
  const unknown = !state.version && !state.installed;
  const failed = state.phase === 'error' && !state.installed;
  const title = state.phase === 'checking' ? 'Проверяем обновления'
    : state.phase === 'downloading' ? 'Скачиваем обновление'
      : state.phase === 'installing' ? 'Устанавливаем обновление'
        : state.phase === 'restarting' ? 'Перезапускаем Рилэй'
          : state.installed ? 'Обновление установлено'
            : failed ? (unknown ? 'Не удалось проверить обновления' : 'Не удалось обновиться')
              : state.version ? `Доступна версия ${state.version}` : 'Обнови Рилэй перед входом';
  const text = state.phase === 'checking' ? 'Это займёт пару секунд.'
    : state.phase === 'installing' ? 'Пожалуйста, не закрывай приложение.'
      : state.phase === 'restarting' ? 'Сейчас откроется новая версия…'
        : state.installed ? 'Перезапусти приложение, и можно будет войти.'
          : failed ? 'Проверь подключение к интернету и попробуй ещё раз.'
            : state.phase === 'downloading' ? ''
              : 'После обновления Рилэй перезапустится, и можно будет войти.';
  const tone = failed ? 'danger' : state.phase === 'available' || state.installed ? 'accent' : 'muted';
  const install = () => { void nativeUpdateController.apply().catch(() => {}); };
  return (
    <main className="native-update-gate">
      <div className="nu-brand"><LogoLoader size={28} animate={false} /><span>Рилэй</span></div>
      <section className={'nu-card' + (tone === 'accent' ? ' accent' : '')} aria-labelledby="native-update-title" aria-busy={busy}>
        {state.phase === 'downloading' ? (
          <div className="nu-pct" aria-hidden="true"><b>{percent ?? '…'}</b><span>%</span></div>
        ) : (
          <span className={'nu-ic ' + tone}><Glyph name={failed ? 'warn' : state.phase === 'checking' ? 'check' : 'download'} /></span>
        )}
        <h1 id="native-update-title">{title}</h1>
        {text ? <p role={failed ? 'alert' : undefined}>{text}</p> : null}
        {state.phase === 'downloading' ? (
          <div className="nu-progress" aria-live="polite">
            <progress aria-label="Загрузка обновления" max={100} value={percent ?? undefined} />
            <span>{mb(state.downloaded)} МБ{state.total ? ` из ${mb(state.total)} МБ` : ''} · не закрывай приложение</span>
          </div>
        ) : busy ? <span className="nu-indet" role="status" aria-label={title}><i /></span> : null}
        {busy ? null : (
          <div className="nu-actions">
            {unknown ? <>
              <button type="button" className="nu-btn primary" onClick={() => { void nativeUpdateController.retryCheck(); }}>Повторить</button>
              <button type="button" className="nu-btn" onClick={() => nativeUpdateController.continueWithoutCheck()}>Продолжить ко входу</button>
            </> : <button type="button" className="nu-btn primary" onClick={install}>{state.installed ? 'Перезапустить' : state.phase === 'error' ? 'Повторить' : 'Скачать и обновить'}</button>}
          </div>
        )}
      </section>
    </main>
  );
}
