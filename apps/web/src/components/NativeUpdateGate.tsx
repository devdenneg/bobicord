import { nativeUpdateController } from '../nativeUpdate';
import type { NativeUpdateState } from '../nativeUpdateController';
import { LogoLoader } from './LogoLoader';
import './NativeUpdateGate.css';

export function NativeUpdateGate({ state }: { state: NativeUpdateState }) {
  const busy = ['checking', 'downloading', 'installing', 'restarting'].includes(state.phase);
  const percent = state.total ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : null;
  const title = state.phase === 'checking' ? 'Проверяем обновления'
    : state.phase === 'downloading' ? 'Скачиваем обновление'
      : state.phase === 'installing' ? 'Устанавливаем обновление'
        : state.phase === 'restarting' ? 'Перезапускаем Рилэй'
          : state.installed ? 'Обновление установлено'
            : state.version ? 'Обнови Рилэй перед входом' : 'Не удалось проверить обновления';
  const unknown = !state.version && !state.installed;
  const install = () => { void nativeUpdateController.apply().catch(() => {}); };
  return (
    <main className="native-update-gate">
      <section className="native-update-card" aria-labelledby="native-update-title" aria-busy={busy}>
        <LogoLoader size={112} animate={false} />
        <span className="native-update-brand">Рилэй · приложение для компьютера</span>
        <h1 id="native-update-title">{title}</h1>
        <p>{state.version ? `Доступна версия ${state.version}. После обновления приложение перезапустится, и можно будет войти.`
          : 'Проверка займёт несколько секунд. Актуальная версия нужна для стабильной связи.'}</p>
        {state.phase === 'downloading' ? <div className="native-update-progress" aria-live="polite">
          <progress aria-label="Загрузка обновления" max={100} value={percent ?? undefined} />
          <span>{percent !== null ? `${percent}% · ` : ''}{(state.downloaded / 1024 / 1024).toFixed(1)} МБ{state.total ? ` из ${(state.total / 1024 / 1024).toFixed(1)} МБ` : ''}</span>
        </div> : null}
        {state.error ? <p className="native-update-error" role="alert">{state.error}</p> : null}
        <div className="native-update-actions">
          {busy ? <div className="native-update-status" role="status"><span aria-hidden="true" />{state.phase === 'checking' ? 'Проверка…' : state.phase === 'restarting' ? 'Сейчас откроется новая версия…' : 'Пожалуйста, не закрывай приложение'}</div>
            : unknown ? <>
              <button type="button" className="native-update-primary" onClick={() => { void nativeUpdateController.retryCheck(); }}>Повторить проверку</button>
              <button type="button" className="native-update-secondary" onClick={() => nativeUpdateController.continueWithoutCheck()}>Продолжить ко входу</button>
            </> : <button type="button" className="native-update-primary" onClick={install}>{state.installed ? 'Перезапустить' : state.phase === 'error' ? 'Повторить обновление' : 'Скачать и обновить'}</button>}
        </div>
      </section>
    </main>
  );
}
