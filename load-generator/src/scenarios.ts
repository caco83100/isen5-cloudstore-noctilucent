import { RequestRecord, ScenarioDefinition } from './types';

export const SCENARIOS: ScenarioDefinition[] = [
  {
    id: 'checkout-saga',
    name: 'Full Checkout Saga (Nominal)',
    description: 'Executes standard customer checkouts via Service C, orchestrating Auth token check, Catalog stock lock, and Payment charging.',
    defaultIntervalMs: 500,
    targetService: 'order',
  },
  {
    id: 'nominal-browsing',
    name: 'Catalog Browsing & Sessions',
    description: 'Simulates store visitors browsing product inventory (Service B) and refreshing user sessions (Service A).',
    defaultIntervalMs: 250,
    targetService: 'catalog',
  },
  {
    id: 'peak-traffic',
    name: 'Peak Shopping Surge',
    description: 'High-frequency purchase burst simulating flash sales and rush hours to measure concurrency and latency queues.',
    defaultIntervalMs: 100,
    targetService: 'order',
  },
  {
    id: 'out-of-stock',
    name: 'Out-of-Stock Purchase (409)',
    description: 'Attempts to checkout items with quantities exceeding available inventory, expecting 409 Conflict handling and saga compensation.',
    defaultIntervalMs: 400,
    targetService: 'order',
  },
  {
    id: 'custom-single',
    name: 'Custom Endpoint Ping',
    description: 'Send custom requests directly to any specified microservice and route.',
    defaultIntervalMs: 300,
    targetService: 'custom',
  },
];

export interface EndpointsConfig {
  serviceA: string;
  serviceB: string;
  serviceC: string;
  serviceD: string;
  customUrl: string;
  customMethod: string;
  customBody: string;
}

export function generateTraceContext(): { traceId: string; spanId: string; header: string } {
  const hex = (len: number) => {
    let out = '';
    while (out.length < len) {
      out += Math.random().toString(16).substring(2);
    }
    return out.substring(0, len);
  };

  const traceId = hex(32);
  const spanId = hex(16);
  const header = `00-${traceId}-${spanId}-01`;
  return { traceId, spanId, header };
}

let counter = 0;

// ==========================================
// Authentication (Service A)
// ==========================================
// The load generator behaves like a real client: it logs in once through
// POST /auth/login, keeps the signed JWT, and sends it as
// "Authorization: Bearer <jwt>". Service A only accepts signed, non-expired JWTs.
// Test account: the mock user defined in services/service-a-auth/src/server.ts.
const TEST_ACCOUNT = { username: 'alice', password: 'mon_password' };
const TOKEN_REFRESH_MARGIN_MS = 60_000; // re-login 1 min before expiry

let cachedToken: { value: string; expiresAt: number } | null = null;
// Login in progress, shared by concurrent requests (avoids N parallel logins)
let pendingLogin: Promise<string | null> | null = null;

function getAuthToken(serviceA: string): Promise<string | null> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return Promise.resolve(cachedToken.value);
  }
  if (!pendingLogin) {
    pendingLogin = login(serviceA).finally(() => {
      pendingLogin = null;
    });
  }
  return pendingLogin;
}

async function login(serviceA: string): Promise<string | null> {
  try {
    const resp = await fetch(`${serviceA}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TEST_ACCOUNT),
    });
    if (!resp.ok) {
      cachedToken = null;
      return null;
    }
    const data = (await resp.json()) as { token: string; expires_in: number };
    cachedToken = { value: data.token, expiresAt: Date.now() + data.expires_in * 1000 };
    return cachedToken.value;
  } catch {
    // Service A unreachable: the request is sent without a token and its 401
    // shows up in the stream (a real signal that auth is down).
    cachedToken = null;
    return null;
  }
}

export async function executeScenarioStep(
  scenarioId: string,
  endpoints: EndpointsConfig,
  injectTraceContext: boolean
): Promise<RequestRecord> {
  counter++;
  const id = `req-${Date.now()}-${counter}`;
  const timestamp = new Date().toISOString();

  let method = 'GET';
  let url = '';
  let body: unknown = undefined;
  let traceId: string | undefined = undefined;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (injectTraceContext) {
    const ctx = generateTraceContext();
    headers['traceparent'] = ctx.header;
    headers['x-client-request-id'] = id;
    traceId = ctx.traceId;
  }

  const userId = `USER-${(counter % 20) + 1}`;

  // Scenarios that hit an authenticated route get the real JWT
  const needsAuth = ['checkout-saga', 'peak-traffic', 'out-of-stock', 'nominal-browsing'].includes(scenarioId);
  const token = needsAuth ? await getAuthToken(endpoints.serviceA) : null;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  switch (scenarioId) {
    case 'checkout-saga':
    case 'peak-traffic': {
      method = 'POST';
      url = `${endpoints.serviceC}/orders/checkout`;
      body = {
        user_id: userId,
        items: [
          { product_id: `PROD-${(counter % 5) + 1}`, quantity: (counter % 3) + 1 },
        ],
        payment_method: 'card',
      };
      break;
    }

    case 'nominal-browsing': {
      const mode = counter % 2;
      if (mode === 0) {
        method = 'GET';
        url = `${endpoints.serviceB}/products`;
      } else {
        method = 'GET';
        url = `${endpoints.serviceA}/auth/verify`;
        // Authorization: real JWT set above (no more unsigned "demo-token-...")
      }
      break;
    }

    case 'out-of-stock': {
      method = 'POST';
      url = `${endpoints.serviceC}/orders/checkout`;
      body = {
        user_id: userId,
        items: [{ product_id: 'PROD-DEPLETED-999', quantity: 99999 }],
        payment_method: 'card',
      };
      break;
    }

    case 'custom-single':
    default: {
      method = endpoints.customMethod || 'GET';
      url = endpoints.customUrl || `${endpoints.serviceA}/healthz`;
      if (method !== 'GET' && method !== 'HEAD' && endpoints.customBody) {
        try {
          body = JSON.parse(endpoints.customBody);
        } catch {
          body = { raw: endpoints.customBody };
        }
      }
      break;
    }
  }

  const startTime = performance.now();
  let status = 0;
  let responseBody: unknown = null;
  let errorMsg: string | undefined = undefined;

  try {
    const fetchOptions: RequestInit = {
      method,
      headers,
    };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(body);
    }

    const resp = await fetch(url, fetchOptions);
    status = resp.status;
    if (status === 401 && token) {
      // Token rejected (expired, A restarted with another secret...): log in again next time
      cachedToken = null;
    }
    const text = await resp.text();
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  } catch (err) {
    status = 0;
    errorMsg = (err as Error).message || 'Network request failed';
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    id,
    timestamp,
    scenarioName: SCENARIOS.find((s) => s.id === scenarioId)?.name || scenarioId,
    method,
    url,
    status,
    durationMs,
    traceId,
    requestHeaders: headers,
    requestBody: body,
    responseBody,
    error: errorMsg,
  };
}
