// @ranupod/ranutrace-node Real User Monitoring (RanuRUM) module
// Zero-code Browser RUM auto-injector + internal reverse proxy to OpenObserve
// Avoids CORS, AdBlockers, and keeps OpenObserve credentials server-side.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { trace, context } = require('@opentelemetry/api');

const rumEnabled = process.env.RANUPOD_RUM_ENABLED !== 'false';
const proxyBasePath = (process.env.RANUPOD_RUM_PROXY_PATH || '/__ranurum').replace(/\/+$/, '');
const sampleRate = parseFloat(process.env.RANUPOD_RUM_SAMPLE_RATE || '1.0');
const serviceName = process.env.OTEL_SERVICE_NAME || process.env.DD_SERVICE || 'ranupod-node-app';
const envName = process.env.DD_ENV || process.env.NODE_ENV || 'production';

// Parse OTEL_RESOURCE_ATTRIBUTES (e.g. deployment.environment=...,project.id=...,service.name=...,tenant.id=...)
function parseResourceAttrs(raw) {
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

const resourceAttrs = parseResourceAttrs(process.env.OTEL_RESOURCE_ATTRIBUTES);

// Parse OTEL_EXPORTER_OTLP_HEADERS (e.g. Authorization=Basic xxx)
function parseOtlpHeaders(raw) {
  const headers = {};
  if (!raw) return headers;
  raw.split(',').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  });
  return headers;
}

const otlpHeaders = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

// Determine OpenObserve JSON ingestion URL for RUM stream: /api/{org}/rum/_json
function getRumIngestUrl() {
  const base = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://192.10.1.9:5080/api/default')
    .replace(/\/v1\/traces\/?$/, '')
    .replace(/\/+$/, '');
  return `${base}/rum/_json`;
}

