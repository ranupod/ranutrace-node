// @ranupod/ranutrace-node Real User Monitoring (RanuRUM) module
// Bundles the official NPM @openobserve/browser-rum & @openobserve/browser-logs SDKs (v0.4.3)
// into a single first-party bundle (/o2-sdk.js) with automatic rumtoken discovery and /rum/v1/* reverse proxy.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const rumEnabled = process.env.RANUPOD_RUM_ENABLED !== 'false';
const proxyBasePath = (process.env.RANUPOD_RUM_PROXY_PATH || '/__ranurum').replace(/\/+$/, '');
const sampleRate = parseFloat(process.env.RANUPOD_RUM_SAMPLE_RATE || '1.0');
const serviceName = process.env.OTEL_SERVICE_NAME || process.env.DD_SERVICE || 'ranupod-node-app';
const appVersion = process.env.DD_VERSION || process.env.npm_package_version || '1.0.0';
const RUM_SDK_VERSION = '0.4.3';

// Load pre-bundled NPM @openobserve/browser-rum + @openobserve/browser-logs (with inline Session Replay recorder)
let sdkBundleRaw = Buffer.from('');
let sdkBundleGzip = Buffer.from('');
try {
  sdkBundleRaw = fs.readFileSync(path.join(__dirname, 'o2-bundle.min.js'));
  sdkBundleGzip = zlib.gzipSync(sdkBundleRaw);
} catch (e) {}

// Parse OTEL_RESOURCE_ATTRIBUTES (e.g. deployment.environment=...,project.id=...,service.name=...,tenant.id=...)
function parseKeyValuePairs(raw) {
  const map = {};
  if (!raw) return map;
  raw.split(',').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      map[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  });
  return map;
}

const resourceAttrs = parseKeyValuePairs(process.env.OTEL_RESOURCE_ATTRIBUTES);
const otlpHeaders = parseKeyValuePairs(process.env.OTEL_EXPORTER_OTLP_HEADERS);

// Resolve OpenObserve root URL and organization identifier from OTEL_EXPORTER_OTLP_ENDPOINT
function parseOpenObserveEndpoint() {
  const raw = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://192.10.1.9:5080/api/default')
    .replace(/\/v1\/traces\/?$/, '')
    .replace(/\/+$/, '');
  const match = raw.match(/^(https?:\/\/[^/]+)\/api\/([^/]+)$/);
  if (match) {
    return {
      origin: match[1],
      orgId: resourceAttrs['tenant.id'] || match[2] || 'default',
    };
  }
  try {
    const u = new URL(raw);
    return {
      origin: `${u.protocol}//${u.host}`,
      orgId: resourceAttrs['tenant.id'] || 'default',
    };
  } catch (e) {
    return {
      origin: 'http://192.10.1.9:5080',
      orgId: resourceAttrs['tenant.id'] || 'default',
    };
  }
}

const ooConfig = parseOpenObserveEndpoint();
const rawDeployEnv = resourceAttrs['deployment.environment'] || '';
const envName =
  (!/^[0-9a-f-]{36}$/i.test(rawDeployEnv) && rawDeployEnv) ||
  process.env.DD_ENV ||
  process.env.NODE_ENV ||
  'production';
const applicationId = resourceAttrs['project.id'] || serviceName;

// Cached RUM clientToken fetched from OpenObserve /api/{orgId}/rumtoken
let cachedRumToken = process.env.RANUPOD_RUM_CLIENT_TOKEN || '';
let tokenFetchInFlight = false;

