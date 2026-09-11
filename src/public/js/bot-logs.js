(function () {
  var id = window.LOG_DEPLOYMENT_ID;
  var token = window.LOG_TOKEN;

  var consoleEl = document.getElementById('logConsole');
  var badge = document.getElementById('logStatusBadge');
  var pauseBtn = document.getElementById('pauseBtn');
  var clearBtn = document.getElementById('clearBtn');
  var downloadBtn = document.getElementById('downloadBtn');

  var paused = false;
  var queued = 0;
  var allLines = []; // plain-text copy, for the Download button
  var ws = null;
  var reconnectDelay = 1500;
  var reconnectTimer = null;

  function setBadge(kind, text) {
    badge.className = 'badge badge-' + kind;
    badge.textContent = text;
  }

  function appendEntry(entry) {
    var text = entry.type === 'structured'
      ? '[' + entry.dyno + '] ' + entry.message
      : entry.message;
    allLines.push(text);

    if (paused) {
      queued += 1;
      pauseBtn.textContent = 'Resume (' + queued + ' new)';
      return;
    }

    var row = document.createElement('div');
    row.className = 'console-line' + (entry.isError ? ' err' : '');
    var tSpan = document.createElement('span');
    tSpan.className = 't';
    tSpan.textContent = entry.type === 'structured' ? entry.dyno : '·';
    var mSpan = document.createElement('span');
    mSpan.className = 'msg';
    mSpan.textContent = entry.message;
    row.appendChild(tSpan);
    row.appendChild(mSpan);
    consoleEl.appendChild(row);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function appendNote(text, kind) {
    var row = document.createElement('div');
    row.className = 'console-line' + (kind ? ' ' + kind : '');
    row.innerHTML = '<span class="t">·</span><span class="msg">' + text + '</span>';
    consoleEl.appendChild(row);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function loadSnapshot() {
    fetch('/api/logs/' + id)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        consoleEl.innerHTML = '';
        if (data.success && data.logs && data.logs.length) {
          data.logs.forEach(appendEntry);
        } else if (data.success) {
          appendNote('No logs yet — nothing has printed to the console since this app started.');
        } else {
          appendNote(data.error || 'Could not load logs.', 'err');
        }
      })
      .catch(function () {
        appendNote('Could not load logs — check your connection and refresh.', 'err');
      });
  }

  function connect() {
    clearTimeout(reconnectTimer);
    setBadge('pending', 'Connecting…');

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/api/logs/stream?token=' + encodeURIComponent(token));

    ws.onmessage = function (evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }

      if (msg.type === 'status') {
        setBadge('succeeded', 'Live');
      } else if (msg.type === 'log') {
        appendEntry(msg.data);
      } else if (msg.type === 'error') {
        setBadge('failed', 'Disconnected');
        appendNote(msg.message, 'err');
      }
    };

    ws.onclose = function () {
      setBadge('failed', 'Reconnecting…');
      reconnectTimer = setTimeout(refreshTokenAndReconnect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
    };

    ws.onerror = function () {
      // onclose fires right after — let that path handle reconnect.
    };
  }

  function refreshTokenAndReconnect() {
    fetch('/api/logs/' + id + '/token')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.token) {
          token = data.token;
          connect();
        } else {
          setBadge('failed', 'Disconnected');
        }
      })
      .catch(function () {
        reconnectTimer = setTimeout(refreshTokenAndReconnect, reconnectDelay);
      });
  }

  pauseBtn.addEventListener('click', function () {
    paused = !paused;
    if (paused) {
      pauseBtn.textContent = 'Resume';
    } else {
      queued = 0;
      pauseBtn.textContent = 'Pause';
      loadSnapshot(); // simplest way to flush what was missed while paused
    }
  });

  clearBtn.addEventListener('click', function () {
    consoleEl.innerHTML = '';
    allLines = [];
  });

  downloadBtn.addEventListener('click', function () {
    var blob = new Blob([allLines.join('\n')], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'logs.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  window.addEventListener('beforeunload', function () {
    if (ws) ws.close();
  });

  loadSnapshot();
  connect();
})();