// Browser-side RUM collector script served at /__ranurum/rum.js
function buildBrowserScript() {
  return `(function(){
  if(window.__RANURUM_LOADED__)return;
  window.__RANURUM_LOADED__=true;
  var cfg=window.__RANURUM_CONFIG__||{};
  var endpoint=(cfg.proxyPath||"${proxyBasePath}")+"/events";
  var sampleRate=typeof cfg.sampleRate==="number"?cfg.sampleRate:${sampleRate};
  if(Math.random()>sampleRate)return;

  var sessionId="";
  try{
    sessionId=sessionStorage.getItem("_ranurum_sid");
    if(!sessionId){
      sessionId=Math.random().toString(16).slice(2,10)+Date.now().toString(16);
      sessionStorage.setItem("_ranurum_sid",sessionId);
    }
  }catch(e){sessionId="anon";}

  function randHex(len){
    var s="";
    while(s.length<len)s+=Math.random().toString(16).slice(2);
    return s.slice(0,len);
  }

  var pageTraceId=cfg.serverTraceId||randHex(32);
  var queue=[];
  var flushTimer=null;

  function send(evt){
    var payload=Object.assign({
      service_name:cfg.service||"${serviceName}",
      environment:cfg.env||"${envName}",
      session_id:sessionId,
      trace_id:evt.trace_id||pageTraceId,
      page_url:location.href,
      page_path:location.pathname,
      referrer:document.referrer||"",
      user_agent:navigator.userAgent
    },evt);
    queue.push(payload);
    if(queue.length>=10)flush();
    else if(!flushTimer)flushTimer=setTimeout(flush,2000);
  }

  function flush(){
    if(flushTimer){clearTimeout(flushTimer);flushTimer=null;}
    if(!queue.length)return;
    var batch=queue.splice(0,queue.length);
    var body=JSON.stringify(batch);
    try{
      if(navigator.sendBeacon){
        var blob=new Blob([body],{type:"application/json"});
        navigator.sendBeacon(endpoint,blob);
      }else{
        fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:body,keepalive:true}).catch(function(){});
      }
    }catch(e){}
  }

  addEventListener("visibilitychange",function(){
    if(document.visibilityState==="hidden")flush();
  });

  // 1. Page Navigation & Timing (TTFB, DOM Load, Full Load)
  function recordNavigation(){
    try{
      var nav=performance.getEntriesByType&&performance.getEntriesByType("navigation")[0];
      if(nav){
        send({
          event_type:"pageview",
          ttfb_ms:Math.round(nav.responseStart-nav.requestStart),
          dom_load_ms:Math.round(nav.domContentLoadedEventEnd-nav.startTime),
          load_ms:Math.round(nav.loadEventEnd-nav.startTime||performance.now())
        });
      }else{
        send({event_type:"pageview",load_ms:Math.round(performance.now())});
      }
    }catch(e){}
  }
  if(document.readyState==="complete")setTimeout(recordNavigation,0);
  else addEventListener("load",function(){setTimeout(recordNavigation,100);});

  // 2. Core Web Vitals (LCP, CLS, FID/INP) via PerformanceObserver
  if(typeof PerformanceObserver!=="undefined"){
    try{
      var lcpVal=0;
      var lcpObs=new PerformanceObserver(function(list){
        var entries=list.getEntries();
        var last=entries[entries.length-1];
        if(last)lcpVal=Math.round(last.startTime);
      });
      lcpObs.observe({type:"largest-contentful-paint",buffered:true});
      addEventListener("visibilitychange",function(){
        if(document.visibilityState==="hidden"&&lcpVal>0){
          send({event_type:"vital",vital_name:"LCP",vital_value:lcpVal,lcp_ms:lcpVal});
          lcpVal=0;
        }
      });
    }catch(e){}

    try{
      var clsVal=0;
      var clsObs=new PerformanceObserver(function(list){
        list.getEntries().forEach(function(entry){
          if(!entry.hadRecentInput)clsVal+=entry.value;
        });
      });
      clsObs.observe({type:"layout-shift",buffered:true});
      addEventListener("visibilitychange",function(){
        if(document.visibilityState==="hidden"&&clsVal>0){
          var rounded=Math.round(clsVal*1000)/1000;
          send({event_type:"vital",vital_name:"CLS",vital_value:rounded,cls_score:rounded});
          clsVal=0;
        }
      });
    }catch(e){}

    try{
      var fidObs=new PerformanceObserver(function(list){
        list.getEntries().forEach(function(entry){
          var delay=Math.round(entry.processingStart-entry.startTime);
          send({event_type:"vital",vital_name:"FID",vital_value:delay,fid_ms:delay});
        });
      });
      fidObs.observe({type:"first-input",buffered:true});
    }catch(e){}
  }

  // 3. Frontend JS Errors & Unhandled Promise Rejections
  addEventListener("error",function(e){
    send({
      event_type:"error",
      error_message:e.message||"Window Error",
      error_source:e.filename||"",
      error_line:e.lineno||0,
      error_stack:e.error&&e.error.stack?String(e.error.stack).slice(0,1000):""
    });
  });

  addEventListener("unhandledrejection",function(e){
    var reason=e.reason;
    send({
      event_type:"error",
      error_message:reason&&reason.message?reason.message:String(reason||"Unhandled Rejection"),
      error_stack:reason&&reason.stack?String(reason.stack).slice(0,1000):""
    });
  });

  // 4. Outbound fetch() W3C traceparent injection (links Browser RUM -> Backend RanuTrace)
  if(typeof window.fetch==="function"){
    var origFetch=window.fetch;
    window.fetch=function(input,init){
      var urlStr=typeof input==="string"?input:(input&&input.url)||"";
      if(urlStr.indexOf("${proxyBasePath}")!==-1){
        return origFetch.apply(this,arguments);
      }
      var traceId=randHex(32);
      var spanId=randHex(16);
      var traceparent="00-"+traceId+"-"+spanId+"-01";
      init=Object.assign({},init);
      try{
        var sameOrigin=urlStr.indexOf("/")===0||urlStr.indexOf(location.origin)===0;
        if(sameOrigin){
          var hdrs=new Headers(init.headers||(input instanceof Request?input.headers:undefined));
          if(!hdrs.has("traceparent"))hdrs.set("traceparent",traceparent);
          init.headers=hdrs;
        }
      }catch(e){}
      var t0=performance.now();
      return origFetch.call(this,input,init).then(function(res){
        var dur=Math.round(performance.now()-t0);
        if(res.status>=400||dur>1000){
          send({
            event_type:"xhr",
            trace_id:traceId,
            http_url:urlStr.slice(0,200),
            http_method:(init&&init.method)||"GET",
            http_status:res.status,
            duration_ms:dur
          });
        }
        return res;
      }).catch(function(err){
        send({
          event_type:"error",
          trace_id:traceId,
          error_message:"Fetch failed: "+(err&&err.message||urlStr)
        });
        throw err;
      });
    };
  }
})();`;
}