function fetchOrCreateRumToken(cb) {
  if (cachedRumToken) {
    if (cb) cb(cachedRumToken);
    return;
  }
  if (tokenFetchInFlight) {
    if (cb) cb('');
    return;
  }
  tokenFetchInFlight = true;

  const requestToken = (method, done) => {
    try {
      const targetUrl = new URL(`${ooConfig.origin}/api/${ooConfig.orgId}/rumtoken`);
      const transport = targetUrl.protocol === 'https:' ? https : http;
      const req = transport.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: targetUrl.pathname,
          method,
          headers: {
            Accept: 'application/json',
            ...otlpHeaders,
          },
          timeout: 4000,
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(raw);
              const tok = parsed && parsed.data && parsed.data.rum_token;
              done(tok || '');
            } catch (e) {
              done('');
            }
          });
        }
      );
      req.on('error', () => done(''));
      req.end();
    } catch (e) {
      done('');
    }
  };

  requestToken('GET', (tok) => {
    if (tok) {
      cachedRumToken = tok;
      tokenFetchInFlight = false;
      console.log(`✨ [RanuRUM] Auto-discovered OpenObserve RUM Token for org '${ooConfig.orgId}'`);
      if (cb) cb(cachedRumToken);
    } else {
      requestToken('POST', (createdTok) => {
        if (createdTok) {
          cachedRumToken = createdTok;
          console.log(`✨ [RanuRUM] Auto-created OpenObserve RUM Token for org '${ooConfig.orgId}'`);
        }
        tokenFetchInFlight = false;
        if (cb) cb(cachedRumToken);
      });
    }
  });
}

// Build first-party HTML snippet loading the bundled NPM @openobserve/browser-rum & @openobserve/browser-logs
function buildHtmlSnippet() {
  const sessionSamplePct = Math.max(0, Math.min(100, Math.round(sampleRate * 100)));
  const clientToken = cachedRumToken || 'auto';
  const cfg = {
    clientToken,
    applicationId,
    organizationIdentifier: ooConfig.orgId,
    service: serviceName,
    env: envName,
    version: appVersion,
    proxyBasePath,
    sessionSampleRate: sessionSamplePct,
    sessionReplaySampleRate: sessionSamplePct,
  };

  return `<script>window.__RANURUM_O2_CONFIG__=${JSON.stringify(cfg)};</script><script src="${proxyBasePath}/o2-sdk.js?v=1.3.1" defer></script>`;
}

// Transparently proxy /__ranurum/rum/v1/{org}/* (rum, logs, replay) to OpenObserve
function proxyRumIntakeRequest(req, res) {
  let downstreamPath = req.url.slice(proxyBasePath.length);
  if (!downstreamPath.startsWith('/')) downstreamPath = '/' + downstreamPath;

  const forward = (activeToken) => {
    try {
      if (activeToken && downstreamPath.includes('o2-api-key=auto')) {
        downstreamPath = downstreamPath.replace('o2-api-key=auto', `o2-api-key=${encodeURIComponent(activeToken)}`);
      }
      const targetUrl = new URL(ooConfig.origin + downstreamPath);
      const transport = targetUrl.protocol === 'https:' ? https : http;

      const fwdHeaders = { ...req.headers };
      delete fwdHeaders.host;
      delete fwdHeaders.connection;
      fwdHeaders['accept-encoding'] = 'identity';

      if (activeToken && (!fwdHeaders.authorization || fwdHeaders.authorization.includes('auto'))) {
        fwdHeaders.authorization = `Bearer ${activeToken}`;
      }

      const proxyReq = transport.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: targetUrl.pathname + targetUrl.search,
          method: req.method,
          headers: fwdHeaders,
          timeout: 8000,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 202, {
            'Content-Type': proxyRes.headers['content-type'] || 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          proxyRes.pipe(res);
        }
      );

      proxyReq.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end('{"status":"ok"}');
        }
      });

      req.pipe(proxyReq);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
      }
    }
  };

  if (cachedRumToken) {
    forward(cachedRumToken);
  } else {
    fetchOrCreateRumToken((tok) => forward(tok));
  }
}

