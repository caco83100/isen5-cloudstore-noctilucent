/* instrumentation.ts
 * Initialise OpenTelemetry AVANT le reste de l'application :
 *   - traces  -> collector (OTLP gRPC) -> Jaeger
 *   - logs    -> collector (OTLP gRPC) -> Loki
 *   - metrics -> exposées sur GET /metrics (format Prometheus) via l'exporter OpenTelemetry
 * Chargé au démarrage avec : node --require ./dist/instrumentation.js dist/server.js
 */
import { NodeSDK, logs } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { HostMetrics } from '@opentelemetry/host-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';

// Adresse du collector (fournie par docker-compose, sinon localhost)
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';

// Métriques : l'exporter Prometheus d'OpenTelemetry.
// preventServerStart: on n'ouvre pas de 2e port, c'est la route Express /metrics qui l'expose.
export const prometheusExporter = new PrometheusExporter({ preventServerStart: true });

const sdk = new NodeSDK({
  // Identité du service (nom affiché dans Jaeger, Loki et Prometheus)
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'service-c-order',
    [ATTR_SERVICE_VERSION]: '1.0.0',
  }),

  // Traces -> collector (gRPC, port 4317) -> Jaeger
  traceExporter: new OTLPTraceExporter({ url: endpoint }),

  // Logs -> collector (gRPC, port 4317) -> Loki
  logRecordProcessors: [new logs.BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: endpoint }) })],

  // Metrics -> lues par Prometheus sur GET /metrics
  metricReader: prometheusExporter,

  // Ce qu'on instrumente
  instrumentations: [
    // ← modifié : on ne trace pas le scraping Prometheus (/metrics, toutes les 5 s)
    // ni les healthchecks Docker (/healthz, toutes les 10 s) -> Jaeger reste lisible
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => req.url === '/metrics' || req.url === '/healthz',
    }),
    new ExpressInstrumentation(),
    // fetch() (undici) : crée un span client et ajoute l'en-tête W3C traceparent
    // aux appels vers A, B et D -> une seule trace de bout en bout
    new UndiciInstrumentation(),
    // Log sending is done in server.ts (pino hook) to get uppercase severity_text.
    // The instrumentation still injects trace_id / span_id into the console JSON.
    new PinoInstrumentation({ disableLogSending: true }),
    new RuntimeNodeInstrumentation(), // USE : boucle d'événements, mémoire V8
  ],
});

sdk.start();

// USE : CPU et mémoire du processus (et de la machine)
new HostMetrics({ name: 'service-c-order' }).start();

// Envoie les dernières données avant l'arrêt du conteneur
process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});