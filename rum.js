// @ranupod/ranutrace-node Real User Monitoring (RanuRUM) module
// Uses the official OpenObserve Browser RUM & Browser Logs SDKs (@openobserve/browser-rum & @openobserve/browser-logs)
// with automatic RUM token discovery + internal reverse proxy (/rum/v1/*) to bypass Mixed Content, CORS & private IP boundaries.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const rumEnabled = process.env.RANUPOD_RUM_ENABLED !== 'false';
const proxyBasePath = (process.env.RANUPOD_RUM_PROXY_PATH || '/__ranurum').replace(/\/+$/, '');
const sampleRate = parseFloat(process.env.RANUPOD_RUM_SAMPLE_RATE || '1.0');
const serviceName = process.env.OTEL_SERVICE_NAME || process.env.DD_SERVICE || 'ranupod-node-app';
const appVersion = process.env.DD_VERSION || process.env.npm_package_version || '1.0.0';

const RUM_SDK_VERSION = '0.4.3';
const CDN_HOST = 'https://browsersdk.openobserve.ai';

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
// Example OTEL_EXPORTER_OTLP_ENDPOINT: http://192.10.1.9:5080/api/b79m4kaaeozc
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
const envName = resourceAttrs['deployment.environment'] || process.env.DD_ENV || process.env.NODE_ENV || 'production';
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

// Build the official OpenObserve Browser RUM + Browser Logs CDN snippet
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

  return `<script>
(function(){
  if(window.__RANURUM_O2_INIT__)return;
  window.__RANURUM_O2_INIT__=true;
  var c=${JSON.stringify(cfg)};
  (function(h,o,u,n,d){
    h=h[d]=h[d]||{q:[],onReady:function(cb){h.q.push(cb);}};
    d=o.createElement(u);d.async=1;d.src=n;d.crossOrigin="anonymous";
    n=o.getElementsByTagName(u)[0];
    if(n&&n.parentNode)n.parentNode.insertBefore(d,n);
    else(o.head||o.documentElement).appendChild(d);
  })(window,document,"script","${CDN_HOST}/${RUM_SDK_VERSION}/openobserve-rum.js","O2_RUM");
  (function(h,o,u,n,d){
    h=h[d]=h[d]||{q:[],onReady:function(cb){h.q.push(cb);}};
    d=o.createElement(u);d.async=1;d.src=n;d.crossOrigin="anonymous";
    n=o.getElementsByTagName(u)[0];
    if(n&&n.parentNode)n.parentNode.insertBefore(d,n);
    else(o.head||o.documentElement).appendChild(d);
  })(window,document,"script","${CDN_HOST}/${RUM_SDK_VERSION}/openobserve-logs.js","O2_LOGS");

  var site=window.location.host+c.proxyBasePath;
  var insecureHTTP=window.location.protocol==="http:";

  O2_RUM.onReady(function(){
    O2_RUM.init({
      applicationId:c.applicationId,
      clientToken:c.clientToken,
      site:site,
      organizationIdentifier:c.organizationIdentifier,
      service:c.service,
      env:c.env,
      version:c.version,
      trackResources:true,
      trackLongTasks:true,
      trackUserInteractions:true,
      apiVersion:"v1",
      insecureHTTP:insecureHTTP,
      defaultPrivacyLevel:"allow",
      allowedTracingUrls:[{match:window.location.origin,propagatorTypes:["openobserve","tracecontext"]}],
      sessionSampleRate:c.sessionSampleRate,
      sessionReplaySampleRate:c.sessionReplaySampleRate
    });
    O2_RUM.startSessionReplayRecording();
  });

  O2_LOGS.onReady(function(){
    O2_LOGS.init({
      clientToken:c.clientToken,
      site:site,
      organizationIdentifier:c.organizationIdentifier,
      service:c.service,
      env:c.env,
      version:c.version,
      forwardErrorsToLogs:true,
      insecureHTTP:insecureHTTP,
      apiVersion:"v1"
    });
  });
})();
</script>`;
}

// Transparently proxy /__ranurum/rum/v1/{org}/* (rum, logs, replay) to OpenObserve
function proxyRumIntakeRequest(req, res) {
  // Strip /__ranurum prefix so /__ranurum/rum/v1/... becomes /rum/v1/...
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
 * 1) Proxy /__ranurum/rum/v1/{org}/{rum|logs|replay} directly to OpenObserve's native RUM intake
 * 2) Auto-inject the official OpenObserve Browser RUM & Logs SDK loader into HTML responses
 */
function installRumHook() {
  if (!rumEnabled || http.Server.prototype.__ranurumPatched) return;
  http.Server.prototype.__ranurumPatched = true;

  // Pre-fetch the organization's RUM clientToken at startup
  fetchOrCreateRumToken();

  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (type, req, res) {
    if (type === 'request' && req && res && typeof req.url === 'string') {
      const pathOnly = req.url.split('?')[0];

      // Route 1: Proxy official OpenObserve Browser SDK intake (/rum/v1/{org}/rum, /logs, /replay)
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

      // Route 2: Health/config inspection endpoint
      if (req.method === 'GET' && pathOnly === `${proxyBasePath}/status`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            sdk: '@openobserve/browser-rum',
            sdk_version: RUM_SDK_VERSION,
            org: ooConfig.orgId,
            service: serviceName,
            env: envName,
            token_ready: Boolean(cachedRumToken),
          })
        );
        return true;
      }

      // Auto-inject official OpenObserve RUM + Logs SDK into HTML responses
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