/**
 * Patches Node's http.Server.prototype.emit to:
 * 1) Serve the bundled NPM @openobserve/browser-rum + @openobserve/browser-logs at GET /__ranurum/o2-sdk.js
 * 2) Proxy /__ranurum/rum/v1/{org}/{rum|logs|replay} directly to OpenObserve's native RUM intake
 * 3) Auto-inject the first-party SDK <script> tag into HTML responses
 */
function installRumHook() {
  if (!rumEnabled || http.Server.prototype.__ranurumPatched) return;
  http.Server.prototype.__ranurumPatched = true;

  fetchOrCreateRumToken();

  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (type, req, res) {
    if (type === 'request' && req && res && typeof req.url === 'string') {
      const pathOnly = req.url.split('?')[0];

      // Route 1: Serve bundled NPM @openobserve/browser-rum & @openobserve/browser-logs
      if (
        req.method === 'GET' &&
        (pathOnly === `${proxyBasePath}/o2-sdk.js` || pathOnly === `${proxyBasePath}/rum.js`)
      ) {
        const acceptEnc = String((req.headers && req.headers['accept-encoding']) || '');
        if (acceptEnc.includes('gzip') && sdkBundleGzip.length > 0) {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Content-Encoding': 'gzip',
            'Cache-Control': 'public, max-age=3600',
          });
          res.end(sdkBundleGzip);
        } else {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
          });
          res.end(sdkBundleRaw);
        }
        return true;
      }

      // Route 2: Proxy official OpenObserve Browser SDK intake (/rum/v1/{org}/rum, /logs, /replay)
      if (pathOnly.startsWith(`${proxyBasePath}/rum/`)) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*',
          });
          res.end();
          return true;
        }
        proxyRumIntakeRequest(req, res);
        return true;
      }

      // Route 3: Health/config inspection endpoint
      if (req.method === 'GET' && pathOnly === `${proxyBasePath}/status`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            sdk: '@openobserve/browser-rum + @openobserve/browser-logs (bundled NPM)',
            sdk_version: RUM_SDK_VERSION,
            org: ooConfig.orgId,
            service: serviceName,
            env: envName,
            token_ready: Boolean(cachedRumToken),
          })
        );
        return true;
      }

      // Auto-inject first-party bundled OpenObserve RUM + Logs SDK into HTML responses
      const origWrite = res.write;
      const origEnd = res.end;
      let injected = false;

      function canInjectHtml() {
        if (injected) return false;
        const ct = String(res.getHeader('content-type') || '').toLowerCase();
        const ce = String(res.getHeader('content-encoding') || '').toLowerCase();
        return ct.includes('text/html') && !ce;
      }

      function tryInjectChunk(chunk, encoding) {
        if (!chunk || !canInjectHtml()) return chunk;
        const str = Buffer.isBuffer(chunk) ? chunk.toString(encoding || 'utf8') : String(chunk);
        const closeHeadIdx = str.indexOf('</head>');
        const closeBodyIdx = str.indexOf('</body>');
        const targetIdx = closeHeadIdx !== -1 ? closeHeadIdx : closeBodyIdx;
        if (targetIdx === -1) return chunk;

        injected = true;
        const snippet = buildHtmlSnippet();
        const modified = str.slice(0, targetIdx) + snippet + str.slice(targetIdx);
        if (res.hasHeader && res.hasHeader('content-length')) {
          res.removeHeader('content-length');
        }
        return Buffer.isBuffer(chunk) ? Buffer.from(modified, encoding || 'utf8') : modified;
      }

      res.write = function (chunk, encoding, cb) {
        const nextChunk = tryInjectChunk(chunk, encoding);
        return origWrite.call(this, nextChunk, encoding, cb);
      };

      res.end = function (chunk, encoding, cb) {
        if (chunk && typeof chunk !== 'function') {
          chunk = tryInjectChunk(chunk, encoding);
        }
        return origEnd.call(this, chunk, encoding, cb);
      };
    }

    return origEmit.apply(this, arguments);
  };
}

module.exports = {
  installRumHook,
  buildHtmlSnippet,
};
