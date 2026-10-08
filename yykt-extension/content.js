(function() {
  'use strict';

  // ===== CONFIG =====
  var SKIP_PDF_SEC = 4;          // PDF page: skip after this many seconds without a video
  var SKIP_NONVIDEO_SEC = 12;    // any other non-video page: fallback skip timeout
  var NEXT_WAIT_TRIES = 30;      // goNext: retries while the course sidebar is still loading
  var STALL_RECOVER_MS = 10000;  // no playback progress for this long -> try recovery
  var STALL_RELOAD_MS = 25000;   // still no progress -> reload page to recover
  var MAX_RELOADS = 3;           // anti-loop guard for emergency reloads

  // ===== GLOBAL ERROR SURFACE (visible in status bar) =====
  window.onerror = function(msg, src, line) {
    try { log('err: ' + msg + ' @' + line); } catch(e) {}
    return false;
  };

  // ===== HELPERS =====
  // Extract numeric resource id from "...view.php?id=123" style URLs
  function resId(url) {
    var m = String(url || '').match(/[?&]id=(\d+)/);
    return m ? m[1] : null;
  }

  function visible(el) { return el && el.offsetWidth > 0 && el.offsetHeight > 0; }

  // ===== ONLY FULL MODE ON RESOURCE PAGES =====
  var isFsResource = location.href.indexOf('fsresource') >= 0;

  // ===== LAST VIDEO RESUME =====
  // NOTE: __yykt_last_video is saved inside setup() (only when a real video
  // was found), so PDF pages no longer poison the resume target.

  var isHomePage = location.pathname === '/' || location.pathname === '' ||
                   location.href === 'https://courses.gdut.edu.cn/' ||
                   location.pathname.indexOf('/my') >= 0 ||
                   location.pathname.indexOf('/dashboard') >= 0;
  if (isHomePage) {
    var redirected = false;
    try { redirected = sessionStorage.__yykt_redirected === '1'; } catch(e) {}
    if (!redirected) {
      var lastUrl = '';
      try { lastUrl = localStorage.__yykt_last_video || ''; } catch(e) {}
      if (lastUrl && lastUrl.indexOf('fsresource') >= 0) {
        try { sessionStorage.__yykt_redirected = '1'; } catch(e) {}
        location.replace(lastUrl);
        return;
      }
    }
  }
  if (isFsResource) {
    try { sessionStorage.__yykt_redirected = ''; } catch(e) {}
  }

  if (!isFsResource) return;

  // ===== BELOW THIS LINE: RESOURCE PAGE ONLY =====

  // State bar
  var bar = document.createElement('div');
  bar.id = 'yykt_bar';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;' +
    'background:#0d1117;color:#eee;font-size:12px;padding:6px 14px;' +
    'font-family:sans-serif;display:flex;align-items:center;gap:10px;';
  bar.innerHTML = '<b style="color:#58a6ff;">YYKT</b> <span id="y_msg">init</span>' +
    '<span style="flex:1;"></span><span id="y_time"></span>';
  document.body.prepend(bar);

  // Log only on message change: repeated identical writes feed the
  // MutationObserver and can livelock the page.
  var lastMsg = '';
  function log(s) {
    if (s === lastMsg) return;
    lastMsg = s;
    var e = document.getElementById('y_msg');
    if (e) e.textContent = s;
  }
  function timeStr(t) {
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  // ===== STATE =====
  var video = null;
  var holding = false;
  var holdTimer = null;
  var nextTriggered = false;
  var navigating = false;
  var findTicks = 0;   // seconds elapsed since we started looking for a video

  // ===== PDF / NON-VIDEO DETECTION =====
  // Signals (checked in order):
  //  1. page title ends with .pdf   (most reliable: tab shows "xxx.pdf | ...")
  //  2. sidebar link title of the current resource ends with .pdf
  //  3. an embedded PDF viewer exists on the page
  function isPdfPage() {
    try {
      if (/\.pdf\b/i.test(document.title || '')) return true;
      var curId = resId(location.href);
      if (curId) {
        var links = document.querySelectorAll('a[href*="fsresource"]');
        for (var i = 0; i < links.length; i++) {
          var h = links[i].getAttribute('href') || '';
          if (resId(h) === curId) {
            if (/\.pdf\b/i.test(links[i].textContent || '')) return true;
          }
        }
      }
      if (document.querySelector('embed[type*="pdf"], object[data*=".pdf"], iframe[src*=".pdf"]')) return true;
    } catch(e) { log('err(pdf): ' + e.message); }
    return false;
  }

  // ===== FIND VIDEO (interval-driven, no retry chains, no observer recursion) =====
  function findVideoElement() {
    var v = document.querySelector('video');
    if (v && v.offsetWidth > 0) return v;
    var ifs = document.querySelectorAll('iframe');
    for (var i = 0; i < ifs.length; i++) {
      try {
        var d = ifs[i].contentDocument || ifs[i].contentWindow.document;
        v = d && d.querySelector('video');
        if (v && v.offsetWidth > 0) return v;
      } catch(e) {}
    }
    return null;
  }

  function findVideoTick() {
    try {
      if (video || navigating) return;
      var v = findVideoElement();
      if (v) { setup(v); return; }

      findTicks++;
      var isPdf = isPdfPage();
      var limit = isPdf ? SKIP_PDF_SEC : SKIP_NONVIDEO_SEC;
      if (findTicks >= limit) {
        // Non-video resource (PDF etc.): skip it and keep walking until a video page.
        nextTriggered = true;
        goNextSoon(isPdf ? 'pdf detected - skipping...' : 'no video here - skipping...');
      } else if (findTicks % 3 === 0) {
        log(isPdf ? 'pdf detected, skip in ' + (limit - findTicks) + 's...'
                  : 'looking for video...');
      }
    } catch(e) {
      log('err(find): ' + e.message);
    }
  }

  function setup(v) {
    video = v;
    log('video found');

    // Remember this page as the resume target ONLY when a video is confirmed
    try { localStorage.__yykt_last_video = location.href; } catch(e) {}

    // Prevent browser from suspending video when minimized
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }

    v.muted = true;
    var p = v.play();
    if (p && p.then) {
      p.then(function() { log('auto-playing'); })
       .catch(function() { log('click to start'); });
    }

    v.addEventListener('play',  function() {
      log('playing');
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    });
    v.addEventListener('pause', function() {
      log('paused');
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      // Auto-resume if unexpectedly paused (browser throttling)
      if (!nextTriggered && v.currentTime < v.duration - 2) {
        setTimeout(function() { v.play().catch(function(){}); }, 200);
      }
    });
    v.addEventListener('ended', function() {
      if (!nextTriggered) { log('ended - next...'); nextTriggered = true; goNextSoon(''); }
    });
    // Media stream network error: reload the source automatically.
    // If the source is dead, the stall watchdog will reload the page as fallback.
    v.addEventListener('error', function() {
      log('media error - retrying source...');
      setTimeout(function() {
        try {
          v.load();
          var rp = v.play();
          if (rp && rp.catch) rp.catch(function() {});
        } catch(e) {}
      }, 1500);
    });
    v.addEventListener('timeupdate', function() {
      if (v.duration) {
        var el = document.getElementById('y_time');
        if (el) el.textContent = timeStr(v.currentTime) + ' / ' + timeStr(v.duration);
      }
    });
  }

  // ===== FIND "MY PLAYBACK PROGRESS" ON PAGE =====
  function findMyProgress() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while (node = walker.nextNode()) {
      var txt = node.textContent.trim();
      if (txt.indexOf('我的播放进度') >= 0) {
        var parent = node.parentElement;
        if (!parent) continue;

        var parentText = (parent.textContent || '').trim();
        var m = parentText.match(/(\d+(?:\.\d+)?)\s*%/);
        if (m) {
          var pct = parseFloat(m[1]);
          if (pct >= 0 && pct <= 100) return pct;
        }

        var next = parent.nextElementSibling;
        while (next) {
          var nextText = (next.textContent || '').trim();
          var nm = nextText.match(/^(\d+(?:\.\d+)?)\s*%$/);
          if (nm) return parseFloat(nm[1]);
          nm = nextText.match(/(\d+(?:\.\d+)?)\s*%/);
          if (nm) return parseFloat(nm[1]);
          next = next.nextElementSibling;
        }

        var children = parent.querySelectorAll('*');
        for (var i = 0; i < children.length; i++) {
          var childText = (children[i].textContent || '').trim();
          var cm = childText.match(/^(\d+(?:\.\d+)?)\s*%$/);
          if (cm) return parseFloat(cm[1]);
        }

        if (m) return parseFloat(m[1]);
      }
    }
    return null;
  }

  // ===== CHECK MY PROGRESS -> GO NEXT =====
  function checkProgress() {
    if (nextTriggered) return;
    if (!video || video.paused) return;

    var myPct = findMyProgress();
    if (myPct === null) {
      if (Math.random() < 0.2) log('looking for progress...');
      return;
    }

    log('my progress: ' + myPct + '%');

    if (myPct >= 90) {
      log('progress ' + myPct + '% >= 90% -> going next!');
      nextTriggered = true;
      goNextSoon('');
    }
  }

  // ===== NEXT =====
  // Strict matching by resource id: "id=17828" no longer matches "id=178282".
  // The course sidebar loads asynchronously (empty skeleton on first seconds),
  // so retry while no usable link list exists instead of giving up.
  var goNextTries = 0;
  function goNext() {
    try {
      var links = document.querySelectorAll('a[href*="fsresource"]');
      var curId = resId(location.href);
      var found = false;
      for (var i = 0; i < links.length; i++) {
        var h = links[i].getAttribute('href') || '';
        if (!h) continue;
        var id = resId(h);
        if (id && id === curId) { found = true; continue; }
        if (found) {
          var url = h.startsWith('http') ? h :
            location.origin + (h.startsWith('/') ? '' : '/') + h;
          log('next: ' + (links[i].textContent || '').substring(0, 30));
          location.href = url;
          return;
        }
      }
      // Sidebar not loaded yet (or current item missing): keep waiting a while
      if (goNextTries++ < NEXT_WAIT_TRIES) {
        log('waiting for resource list... (' + goNextTries + '/' + NEXT_WAIT_TRIES + ')');
        setTimeout(goNext, 2000);
        return;
      }
      log('all done!');
    } catch(e) {
      log('err(next): ' + e.message);
    }
  }

  function goNextSoon(msg) {
    if (navigating) return;
    navigating = true;
    if (msg) log(msg);
    setTimeout(goNext, 800);
  }

  // ===== DIALOG AUTO-CLICK (network error / confirm popups) =====
  var DIALOG_BTN_TEXT = /^(继续|继续播放|重新播放|重试|确定|恢复播放|播放)$/;

  function clickDialogButtons() {
    try {
      var sels = '.ui-dialog button, .ui-dialog-buttonpane button, .layui-layer-btn a, ' +
        '.modal button, .modal .btn, [class*="dialog"] button, [class*="dialog"] a.btn, ' +
        '[class*="modal"] button, [class*="modal"] .btn, [class*="popup"] button, ' +
        'button, a.btn, .btn';
      var els = document.querySelectorAll(sels);
      var now = Date.now();
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!visible(el)) continue;
        var txt = (el.textContent || '').trim();
        if (!txt || !DIALOG_BTN_TEXT.test(txt)) continue;
        if (el.offsetHeight > 60 || el.offsetWidth > 400) continue;
        var last = parseInt(el.dataset._ylast || '0', 10);
        if (now - last < 5000) continue;
        el.dataset._ylast = String(now);
        log('auto-click dialog: ' + txt);
        try { el.click(); } catch(e) {}
      }
    } catch(e) { log('err(dlg): ' + e.message); }
  }

  // ===== STALL WATCHDOG (auto-recovery without human action) =====
  var lastPos = -1;
  var lastMoveTs = Date.now();
  var reloads = 0;
  try { reloads = parseInt(sessionStorage.__yykt_reloads || '0', 10) || 0; } catch(e) {}

  function watchdog() {
    try {
      if (!video || nextTriggered || holding) { lastMoveTs = Date.now(); return; }
      if (video.ended) return;

      var t = video.currentTime;
      if (Math.abs(t - lastPos) > 0.4) {
        lastPos = t;
        lastMoveTs = Date.now();
        if (reloads > 0) {
          reloads = 0;
          try { sessionStorage.__yykt_reloads = '0'; } catch(e) {}
        }
        return;
      }

      var stuckFor = Date.now() - lastMoveTs;
      if (stuckFor > STALL_RECOVER_MS) {
        log('stalled ' + Math.round(stuckFor / 1000) + 's - recovering...');
        clickDialogButtons();
        if (video.paused || video.readyState < 3) {
          var p = video.play();
          if (p && p.catch) p.catch(function() {});
        }
        if (stuckFor > STALL_RELOAD_MS && reloads < MAX_RELOADS) {
          reloads++;
          try { sessionStorage.__yykt_reloads = String(reloads); } catch(e) {}
          log('reload to recover (#' + reloads + ')');
          setTimeout(function() { location.reload(); }, 800);
        }
      }
    } catch(e) { log('err(wd): ' + e.message); }
  }

  // ===== VERIFICATION HOLD =====
  function scanHold() {
    if (holding) return;
    var els = document.querySelectorAll('button, [role="button"], div[class*="btn"], div[class*="hold"], div[class*="verify"], span[class*="btn"], span[class*="hold"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
      var txt = (el.textContent || '').trim();
      if (!txt) continue;
      if (el.dataset._yheld) continue;

      var txtLower = txt.toLowerCase();
      var id = (el.id || '').toLowerCase();
      var cls = ((el.className || '') + '').toLowerCase();

      var isHold = false;

      if (txt.indexOf('按住') >= 0 || txt.indexOf('长按') >= 0 || txt.indexOf('确认你在观看') >= 0) {
        isHold = true;
      }
      if (txtLower.indexOf('hold') >= 0 || txtLower.indexOf('press and hold') >= 0 || txtLower === 'press') {
        isHold = true;
      }
      if (id.indexOf('hold') >= 0 || id.indexOf('verify') >= 0) isHold = true;
      if (cls.indexOf('hold') >= 0 || cls.indexOf('verify') >= 0) isHold = true;

      if (!isHold) continue;

      if (txt.length > 100 && el.tagName !== 'BUTTON') continue;

      el.dataset._yheld = '1';
      log('verification detected - auto holding...');
      doHold(el);
      return;
    }
  }

  function doHold(btn) {
    holding = true;
    var r = btn.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var elapsed = 0;

    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy }));
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse', isPrimary: true }));

    holdTimer = setInterval(function() {
      elapsed += 200;
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx + Math.random() * 2, clientY: cy + Math.random() * 2 }));
      log('holding... ' + Math.max(0, Math.ceil((8000 - elapsed) / 1000)) + 's');

      if (elapsed >= 8000 || btn.offsetWidth === 0) {
        clearInterval(holdTimer);
        holdTimer = null;
        holding = false;
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy }));
        btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        log('verification passed!');
        if (video && video.paused) video.play().catch(function() {});
      }
    }, 200);
  }

  // ===== START =====
  log('activating...');

  // Single driver loop: no retry chains, observer never re-enters findVideo
  setInterval(findVideoTick, 1000);

  setInterval(function() {
    if (video && !nextTriggered) checkProgress();
  }, 3000);

  setInterval(scanHold, 3000);

  setInterval(clickDialogButtons, 2000);

  setInterval(watchdog, 3000);

  // Observer only handles the hold-verification; findVideo is driven by the
  // interval above, so logging can never feed back into an infinite loop.
  var observer = new MutationObserver(function() {
    scanHold();
  });
  observer.observe(document.body, { childList: true, subtree: true });

})();
