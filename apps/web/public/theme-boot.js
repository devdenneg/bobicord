// Ставит тему и акцент ДО первого кадра, чтобы светлая тема не мигала тёмным фоном загрузки.
// Логика повторяет theme.ts; отдельный файл, потому что CSP запрещает инлайн-скрипты.
(function () {
  var root = document.documentElement, mode = 'dark', accent = 'sage';
  try { mode = localStorage.getItem('theme') || 'dark'; accent = localStorage.getItem('accent') || 'sage'; } catch (e) {}
  if (mode === 'system') mode = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  root.setAttribute('data-theme', mode === 'light' ? 'light' : 'dark');
  root.setAttribute('data-accent', /^(sage|lavender|sky|peach)$/.test(accent) ? accent : 'sage');
})();
