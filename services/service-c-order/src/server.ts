import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { CheckoutRequest, CheckoutResponse, ErrorResponse } from './types';
import pino from 'pino';
import { trace, metrics } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { prometheusExporter } from './instrumentation';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8083;
const SERVICE_NAME = 'service-c-order';

// Downstream service configuration
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://service-a:8081';
const CATALOG_SERVICE_URL = process.env.CATALOG_SERVICE_URL || 'http://service-b:8082';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://service-d:8084';

// ==========================================
// Structured JSON logs (pino) with trace_id / span_id
// ==========================================
// Logs -> Loki: emitted here through the OTel Logs API (pino log sending is
// disabled in instrumentation.ts) so severity_text is uppercase (INFO / WARN /
// ERROR) like in services A, B and D. trace_id / span_id are attached by the SDK.
const otelLogger = logs.getLogger(SERVICE_NAME);
const PINO_LEVELS: Record<number, [SeverityNumber, string]> = {
  10: [SeverityNumber.TRACE, 'TRACE'],
  20: [SeverityNumber.DEBUG, 'DEBUG'],
  30: [SeverityNumber.INFO, 'INFO'],
  40: [SeverityNumber.WARN, 'WARN'],
  50: [SeverityNumber.ERROR, 'ERROR'],
  60: [SeverityNumber.FATAL, 'FATAL'],
};

function emitToOtel(level: number, args: unknown[]) {
  const [first, second] = args;
  const fields = typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {};
  const message = typeof first === 'string' ? first : typeof second === 'string' ? second : '';
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') attributes[key] = value;
    else if (value !== undefined && value !== null) attributes[key] = JSON.stringify(value);
  }
  const [severityNumber, severityText] = PINO_LEVELS[level] ?? [SeverityNumber.INFO, 'INFO'];
  otelLogger.emit({ severityNumber, severityText, body: message, attributes });
}

const logger = pino({
  base: { service: SERVICE_NAME },
  timestamp: pino.stdTimeFunctions.isoTime,
  hooks: {
    // Every logger.info/warn/error call: console (pino) + Loki (OTel)
    logMethod(args, method, level) {
      emitToOtel(level, args);
      return method.apply(this, args);
    },
  },
  mixin() {
    const span = trace.getActiveSpan();
    if (!span) return {};
    const { traceId, spanId } = span.spanContext();
    return { trace_id: traceId, span_id: spanId };
  },
});

// ==========================================
// Metrics (OpenTelemetry)
// ==========================================
// USE (CPU, mémoire, boucle d'événements) : fournies par instrumentation.ts
// (HostMetrics + RuntimeNodeInstrumentation).

const meter = metrics.getMeter(SERVICE_NAME, '1.0.0');

// R and E: counts every request, split by method, route and status code
// (l'exporter Prometheus ajoute "_total" -> http_requests_total)
const httpRequestsTotal = meter.createCounter('http_requests', {
  description: 'Total number of HTTP requests',
});

// D: measures how long each request takes, in seconds
const httpRequestDuration = meter.createHistogram('http_request_duration_seconds', {
  description: 'HTTP request duration in seconds',
  advice: { explicitBucketBoundaries: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1] },
});

// Measures every request for the RED metrics
app.use((req: Request, res: Response, next: NextFunction) => {
  // Skip Prometheus's own visits to /metrics so they do not pollute the numbers
  if (req.path === '/metrics') return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: req.route ? req.route.path : 'unmatched',
      status_code: String(res.statusCode),
    };
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestsTotal.add(1, labels);
    httpRequestDuration.record(seconds, labels);
  });
  next();
});

app.use(cors());
app.use(express.json());

