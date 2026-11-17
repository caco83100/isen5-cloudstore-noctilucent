import { logs, SeverityNumber } from '@opentelemetry/api-logs';

const otelLogger = logs.getLogger('service-b-catalog');

export function logInfo(message: string) {
  console.log(message);
  otelLogger.emit({ severityNumber: SeverityNumber.INFO, severityText: 'INFO', body: message });
}

export function logError(message: string) {
  console.error(message);
  otelLogger.emit({ severityNumber: SeverityNumber.ERROR, severityText: 'ERROR', body: message });
}