const cachedBrowserScript = buildBrowserScript();

function forwardEventsToOpenObserve(events) {
  if (!Array.isArray(events) || events.length === 0) return;

  const targetUrl = new URL(getRumIngestUrl());
  const nowMicros = Date.now() * 1000;

  const enriched = events.slice(0, 50).map((ev) => ({
    _timestamp: nowMicros,
    service_name: serviceName,
    environment: envName,
    project_id: resourceAttrs['project.id'] || '',
    tenant_id: resourceAttrs['tenant.id'] || '',
    ranupod_rum: true,
    ...ev,
  }));

  const body = JSON.stringify(enriched);
  const transport = targetUrl.protocol === 'https:' ? https : http;

  const req = transport.request(
    {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...otlpHeaders,
      },
      timeout: 4000,
    },
    (res) => {
      res.resume();
    }
  );

  req.on('error', () => {});
  req.write(body);
  req.end();
}

function getActiveTraceId() {
  try {
    const span = trace.getSpan(context.active());
    const ctx = span && span.spanContext && span.spanContext();
    return (ctx && ctx.traceId) || '';
  } catch (e) {
    return '';
  }
}

function buildHtmlSnippet(serverTraceId) {
  const cfg = JSON.stringify({
    service: serviceName,
    env: envName,
    proxyPath: proxyBasePath,
    sampleRate,
    serverTraceId: serverTraceId || '',
  });
  return `<script>window.__RANURUM_CONFIG__=${cfg};</script><script src="${proxyBasePath}/rum.js" defer></script>`;
}

/**
 * Patches Node's http.Server.prototype.emit to:
 * 1) Serve GET /__ranurum/rum.js and POST /__ranurum/events
 * 2) Auto-inject the RUM <script> snippet into uncompressed text/html responses
 */
function installRumHook() {
  if (!rumEnabled || http.Server.prototype.__ranurumPatched) return;
  http.Server.prototype.__ranurumPatched = true;

  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (type, req, res) {
    if (type === 'request' && req && res && typeof req.url === 'string') {
      const pathOnly = req.url.split('?')[0];

      // Route 1: Serve RUM browser agent JS
      if (req.method === 'GET' && pathOnly === `${proxyBasePath}/rum.js`) {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        });
        res.end(cachedBrowserScript);
        return true;
      }

      // Route 2: Receive RUM beacon batch & forward to OpenObserve
      if (req.method === 'POST' && pathOnly === `${proxyBasePath}/events`) {
        let raw = '';
        req.on('data', (chunk) => {
          if (raw.length < 65536) raw += chunk;
        });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed) ? parsed : [parsed];
            forwardEventsToOpenObserve(list);
          } catch (e) {}
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end('{"status":"ok"}');
        });
        return true;
      }

      // Auto-inject <script src="/__ranurum/rum.js"> into HTML responses
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
        const snippet = buildHtmlSnippet(getActiveTraceId());
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
