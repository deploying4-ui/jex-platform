(function () {
  var id = window.DEPLOYMENT_ID;
  var consoleEl = document.getElementById('console');
  var heading = document.getElementById('statusHeading');
  var sub = document.getElementById('statusSub');
  var spinner = document.getElementById('statusSpinner');
  var actions = document.getElementById('statusActions');

  var startedAt = Date.now();
  var pollHandle = null;
  var pollCount = 0;
  var buildLogStarted = false;

  function elapsed() {
    var s = Math.floor((Date.now() - startedAt) / 1000);
    var mm = String(Math.floor(s / 60)).padStart(2, '0');
    var ss = String(s % 60).padStart(2, '0');
    return '[' + mm + ':' + ss + ']';
  }

  function addLine(msg, kind) {
    var row = document.createElement('div');
    row.className = 'console-line' + (kind ? ' ' + kind : '');
    var t = document.createElement('span');
    t.className = 't';
    t.textContent = elapsed();
    var m = document.createElement('span');
    m.className = 'msg';
    m.textContent = msg; // textContent, not innerHTML — build output is untrusted
    row.appendChild(t);
    row.appendChild(m);
    consoleEl.appendChild(row);
    consoleEl.scrollTop = consoleEl.scrollHeight;
    return row;
  }

  function isErrorLine(line) {
    return /error|failed|fatal|exception|npm err!/i.test(line);
  }

  // Streams the real `npm install`/build output from Heroku straight
  // into the console, line by line, as it's produced — not just the
  // one-line failure summary. Runs once per deploy; the upstream
  // request resolves on its own once Heroku closes the build.
  function streamBuildLog(buildId) {
    if (buildLogStarted) return;
    buildLogStarted = true;

    fetch('/api/deploy/build-log/' + id + '/' + buildId)
      .then(function (res) {
        if (!res.body || !res.body.getReader) return; // browser can't stream fetch bodies — heartbeat keeps going
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var partial = '';

        function pump() {
          return reader.read().then(function (result) {
            if (result.done) return;
            var text = partial + decoder.decode(result.value, { stream: true });
            var lines = text.split('\n');
            partial = lines.pop(); // last chunk may be a partial line — hold it for next read
            lines.forEach(function (line) {
              if (line.trim()) addLine(line, isErrorLine(line) ? 'err' : null);
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function () {
        // Stream dropped — the periodic status poll still catches success/failure either way.
      });
  }

  function finish(kind, headingText, subHtml) {
    clearInterval(pollHandle);
    spinner.style.display = 'none';
    heading.textContent = headingText;
    sub.innerHTML = subHtml;
  }

  function poll() {
    pollCount += 1;
    fetch('/api/deploy/status/' + id)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.buildId) streamBuildLog(data.buildId);

        if (data.status === 'succeeded') {
          addLine('Build succeeded', 'ok');
          finish('ok', 'Deployed', 'Your bot is live.');
          actions.style.display = 'flex';
          actions.innerHTML =
            (data.appUrl ? '<a class="btn btn-primary" href="' + data.appUrl + '" target="_blank" rel="noopener">Open app</a>' : '') +
            '<a class="btn btn-secondary" href="/my-bots/' + id + '/logs">View logs</a>' +
            '<a class="btn btn-secondary" href="/dashboard">Back to dashboard</a>';
          var redeployPanel = document.getElementById('redeployPanel');
          if (redeployPanel) redeployPanel.style.display = 'block';
        } else if (data.status === 'failed') {
          addLine(data.failureMessage || 'Build failed on platform.', 'err');
          finish('err', 'Deploy failed', 'See the log above for details.');
          actions.style.display = 'flex';
          actions.innerHTML = '<a class="btn btn-primary" href="/dashboard">Back to dashboard</a>';
        } else if (!buildLogStarted && pollCount % 4 === 0) {
          // No build object yet (still provisioning) — heartbeat so the
          // console doesn't look stalled. Once real build output starts
          // streaming in, this stops — the real lines speak for themselves.
          addLine('Still building on platform…');
        }
      })
      .catch(function () {
        // Transient network hiccup — next poll will retry.
      });
  }

  poll();
  pollHandle = setInterval(poll, 2500);
})();