// Operational health probe
app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: SERVICE_NAME,
    downstreams: {
      auth: AUTH_SERVICE_URL,
      catalog: CATALOG_SERVICE_URL,
      payment: PAYMENT_SERVICE_URL,
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /metrics
 * Purpose: Prometheus exposition format endpoint (USE + RED metrics via OpenTelemetry).
 */
app.get('/metrics', (req: Request, res: Response) => {
  prometheusExporter.getMetricsRequestHandler(req, res);
});

// ==========================================
// Service Endpoints
// ==========================================

/**
 * POST /orders/checkout
 * Purpose: Coordinates distributed checkout transaction saga.
 * Workflow:
 *   1. Authenticate user via Service A (GET /auth/verify) with trace context.
 *   2. Reserve inventory via Service B (POST /inventory/reserve) with trace context.
 *   3. Charge customer via Service D (POST /payments/charge) with trace context.
 *   4. Return 201 Created with { "order_id": "ORD-...", "status": "CONFIRMED" }.
 */
app.post(
  '/orders/checkout',
  async (req: Request<{}, {}, CheckoutRequest>, res: Response<CheckoutResponse | ErrorResponse>) => {
    const order_id = `ORD-${Date.now()}`;

    // Petite fonction pour répondre une erreur (et la logger)
    const fail = (status_code: number, message: string) => {
      logger.warn({ order_id, status_code, reason: message }, 'checkout failed');
      return res.status(status_code).json({ error: 'Checkout Failed', message, status_code });
    };

    // 1. Validate incoming checkout payload (user_id, items, payment_method).
    const { user_id, items, payment_method } = req.body ?? {};
    if (!user_id || !payment_method || !Array.isArray(items) || items.length === 0) {
      return fail(400, 'user_id, items and payment_method are required');
    }
    for (const item of items) {
      if (!item.product_id || !(item.quantity > 0)) {
        return fail(400, 'each item needs a product_id and a quantity > 0');
      }
    }

    // 2a. Le client doit fournir son jeton (obtenu via POST /auth/login sur A).
    // Sans header Authorization, inutile d'appeler A : on refuse tout de suite.
    const authorization = req.header('authorization');
    if (!authorization) {
      return fail(401, 'Missing authorization token');
    }

    logger.info({ order_id, user_id, items_count: items.length }, 'checkout started');

    // Headers communs aux appels sortants.
    // Le header W3C traceparent n'est PAS copié à la main : UndiciInstrumentation
    // (instrumentation.ts) l'ajoute à chaque fetch() avec le span courant de C.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // 5. Compensation : rend le stock réservé (POST /inventory/release)
    const release = async (reservation_id: string) => {
      await fetch(`${CATALOG_SERVICE_URL}/inventory/release`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ reservation_id }),
      }).catch(() => logger.error({ order_id, reservation_id }, 'inventory release failed'));
    };

    try {
      // 2b. Call Service A (GET /auth/verify) with the client's own token.
      const authResp = await fetch(`${AUTH_SERVICE_URL}/auth/verify`, {
        method: 'GET',
        headers: { ...headers, Authorization: authorization },
      });
      const auth = await authResp.json().catch(() => null);
      if (!authResp.ok || !auth?.valid) {
        return fail(401, 'Authentication failed');
      }

      // 3. Call Service B (POST /inventory/reserve) passing W3C traceparent headers.
      const reserveResp = await fetch(`${CATALOG_SERVICE_URL}/inventory/reserve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ items }),
      });
      const reserve = await reserveResp.json().catch(() => null);
      if (!reserveResp.ok || !reserve?.reservation_id) {
        // Preserve client-caused catalog errors so they are not counted as checkout server failures.
        const statusCode = [400, 404, 409].includes(reserveResp.status) ? reserveResp.status : 502;
        return fail(statusCode, reserve?.message ?? 'Inventory reservation failed');
      }
      const reservation_id: string = reserve.reservation_id;

      // Montant à payer : prix récupérés via GET /products (Service B)
      const productsResp = await fetch(`${CATALOG_SERVICE_URL}/products`, { headers });
      const products: { id: string; price_cents: number }[] = await productsResp.json().catch(() => []);
      let total_cents = 0;
      for (const item of items) {
        const product = Array.isArray(products) ? products.find((p) => p.id === item.product_id) : undefined;
        if (!product) {
          await release(reservation_id);
          return fail(502, `Price not found for ${item.product_id}`);
        }
        total_cents += product.price_cents * item.quantity;
      }

      // 4. Call Service D (POST /payments/charge) passing W3C traceparent headers.
      const chargeResp = await fetch(`${PAYMENT_SERVICE_URL}/payments/charge`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ order_id, amount_cents: total_cents, idempotency_key: order_id }),
      });
      const charge = await chargeResp.json().catch(() => null);
      if (!chargeResp.ok || charge?.status !== 'SUCCESS') {
        await release(reservation_id);
        return fail(chargeResp.status === 402 ? 402 : 502, charge?.message ?? 'Payment failed');
      }

      // 6. Return 201 Created { order_id, status: "CONFIRMED" }.
      logger.info({ order_id, total_cents, transaction_id: charge.transaction_id }, 'checkout confirmed');
      return res.status(201).json({
        order_id,
        status: 'CONFIRMED',
        total_cents,
        reservation_id,
        transaction_id: charge.transaction_id,
      });
    } catch (err) {
      // Un service est éteint / injoignable
      logger.error({ err, order_id }, 'checkout error: downstream unreachable');
      return fail(502, 'A downstream service is unreachable');
    }
  }
);

app.listen(PORT, '0.0.0.0', () => {
  logger.info(
    { port: PORT, auth: AUTH_SERVICE_URL, catalog: CATALOG_SERVICE_URL, payment: PAYMENT_SERVICE_URL },
    'service started'
  );
});