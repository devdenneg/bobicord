import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { normalizeExternalHttpUrl } from '../linkify';
import { isTauri, openExternalUrl } from '../native';
import { useStore } from '../store';

type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> & {
  href: string;
};

export function ExternalLink({ href, children, onClick, onAuxClick, ...props }: ExternalLinkProps) {
  const safeHref = normalizeExternalHttpUrl(href);
  if (!safeHref) return <span className={props.className}>{children}</span>;

  const openInNativeBrowser = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isTauri) return;
    event.preventDefault();
    void openExternalUrl(safeHref).catch(() => {
      useStore.getState().toast('Не удалось открыть ссылку', 'err');
    });
  };

  return (
    <a
      {...props}
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer external"
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) openInNativeBrowser(event);
      }}
      onAuxClick={(event) => {
        onAuxClick?.(event);
        if (!event.defaultPrevented && event.button === 1) openInNativeBrowser(event);
      }}
    >
      {children}
    </a>
  );
}
