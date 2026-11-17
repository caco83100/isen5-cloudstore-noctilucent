import { ReleaseRequest, ReleaseResponse, RouteResult } from '../types';
import { findProduct, reservations } from '../models/catalog';
import { logInfo, logError } from '../midlewares/logger';

/**
 * Releases a previous reservation: puts its items back in stock
 * and deletes the reservation so it cannot be released twice.
 */
export function releaseInventory(body: ReleaseRequest): RouteResult<ReleaseResponse> {
  if (typeof body?.reservation_id !== 'string' || body.reservation_id === '') {
    logError('Release rejected: missing reservation_id');
    return {
      status: 400,
      body: { error: 'Bad Request', message: 'Body must contain a "reservation_id" string', status_code: 400 },
    };
  }

  const { reservation_id } = body;
  const items = reservations.get(reservation_id);
  if (!items) {
    logError(`Release rejected: reservation ${reservation_id} not found`);
    return {
      status: 404,
      body: {
        error: 'Not Found',
        message: `Reservation ${reservation_id} does not exist or was already released`,
        status_code: 404,
      },
    };
  }

  for (const item of items) {
    const product = findProduct(item.product_id);
    if (product) {
      product.stock += item.quantity;
    }
  }
  reservations.delete(reservation_id);
  logInfo(`Stock released: ${reservation_id}`);

  return { status: 200, body: { reservation_id, status: 'released' } };
}
