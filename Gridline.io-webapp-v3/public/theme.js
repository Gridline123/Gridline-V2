// Applies the saved light/dark choice before the page draws, so there's no flash.
try { document.documentElement.dataset.theme = localStorage.getItem('gl_theme') || 'system'; } catch (e) { document.documentElement.dataset.theme = 'system'; }
