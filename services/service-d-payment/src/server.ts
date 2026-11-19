import express, { Request, Response } from 'express';
import cors from 'cors';
import { ChargeRequest, ChargeResponse, ErrorResponse } from './types';
import { randomUUID } from 'crypto';
import { trace, SpanStatusCode, metrics } from '@opentelemetry/api'; // Oui j'aurais pu le concaténer avec l'import de metrics mais je préfère garder les choses séparément.
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8084;
const SERVICE_NAME = 'service-d-payment';

const idempotencyStore = new Map<string, ChargeResponse>();

const tracer = trace.getTracer(SERVICE_NAME); // Avec ça je vais pouvoir créer des spans personnalisés.

// ==============================
// Mes paramètres de simulation :
// ==============================
const PAYMENT_LATENCY_MS = 0;//800; // On fixe une latence arbitraire de 800ms.
const PAYMENT_DECLINE_RATE = 0;//0.1;

// ===================================
// Début de ma fonciton pour les logs.
// ===================================
type LogLevel = 'info' | 'warn' | 'error';

// Logger OpenTelemetry : les logs émis ici partent au Collector puis dans Loki.
const otelLogger = logs.getLogger(SERVICE_NAME);
const SEVERITY: Record<LogLevel, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

function log(
  level: LogLevel,
  message: string,
  attributes: Record<string, string | number | boolean> = {},
): void {
  const spanContext = trace.getActiveSpan()?.spanContext();

  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    message,
    ...attributes,
    trace_id: spanContext?.traceId ?? null,
    span_id: spanContext?.spanId ?? null,
  };

  console.log(JSON.stringify(logEntry));

  // Même log envoyé à Loki. Le SDK y attache tout seul le trace_id / span_id
  // du span actif -> lien "View trace in Jaeger" dans Grafana.
  otelLogger.emit({
    severityNumber: SEVERITY[level],
    severityText: level.toUpperCase(),
    body: message,
    attributes, // order_id, payment_status... deviennent des champs filtrables dans Loki
  });
}
// =================================
// Fin de ma fonciton pour les logs.
// =================================


app.use(cors());
app.use(express.json());

/* J'ai déplacé le healthz en bas */


// ==========================================
// Mon espace réservé à faire /metrics
// Donc sortez d'ma plouze ! >:[
// ==========================================
import { prometheusExporter } from './instrumentation';


// Ici on récupère le système de métrique auquel nous allons intégrer certaines méthodes (notamment un compteur)
const meter = metrics.getMeter(SERVICE_NAME);

// Ici on crée notre compteur de requêtes.
const httpRequests = meter.createCounter('http_requests', {
  description: 'Total des requêtes HTTP terminées',
  unit: '{request}',  // On annonce que nous allons compter des requêtes, ce n'est pas obligatoire de préciser mais c'est mieux pour la documentation. (Oui, la librairie semble comprendre 'request')
});

// On initialise notre histogram.
const httpRequestDuration = meter.createHistogram(
  'http_request_duration',
  {
    description: 'Durée des requêtes HTTP',
    unit: 's',
    advice: { explicitBucketBoundaries: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.3, 0.5, 1, 2.5, 5] },
  },
);

const httpErrors = meter.createCounter('http_errors', {
  description: 'Nombre total de requêtes HTTP en erreur',
  unit: '{error}',});

// Ici on a notre fonction qui va définir le comportement [du service ?] pour chaque traitement de requêtes.
app.use((req: Request, res: Response, next) => {
  // On ne compte pas le scraping de /metrics
  // dans les métriques métier.
  if (req.path === '/metrics') {
    return next();
  }

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationSeconds =
      Number(process.hrtime.bigint() - start) / 1e9;

    // À la fin de la requête, Express a normalement
    // résolu la route et fixé le statut HTTP.
    const route = req.route?.path ?? req.path;

    const attributes = {
      'http.request.method': req.method,
      'http.route': route,
      'http.response.status_code': String(res.statusCode),
    };

    httpRequests.add(1, attributes);  // Nombre total de requêtes.

    if(res.statusCode >= 400){
      httpErrors.add(1, attributes);
    }

    httpRequestDuration.record(
      durationSeconds,
      attributes,
    );
  });

  next();
});

