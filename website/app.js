// Fills the download links with the newest release assets and highlights the visitor's OS.
// releases.json is written by .github/scripts/pages-releases.mjs when the site is deployed; if it
// is missing (local preview) the public GitHub API is asked instead. Without either, every link
// keeps its static fallback: the GitHub Releases page.
(function () {
  'use strict';

  var REPO = 'emashiq/framecapt';

  // Same rules as .github/scripts/pages-releases.mjs.
  var MATCHERS = {
    windowsSetup: /^FrameCapt-Setup-.*\.exe$/,
    windowsZip: /^FrameCapt-win32-x64-.*\.zip$/,
    appImage: /\.AppImage$/,
    deb: /_amd64\.deb$/,
  };

  function formatSize(bytes) {
    return bytes ? Math.round(bytes / 1048576) + ' MB' : '';
  }

  // Newest non-draft release that carries each kind of asset (a release may be Windows-only).
  function pickFromApi(releases) {
    var out = {};
    releases
      .filter(function (r) {
        return !r.draft;
      })
      .forEach(function (release) {
        release.assets.forEach(function (asset) {
          Object.keys(MATCHERS).forEach(function (key) {
            if (!out[key] && MATCHERS[key].test(asset.name)) {
              var sums = release.assets.find(function (a) {
                return a.name === 'SHA256SUMS.txt';
              });
              out[key] = {
                name: asset.name,
                url: asset.browser_download_url,
                size: asset.size,
                tag: release.tag_name,
                checksums: sums ? sums.browser_download_url : null,
              };
            }
          });
        });
      });
    return out;
  }

  function load() {
    return fetch('releases.json', { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('no releases.json');
        return res.json();
      })
      .then(function (data) {
        return data.assets;
      })
      .catch(function () {
        return fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=30')
          .then(function (res) {
            if (!res.ok) throw new Error('GitHub API ' + res.status);
            return res.json();
          })
          .then(pickFromApi);
      });
  }

  function apply(assets) {
    document.querySelectorAll('[data-asset]').forEach(function (link) {
      var key = link.getAttribute('data-asset');
      if (key === 'checksums') {
        var main = assets.windowsSetup || assets.appImage;
        if (main && main.checksums) link.href = main.checksums;
        return;
      }
      var asset = assets[key];
      if (!asset) return;
      link.href = asset.url;
      var meta = link.querySelector('[data-meta]');
      if (meta)
        meta.textContent = [asset.tag, formatSize(asset.size), asset.name]
          .filter(Boolean)
          .join(' · ');
    });

    var line = document.getElementById('release-line');
    var win = assets.windowsSetup;
    if (line && win) {
      var text = 'Latest: ' + win.tag + ' (Windows)';
      if (assets.appImage) text += ' · ' + assets.appImage.tag + ' (Linux)';
      line.textContent = text + '. Pre-release builds, unsigned.';
    }
    return assets;
  }

  function detectOs() {
    var platform =
      (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var ua = navigator.userAgent || '';
    if (/win/i.test(platform) || /Windows/.test(ua)) return 'windows';
    if (/linux/i.test(platform) && !/Android/.test(ua)) return 'linux';
    return null;
  }

  function highlightOs(assets) {
    var os = detectOs();
    var hero = document.getElementById('hero-download');
    if (!os || !hero) return;
    var card = document.getElementById('card-' + os);
    if (card) card.classList.add('recommended');
    var key = os === 'windows' ? 'windowsSetup' : 'appImage';
    var label = hero.querySelector('span');
    if (label) label.textContent = 'Download for ' + (os === 'windows' ? 'Windows' : 'Linux');
    if (assets && assets[key]) hero.href = assets[key].url;
  }

  // Docs page: mark the table-of-contents entry of the last section whose heading has scrolled
  // past the top third of the window.
  function trackToc() {
    var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
    var sections = links
      .map(function (a) {
        return document.getElementById(a.getAttribute('href').slice(1));
      })
      .filter(Boolean);
    if (!sections.length) return;
    var pending = false;
    function update() {
      pending = false;
      var current = sections[0];
      sections.forEach(function (section) {
        if (section.getBoundingClientRect().top < window.innerHeight / 3) current = section;
      });
      links.forEach(function (a) {
        a.classList.toggle('active', a.getAttribute('href') === '#' + current.id);
      });
    }
    window.addEventListener(
      'scroll',
      function () {
        if (!pending) {
          pending = true;
          requestAnimationFrame(update);
        }
      },
      { passive: true },
    );
    update();
  }

  trackToc();
  if (document.querySelector('[data-asset]')) {
    load()
      .then(apply)
      .then(highlightOs)
      .catch(function () {
        highlightOs(null);
      });
  }
})();
