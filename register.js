// @ranupod/trace auto-registration script
// Usage: node --require @ranupod/trace/register app.js
// Or injected via NODE_OPTIONS="--require @ranupod/trace/register"

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');

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

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('[RanuPod Trace] Tracing terminated gracefully'))
    .catch((error) => console.error('[RanuPod Trace] Error terminating tracing', error))
    .finally(() => process.exit(0));
});

module.exports = sdk;
