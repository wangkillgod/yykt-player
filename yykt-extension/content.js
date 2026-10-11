(function() {
  'use strict';

  // ===== CONFIG =====
  var SKIP_NONVIDEO_SEC = 12;    // non-video page: skip after this many seconds without a video
  var NEXT_WAIT_TRIES = 60;      // max seconds to wait for the course sidebar to load
  var STALL_RECOVER_MS = 10000;  // no playback progress for this long -> try recovery
  var STALL_RELOAD_MS = 25000;   // still no progress -> reload page to recover
  var MAX_RELOADS = 3;           // anti-loop guard for emergency reloads
  var COURSE_ARCHIVE_URL = 'https://courses.gdut.edu.cn/local/course_archive/student.php';

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

  // ===== COURSE MEMORY =====
  // Stores completed course IDs as a JSON array in localStorage.
  // A course is marked completed when we reach its quiz page (course end).
  function getCompletedCourses() {
    try { return JSON.parse(localStorage.__yykt_completed_courses || '[]'); }
    catch(e) { return []; }
  }
  function isCourseCompleted(courseId) {
    if (!courseId) return false;
    return getCompletedCourses().indexOf(String(courseId)) >= 0;
  }
  function markCourseCompleted(courseId) {
    if (!courseId) return;
    var list = getCompletedCourses();
    if (list.indexOf(String(courseId)) < 0) {
      list.push(String(courseId));
      try { localStorage.__yykt_completed_courses = JSON.stringify(list); } catch(e) {}
    }
  }

  // ===== COURSE ID HELPERS =====
  function getCourseIdFromUrl(url) {
    var m = String(url || location.href).match(/course\/view\.php\?id=(\d+)/);
    return m ? m[1] : null;
  }
  // Get current course ID: sessionStorage (set by course home page) > URL > breadcrumb links
  function getCurrentCourseId() {
    try {
      var sid = sessionStorage.__yykt_course_id;
      if (sid) return sid;
    } catch(e) {}
    var fromUrl = getCourseIdFromUrl();
    if (fromUrl) return fromUrl;
    var links = document.querySelectorAll('a[href*="course/view.php"]');
    for (var i = 0; i < links.length; i++) {
      var h = links[i].getAttribute('href') || '';
      var m = h.match(/id=(\d+)/);
      if (m) return m[1];
    }
    return null;
  }
  function goToCourseArchive() {
    location.href = COURSE_ARCHIVE_URL;
  }

  // ===== PAGE TYPE =====
  var isFsResource = location.href.indexOf('fsresource') >= 0;
  var isPdf = isFsResource && /\.pdf\b/i.test(document.title || '');
  var isQuiz = location.href.indexOf('mod/quiz') >= 0;
  var isCourseArchive = location.pathname.indexOf('course_archive/student.php') >= 0;
  var isCourseView = location.pathname.indexOf('course/view.php') >= 0;
  var isLoginPage = /login|登录|登陆/i.test(document.title || '') ||
                    location.href.indexOf('login') >= 0;

  // Only handle pages we know about
  if (!isFsResource && !isQuiz && !isCourseArchive && !isCourseView) return;

  // ===== KILL SWITCH (click the YYKT logo to toggle) =====
  var disabled = false;
  try { disabled = localStorage.__yykt_disabled === '1'; } catch(e) {}

  // ===== LAST VIDEO RESUME =====
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

  // ===== LOGIN PAGE DETECTION =====
  if (isLoginPage) {
    // Create a minimal status bar to alert the user
    var loginBar = document.createElement('div');
    loginBar.id = 'yykt_bar';
    loginBar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;' +
      'background:#8b0000;color:#fff;font-size:13px;padding:8px 14px;' +
      'font-family:sans-serif;text-align:center;';
    loginBar.innerHTML = '<b style="color:#ffcc00;">YYKT</b> 检测到登录页面 — 请手动登录后刷新页面，插件将继续自动播放';
    document.body.prepend(loginBar);
    return; // do nothing else on login page
  }

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

  // === Logging system with in-memory buffer (prevents log loss on page nav) ===
  var LOG_KEY = '__yykt_logs';
  var SETTINGS_KEY = '__yykt_settings';
  var LOG_RETENTION_DAYS = 7;
  var logEnabled = false; // cached, updated async from chrome.storage
  var logBuffer = []; // in-memory buffer, flushed to storage periodically
  var lastLogSecond = ''; // for deduping same-second repeated logs

  // Load settings from chrome.storage.local
  try {
    chrome.storage.local.get([SETTINGS_KEY], function(result) {
      if (result[SETTINGS_KEY] && result[SETTINGS_KEY].enableLog === true) {
        logEnabled = true;
      }
    });
  } catch(e) {}

  // Listen for settings changes from popup
  try {
    chrome.storage.onChanged.addListener(function(changes, area) {
      if (area === 'local' && changes[SETTINGS_KEY]) {
        logEnabled = changes[SETTINGS_KEY].newValue && changes[SETTINGS_KEY].newValue.enableLog === true;
      }
    });
  } catch(e) {}

  // Flush buffer to chrome.storage.local
  function flushLogBuffer() {
    if (logBuffer.length === 0) return;
    var entries = logBuffer.splice(0, logBuffer.length);
    try {
      chrome.storage.local.get([LOG_KEY], function(result) {
        var logs = result[LOG_KEY] || {};
        for (var i = 0; i < entries.length; i++) {
          var dateStr = entries[i].date;
          if (!logs[dateStr]) logs[dateStr] = [];
          logs[dateStr].push(entries[i].text);
          if (logs[dateStr].length > 2000) {
            logs[dateStr] = logs[dateStr].slice(-2000);
          }
        }
        // Cleanup logs older than 7 days
        var cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - LOG_RETENTION_DAYS);
        var cutoffStr = cutoff.toISOString().slice(0, 10);
        for (var d in logs) {
          if (d < cutoffStr) delete logs[d];
        }
        chrome.storage.local.set({__yykt_logs: logs});
      });
    } catch(e) {}
  }

  // Flush every 2 seconds
  setInterval(flushLogBuffer, 2000);

  // Flush before page unload (navigation, refresh)
  window.addEventListener('beforeunload', function() {
    flushLogBuffer();
  });

  function writeLog(s) {
    if (!logEnabled) return;
    // Dedupe: skip if same message within the same second (e.g. holding... 8s repeated)
    var now = new Date();
    var secondKey = now.toTimeString().slice(0, 8) + '|' + s;
    if (secondKey === lastLogSecond) return;
    lastLogSecond = secondKey;

    var dateStr = now.toISOString().slice(0, 10);
    var timeStr = now.toTimeString().slice(0, 8);
    logBuffer.push({date: dateStr, text: '[' + timeStr + '] ' + s});
  }

  function log(s) {
    // Always output to console so full history is preserved
    try { console.log('[YYKT] ' + s); } catch(e) {}
    // Write to persistent log if enabled
    writeLog(s);
    if (s === lastMsg) return;
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

  // ================================================================
  // PAGE 1: QUIZ PAGE — course has ended, mark complete, go to archive
  // ================================================================
  if (isQuiz) {
    log('quiz detected - course finished!');
    var courseId = getCurrentCourseId();
    if (courseId) {
      markCourseCompleted(courseId);
      log('course ' + courseId + ' marked completed');
    } else {
      log('warning: could not determine course ID');
    }
    setTimeout(function() {
      log('going to course archive...');
      goToCourseArchive();
    }, 1500);
    return;
  }

  // ================================================================
  // PAGE 2: COURSE ARCHIVE — select next uncompleted course
  // ================================================================
  if (isCourseArchive) {
    log('course archive - selecting next course...');
    var archiveTries = 0;
    var archiveTimer = setInterval(function() {
      try {
        archiveTries++;
        // Find all "点击进入该课程" buttons
        var btns = document.querySelectorAll('button, a, [role="button"], input[type="button"]');
        var courseButtons = [];
        for (var i = 0; i < btns.length; i++) {
          var txt = (btns[i].textContent || btns[i].value || '').trim();
          if (txt.indexOf('点击进入该课程') >= 0 && visible(btns[i])) {
            courseButtons.push(btns[i]);
          }
        }
        if (courseButtons.length === 0) {
          if (archiveTries >= NEXT_WAIT_TRIES) {
            clearInterval(archiveTimer);
            log('course list never loaded - stopped');
          } else {
            log('waiting for course list (' + archiveTries + '/' + NEXT_WAIT_TRIES + ')');
          }
          return;
        }

        clearInterval(archiveTimer);
        var completed = getCompletedCourses();
        log('found ' + courseButtons.length + ' courses, ' + completed.length + ' completed');

        // Find first uncompleted course by trying to extract course ID from
        // the button or its card container. If we can't get the ID upfront,
        // click into the course home page and check there.
        var selected = null;
        for (var c = 0; c < courseButtons.length; c++) {
          var btn = courseButtons[c];
          var cid = null;
          // Try button href
          var href = btn.getAttribute('href') || '';
          var m = href.match(/id=(\d+)/);
          if (m) cid = m[1];
          // Try links in the parent card
          if (!cid) {
            var card = btn.closest('div') || btn.parentElement;
            for (var depth = 0; depth < 5 && card; depth++) {
              var cardLinks = card.querySelectorAll('a[href*="course/view.php"]');
              for (var cl = 0; cl < cardLinks.length; cl++) {
                var ch = cardLinks[cl].getAttribute('href') || '';
                var cm = ch.match(/id=(\d+)/);
                if (cm) { cid = cm[1]; break; }
              }
              if (cid) break;
              card = card.parentElement;
            }
          }
          if (cid && isCourseCompleted(cid)) {
            log('course ' + cid + ' already completed, skipping...');
            continue;
          }
          selected = btn;
          break;
        }

        if (!selected) {
          log('ALL COURSES COMPLETED!');
          return;
        }

        log('entering next course...');
        setTimeout(function() { selected.click(); }, 800);
      } catch(e) { log('err(archive): ' + e.message); }
    }, 1000);
    return;
  }

  // ================================================================
  // PAGE 3: COURSE HOME (course/view.php) — scan ALL videos (with
  // scroll + expand), decide whether to skip course or resume.
  // ================================================================
  if (isCourseView) {
    var viewCourseId = getCourseIdFromUrl();
    if (viewCourseId) {
      try { sessionStorage.__yykt_course_id = viewCourseId; } catch(e) {}
      log('course home - id=' + viewCourseId);
    } else {
      log('course home - could not parse id');
    }

    // NOTE: Even if this course is in our completed-memory, we still scan
    // all videos.  Earlier versions had a scan bug that could mark a course
    // complete prematurely; the memory may be stale.  Only skip if a fresh
    // scan confirms every video is done.  If we find unfinished videos, we
    // remove the stale memory entry and resume playback.
    var memorySaysDone = viewCourseId ? isCourseCompleted(viewCourseId) : false;
    if (memorySaysDone) {
      log('course ' + viewCourseId + ' in completed-memory, but re-scanning to verify...');
    }

    // Locate the main content area (exclude left sidebar nav links)
    function getMainContent() {
      return document.querySelector('#region-main, #region-main-box, .course-content, #page-content, [role="main"], #content, .region-content') || document.body;
    }

    // Check if an element is inside a sidebar/navigation block (not main content)
    function isInSidebar(el) {
      var node = el;
      while (node && node !== document.body) {
        var id = (node.id || '') + '';
        var cls = (node.className || '') + '';
        if (/side-pre|side-post|sidebar|block-region|navblock|course-menu|left-nav/i.test(id + ' ' + cls)) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    }

    function isRowCompleted(linkEl) {
      // Locate the ACTIVITY-level row (not section-level <li>)
      var row = linkEl.closest('li[class*="activity"]') ||
                linkEl.closest('div[class*="activity"]') ||
                linkEl.closest('li.modtype_resource') ||
                linkEl.closest('div[class*="resource"]') ||
                linkEl.parentElement;
      if (!row) return false;

      var rowText = (row.textContent || '').trim();

      // DEFINITELY unfinished: explicit "待办事项" or "未完成" text
      if (rowText.indexOf('待办事项') >= 0) return false;
      if (rowText.indexOf('未完成') >= 0) return false;

      // Check dedicated completion element.  If it says "完成", it's done.
      // (Don't require a specific class — Moodle themes vary.)
      var comp = row.querySelector('[class*="completion"]');
      if (comp) {
        var compText = (comp.textContent || comp.getAttribute('title') || comp.getAttribute('aria-label') || '').trim();
        if (compText.indexOf('待办') >= 0 || compText.indexOf('未完成') >= 0) return false;
        if (compText.indexOf('完成') >= 0 || compText.indexOf('已通过') >= 0 || compText.indexOf('已完成') >= 0) {
          return true;
        }
        // Also check completion element's own class for passed state
        var compCls = (comp.className || '') + '';
        if (/pass|complete|done|finished|success|y\b/i.test(compCls) && !/n\b|pending|uncomplete/i.test(compCls)) {
          return true;
        }
      }

      // Check for green check / done icon anywhere in the row
      var icons = row.querySelectorAll('i, span[class*="icon"], img[class*="icon"], [class*="check"]');
      for (var ic = 0; ic < icons.length; ic++) {
        var iconCls = (icons[ic].className || '') + '';
        if (/check|done|complete|success|tick/i.test(iconCls) && !/uncheck|pending|empty/i.test(iconCls)) {
          // Make sure it's not a "mark as complete" button (which says "标记完成")
          var iconParentText = (icons[ic].parentElement ? icons[ic].parentElement.textContent || '' : '');
          if (iconParentText.indexOf('标记完成') < 0) {
            return true;
          }
        }
      }

      // Last resort: very small row (activity-level) with "完成" and no
      // "待办"/"标记完成".  Rows >100 chars are likely section-level containers.
      if (rowText.length < 100 &&
          rowText.indexOf('完成') >= 0 &&
          rowText.indexOf('标记完成') < 0 &&
          rowText.indexOf('待办') < 0) {
        return true;
      }

      // DEFAULT: unfinished.  When in doubt, we'd rather re-watch a video
      // than skip one that isn't done.
      return false;
    }

    // Aggressively prepare the page: scroll to bottom (lazy-load), expand
    // all collapsed sections, click "全部展开" if present.
    // Prepare the page WITHOUT jumping to the bottom (which can land on the
    // quiz section and trigger false course-end detection). Instead: expand
    // all sections, then do a gentle top-to-bottom scroll to trigger lazy
    // loading, and return to the top before scanning.
    var scrollStep = 0;
    function preparePage() {
      // Start at top
      if (scrollStep === 0) {
        try { window.scrollTo(0, 0); } catch(e) {}
      }
      // Click "全部展开" if present
      var allEls = document.querySelectorAll('a, button, span');
      for (var i = 0; i < allEls.length; i++) {
        var t = (allEls[i].textContent || '').trim();
        if (t === '全部展开' || t === '展开所有') {
          try { allEls[i].click(); } catch(e) {}
          break;
        }
      }
      // Expand all collapsed toggles
      var collapsed = document.querySelectorAll('[aria-expanded="false"]');
      for (var j = 0; j < collapsed.length; j++) {
        try { collapsed[j].click(); } catch(e) {}
      }
      // Expand hidden/collapsed sections
      var sections = document.querySelectorAll('li.section, div[class*="section"]');
      for (var k = 0; k < sections.length; k++) {
        var cls = (sections[k].className || '') + '';
        if (/hidden|collapsed|closed/i.test(cls)) {
          var title = sections[k].querySelector('h3, .sectionname, [class*="title"]');
          if (title) { try { title.click(); } catch(e) {} }
        }
      }
      // Gentle incremental scroll (one viewport per tick) to trigger lazy
      // loading without suddenly landing on the quiz section at the bottom.
      var viewportH = window.innerHeight || 800;
      var targetScroll = Math.min(
        (scrollStep + 1) * viewportH,
        document.body.scrollHeight
      );
      try { window.scrollTo(0, targetScroll); } catch(e) {}
      scrollStep++;
    }

    var viewTries = 0;
    var allDoneStreak = 0;
    var PREPARE_TICKS = 6;  // 6s of expand + gentle scrolling
    var SCAN_DELAY_TICKS = 1; // 1s extra wait after scrolling back to top
    var viewTimer = setInterval(function() {
      try {
        viewTries++;

        // Preparation phase: expand + gentle scroll, no scanning
        if (viewTries <= PREPARE_TICKS) {
          preparePage();
          log('preparing page: expand + scroll (' + viewTries + '/' + PREPARE_TICKS + ')');
          return;
        }

        // After prep: scroll back to top and wait one tick for rendering
        if (viewTries === PREPARE_TICKS + 1) {
          try { window.scrollTo(0, 0); } catch(e) {}
          var collapsed2 = document.querySelectorAll('[aria-expanded="false"]');
          for (var e2 = 0; e2 < collapsed2.length; e2++) {
            try { collapsed2[e2].click(); } catch(e) {}
          }
          log('scrolled to top, waiting for render...');
          return;
        }

        // Collect video resource links.  NOTE: video titles on this site do
        // NOT always end in .mp4 (e.g. "第一节 健康概念").  So we include ALL
        // fsresource links EXCEPT known non-video document types.
        // Also: exclude sidebar links, dedupe by URL, and only keep links
        // inside activity containers (not course intro / reference materials).
        var NON_VIDEO_EXT = /\.(pdf|pptx?|docx?|xlsx?|txt|zip|rar|7z)\b/i;
        // NOTE: "资源库文件" is a suffix appended to ALL video links on this
        // site, so it must NOT be in the non-video keywords list.
        var NON_VIDEO_KEYWORDS = /参考教材|课件|教案|大纲|课程说明|课程简介|课程目录|课程封面|版权|前言|教材|讲义|教学大纲|考核说明|学习指南|课程介绍/i;
        // Video titles usually have: .mp4 suffix, or "第X节/章/讲", or
        // chapter numbering like [12.2] or 1.1.  Plain text like "参考教材"
        // has none of these and should be excluded.
        var VIDEO_PATTERN = /\.mp4\b|第[一二三四五六七八九十百千\d]+[节章讲]|\[\d+\.\d+\]|\b\d+\.\d+\b/i;
        var main = getMainContent();
        var allLinks = main.querySelectorAll('a[href*="fsresource"]');
        var videoLinks = [];
        var seenUrls = {};
        for (var i = 0; i < allLinks.length; i++) {
          var link = allLinks[i];
          var txt = (link.textContent || '').trim();
          if (!txt) continue;
          if (NON_VIDEO_EXT.test(txt)) continue; // skip documents
          if (NON_VIDEO_KEYWORDS.test(txt)) continue; // skip non-video resources
          if (!VIDEO_PATTERN.test(txt)) continue; // must look like a video title
          if (isInSidebar(link)) continue; // skip left-nav duplicates
          var href = link.getAttribute('href') || link.href;
          if (seenUrls[href]) continue; // dedupe
          seenUrls[href] = true;
          videoLinks.push(link);
        }
        log('scan found ' + videoLinks.length + ' unique video links in main content');

        if (videoLinks.length === 0) {
          // No-video course (PPT-only / exam-only): wait up to 15s to be
          // sure, then skip to next course.
          if (viewTries >= 15) {
            clearInterval(viewTimer);
            log('no video in this course - marking done, going to next');
            if (viewCourseId) markCourseCompleted(viewCourseId);
            setTimeout(goToCourseArchive, 1000);
          } else if (viewTries % 3 === 0) {
            log('still loading videos... (' + viewTries + '/15)');
          }
          return;
        }

        // Scan completion status
        var completedCount = 0;
        var firstUnfinished = null;
        var firstUnfinishedIdx = -1;
        for (var v = 0; v < videoLinks.length; v++) {
          var done = isRowCompleted(videoLinks[v]);
          var name = (videoLinks[v].textContent || '').trim().substring(0, 35);
          log('  [' + (done ? 'OK ' : '...') + '] ' + name);
          if (done) {
            completedCount++;
          } else if (!firstUnfinished) {
            firstUnfinished = videoLinks[v];
            firstUnfinishedIdx = v;
          }
        }

        log('scan: ' + completedCount + '/' + videoLinks.length + ' videos completed');

        // If first unfinished is not the first video, double-check the
        // videos before it — a misread could make us skip unwatched videos.
        if (firstUnfinished && firstUnfinishedIdx > 0) {
          log('first unfinished at index ' + firstUnfinishedIdx + ' — re-verifying earlier videos...');
          var allBeforeDone = true;
          for (var c = 0; c < firstUnfinishedIdx; c++) {
            if (!isRowCompleted(videoLinks[c])) {
              allBeforeDone = false;
              firstUnfinished = videoLinks[c];
              firstUnfinishedIdx = c;
              log('  correction: video #' + c + ' is actually unfinished');
              break;
            }
          }
          if (allBeforeDone) {
            log('  verified: all ' + firstUnfinishedIdx + ' earlier videos are completed');
          }
        }

        log('scan: ' + completedCount + '/' + videoLinks.length + ' videos completed');

        // ALL videos completed?
        if (completedCount === videoLinks.length) {
          allDoneStreak++;
          // Safety: require at least 3 videos to trust "all done" (a course
          // with 1-2 videos may not have loaded all sections yet)
          if (videoLinks.length < 3) {
            log('only ' + videoLinks.length + ' videos found - content may not be fully loaded, not trusting "all done"');
            allDoneStreak = 0;
            // fall through to click first video
          } else if (allDoneStreak < 2) {
            // Need 2 consecutive "all done" scans to confirm
            log('all done? re-scrolling to confirm (' + allDoneStreak + '/2)');
            return;
          } else {
            clearInterval(viewTimer);
            log('ALL ' + videoLinks.length + ' videos completed - marking course done');
            if (viewCourseId) markCourseCompleted(viewCourseId);
            setTimeout(goToCourseArchive, 1200);
            return;
          }
        } else {
          allDoneStreak = 0;
          // If this course was in completed-memory but we found unfinished
          // videos, the memory is stale — remove it so future runs are correct.
          if (memorySaysDone && viewCourseId) {
            log('stale memory detected: removing course ' + viewCourseId + ' from completed list');
            try {
              var list = getCompletedCourses();
              var idx = list.indexOf(String(viewCourseId));
              if (idx >= 0) {
                list.splice(idx, 1);
                localStorage.__yykt_completed_courses = JSON.stringify(list);
              }
            } catch(e) {}
          }
        }

        // Some unfinished → resume at the first one.
        // Use direct URL navigation — most reliable, no DOM re-query issues.
        if (firstUnfinished) {
          clearInterval(viewTimer);
          var targetHref = firstUnfinished.getAttribute('href') || firstUnfinished.href;
          var targetName = (firstUnfinished.textContent || '').trim();
          log('resuming at first unfinished: ' + targetName.substring(0, 40));
          log('navigating to: ' + targetHref);
          // Resolve relative URL to absolute
          var absUrl = targetHref;
          if (targetHref && targetHref.indexOf('http') !== 0) {
            try { absUrl = new URL(targetHref, window.location.origin).href; } catch(e) {}
          }
          // Force-flush log buffer before navigation so scan logs aren't lost
          flushLogBuffer();
          setTimeout(function() {
            window.location.href = absUrl;
          }, 500);
        }
      } catch(e) { log('err(coursehome): ' + e.message); }
    }, 1000);
    return;
  }

  // ================================================================
  // PAGE 4: PDF FAST PATH (unchanged from v1.6)
  // ================================================================
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
        if (next === '') {
          clearInterval(pdfTimer);
          log('pdf - last resource, course finished');
          var cid = getCurrentCourseId();
          if (cid) markCourseCompleted(cid);
          setTimeout(goToCourseArchive, 1000);
          return;
        }
        if (pdfTries >= NEXT_WAIT_TRIES) {
          clearInterval(pdfTimer);
          log('pdf - resource list never loaded');
          return;
        }
        log('pdf - waiting for list (' + pdfTries + '/' + NEXT_WAIT_TRIES + ')');
      } catch(e) { log('err(pdf): ' + e.message); }
    }, 1000);
    return;
  }

  // ================================================================
  // PAGE 5: FULL MODE (video pages) — existing logic + course-end handling
  // ================================================================

  var video = null;
  var holding = false;
  var holdTimer = null;
  var nextTriggered = false;
  var navigating = false;
  var findTicks = 0;
  var baselinePct = null;
  var endReplayCount = 0;  // how many times we've replayed the tail to force heartbeat

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
      if (next === '') {
        // Last resource in this course — course finished
        log('last resource - course finished!');
        var cid = getCurrentCourseId();
        if (cid) {
          markCourseCompleted(cid);
          log('course ' + cid + ' marked completed');
        }
        setTimeout(goToCourseArchive, 1000);
        return;
      }
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

    // Silent-audio keepalive
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
      if (nextTriggered) return;
      nextTriggered = true;
      log('video ended - waiting for server progress sync...');

      // After the video ends, the site's progress heartbeat may not have
      // reported the final chunk yet.  Poll the displayed progress for up
      // to ~15s; once it reaches 90% we can safely advance.  If it never
      // reaches 90%, replay the last 5 seconds to force a final heartbeat.
      var endChecks = 0;
      var endTimer = setInterval(function() {
        try {
          endChecks++;
          var pct = findMyProgress();
          var dur = v.duration;
          var realPct = (isFinite(dur) && dur > 0) ? (v.currentTime / dur) * 100 : 100;
          log('ended wait: server=' + (pct !== null ? pct + '%' : '?') +
              ' actual=' + realPct.toFixed(1) + '% (' + endChecks + '/6)');

          if (pct !== null && pct >= 90) {
            clearInterval(endTimer);
            log('progress confirmed ' + pct + '% -> going next');
            goNextSoon('');
            return;
          }

          if (endChecks >= 6) {
            clearInterval(endTimer);
            // Server progress still below 90% after 18s — replay tail once
            if (endReplayCount < 1 && pct !== null && pct < 90 && isFinite(dur) && dur > 5) {
              endReplayCount++;
              log('WARNING: server only ' + pct + '% after ended - replaying last 6s to force heartbeat (attempt ' + endReplayCount + ')');
              try {
                v.currentTime = Math.max(0, dur - 6);
                nextTriggered = false; // re-arm so normal flow handles the re-play
                var rp = v.play();
                if (rp && rp.catch) rp.catch(function() {});
              } catch(e) {
                log('replay failed, advancing anyway');
                goNextSoon('');
              }
            } else {
              if (endReplayCount >= 1) {
                log('server still below 90% after replay - advancing anyway (cannot force more)');
              } else {
                log('progress unreadable, advancing anyway');
              }
              goNextSoon('');
            }
          }
        } catch(e) {
          clearInterval(endTimer);
          log('err(endcheck): ' + e.message);
          goNextSoon('');
        }
      }, 3000);
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

      // First readable reading = progress carried over from previous sessions.
      // If already >=90%, this video was completed before — skip it immediately.
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
      // v1.9: no longer jump at 90%.  We wait for the video to fully end
      // (see 'ended' handler), then confirm server progress before advancing.
      // This avoids cutting off videos and gives the server time to log
      // the final watch segment.
      var dur = video.duration;
      var realPct = (isFinite(dur) && dur > 0) ? (video.currentTime / dur) * 100 : 0;
      log('progress: server=' + myPct + '% actual=' + realPct.toFixed(1) + '%');
    } catch(e) { log('err(prog): ' + e.message); }
  }, 5000);

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
    if (now - lastHoldScan < 2000) return;
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

  var observer = new MutationObserver(function() { scanHold(); });
  observer.observe(document.body, { childList: true, subtree: true });

})();
