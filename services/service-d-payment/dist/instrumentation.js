"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prometheusExporter = void 0;
const sdk_node_1 = require("@opentelemetry/sdk-node");
const auto_instrumentations_node_1 = require("@opentelemetry/auto-instrumentations-node");
const exporter_trace_otlp_grpc_1 = require("@opentelemetry/exporter-trace-otlp-grpc");
const exporter_prometheus_1 = require("@opentelemetry/exporter-prometheus");
const resources_1 = require("@opentelemetry/resources");
exports.prometheusExporter = new exporter_prometheus_1.PrometheusExporter({
    preventServerStart: true,
});
const sdk = new sdk_node_1.NodeSDK({
    resource: (0, resources_1.resourceFromAttributes)({
        'service.name': 'service-d-payment',
    }),
    traceExporter: new exporter_trace_otlp_grpc_1.OTLPTraceExporter(),
    metricReader: exports.prometheusExporter,
    instrumentations: [(0, auto_instrumentations_node_1.getNodeAutoInstrumentations)()],
});
sdk.start();
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
