// @ranupod/ranutrace-node auto-registration script
// Usage: node --require @ranupod/ranutrace-node/register app.js
// Or injected via NODE_OPTIONS="--require @ranupod/ranutrace-node/register"

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');
const { trace, context } = require('@opentelemetry/api');

const serviceName = process.env.OTEL_SERVICE_NAME || process.env.DD_SERVICE || 'ranupod-node-app';
const agentHost = process.env.DD_AGENT_HOST || 'alloy-otlp.observability.svc';
const defaultEndpoint = `http://${agentHost}:4318/v1/traces`;
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT 
  ? (process.env.OTEL_EXPORTER_OTLP_ENDPOINT.endsWith('/v1/traces') 
      ? process.env.OTEL_EXPORTER_OTLP_ENDPOINT 
      : `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`)
  : defaultEndpoint;

const traceExporter = new OTLPTraceExporter({
  url: endpoint,
});

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    'deployment.environment': process.env.DD_ENV || process.env.NODE_ENV || 'production',
    'ranupod.managed': 'true',
  }),
  traceExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false }, // Avoid cluttering traces with file reads
    }),
  ],
});

sdk.start();

/**
 * Helper to retrieve active correlation identifiers from OpenTelemetry context
 * Compatible with Datadog & OpenTelemetry standards:
 * - trace_id: 32-hex character string
 * - span_id: 16-hex character string
 * - correlation_id: alias to trace_id
 */
function getTraceCorrelation() {
  const activeSpan = trace.getSpan(context.active());
  if (!activeSpan) {
    return {
      trace_id: '',
      span_id: '',
      trace_flags: '',
      correlation_id: '',
    };
  }
  const spanContext = activeSpan.spanContext();
  if (!spanContext || !spanContext.traceId) {
    return {
      trace_id: '',
      span_id: '',
      trace_flags: '',
      correlation_id: '',
    };
  }

  const traceId = spanContext.traceId;
  const spanId = spanContext.spanId;
  const traceFlags = spanContext.traceFlags ? spanContext.traceFlags.toString(16).padStart(2, '0') : '01';

  return {
    trace_id: traceId,
    span_id: spanId,
    trace_flags: traceFlags,
    correlation_id: traceId,
  };
}

/**
 * Patch standard console methods (log, info, warn, error, debug)
 * to automatically inject [trace_id=... span_id=...] prefix when inside an active trace span,
 * similar to Datadog Node.js tracer log injection (DD_LOGS_INJECTION=true).
 */
const shouldInjectConsole = process.env.RANUPOD_LOGS_INJECTION !== 'false' && process.env.DD_LOGS_INJECTION !== 'false';

if (shouldInjectConsole) {
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  methods.forEach((method) => {
    const original = console[method];
    console[method] = function (...args) {
      const { trace_id, span_id } = getTraceCorrelation();
      if (trace_id) {
        // Datadog & standard OTel format: [dd.trace_id=... dd.span_id=...] [trace_id=... span_id=...]
        const prefix = `[trace_id=${trace_id} span_id=${span_id}]`;
        if (typeof args[0] === 'string') {
          return original.call(console, `${prefix} ${args[0]}`, ...args.slice(1));
        } else if (typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
          // If first argument is a JSON object (e.g. Pino or Winston raw object), enrich it directly
          try {
            args[0].trace_id = trace_id;
            args[0].span_id = span_id;
            args[0].correlation_id = trace_id;
            return original.apply(console, args);
          } catch (e) {
            return original.call(console, prefix, ...args);
          }
        } else {
          return original.call(console, prefix, ...args);
        }
      }
      return original.apply(console, args);
    };
  });
}

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('[RanuPod Trace] Tracing terminated gracefully'))
    .catch((error) => console.error('[RanuPod Trace] Error terminating tracing', error))
    .finally(() => process.exit(0));
});

module.exports = {
  sdk,
  getTraceCorrelation,
};
