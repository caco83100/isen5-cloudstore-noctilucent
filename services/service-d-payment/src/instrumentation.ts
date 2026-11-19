import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { HostMetrics } from '@opentelemetry/host-metrics';

export const prometheusExporter = new PrometheusExporter({
  preventServerStart: true,
});

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': 'service-d-payment',
  }),
  traceExporter: new OTLPTraceExporter(),
  metricReader: prometheusExporter,
  // Logs -> OTLP gRPC -> otel-collector:4317 -> Loki
  // (BatchLogRecordProcessor prend un objet { exporter } dans cette version du SDK)
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  instrumentations: [
    getNodeAutoInstrumentations({
      // Do not trace Prometheus scraping (/metrics, every 5 s) nor Docker
      // healthchecks (/healthz, every 10 s): Jaeger stays readable.
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) => req.url === '/metrics' || req.url === '/healthz',
      },
    }),
  ],
});

sdk.start();

new HostMetrics({ name: 'service-d-payment' }).start();


/*import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import {
  PeriodicExportingMetricReader,
  ConsoleMetricExporter,
} from '@opentelemetry/sdk-metrics';

const sdk = new NodeSDK({
  traceExporter: new ConsoleSpanExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new ConsoleMetricExporter(),
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();*/