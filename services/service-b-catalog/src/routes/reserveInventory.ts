import { randomUUID } from 'crypto';
import { ReserveRequest, ReserveResponse, ReservationItem, RouteResult } from '../types';
import { findProduct, reservations } from '../models/catalog';
import { logInfo, logError } from '../midlewares/logger';

/**
 * Reserves the requested items in stock.
 * Either every item is reserved, or none is (all-or-nothing).
 */
export function reserveInventory(body: ReserveRequest): RouteResult<ReserveResponse> {
  const items = validateItems(body);
  if (!items) {
    logError('Reserve rejected: invalid request body');
    return {
      status: 400,
      body: {
        error: 'Bad Request',
        message: 'Body must contain a non-empty "items" array of { product_id: string, quantity: positive integer }',
        status_code: 400,
      },
    };
  }

  // 1. Check availability for every item before touching the stock.
  for (const item of items) {
    const product = findProduct(item.product_id);
    if (!product) {
      logError(`Reserve rejected: product ${item.product_id} does not exist`);
      return {
        status: 404,
        body: { error: 'Not Found', message: `Product ${item.product_id} does not exist`, status_code: 404 },
      };
    }
    if (product.stock < item.quantity) {
      logError(`Reserve rejected: insufficient stock for ${item.product_id} (requested ${item.quantity}, available ${product.stock})`);
      return {
        status: 409,
        body: {
          error: 'Conflict',
          message: `Insufficient stock for ${item.product_id} (requested ${item.quantity}, available ${product.stock})`,
          status_code: 409,
        },
      };
    }
  }

  // 2. Decrement stock. This runs synchronously, so no other request can
  //    interleave between the check above and this update.
  for (const item of items) {
    findProduct(item.product_id)!.stock -= item.quantity;
  }

  const reservation_id = randomUUID();
  reservations.set(reservation_id, items);
  logInfo(`Stock reserved: ${reservation_id}`);

  return { status: 200, body: { reservation_id, status: 'reserved' } };
}

/**
 * Validates the request body and merges duplicate product lines
 * (e.g. two lines for p-001 become one with the summed quantity).
 * Returns null if the body is invalid.
 */
function validateItems(body: ReserveRequest): ReservationItem[] | null {
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return null;
  }

  const merged = new Map<string, number>();
  for (const item of body.items) {
    if (typeof item?.product_id !== 'string' || !Number.isInteger(item.quantity) || item.quantity <= 0) {
      return null;
    }
    merged.set(item.product_id, (merged.get(item.product_id) ?? 0) + item.quantity);
  }

  return [...merged].map(([product_id, quantity]) => ({ product_id, quantity }));
}
