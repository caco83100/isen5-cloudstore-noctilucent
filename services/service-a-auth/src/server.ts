import './instrumentation'; // S'assure que le SDK démarre avant le reste
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { LoginRequest, TokenResponse, AuthVerifyResponse, ErrorResponse } from './types';
import { trace, context, propagation, metrics, SpanStatusCode } from '@opentelemetry/api';
import { prometheusExporter } from './instrumentation'; // Import de l'instance partagée
import { log } from './logger';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8081;
const JWT_SECRET = process.env.JWT_SECRET || 'ma_cle_secrete_par_defaut';
const SERVICE_NAME = 'service-a-auth';

// Initialisation des métriques RED manuelles[cite: 1]
const meter = metrics.getMeter(SERVICE_NAME);
const requestCounter = meter.createCounter('http_requests_total', { description: 'Total number of HTTP requests' });
const requestDuration = meter.createHistogram('http_request_duration_seconds', {
  description: 'Duration of HTTP requests in seconds',
  unit: 's',
  // Buckets en secondes (les buckets par défaut d'OTel sont prévus pour des millisecondes)
  advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] },
});

// Spans internes (cascade Jaeger) : user store, signature et vérification du JWT
const tracer = trace.getTracer(SERVICE_NAME);

app.use(cors());
// express.json() est enregistré APRÈS le middleware de métriques (plus bas),
// pour que les requêtes au JSON invalide (400) soient comptées elles aussi.

// Routes techniques exclues des logs d'accès (voir plus bas)
const NOISY_ROUTES = new Set(['/metrics', '/healthz']);

// Middleware global pour la collecte des métriques RED
app.use((req, res, next) => {
  const startTime = process.hrtime();
  res.on('finish', () => {
    const duration = process.hrtime(startTime);
    const durationInSeconds = duration[0] + duration[1] / 1e9;
    // 'unmatched' évite d'exploser la cardinalité avec des URL inconnues (404)
    const attributes = { route: req.route?.path || 'unmatched', method: req.method, status_code: res.statusCode };
    requestCounter.add(1, attributes);
    requestDuration.record(durationInSeconds, attributes);

    // Log d'accès : un par requête, corrélé à la trace via le contexte actif.
    // Pas de log pour les sondes techniques (Prometheus scrape /metrics toutes
    // les 5 s, Docker appelle /healthz) : elles noieraient les vrais logs.
    // Elles restent comptées dans les métriques ci-dessus.
    if (NOISY_ROUTES.has(attributes.route)) return;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log(level, 'HTTP request completed', {
      'http.method': req.method,
      'http.route': attributes.route,
      'http.status_code': res.statusCode,
      'http.duration_s': durationInSeconds,
    });
  });
  next();
});

app.use(express.json());

// Operational health probe
app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', (req: Request, res: Response) => {
  prometheusExporter.getMetricsRequestHandler(req, res);
});

// ==========================================
// Service Endpoints (Skeleton)
// ==========================================

/**
 * POST /auth/login
 * Purpose: Accepts customer credentials, issues JWT or session token.
 * Skeleton: Returns 501 Not Implemented.
 */
