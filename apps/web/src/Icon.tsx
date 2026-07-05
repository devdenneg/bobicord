export function Icon({ name, sm }: { name: string; sm?: boolean }) {
  return (
    <svg className={'ic' + (sm ? ' sm' : '')} aria-hidden="true">
      <use href={'#i-' + name} />
    </svg>
  );
}

export function IconSprite() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" style={{ display: 'none' }} dangerouslySetInnerHTML={{ __html: `
  <symbol id="i-mic" viewBox="0 0 24 24"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M8.5 21h7"/></symbol>
  <symbol id="i-mic-off" viewBox="0 0 24 24"><path d="M9 5.5v-.5a3 3 0 0 1 6 0v6c0 .5-.1 1-.35 1.4"/><path d="M9 9.5v3.5a3 3 0 0 0 5 2.2"/><path d="M5 11a7 7 0 0 0 11.4 5.4M19 11a7 7 0 0 1-.36 2.2"/><path d="M12 18v3"/><path d="M8.5 21h7"/><path d="M3 3l18 18"/></symbol>
  <symbol id="i-head" viewBox="0 0 24 24"><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Zm18 0h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-5Z"/><path d="M3 14v-2a9 9 0 0 1 18 0v2"/></symbol>
  <symbol id="i-head-off" viewBox="0 0 24 24"><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z"/><path d="M3 14v-2a9 9 0 0 1 14.5-7.1M21 12v2"/><path d="M18 14h3v3"/><path d="M3 3l18 18"/></symbol>
  <symbol id="i-screen" viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8.5 21h7"/><path d="M12 17v4"/><path d="M12 13.5V8"/><path d="M9.5 10.2 12 7.8l2.5 2.4"/></symbol>
  <symbol id="i-screen-stop" viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8.5 21h7"/><path d="M12 17v4"/><path d="M9.6 8.2l4.8 4.6M14.4 8.2l-4.8 4.6"/></symbol>
  <symbol id="i-cam" viewBox="0 0 24 24"><rect x="2.5" y="6" width="13.5" height="12" rx="2.5"/><path d="M16 10.5l5.5-3v9l-5.5-3"/></symbol>
  <symbol id="i-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V19.7a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.12-1.56 1.7 1.7 0 0 0-1.87.34l-.07.06a2 2 0 1 1-2.83-2.83l.07-.06a1.7 1.7 0 0 0 .33-1.88 1.7 1.7 0 0 0-1.55-1.03H4.3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 5.95 7.5a1.7 1.7 0 0 0-.33-1.87l-.07-.07a2 2 0 1 1 2.83-2.83l.06.07a1.7 1.7 0 0 0 1.88.33h.08a1.7 1.7 0 0 0 1.03-1.55V4.3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.03 1.56a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.88v.08c.26.62.88 1.03 1.56 1.03h.09a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.02z"/></symbol>
  <symbol id="i-leave" viewBox="0 0 24 24"><path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/></symbol>
  <symbol id="i-link" viewBox="0 0 24 24"><path d="M10 13.5a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 10.5a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></symbol>
  <symbol id="i-send" viewBox="0 0 24 24"><path d="M22 2 11 13"/><path d="M22 2 15 21l-4-8-8-4z"/></symbol>
  <symbol id="i-users" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></symbol>
  <symbol id="i-chat" viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 20l1-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol>
  <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="M12 16v-5"/><path d="M12 8h.01"/></symbol>
  <symbol id="i-warn" viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></symbol>
  <symbol id="i-mic-sm" viewBox="0 0 24 24"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></symbol>
  <symbol id="i-smile" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="M8.5 14.5a4.5 4 0 0 0 7 0"/><path d="M9 9.5h.01"/><path d="M15 9.5h.01"/></symbol>
  <symbol id="i-eye" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></symbol>
  <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="i-home" viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/></symbol>
  <symbol id="i-hash" viewBox="0 0 24 24"><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/></symbol>
  <symbol id="i-speaker" viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></symbol>
  <symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.8"/><path d="M21 15l-5-5L5 21"/></symbol>
` }} />
  );
}
