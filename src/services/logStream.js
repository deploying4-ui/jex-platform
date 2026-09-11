// Live "app logs" for a deployed bot — the platform-native equivalent
// of `heroku logs --tail`, surfaced in the dashboard so users can see
// their bot's console output/errors without needing Heroku CLI access.
//
// Two halves:
//   1. A short-lived signed token (stateless HMAC, no session store
//      lookup needed on the raw WebSocket upgrade) that proves the
//      platform already checked the requester owns this deployment.
//   2. A WebSocket relay: browser <-> jex-platform <-> Heroku logplex.
//      We open a Heroku log session per connection and pipe its
//      stream straight through, so nothing is buffered server-side.

const crypto = require('crypto');
const WebSocket = require('ws');
const config = require('../config');
const db = require('../db');
const heroku = require('./heroku');

const TOKEN_TTL_MS = 5 * 60 * 1000; // plenty for the client to open the socket; it re-fetches on reconnect

// Redact anything that looks like an email or a bearer/API-key-shaped
// token before it ever reaches the browser — bot logs sometimes echo
// back config vars or user input.
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const SECRET_LOOKING_PATTERN = /\b(?:sk|key|token)[-_][A-Za-z0-9]{16,}\b/gi;

function redact(text) {
  return text
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(SECRET_LOOKING_PATTERN, '[redacted]');
}

function signLogToken(deploymentId) {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `${deploymentId}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', config.server.sessionSecret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyLogToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [deploymentId, expiresAt, sig] = parts;
  const payload = `${deploymentId}.${expiresAt}`;
  const expected = crypto.createHmac('sha256', config.server.sessionSecret).update(payload).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(expiresAt)) return null;
  return deploymentId;
}

// Turns a raw logplex line ("2026-09-10T12:00:00+00:00 app[web.1]: ...")
// into something the client can color/format without re-parsing.
function processLogLine(line) {
  if (!line) return null;
  const clean = redact(line);
  const matches = clean.match(/^([\d-]+T[\d:.+-]+Z?) (\S+)\[([^\]]+)\]: (.*)$/);
  if (matches) {
    return {
      type: 'structured',
      timestamp: matches[1],
      source: matches[2],
      dyno: matches[3],
      message: matches[4],
      isError: /error|exception|fatal|crash/i.test(matches[4]) || matches[3].startsWith('heroku') && /Error|R1[0-9]|H1[0-9]/.test(matches[4]),
    };
  }
  return { type: 'raw', message: clean, isError: /error|exception|fatal/i.test(clean) };
}

function attachLogsWebSocket(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/logs/stream') return; // not ours — leave it alone

    const deploymentId = verifyLogToken(url.searchParams.get('token'));
    if (!deploymentId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, deploymentId);
    });
  });

  wss.on('connection', async (ws, deploymentId) => {
    let herokuSocket;
    const cleanup = () => {
      if (herokuSocket) herokuSocket.close();
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };

    try {
      const deployment = await db.getDeploymentById(deploymentId);
      if (!deployment) throw new Error('Deployment not found');

      ws.send(JSON.stringify({ type: 'status', message: 'Connecting to log stream…' }));

      const apiKey = await db.resolveHerokuApiKey(deployment);
      if (!apiKey) throw new Error('No deploy account linked to this app');

      const session = await heroku.createLogSession(apiKey, deployment.app_name, { tail: true, lines: 100 });
      if (!session.logplex_url) throw new Error('Heroku did not return a log stream');

      herokuSocket = new WebSocket(session.logplex_url);

      herokuSocket.on('open', () => {
        ws.send(JSON.stringify({ type: 'status', message: 'Live — streaming logs' }));
      });

      herokuSocket.on('message', (data) => {
        data
          .toString()
          .split('\n')
          .filter(Boolean)
          .forEach((line) => {
            const processed = processLogLine(line);
            if (processed) ws.send(JSON.stringify({ type: 'log', data: processed }));
          });
      });

      herokuSocket.on('error', () => {
        ws.send(JSON.stringify({ type: 'error', message: 'Log stream connection dropped.' }));
        cleanup();
      });
      herokuSocket.on('close', cleanup);
      ws.on('close', cleanup);
      ws.on('error', cleanup);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message || 'Could not start log stream.' }));
      cleanup();
    }
  });
}

module.exports = {
  signLogToken,
  verifyLogToken,
  processLogLine,
  attachLogsWebSocket,
};
