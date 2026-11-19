import { prometheusExporter } from './instrumentation';
import express, { Request, Response } from 'express';
import cors from 'cors';
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
import { logInfo, logError } from './midlewares/logger';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8082;
const SERVICE_NAME = 'service-b-catalog';

app.use(cors());
app.use(express.json());
app.use(metricsMiddleware);

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
    const { status, body } = getProducts();
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
      const { status, body } = reserveInventory(req.body);
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
      const { status, body } = releaseInventory(req.body);
      res.status(status).json(body);
    } catch (err) {
      logError('Unexpected error', { route: '/inventory/release', status_code: 500, error: String(err) });
      res.status(500).json({ error: 'Internal Server Error', message: String(err), status_code: 500 });
    }
  }
);

app.listen(PORT, '0.0.0.0', () => {
  logInfo('Service started', { port: PORT });
});
