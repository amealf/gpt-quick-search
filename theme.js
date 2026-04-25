/* ─── theme toggle ─── */
(function () {
  const root = document.documentElement;
  const btn = document.getElementById('themeToggle');
  const KEY = 'gqs-theme';

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    localStorage.setItem(KEY, theme);
  }

  /* restore saved preference */
  const saved = localStorage.getItem(KEY);
  if (saved === 'dark' || saved === 'light') {
    applyTheme(saved);
  }

  if (btn) {
    btn.addEventListener('click', function () {
      const current = root.getAttribute('data-theme') || 'light';
      applyTheme(current === 'light' ? 'dark' : 'light');
    });
  }
})();
