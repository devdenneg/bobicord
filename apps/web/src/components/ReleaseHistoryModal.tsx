import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from '../Icon';
import { useStore } from '../store';
import type { ReleaseHistoryItem } from '../types';
import { Backdrop } from './Backdrop';

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function publishedDate(value: number) {
  const timestamp = value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : '';
}

export function ReleaseHistoryModal() {
  const close = () => useStore.getState().setModal(null);
  const markReleaseHistoryRead = useStore((state) => state.markReleaseHistoryRead);
  const requestRef = useRef<AbortController | null>(null);
  const [releases, setReleases] = useState<ReleaseHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError('');
    api.releaseHistory(controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          const nextReleases = Array.isArray(response.releases) ? response.releases.slice(0, 10) : [];
          setReleases(nextReleases);
          // Ошибка/abort не очищают индикатор: прочитанным считается только реально
          // загруженное и показанное пользователю окно истории.
          markReleaseHistoryRead(nextReleases);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : 'Не удалось загрузить историю обновлений');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  }, [markReleaseHistoryRead]);

  useEffect(() => {
    load();
    return () => requestRef.current?.abort();
  }, [load]);

  return <Backdrop onClose={close} label="Что нового" boxClass="release-history-modal">
    <button className="settings-x" onClick={close} aria-label="Закрыть"><Icon name="close" /></button>
    <header className="release-history-head">
      <span className="release-history-head-icon" aria-hidden="true"><Icon name="updates" /></span>
      <div>
        <h2>Что нового</h2>
        <p className="msub">Последние 10 обновлений RelayApp — всё важное в одном месте.</p>
      </div>
    </header>

    {loading ? <div className="release-history-skeleton" role="status" aria-live="polite" aria-label="Загружаем обновления">
      {[0, 1, 2].map((item) => <div className="release-history-skeleton-card" key={item} aria-hidden="true">
        <span /><i /><i />
      </div>)}
    </div> : null}

    {!loading && error ? <div className="release-history-state" role="alert">
      <span className="release-history-state-icon"><Icon name="warn" /></span>
      <strong>История пока недоступна</strong>
      <p>{error}</p>
      <button className="primary" onClick={load}><Icon name="refresh" sm />Попробовать снова</button>
    </div> : null}

    {!loading && !error && !releases.length ? <div className="release-history-state">
      <span className="release-history-state-icon"><Icon name="updates" /></span>
      <strong>Здесь появятся обновления</strong>
      <p>История заполнится после первого успешного релиза с патчноутом.</p>
    </div> : null}

    {!loading && !error && releases.length ? <div className="release-history-list">
      {releases.map((release, index) => {
        const date = publishedDate(release.publishedAt);
        const publishedAt = release.publishedAt > 0 && release.publishedAt < 1_000_000_000_000
          ? release.publishedAt * 1000
          : release.publishedAt;
        return <article className="release-history-entry" key={release.sha}>
          <div className="release-history-timeline" aria-hidden="true">
            <span><Icon name={index === 0 ? 'updates' : 'check'} sm /></span>
          </div>
          <div className="release-history-card">
            <div className="release-history-meta">
              <span className="release-history-version">{release.version ? `Версия ${release.version}` : index === 0 ? 'Последнее обновление' : 'Обновление'}</span>
              {date ? <time dateTime={new Date(publishedAt).toISOString()}>{date}</time> : null}
            </div>
            {release.title && release.title !== 'Обновление RelayApp' ? <h3>{release.title}</h3> : null}
            <ul>{release.notes.map((note, noteIndex) => <li key={`${release.sha}:${noteIndex}`}>{note}</li>)}</ul>
          </div>
        </article>;
      })}
    </div> : null}
  </Backdrop>;
}