/**
 * GET /metrics
 * Purpose: Prometheus exposition format endpoint.
 * Skeleton: Returns 501 Not Implemented.
 * TODO [Lab 2]: Install OpenTelemetry and implement RED metrics collection (http_requests_total, http_request_duration_seconds). Pour ça on va utiliser OpenTelemetry
 */
app.get('/metrics', (req: Request, res: Response) => {
  prometheusExporter.getMetricsRequestHandler(req, res);
});


// Operational health probe
app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  });
});

// ==========================================
// Service Endpoints (Skeleton - Unimplemented)
// ==========================================

/**
 * POST /payments/charge
 * Purpose: Simulates payment authorization with idempotency keys.
 * Skeleton: Returns 501 Not Implemented.
 */

app.post(
  '/payments/charge',
  async (
    req: Request<{}, {}, ChargeRequest>,
    res: Response<ChargeResponse | ErrorResponse>
  ) => {
    return tracer.startActiveSpan('payment.process', async (span) => {
      try {
        // On vérifie que le corps de la requête est correctement structuré.
        const body: unknown = req.body;

        if (
          body === null ||
          typeof body !== 'object' ||
          Array.isArray(body)
        ) {
          return res.status(400).json({
            error: 'Bad Request',
            message: 'Request body must be a JSON object.',
            status_code: 400,
          });
        }

        const { order_id, amount_cents, idempotency_key } = body as Partial<ChargeRequest>;

        // Vérification de la clé d'idempotence.
        if (
          typeof idempotency_key !== 'string' ||
          idempotency_key.trim().length === 0
        ) {
          return res.status(400).json({
            error: 'Bad Request',
            message: 'idempotency_key is required.',
            status_code: 400,
          });
        }

        // Vérification de l'identifiant de commande.
        if (
          typeof order_id !== 'string' ||
          order_id.trim().length === 0
        ) {
          return res.status(400).json({
            error: 'Bad Request',
            message: 'order_id is required.',
            status_code: 400,
          });
        }

        // Vérification du montant.
        if (
          typeof amount_cents !== 'number' ||
          !Number.isSafeInteger(amount_cents) ||
          amount_cents <= 0
        ) {
          return res.status(400).json({
            error: 'Bad Request',
            message: 'amount_cents must be a positive safe integer.',
            status_code: 400,
          });
        }

        // Ajout d'informations métier au span.
        span.setAttribute('payment.order_id', order_id);
        span.setAttribute('payment.amount_cents', amount_cents);

        // Vérification de l'idempotence.
        const existingPayment = idempotencyStore.get(idempotency_key);

        if (existingPayment) {
          // #LOG_JSON
          log('info', 'Payment found in idempotency store', {
            order_id,
            payment_status: existingPayment.status,
          });

          span.setAttribute('payment.idempotency_hit', true);

          return res.status(
            existingPayment.status === 'SUCCESS' ? 200 : 402,
          ).json(existingPayment);
        }

        span.setAttribute('payment.idempotency_hit', false);

        // Simulation de la latence du prestataire.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PAYMENT_LATENCY_MS);
        });

        // Simulation d'un refus ou d'une acceptation.
        let paymentResponse: ChargeResponse;
        let httpStatus: number;

        if (Math.random() < PAYMENT_DECLINE_RATE) {
          paymentResponse = {
            transaction_id: randomUUID(),
            status: 'FAILED_DECLINED',
            code: 402,
            message: 'Payment declined by the simulated provider.',
          };

          httpStatus = 402;
        } else {
          paymentResponse = {
            transaction_id: randomUUID(),
            status: 'SUCCESS',
            code: 200,
          };

          httpStatus = 200;
        }

        // Mémorisation de la réponse.
        idempotencyStore.set(idempotency_key, paymentResponse);
        // #LOG_JSON
        log(
          paymentResponse.status === 'SUCCESS' ? 'info' : 'warn',
          'Payment processing completed',
          {
            order_id,
            transaction_id: paymentResponse.transaction_id,
            payment_status: paymentResponse.status,
            amount_cents,
            http_status: httpStatus,
          },
        );

        span.setAttribute('payment.status', paymentResponse.status);
        span.setAttribute('http.response.status_code', httpStatus);

        return res.status(httpStatus).json(paymentResponse);

      } catch (error) {
        // #LOG_JSON
        log('error', 'Payment processing failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Enregistrement de l'erreur dans la trace.
        span.recordException(
          error instanceof Error ? error : new Error(String(error))
        );

        span.setStatus({
          code: SpanStatusCode.ERROR,
        });

        return res.status(500).json({
          error: 'Internal Server Error',
          message: 'An unexpected error occurred while processing payment.',
          status_code: 500,
        });

      } finally {
        // Le span est toujours terminé, même en cas de retour anticipé.
        span.end();
      }
    });
  }
);

