(() => {
  'use strict';

  const DEFAULTS = Object.freeze({ enabled: true });
  const enabled = document.querySelector('#enabled');

  function render(current) {
    enabled.checked = current.enabled !== false;
  }

  enabled.addEventListener('change', () => {
    chrome.storage.sync.set({ enabled: enabled.checked });
  });

  chrome.storage.sync.get(DEFAULTS).then(render).catch(() => render(DEFAULTS));
})();
