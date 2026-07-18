import { useEffect, useRef, useState } from 'react';
import { resolveUploadUrl } from '../api';

const PROFILE_BANNER_UPLOAD = /^\/api\/uploads\/[a-f0-9]{24}\.(?:png|jpg|gif|webp)$/;

export function normalizeProfileBanner(value?: string): string {
  return value && PROFILE_BANNER_UPLOAD.test(value) ? value : '';
}

/**
 * Decorative profile background backed only by an uploaded image.
 * Compact rows mount animated GIF/WebP media only near the viewport, so visible
 * backgrounds animate while off-screen rows do not keep consuming decode time.
 */
export function ProfileBannerMedia({ value, className = '', compact = false }: {
  value?: string;
  className?: string;
  compact?: boolean;
}) {
  const mediaRef = useRef<HTMLSpanElement>(null);
  const canObserve = compact && typeof IntersectionObserver !== 'undefined';
  const [visible, setVisible] = useState(() => !canObserve);
  const normalized = normalizeProfileBanner(value);
  const source = normalized ? resolveUploadUrl(normalized) : '';

  useEffect(() => {
    if (!compact || !source || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const node = mediaRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    }, { rootMargin: '96px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [compact, source]);

  if (!source) return null;
  const classes = `profile-banner-media${visible ? '' : ' deferred'}${className ? ` ${className}` : ''}`;
  return (
    <span ref={mediaRef} className={classes} aria-hidden="true">
      {visible ? <img src={source} alt="" draggable={false} decoding="async" /> : null}
    </span>
  );
}
