"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const app = (0, express_1.default)();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8084;
const SERVICE_NAME = 'service-d-payment';
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Operational health probe
app.get('/healthz', (_req, res) => {
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
 * TODO [Lab 2]: Install prom-client and implement RED metrics collection (http_requests_total, http_request_duration_seconds).
 */
app.get('/metrics', (_req, res) => {
    res.status(501).json({
        error: 'Not Implemented',
        message: 'GET /metrics is not implemented in this skeleton. Implement Prometheus metrics in Lab 2.',
        status_code: 501,
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
app.post('/payments/charge', (req, res) => {
    // TODO [Before day 2]:
    // 1. Verify idempotency key to prevent duplicate charges.
    // 2. Simulate third-party payment processing latency.
    // 3. Return 200 OK with transaction_id and status "SUCCESS" or decline with 402/400.
    res.status(501).json({
        error: 'Not Implemented',
        message: 'POST /payments/charge is not implemented in this skeleton. Implement payment gateway processing before day 2.',
        status_code: 501,
    });
});
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
});
