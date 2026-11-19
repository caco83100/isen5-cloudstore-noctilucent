import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { trace } from '@opentelemetry/api';

const SERVICE_NAME = 'service-b-catalog';
const otelLogger = logs.getLogger(SERVICE_NAME);

// Business fields attached to a log (route, product_id, reservation_id...).
// They become filterable fields in Loki.
export type LogAttributes = Record<string, string | number | boolean>;

type Level = 'INFO' | 'WARN' | 'ERROR';
const SEVERITY: Record<Level, SeverityNumber> = {
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
};

function log(level: Level, message: string, attributes: LogAttributes = {}) {
  // Console: one JSON line (docker compose logs), with the active trace context
  const span = trace.getActiveSpan()?.spanContext();
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    message,
    ...attributes,
    trace_id: span?.traceId ?? null,
    span_id: span?.spanId ?? null,
  });
  if (level === 'ERROR') console.error(line);
  else console.log(line);

  // Loki: the SDK attaches trace_id / span_id of the active span automatically
  otelLogger.emit({ severityNumber: SEVERITY[level], severityText: level, body: message, attributes });
}

/** Normal business event (stock reserved, products listed...). */
export const logInfo = (message: string, attributes?: LogAttributes) => log('INFO', message, attributes);

/** Request rejected because of the client (4xx): expected, not a service failure. */
export const logWarn = (message: string, attributes?: LogAttributes) => log('WARN', message, attributes);

/** Service failure (5xx, unexpected exception). */
export const logError = (message: string, attributes?: LogAttributes) => log('ERROR', message, attributes);
