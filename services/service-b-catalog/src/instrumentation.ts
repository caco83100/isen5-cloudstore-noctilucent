import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { HostMetrics } from '@opentelemetry/host-metrics';

// Metrics : pulled by Prometheus on GET /metrics (served by server.ts)
export const prometheusExporter = new PrometheusExporter({ preventServerStart: true });

// Traces & Logs : pushed over OTLP/gRPC to the OTel Collector (-> Jaeger / Loki).
// The Collector URL comes from OTEL_EXPORTER_OTLP_ENDPOINT (docker-compose.yml).
const sdk = new NodeSDK({
    serviceName: 'service-b-catalog',
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [prometheusExporter],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    instrumentations: [
        getNodeAutoInstrumentations({
            // Do not trace Prometheus scraping (/metrics, every 5 s) nor Docker
            // healthchecks (/healthz, every 10 s): Jaeger stays readable.
            // They are still counted in the RED metrics.
            '@opentelemetry/instrumentation-http': {
                ignoreIncomingRequestHook: (req) => req.url === '/metrics' || req.url === '/healthz',
            },
        }),
    ],
});

sdk.start();

// USE: process CPU and memory (process_cpu_utilization, process_memory_usage)
// for the "USE" row of the dashboard, like services A and C.
new HostMetrics({ name: 'service-b-catalog' }).start();
