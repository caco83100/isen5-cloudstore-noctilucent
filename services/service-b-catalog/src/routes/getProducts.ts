import { Product, RouteResult } from '../types';
import { products } from '../models/catalog';
import { logInfo, logError } from '../midlewares/logger';

/**
 * Returns the product list with current stock levels.
 */
export function getProducts(): RouteResult<Product[]> {
  logInfo(`Products listed: ${products.length} items`);
  // Return copies so callers cannot mutate the store.
  return { status: 200, body: products.map((p) => ({ ...p })) };
}
