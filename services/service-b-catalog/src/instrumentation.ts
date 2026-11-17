import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';

// Metrics : pulled by Prometheus on GET /metrics (served by server.ts)
export const prometheusExporter = new PrometheusExporter({ preventServerStart: true });

// Traces & Logs : pushed over OTLP/gRPC to the OTel Collector (-> Jaeger / Loki).
// The Collector URL comes from OTEL_EXPORTER_OTLP_ENDPOINT (docker-compose.yml).
const sdk = new NodeSDK({
    serviceName: 'service-b-catalog',
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [prometheusExporter],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
