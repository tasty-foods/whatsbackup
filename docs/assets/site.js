/* Progressive enhancement. The installer link works without JavaScript. */
(function () {
  'use strict';
  var tablist = document.querySelector('.demo-tabs');
  if (tablist) {
    var tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    function selectTab(tab, focus) {
      tabs.forEach(function (item) {
        var active = item === tab;
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
        document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
      });
      if (focus) tab.focus();
    }
    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () { selectTab(tab, false); });
      tab.addEventListener('keydown', function (event) {
        var next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next !== undefined) { event.preventDefault(); selectTab(tabs[next], true); }
      });
    });
    tablist.hidden = false;
  }
  var downloads = document.querySelectorAll('[data-download]');
  if (!downloads.length || !window.fetch) return;
  fetch('https://api.github.com/repos/tasty-foods/whatsbackup/releases/latest', { headers: { accept: 'application/vnd.github+json' } })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (release) {
      if (!release || release.draft || release.prerelease || !Array.isArray(release.assets)) return;
      var version = String(release.tag_name || '').replace(/^v/, '');
      if (!/^\d+\.\d+\.\d+$/.test(version)) return;
      var installer = release.assets.find(function (asset) { return asset.name === 'WhatsBackUp-Setup-' + version + '.exe'; });
      var expected = 'https://github.com/tasty-foods/whatsbackup/releases/download/' + release.tag_name + '/' + installer?.name;
      if (!installer || installer.browser_download_url !== expected) return;
      downloads.forEach(function (link) { link.href = installer.browser_download_url; });
      document.querySelectorAll('[data-version]').forEach(function (node) { node.textContent = version; });
      if (Number.isFinite(installer.size) && installer.size > 0) {
        document.querySelectorAll('[data-size]').forEach(function (node) { node.textContent = Math.round(installer.size / 1048576) + ' MB'; });
      }
      document.querySelectorAll('[data-release]').forEach(function (link) { link.href = 'https://github.com/tasty-foods/whatsbackup/releases/tag/' + release.tag_name; });
    })
    .catch(function () { /* Keep the published fallback installer. */ });
})();
