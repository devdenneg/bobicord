import { useEffect, useRef, useState } from 'react';
import { api, setToken } from '../api';
import { useStore } from '../store';
import { Icon } from '../Icon';
import { isTauri } from '../native';

export function Auth() {
  // ссылка на свежий билд натива (только в браузере; в самом приложении не показываем)
  const [appDl, setAppDl] = useState<{ version: string; url: string } | null>(null);
  useEffect(() => { if (!isTauri) api.appLatest().then(setAppDl); }, []);

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const afterAuth = useStore((s) => s.afterAuth);

  async function submit() {
    if (!user.trim() || !pass) { setErr('Заполни оба поля'); return; }
    setBusy(true); setErr('');
    try {
      const d = mode === 'login' ? await api.login(user.trim(), pass) : await api.register(user.trim(), pass);
      setToken(d.token);
      await afterAuth(d.user);
    } catch (e: any) {
      setErr(e.message);
      const c = cardRef.current; if (c) { c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake'); }
    } finally { setBusy(false); }
  }

  return (
    <div id="auth" className="overlay">
      <div className="card" ref={cardRef}>
        <div className="brand"><div className="logo"><Icon name="mic" /></div><h1>Voice</h1></div>
        <p className="sub">Голос, чат и трансляции — для своих.</p>
        <div className="tabs2">
          <button className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setErr(''); }}>Вход</button>
          <button className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setErr(''); }}>Регистрация</button>
        </div>
        <div className="row"><label>Логин</label>
          <input value={user} maxLength={20} placeholder="3–20: латиница, цифры, _" autoComplete="username"
            onChange={(e) => setUser(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} /></div>
        <div className="row"><label>Пароль</label>
          <input type="password" value={pass} maxLength={64} placeholder="••••••••" autoComplete="current-password"
            onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} /></div>
        <button className="primary" disabled={busy} onClick={submit}>
          {busy ? <span className="spin" /> : null}{mode === 'login' ? 'Войти' : 'Создать аккаунт'}
        </button>
        <div className="err" role="alert">{err}</div>
        {appDl ? (
          <a className="app-dl" href={appDl.url} download>
            <Icon name="download" sm />Скачать приложение для Windows <span className="app-dl-ver">v{appDl.version}</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}
