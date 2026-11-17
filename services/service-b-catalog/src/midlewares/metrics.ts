import { Request, Response, NextFunction } from 'express';
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('service-b-catalog');

//Rate: number of requests
const httpRequestsTotal = meter.createCounter('http_requests_total', {
    description: 'Total number of HTTP requests'
})

//Duration: time taken to process requests
const httpRequestDuration = meter.createHistogram('http_request_duration_seconds', {
    description : 'Duration of HTTP requests (seconds)',
    unit: 's',
    advice: {
        explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    }
})

/**
 * Records RED metrics for every request (except /metrics itself).
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === '/metrics') {
    return next();
  }

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const attributes = {
      method: req.method,
      route: req.route?.path ?? 'unmatched',
      status_code: String(res.statusCode),
    };
    httpRequestsTotal.add(1, attributes);
    httpRequestDuration.record(durationSeconds, attributes);
  });

  next();
}