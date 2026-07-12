import { useSyncExternalStore } from 'react';
import { emoteUrl, emoteUrlSm, isImgProxy, subscribeImgProxy, onEmoteImgError } from '../emotes';

// Единая точка рендера 7TV-эмоута. Подписка на флаг imgProxy: когда проба определит блокировку
// cdn.7tv.app (или ре-проба вернёт direct), уже смонтированные картинки перерисуются на нужный src.
// onError — только триггер sentinel-пробы (сам флаг флипает проба, не одиночный сбой картинки),
// с гардом data-fb против повторов на узле (Virtuoso рециклит DOM — но флаг уже глобальный).
export function EmoteImg({ id, size = 'lg', className, alt, title }: {
  id: string; size?: 'sm' | 'lg'; className?: string; alt?: string; title?: string;
}) {
  useSyncExternalStore(subscribeImgProxy, isImgProxy);
  const src = size === 'sm' ? emoteUrlSm(id) : emoteUrl(id);
  return (
    <img
      className={className}
      src={src}
      alt={alt ?? ''}
      title={title}
      loading="lazy"
      decoding="async"
      onError={(e) => {
        const img = e.currentTarget;
        if (img.dataset.fb) return; // фолбэк на этом узле уже пробовали — не зацикливаемся
        img.dataset.fb = '1';
        onEmoteImgError();
      }}
    />
  );
}
