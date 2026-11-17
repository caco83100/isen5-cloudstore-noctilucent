import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { context } from '@opentelemetry/api';

const otelLogger = logs.getLogger('service-a-auth');

const SEVERITY = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
} as const;

export type LogLevel = keyof typeof SEVERITY;

/**
 * Émet un log structuré via OpenTelemetry (-> collector -> Loki).
 * Passer context.active() suffit pour que le trace_id et le span_id
 * de la requête en cours soient attachés automatiquement au log.
 */
export function log(
  level: LogLevel,
  message: string,
  attributes: Record<string, string | number | boolean> = {},
): void {
  otelLogger.emit({
    severityNumber: SEVERITY[level],
    severityText: level.toUpperCase(),
    body: message,
    attributes,
    context: context.active(),
  });
}