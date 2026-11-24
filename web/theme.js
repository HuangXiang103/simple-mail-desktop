(() => {
  const root = document.documentElement;
  try {
    const stored = localStorage.getItem('simple-mail-theme');
    const mode = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    const dark = mode === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : mode === 'dark';
    root.dataset.theme = dark ? 'dark' : 'light';
    const storedLang = localStorage.getItem('simple-mail-lang');
    if (storedLang === 'en') root.lang = 'en-US';
    else if (storedLang === 'ja') root.lang = 'ja-JP';
  } catch {
    // A blocked storage API should not stop the page from loading.
  }
  // The page stays hidden until the strings are applied, with a hard cap so a script error can
  // never leave a blank window behind.
  setTimeout(() => { root.dataset.ready = 'true'; }, 1200);
})();
