import { prometheusExporter } from './instrumentation';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  Product,
  ReserveRequest,
  ReserveResponse,
  ReleaseRequest,
  ReleaseResponse,
  ErrorResponse,
} from './types';
import { getProducts } from './routes/getProducts';
import { reserveInventory } from './routes/reserveInventory';
import { releaseInventory } from './routes/releaseInventory';
import { metricsMiddleware } from './midlewares/metrics';
import { logInfo, logWarn, logError } from './midlewares/logger';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8082;
const SERVICE_NAME = 'service-b-catalog';

// ==========================================
// Internal spans (catalog store operations)
// ==========================================
// Each store operation gets its own span under the HTTP span, so the Jaeger
// waterfall shows the "database" step (here the in-memory catalog).
// Logs written inside fn() carry this span's span_id.
const tracer = trace.getTracer(SERVICE_NAME);

function withStoreSpan<T extends { status: number }>(operation: string, fn: () => T): T {
  return tracer.startActiveSpan(`catalog_store.${operation}`, (span) => {
    span.setAttributes({ 'db.system': 'in-memory', 'db.operation': operation });
    try {
      const result = fn();
      span.setAttribute('app.result.status_code', result.status);
      if (result.status === 409) {
        // Span event: business refusal visible directly in the waterfall
        span.addEvent('stock.insufficient');
      }
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

// Metrics first: requests rejected by express.json() (invalid JSON -> 400)
// are counted too, otherwise they would be invisible on the dashboard.
app.use(metricsMiddleware);
app.use(cors());
app.use(express.json());

// Operational health probe
app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /metrics
 * Purpose: Prometheus exposition format endpoint.
 * Skeleton: Returns 501 Not Implemented.
 * TODO [Lab 2]: Install OPTel and implement RED metrics collection (http_requests_total, http_request_duration_seconds).
 */
app.get('/metrics', (_req: Request, res: Response<ErrorResponse>) => {
  prometheusExporter.getMetricsRequestHandler(_req, res);
});

// ==========================================
// Service Endpoints
// ==========================================

/**
 * GET /products
 * Purpose: Returns product list with stock counts.
 */
app.get('/products', (_req: Request, res: Response<Product[] | ErrorResponse>) => {
  try {
    const { status, body } = withStoreSpan('list_products', getProducts);
    res.status(status).json(body);
  } catch (err) {
    logError('Unexpected error', { route: '/products', status_code: 500, error: String(err) });
    res.status(500).json({ error: 'Internal Server Error', message: String(err), status_code: 500 });
  }
});

/**
 * POST /inventory/reserve
 * Purpose: Locks requested items in stock (200 with reservation_id, 409 if stock is insufficient).
 */
app.post(
  '/inventory/reserve',
  (req: Request<{}, {}, ReserveRequest>, res: Response<ReserveResponse | ErrorResponse>) => {
    try {
      const { status, body } = withStoreSpan('reserve', () => reserveInventory(req.body));
      res.status(status).json(body);
    } catch (err) {
      logError('Unexpected error', { route: '/inventory/reserve', status_code: 500, error: String(err) });
      res.status(500).json({ error: 'Internal Server Error', message: String(err), status_code: 500 });
    }
  }
);

/**
 * POST /inventory/release
 * Purpose: Releases previously reserved stock on rollback / checkout abort.
 */
app.post(
  '/inventory/release',
  (req: Request<{}, {}, ReleaseRequest>, res: Response<ReleaseResponse | ErrorResponse>) => {
    try {
      const { status, body } = withStoreSpan('release', () => releaseInventory(req.body));
      res.status(status).json(body);
    } catch (err) {
      logError('Unexpected error', { route: '/inventory/release', status_code: 500, error: String(err) });
      res.status(500).json({ error: 'Internal Server Error', message: String(err), status_code: 500 });
    }
  }
);

// Error handler (must be registered AFTER the routes).
// express.json() throws on a malformed body: answer a JSON 400 instead of
// Express's default HTML error page. Any other error -> JSON 500.
app.use((err: { type?: string; status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  const message = err.type === 'entity.parse.failed' ? 'Malformed JSON body' : status < 500 ? err.message ?? 'Bad Request' : 'Unexpected error';
  if (status >= 500) {
    trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    logError('Request rejected by error handler', { status_code: status, reason: message });
  } else {
    logWarn('Request rejected by error handler', { status_code: status, reason: message });
  }
  res.status(status).json({ error: status < 500 ? 'Bad Request' : 'Internal Server Error', message, status_code: status });
});

app.listen(PORT, '0.0.0.0', () => {
  logInfo('Service started', { port: PORT });
});
