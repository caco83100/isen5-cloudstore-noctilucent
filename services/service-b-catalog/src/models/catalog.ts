import { Product, ReservationItem } from '../types';

/**
 * In-memory mock data store for the catalog.
 * Data is reset every time the service restarts.
 */
export const products: Product[] = [
  { id: 'p-001', name: 'Mechanical Keyboard', price_cents: 8999, stock: 25 },
  { id: 'p-002', name: 'Wireless Mouse', price_cents: 3499, stock: 50 },
  { id: 'p-003', name: '27" Monitor', price_cents: 24999, stock: 10 },
  { id: 'p-004', name: 'USB-C Hub', price_cents: 2999, stock: 40 },
  { id: 'p-005', name: 'Noise Cancelling Headphones', price_cents: 19999, stock: 0 },
];

/** Active reservations: reservation_id -> items held out of stock. */
export const reservations = new Map<string, ReservationItem[]>();

export function findProduct(id: string): Product | undefined {
  return products.find((p) => p.id === id);
}
