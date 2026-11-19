import { Product, RouteResult } from '../types';
import { products } from '../models/catalog';
import { logInfo } from '../midlewares/logger';

/**
 * Returns the product list with current stock levels.
 */
export function getProducts(): RouteResult<Product[]> {
  logInfo('Products listed', {
    route: '/products',
    status_code: 200,
    products_count: products.length,
    out_of_stock_count: products.filter((p) => p.stock === 0).length,
  });
  // Return copies so callers cannot mutate the store.
  return { status: 200, body: products.map((p) => ({ ...p })) };
}
