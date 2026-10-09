(function() {
  'use strict';

  // ===== CONFIG =====
  var SKIP_NONVIDEO_SEC = 12;    // non-video page: skip after this many seconds without a video
  var NEXT_WAIT_TRIES = 60;      // max seconds to wait for the course sidebar to load
  var STALL_RECOVER_MS = 10000;  // no playback progress for this long -> try recovery
  var STALL_RELOAD_MS = 25000;   // still no progress -> reload page to recover
  var MAX_RELOADS = 3;           // anti-loop guard for emergency reloads

  // ===== HELPERS =====
  function resId(url) {
    var m = String(url || '').match(/[?&]id=(\d+)/);
    return m ? m[1] : null;
  }
  function visible(el) { return el && el.offsetWidth > 0 && el.offsetHeight > 0; }
  function absUrl(h) {
    return h.indexOf('http') === 0 ? h :
      location.origin + (h.charAt(0) === '/' ? '' : '/') + h;
  }
  // Find the sidebar link that follows the current resource.
  // Returns: null = list not loaded yet, '' = no next item, url = next resource.
  function findNextUrl() {
    var links = document.querySelectorAll('a[href*="fsresource"]');
    var curId = resId(location.href);
    for (var i = 0; i < links.length; i++) {
      var h = links[i].getAttribute('href') || '';
      if (!h) continue;
      if (resId(h) === curId) {
        for (var j = i + 1; j < links.length; j++) {
          var h2 = links[j].getAttribute('href') || '';
          if (h2 && resId(h2) !== curId) return absUrl(h2);
        }
        return ''; // current item is the last one
      }
    }
    return null;
  }

  // ===== PAGE TYPE =====
  var isFsResource = location.href.indexOf('fsresource') >= 0;
  // Reliable, zero-cost PDF detection: tab title like "4.1 xxx.pdf | 蕴瑜课堂"
  var isPdf = isFsResource && /\.pdf\b/i.test(document.title || '');

  // ===== KILL SWITCH (click the YYKT logo to toggle) =====
  var disabled = false;
  try { disabled = localStorage.__yykt_disabled === '1'; } catch(e) {}

  // ===== LAST VIDEO RESUME =====
  // __yykt_last_video is saved in setup() only after a real video is found,
  // so PDF pages never poison the resume target.
  var isHomePage = location.pathname === '/' || location.pathname === '' ||
                   location.href === 'https://courses.gdut.edu.cn/' ||
                   location.pathname.indexOf('/my') >= 0 ||
                   location.pathname.indexOf('/dashboard') >= 0;
  if (isHomePage && !disabled) {
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

  // ===== STATE BAR (static; logo click toggles the kill switch) =====
  var bar = document.createElement('div');
  bar.id = 'yykt_bar';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;' +
    'background:#0d1117;color:#eee;font-size:12px;padding:6px 14px;' +
    'font-family:sans-serif;display:flex;align-items:center;gap:10px;';
  bar.innerHTML = '<b id="y_logo" style="color:#58a6ff;cursor:pointer;user-select:none;">YYKT</b>' +
    '<span id="y_msg">init</span><span style="flex:1;"></span><span id="y_time"></span>';
  document.body.prepend(bar);

  var lastMsg = '';
  function log(s) {
    if (s === lastMsg) return; // dedupe: repeated identical DOM writes are waste
    lastMsg = s;
    var e = document.getElementById('y_msg');
    if (e) e.textContent = s;
  }
  window.onerror = function(msg, src, line) {
    try { log('err: ' + msg + ' @' + line); } catch(e) {}
    return false;
  };
  function timeStr(t) {
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  document.getElementById('y_logo').addEventListener('click', function() {
    try {
      if (disabled) {
        delete localStorage.__yykt_disabled;
        log('enabled - reloading...');
      } else {
        localStorage.__yykt_disabled = '1';
        disabled = true;
        log('DISABLED - click YYKT again to re-enable');
        return;
      }
    } catch(e) {}
    setTimeout(function() { location.reload(); }, 600);
  });

  if (disabled) { log('OFF - click YYKT to enable'); return; }

  // ===== PDF FAST PATH: MINIMAL SKIP MODE =====
  // No MutationObserver, no verification scanning, no watchdog, no dialog
  // clicking. Just one lightweight 1s interval that waits for the course
  // sidebar and jumps to the next resource. Minimal footprint = nothing for
  // the site's own PDF scripts to collide with.
  if (isPdf) {
    log('pdf detected - minimal skip mode');
    var pdfTries = 0;
    var pdfTimer = setInterval(function() {
      try {
        pdfTries++;
        var next = findNextUrl();
        if (next) {
          clearInterval(pdfTimer);
          log('pdf - jumping to next resource...');
          setTimeout(function() { location.href = next; }, 500);
          return;
        }
        if (next === '') { clearInterval(pdfTimer); log('pdf - all resources done'); return; }
        if (pdfTries >= NEXT_WAIT_TRIES) {
          clearInterval(pdfTimer);
          log('pdf - resource list never loaded');
          return;
        }
        log('pdf - waiting for list (' + pdfTries + '/' + NEXT_WAIT_TRIES + ')');
      } catch(e) { log('err(pdf): ' + e.message); }
    }, 1000);
    return; // PDF page ends here - nothing else runs
  }

  // ===== BELOW THIS LINE: FULL MODE (video pages / unknown resource pages) =====

  var video = null;
  var holding = false;
  var holdTimer = null;
  var nextTriggered = false;
  var navigating = false;
  var findTicks = 0;
  var baselinePct = null;   // page progress read BEFORE this session contributed (previous progress)

  function goNextSoon(msg) {
    if (navigating) return;
    navigating = true;
    if (msg) log(msg);
    setTimeout(goNext, 800);
  }

  var goNextTries = 0;
  function goNext() {
    try {
      var next = findNextUrl();
      if (next) {
        log('next resource...');
        location.href = next;
        return;
      }
      if (next === '') { log('all done!'); return; }
      // Sidebar not loaded yet: retry for a while
      goNextTries++;
      if (goNextTries <= NEXT_WAIT_TRIES) {
        log('waiting for resource list... (' + goNextTries + '/' + NEXT_WAIT_TRIES + ')');
        setTimeout(goNext, 2000);
        return;
      }
      log('all done!');
    } catch(e) { log('err(next): ' + e.message); }
  }

  function setup(v) {
    video = v;
    log('video found');

    try { localStorage.__yykt_last_video = location.href; } catch(e) {}

    // Silent-audio keepalive: an (inaudible, gain=0.001) oscillator makes
    // Chrome treat this tab as "playing audio", so background timer
    // throttling never kicks in. The site's progress heartbeat keeps firing
    // and the "网络异常" alert stops appearing at the source.
    try {
      if (!window.__yyktKeepAlive) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          var ctx = new AC();
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          gain.gain.value = 0.001;
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
          window.__yyktKeepAlive = true;
        }
      }
    } catch(e) {}

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
      if (!nextTriggered && v.currentTime < v.duration - 2) {
        setTimeout(function() { v.play().catch(function(){}); }, 200);
      }
    });
    v.addEventListener('ended', function() {
      if (!nextTriggered) { log('ended - next...'); nextTriggered = true; goNextSoon(''); }
    });
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

  // Single driver loop for finding the video / deciding to skip
  var findTimer = setInterval(function() {
    try {
      if (video || navigating) return;
      var v = findVideoElement();
      if (v) { clearInterval(findTimer); setup(v); return; }

      findTicks++;
      if (findTicks >= SKIP_NONVIDEO_SEC) {
        clearInterval(findTimer);
        nextTriggered = true;
        goNextSoon('no video here - skipping...');
      } else if (findTicks % 3 === 0) {
        log('looking for video...');
      }
    } catch(e) { log('err(find): ' + e.message); }
  }, 1000);

  // ===== "MY PLAYBACK PROGRESS" =====
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

  setInterval(function() {
    try {
      if (nextTriggered || !video) return;
      var myPct = findMyProgress();
      if (myPct === null) {
        if (Math.random() < 0.2) log('looking for progress...');
        return;
      }

      // First readable reading = the progress carried over from previous
      // sessions (our own playback has barely started). If that is already
      // >= 90%, this video is finished - skip it right away.
      if (baselinePct === null) {
        baselinePct = myPct;
        if (myPct >= 90) {
          log('already completed (' + myPct + '%) - skipping...');
          nextTriggered = true;
          goNextSoon('');
          return;
        }
      }

      if (video.paused) return;
      log('my progress: ' + myPct + '%');
      if (myPct >= 90) {
        // The site's "我的播放进度" is 累计观看时长/视频总时长 - it can run ahead
        // of the real playback position, so never jump unless the REAL
        // position reached 90% too.
        var dur = video.duration;
        var realPct = (isFinite(dur) && dur > 0) ? (video.currentTime / dur) * 100 : 100;
        if (realPct >= 90) {
          log('progress ' + myPct + '% + actual ' + realPct.toFixed(1) + '% >= 90% -> going next!');
          nextTriggered = true;
          goNextSoon('');
        } else {
          log('server ' + myPct + '% but actual ' + realPct.toFixed(1) + '% - keep watching');
        }
      }
    } catch(e) { log('err(prog): ' + e.message); }
  }, 3000);

  // ===== DIALOG AUTO-CLICK =====
  var DIALOG_BTN_TEXT = /^(继续|继续播放|重新播放|重试|确定|恢复播放|播放)$/;

  function clickDialogButtons() {
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
  }
  setInterval(function() { if (video) clickDialogButtons(); }, 2000);

  // ===== STALL WATCHDOG =====
  var lastPos = -1;
  var lastMoveTs = Date.now();
  var reloads = 0;
  try { reloads = parseInt(sessionStorage.__yykt_reloads || '0', 10) || 0; } catch(e) {}

  setInterval(function() {
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
  }, 3000);

  // ===== VERIFICATION HOLD (throttled scan) =====
  var lastHoldScan = 0;
  function scanHold() {
    if (holding) return;
    var now = Date.now();
    if (now - lastHoldScan < 2000) return; // throttle: at most one scan per 2s
    lastHoldScan = now;

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

  setInterval(scanHold, 2000);

  // Observer is only a backup trigger for scanHold, hard-throttled, and it
  // never re-enters findVideo and never writes DOM.
  var observer = new MutationObserver(function() { scanHold(); });
  observer.observe(document.body, { childList: true, subtree: true });

})();
