const BASE_URL = process.env.ORDERS_API_URL || 'https://orders.internal.example.com';
const TIMEOUT_MS = 5000;
const MAX_TIMEOUT_RETRIES = 3;

class OrdersApiError extends Error {
  constructor(status, body) {
    super(`orders api responded ${status}`);
    this.name = 'OrdersApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', query, body } = {}) {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(query || {})) {
    url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = await res.json();
    if (!res.ok) throw new OrdersApiError(res.status, json);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function isTimeout(err) {
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

async function listOrders({ limit = 100, offset = 0 } = {}) {
  const body = await request('/v2/orders', { query: { limit, offset } });
  return {
    orders: body.data.map((order) => ({
      ...order,
      taxCountry: order.ship_to.country,
    })),
    total_count: body.total_count,
    pageCount: Math.ceil(body.total_count / limit),
  };
}

async function createOrderAdjustment(adjustment) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_TIMEOUT_RETRIES; attempt += 1) {
    try {
      return await request('/v2/orders', { method: 'POST', body: adjustment });
    } catch (err) {
      if (!isTimeout(err)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

module.exports = { listOrders, createOrderAdjustment, OrdersApiError };
