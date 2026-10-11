// popup.js - YYKT Auto Player settings panel
// All data stored in chrome.storage.local (shared with content.js)

var LOG_KEY = '__yykt_logs';
var SETTINGS_KEY = '__yykt_settings';

var defaultSettings = {
  enablePlugin: true,
  enableLog: false
};

function getSettings(callback) {
  chrome.storage.local.get([SETTINGS_KEY], function(result) {
    var s = result[SETTINGS_KEY] || {};
    callback(Object.assign({}, defaultSettings, s));
  });
}

function saveSettings(settings, callback) {
  chrome.storage.local.set({__yykt_settings: settings}, function() {
    if (callback) callback();
  });
}

function getLogs(callback) {
  chrome.storage.local.get([LOG_KEY], function(result) {
    callback(result[LOG_KEY] || {});
  });
}

function formatLogs(logs) {
  var lines = [];
  var dates = Object.keys(logs).sort();
  for (var d = 0; d < dates.length; d++) {
    lines.push('===== ' + dates[d] + ' =====');
    var entries = logs[dates[d]];
    for (var i = 0; i < entries.length; i++) {
      lines.push(entries[i]);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function showStatus(msg) {
  var el = document.getElementById('status');
  el.textContent = msg;
  setTimeout(function() { el.textContent = ''; }, 3000);
}

// Set plugin enabled/disabled in the page's localStorage (content.js checks this)
function setPluginEnabledInPage(enabled) {
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    if (!tabs[0]) return;
    var code = enabled
      ? 'localStorage.removeItem("__yykt_disabled");'
      : 'localStorage.setItem("__yykt_disabled", "1");';
    chrome.scripting.executeScript({
      target: {tabId: tabs[0].id},
      func: function(code) { try { eval(code); } catch(e) {} },
      args: [code]
    }).catch(function() {});
  });
}

document.addEventListener('DOMContentLoaded', function() {
  // Load current settings
  getSettings(function(settings) {
    document.getElementById('enablePlugin').checked = settings.enablePlugin;
    document.getElementById('enableLog').checked = settings.enableLog;
  });

  // Enable/disable plugin toggle
  document.getElementById('enablePlugin').addEventListener('change', function() {
    var enabled = this.checked;
    getSettings(function(s) {
      s.enablePlugin = enabled;
      saveSettings(s);
    });
    setPluginEnabledInPage(enabled);
    showStatus(enabled ? '插件已启用（刷新页面后生效）' : '插件已禁用（刷新页面后生效）');
  });

  // Log toggle
  document.getElementById('enableLog').addEventListener('change', function() {
    var enabled = this.checked;
    getSettings(function(s) {
      s.enableLog = enabled;
      saveSettings(s);
    });
    showStatus(enabled ? '日志记录已开启' : '日志记录已关闭');
  });

  // Copy log
  document.getElementById('copyLog').addEventListener('click', function() {
    getLogs(function(logs) {
      var text = formatLogs(logs);
      if (!text.trim()) {
        showStatus('暂无日志');
        return;
      }
      navigator.clipboard.writeText(text).then(function() {
        showStatus('日志已复制到剪贴板');
      }).catch(function() {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showStatus('日志已复制到剪贴板');
      });
    });
  });

  // View log
  var logView = document.getElementById('logView');
  var logVisible = false;
  document.getElementById('viewLog').addEventListener('click', function() {
    if (logVisible) {
      logView.style.display = 'none';
      logVisible = false;
      this.textContent = '查看日志';
    } else {
      getLogs(function(logs) {
        var text = formatLogs(logs);
        logView.textContent = text || '暂无日志';
        logView.style.display = 'block';
        logVisible = true;
        document.getElementById('viewLog').textContent = '隐藏日志';
        logView.scrollTop = logView.scrollHeight;
      });
    }
  });

  // Clear log
  document.getElementById('clearLog').addEventListener('click', function() {
    if (confirm('确定要清空所有日志吗？')) {
      chrome.storage.local.remove(LOG_KEY, function() {
        logView.textContent = '';
        showStatus('日志已清空');
      });
    }
  });
});