app.post('/auth/login', (req: Request<{}, {}, LoginRequest>, res: Response<TokenResponse | ErrorResponse>) => {
  // TODO [Before day 2]:
  // 1. Validate credentials payload.
  const { username, password } = req.body;
  const activeSpan = trace.getActiveSpan();

  // 1. Verify that username and password are provided in the request body.
  if (!username || !password) {
    log('warn', 'Login rejected: missing credentials');
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Username and password are required',
      status_code: 400
    });
  }

  //Mock
  // Span interne "user_store.find" : simule la requête à la base d'utilisateurs
  const credentialsOk = tracer.startActiveSpan('user_store.find', (span) => {
    span.setAttributes({ 'db.system': 'in-memory', 'db.operation': 'find_user', 'app.username': username });
    const ok = username === 'alice' && password === 'mon_password';
    span.setAttribute('app.user.found', ok);
    span.end();
    return ok;
  });

  if (!credentialsOk) {
    log('warn', 'Login failed: invalid credentials', { username });
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid credentials',
      status_code: 401
    });
  }

  // 2. Verify credentials against a user store (e.g., database, mock).
  // const user = await findUserByUsername(username);
  // if (!user || !verifyPassword(password, user.passwordHash)) {
  //   return res.status(401).json({ error: 'Unauthorized', message: 'Invalid credentials', status_code: 401 });
  // }

  // 3. Simulate successful authentication for the skeleton implementation.
  //const userId = 'user-placeholder-id';
  const userId = 'user-alice-id'
  const expiresInSeconds = 3600; // 1 hour

  // 2. Issue signed JWT/session token containing user ID.

  const tokenPayload = {
    user_id: userId,
    username: username,
  };

  const token = tracer.startActiveSpan('token.sign', (span) => {
    span.setAttribute('auth.token.expires_in_s', expiresInSeconds);
    const signed = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: expiresInSeconds });
    span.end();
    return signed;
  });

  // 3. Inject trace context and baggage (observability to implement later)
  activeSpan?.setAttribute('app.user.id', userId);
  const currentBaggage = propagation.getBaggage(context.active()) || propagation.createBaggage();
  const updatedBaggage = currentBaggage.setEntry('user_id', { value: userId });
  context.with(propagation.setBaggage(context.active(), updatedBaggage), () => {
    log('info', 'User logged in', { user_id: userId });
  });
  // 4. Return TokenResponse (200 OK) or Unauthorized (401).

  return res.status(200).json({
    token: token,
    user_id: userId,
    expires_in: expiresInSeconds,
  });

  //res.status(501).json({
  //  error: 'Not Implemented',
  //  message: 'POST /auth/login is not implemented in this skeleton. Implement authentication logic before day 2.',
  //  status_code: 501,
  //});
});

/**
 * GET /auth/verify
 * Purpose: Validates token in Authorization header: Bearer <token>.
 * Skeleton: Returns 501 Not Implemented.
 */
app.get('/auth/verify', (req: Request, res: Response<AuthVerifyResponse | ErrorResponse>) => {
  // TODO [Before day 2]:
  // 1. Extract Bearer token from req.headers.authorization.
  const authHeader = req.headers.authorization;
  const token = authHeader?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const activeSpan = trace.getActiveSpan();

  // If the token is missing or malformed, return 401 Unauthorized.
  if (!token) {
    log('warn', 'Verify rejected: missing or malformed token');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or malformed authorization token',
      status_code: 401,
    });
  }

  try {
    // Span interne "token.verify" : signature + expiration du JWT.
    // Un jeton refusé ajoute un span event (raison du refus) au lieu d'une erreur :
    // c'est une erreur du client (401), pas une panne de A.
    const decoded = tracer.startActiveSpan('token.verify', (span) => {
      try {
        const payload = jwt.verify(token, JWT_SECRET) as {
          user_id: string;
          username?: string;
          roles?: string[];
        };
        span.setAttribute('auth.token.valid', true);
        return payload;
      } catch (err) {
        span.setAttribute('auth.token.valid', false);
        span.addEvent('token.rejected', { reason: (err as Error).name });
        throw err;
      } finally {
        span.end();
      }
    });

    activeSpan?.setAttribute('app.user.id', decoded.user_id);
    const currentBaggage = propagation.getBaggage(context.active()) || propagation.createBaggage();
    const updatedBaggage = currentBaggage.setEntry('user_id', { value: decoded.user_id });

    context.with(propagation.setBaggage(context.active(), updatedBaggage), () => {
      log('info', 'Token verified', { user_id: decoded.user_id });
    });

    return res.status(200).json({ valid: true, user_id: decoded.user_id, roles: decoded.roles });
  } catch (error) {
    log('warn', 'Invalid or expired token');
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token', status_code: 401 });
  }
});

// Gestionnaire d'erreurs (doit être déclaré APRÈS les routes).
// express.json() lève une erreur sur un corps mal formé : on répond un 400 en JSON
// au lieu de la page HTML par défaut d'Express. Toute autre erreur -> 500 en JSON.
app.use((err: { type?: string; status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  const message = err.type === 'entity.parse.failed' ? 'Malformed JSON body' : status < 500 ? err.message ?? 'Bad Request' : 'Unexpected error';
  if (status >= 500) {
    trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  }
  log(status >= 500 ? 'error' : 'warn', 'Request rejected by error handler', { reason: message, status_code: status });
  res.status(status).json({ error: status < 500 ? 'Bad Request' : 'Internal Server Error', message, status_code: status });
});

app.listen(PORT, '0.0.0.0', () => {
  log('info', `${SERVICE_NAME} listening on port ${PORT}`, { port: PORT });
});