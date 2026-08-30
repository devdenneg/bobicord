interface MobileNavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
}

interface DisplayModeLike {
  matchMedia?: (query: string) => { matches: boolean };
}

export function isAppleMobileBrowser(navigatorLike: MobileNavigatorLike): boolean {
  const userAgent = String(navigatorLike.userAgent || '');
  return /iPad|iPhone|iPod/i.test(userAgent)
    || (navigatorLike.platform === 'MacIntel' && Number(navigatorLike.maxTouchPoints) > 1);
}

export function isIosSafariBrowser(navigatorLike: MobileNavigatorLike): boolean {
  const userAgent = String(navigatorLike.userAgent || '');
  if (!isAppleMobileBrowser(navigatorLike)) return false;
  // Positive Safari signature: simply looking for `Safari` also matches some embedded Facebook /
  // Instagram webviews which cannot reliably complete Add to Home Screen. iPad desktop mode can
  // identify itself as Macintosh, so touch capability is used there instead of requiring Mobile.
  if (!/Version\/\d+(?:\.\d+)*\b/i.test(userAgent) || !/Safari\/\d/i.test(userAgent)) return false;
  const ipadDesktopMode = navigatorLike.platform === 'MacIntel' && Number(navigatorLike.maxTouchPoints) > 1;
  if (!ipadDesktopMode && !/Mobile\/\S+/i.test(userAgent)) return false;
  return !/(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA|YaBrowser|FBAN|FBAV|Instagram|Line\/|Twitter|TikTok|Snapchat)/i.test(userAgent);
}

export function isStandalonePwa(navigatorLike: MobileNavigatorLike, displayLike: DisplayModeLike): boolean {
  return navigatorLike.standalone === true
    || Boolean(displayLike.matchMedia?.('(display-mode: standalone)').matches);
}

export function iosSafariNeedsHomeScreenInstall(
  navigatorLike: MobileNavigatorLike = navigator as unknown as MobileNavigatorLike,
  displayLike: DisplayModeLike = window,
): boolean {
  return isIosSafariBrowser(navigatorLike) && !isStandalonePwa(navigatorLike, displayLike);
}
