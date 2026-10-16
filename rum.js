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

// Determine OpenObserve base URL for JSON ingestion: /api/{org}
function getOpenObserveBaseUrl() {
  return (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://192.10.1.9:5080/api/default')
    .replace(/\/v1\/traces\/?$/, '')
    .replace(/\/+$/, '');
}

const appVersion = process.env.DD_VERSION || process.env.npm_package_version || '1.0.0';

function parseUserAgentInfo(ua) {
  const s = String(ua || '');
  let browser = 'Browser';
  if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/Chrome\//i.test(s) && !/Chromium/i.test(s)) browser = 'Chrome';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/Safari\//i.test(s) && !/Chrome\//i.test(s)) browser = 'Safari';

  let os = 'Linux';
  if (/Mac OS X|Macintosh/i.test(s)) os = 'Mac OS X';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';

  const device = /Mobi|Android|iPhone|iPad/i.test(s) ? 'Mobile' : 'Desktop';
  return { browser, os, device };
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

  function randHex(len){
    var s="";
    while(s.length<len)s+=Math.random().toString(16).slice(2);
    return s.slice(0,len);
  }

  var sessionId="";
  try{
    sessionId=sessionStorage.getItem("_ranurum_sid");
    if(!sessionId){
      sessionId=randHex(16);
      sessionStorage.setItem("_ranurum_sid",sessionId);
    }
  }catch(e){sessionId="anon";}

  var viewId=randHex(16);
  var pageTraceId=cfg.serverTraceId||randHex(32);
  var queue=[];
  var flushTimer=null;

  function send(evt,immediate){
    var payload=Object.assign({
      service_name:cfg.service||"${serviceName}",
      environment:cfg.env||"${envName}",
      session_id:sessionId,
      view_id:viewId,
      trace_id:evt.trace_id||pageTraceId,
      page_url:location.href,
      page_path:location.pathname,
      referrer:document.referrer||"",
      user_agent:navigator.userAgent
    },evt);
    queue.push(payload);
    if(immediate||queue.length>=10)flush();
    else if(!flushTimer)flushTimer=setTimeout(flush,1500);
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

  // 1. Page Navigation & Timing (TTFB, FCP, DOM Load, Full Load)
  function recordNavigation(){
    try{
      var fcpMs=0;
      if(performance.getEntriesByType){
        var paints=performance.getEntriesByType("paint")||[];
        for(var i=0;i<paints.length;i++){
          if(paints[i].name==="first-contentful-paint")fcpMs=Math.round(paints[i].startTime);
        }
      }
      var nav=performance.getEntriesByType&&performance.getEntriesByType("navigation")[0];
      if(nav){
        var ttfb=Math.max(0,Math.round(nav.responseStart-nav.requestStart));
        var domLoad=Math.max(0,Math.round(nav.domContentLoadedEventEnd-nav.startTime));
        var fullLoad=Math.max(0,Math.round((nav.loadEventEnd>0?nav.loadEventEnd-nav.startTime:performance.now())));
        send({
          event_type:"pageview",
          ttfb_ms:ttfb,
          fcp_ms:fcpMs||ttfb,
          dom_load_ms:domLoad,
          load_ms:fullLoad
        },true);
      }else{
        send({event_type:"pageview",load_ms:Math.round(performance.now()),fcp_ms:fcpMs},true);
      }
    }catch(e){}
  }
  if(document.readyState==="complete")setTimeout(recordNavigation,50);
  else addEventListener("load",function(){setTimeout(recordNavigation,100);});

  // 2. Core Web Vitals (LCP, CLS, FID/INP) via PerformanceObserver
  if(typeof PerformanceObserver!=="undefined"){
    try{
      var lcpSent=false;
      var lcpVal=0;
      var lcpTimer=null;
      var lcpObs=new PerformanceObserver(function(list){
        var entries=list.getEntries();
        var last=entries[entries.length-1];
        if(last){
          lcpVal=Math.round(last.startTime);
          if(!lcpSent&&!lcpTimer){
            lcpTimer=setTimeout(function(){
              if(lcpVal>0&&!lcpSent){
                lcpSent=true;
                send({event_type:"vital",vital_name:"LCP",vital_value:lcpVal,lcp_ms:lcpVal},true);
              }
            },1200);
          }
        }
      });
      lcpObs.observe({type:"largest-contentful-paint",buffered:true});
    }catch(e){}

    try{
      var clsVal=0;
      var clsSent=false;
      var clsObs=new PerformanceObserver(function(list){
        list.getEntries().forEach(function(entry){
          if(!entry.hadRecentInput)clsVal+=entry.value;
        });
        if(clsVal>0&&!clsSent){
          clsSent=true;
          var rounded=Math.round(clsVal*1000)/1000;
          send({event_type:"vital",vital_name:"CLS",vital_value:rounded,cls_score:rounded});
        }
      });
      clsObs.observe({type:"layout-shift",buffered:true});
    }catch(e){}

    try{
      var fidObs=new PerformanceObserver(function(list){
        list.getEntries().forEach(function(entry){
          var delay=Math.round(entry.processingStart-entry.startTime);
          send({event_type:"vital",vital_name:"FID",vital_value:delay,fid_ms:delay},true);
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
      error_source:e.filename||"source",
      error_line:e.lineno||0,
      error_stack:e.error&&e.error.stack?String(e.error.stack).slice(0,1000):""
    },true);
  });

  addEventListener("unhandledrejection",function(e){
    var reason=e.reason;
    send({
      event_type:"error",
      error_message:reason&&reason.message?reason.message:String(reason||"Unhandled Rejection"),
      error_source:"source",
      error_stack:reason&&reason.stack?String(reason.stack).slice(0,1000):""
    },true);
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
          error_source:"network",
          error_message:"Fetch failed: "+(err&&err.message||urlStr)
        },true);
        throw err;
      });
    };
  }
})();`;
}

const cachedBrowserScript = buildBrowserScript();

function postJsonToOpenObserve(urlStr, payloadArray) {
  if (!Array.isArray(payloadArray) || payloadArray.length === 0) return;
  try {
    const targetUrl = new URL(urlStr);
    const body = JSON.stringify(payloadArray);
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
  } catch (e) {}
}

function forwardEventsToOpenObserve(events, clientIp) {
  if (!Array.isArray(events) || events.length === 0) return;

  const baseUrl = getOpenObserveBaseUrl();
  const nowMs = Date.now();
  const nowMicros = nowMs * 1000;
  const sessionMap = new Map();

  const enriched = events.slice(0, 50).map((ev) => {
    const evType = ev.event_type || 'pageview';
    let ooType = 'view';
    if (evType === 'error') ooType = 'error';
    else if (evType === 'xhr') ooType = 'resource';
    else if (evType === 'action') ooType = 'action';

    const uaInfo = parseUserAgentInfo(ev.user_agent);
    const sid = ev.session_id || 'anon';
    const vid = ev.view_id || sid;

    if (!sessionMap.has(sid)) {
      sessionMap.set(sid, {
        _timestamp: nowMicros,
        session_id: sid,
        view_id: vid,
        start: nowMs - Math.max(Number(ev.load_ms) || 1000, 1000),
        end: nowMs + 5000,
        user_agent_user_agent_family: uaInfo.browser,
        user_agent_os_family: uaInfo.os,
        user_agent_device_family: uaInfo.device,
        ip: clientIp || '0.0.0.0',
        source: 'browser',
        service: serviceName,
        env: envName,
        version: appVersion,
        has_full_snapshot: false,
        records_count: 1,
        index_in_view: 0,
      });
    }

    const ttfbNs = ev.ttfb_ms != null ? Math.round(Number(ev.ttfb_ms) * 1000000) : null;
    const fcpNs = ev.fcp_ms != null ? Math.round(Number(ev.fcp_ms) * 1000000) : ttfbNs;
    const loadNs = ev.load_ms != null ? Math.round(Number(ev.load_ms) * 1000000) : null;
    const lcpNs = ev.lcp_ms != null ? Math.round(Number(ev.lcp_ms) * 1000000) : null;
    const inpNs = ev.fid_ms != null ? Math.round(Number(ev.fid_ms) * 1000000) : null;
    const clsVal = ev.cls_score != null ? Number(ev.cls_score) : 0;

    return {
      _timestamp: nowMicros,
      // RanuPod Console fields
      service_name: serviceName,
      environment: envName,
      project_id: resourceAttrs['project.id'] || '',
      tenant_id: resourceAttrs['tenant.id'] || '',
      ranupod_rum: true,
      // OpenObserve Built-in RUM (_rumdata) required fields
      service: serviceName,
      env: envName,
      version: appVersion,
      source: 'browser',
      application_id: resourceAttrs['project.id'] || serviceName,
      session_id: sid,
      session_type: 'user',
      session_has_replay: true,
      type: ooType,
      view_id: vid,
      view_url: ev.page_url || '',
      view_url_path: ev.page_path || '/',
      view_first_byte: ttfbNs,
      view_first_contentful_paint: fcpNs,
      view_loading_time: loadNs,
      view_largest_contentful_paint: lcpNs,
      view_interaction_to_next_paint: inpNs,
      view_cumulative_layout_shift: clsVal,
      view_time_spent: loadNs || 1000000000,
      error_id: ooType === 'error' ? `${sid}-${nowMs}` : null,
      error_message: ev.error_message || null,
      error_stack: ev.error_stack || null,
      error_handling: ooType === 'error' ? 'unhandled' : null,
      error_source: ooType === 'error' ? (ev.error_source || 'source') : null,
       error_is_crash: false,
      resource_url: ev.http_url || null,
      resource_method: ev.http_method || null,
      resource_status_code: ev.http_status != null ? Number(ev.http_status) : null,
      resource_duration: ev.duration_ms != null ? Math.round(Number(ev.duration_ms) * 1000000) : null,
      resource_size: ooType === 'resource' ? 1024 : null,
      user_agent_user_agent_family: uaInfo.browser,
      user_agent_os_family: uaInfo.os,
      user_agent_device_family: uaInfo.device,
      ...ev,
    };
  });

  // 1) Ingest into OpenObserve's native RUM stream: _rumdata
  postJsonToOpenObserve(`${baseUrl}/_rumdata/_json`, enriched);

  // 2) Ingest session metadata into _sessionreplay so OpenObserve RUM Sessions tab populates
  const sessionList = Array.from(sessionMap.values());
  if (sessionList.length > 0) {
    postJsonToOpenObserve(`${baseUrl}/_sessionreplay/_json`, sessionList);
  }
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
  return `<script>window.__RANURUM_CONFIG__=${cfg};</script><script src="${proxyBasePath}/rum.js?v=1.2.2" defer></script>`;
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
          'Cache-Control': 'no-cache, no-store, must-revalidate',
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
            const xff = req.headers && req.headers['x-forwarded-for'];
            const clientIp = (xff ? String(xff).split(',')[0].trim() : '') || (req.socket && req.socket.remoteAddress) || '';
            forwardEventsToOpenObserve(list, clientIp);
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
