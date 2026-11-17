import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';

// METRICS : exporter en mode "pull", sans serveur fantôme sur le port 9464.
// Les métriques sont exposées par Express sur GET /metrics (voir server.ts).
export const prometheusExporter = new PrometheusExporter({ preventServerStart: true });

const sdk = new NodeSDK({
  // Nom du service tel qu'il apparaîtra dans Jaeger (service) et Loki (label service_name)
  resource: resourceFromAttributes({ 'service.name': 'service-a-auth' }),

  // TRACES : OTLP gRPC -> otel-collector:4317 -> Jaeger
  // (l'endpoint est lu dans OTEL_EXPORTER_OTLP_ENDPOINT)
  traceExporter: new OTLPTraceExporter(),

  // METRICS
  metricReader: prometheusExporter,

  // LOGS : OTLP gRPC -> otel-collector:4317 -> Loki
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],

  instrumentations: [
    getNodeAutoInstrumentations({
      // Remplace la variable d'env OTEL_NODE_ENABLED_INSTRUMENTATIONS du Dockerfile
      // (qui désactivait http/express/undici...). Métriques USE : CPU, mémoire...
      '@opentelemetry/instrumentation-host-metrics': { enabled: true },
    }),
  ],
});

sdk.start();