/*
app.post(
  '/payments/charge',
  async (req: Request<{}, {}, ChargeRequest>, res: Response<ChargeResponse | ErrorResponse>) => {
    // TODO [Before day 2]:
    // On vérifie que le corps de la requête reçue est correctement structurée.
    const body: unknown = req.body;
    // 1. Vérifier que le corps est un objet JSON exploitable.
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body)
    ) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Request body must be a JSON object.',
        status_code: 400,
      });
    }

    const { order_id, amount_cents, idempotency_key } = body as Partial<ChargeRequest>;

    // 2. Vérifier la clé d'idempotence.
    if (
      typeof idempotency_key !== 'string' ||
      idempotency_key.trim().length === 0
    ) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'idempotency_key is required.',
        status_code: 400,
      });
    }

    // 3. Vérifier l'identifiant de commande.
    if (
      typeof order_id !== 'string' ||
      order_id.trim().length === 0
    ) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'order_id is required.',
        status_code: 400,
      });
    }

    // 4. Vérifier le montant en centimes.
    if (
      typeof amount_cents !== 'number' ||
      !Number.isSafeInteger(amount_cents) ||
      amount_cents <= 0
    ) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'amount_cents must be a positive safe integer.',
        status_code: 400,
      });
    }

    // 5. Si la clé existe déjà, renvoyer le résultat mémorisé.
    const existingPayment = idempotencyStore.get(idempotency_key);

    if (existingPayment) {
      return res.status(
        existingPayment.status === 'SUCCESS' ? 200 : 402,
      ).json(existingPayment);
    }

    // 6. Simuler la latence du prestataire de paiement.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PAYMENT_LATENCY_MS);
    });

    // 7. Simuler un refus ou une acceptation du paiement.
    let paymentResponse: ChargeResponse;
    let httpStatus: number;

    if (Math.random() < PAYMENT_DECLINE_RATE) {
      paymentResponse = {
        transaction_id: randomUUID(),
        status: 'FAILED_DECLINED',
        code: 402,
        message: 'Payment declined by the simulated provider.',
      };

      httpStatus = 402;
    } else {
      paymentResponse = {
        transaction_id: randomUUID(),
        status: 'SUCCESS',
        code: 200
      };

      httpStatus = 200;
    }

    // 8. Mémoriser la réponse pour les prochaines requêtes.
    idempotencyStore.set(idempotency_key, paymentResponse);

    return res.status(httpStatus).json(paymentResponse);
    // 2. Simulate third-party payment processing latency.
    // 3. Return 200 OK with transaction_id and status "SUCCESS" or decline with 402/400.
  }
);*/

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
});
