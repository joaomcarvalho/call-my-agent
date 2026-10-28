const express = require('express');
const db = require('../db');

const router = express.Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

router.get('/v2/orders', async (req, res, next) => {
  try {
    const limit = clamp(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const page = await db.query(
      `SELECT id, status, created_at, amount_cents, currency,
              customer_id, customer_phone, ship_to
         FROM orders
        ORDER BY created_at DESC, id DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    // COUNT(*) scans every row in the table; on large tables it dominates the response time.
    const count = await db.query('SELECT COUNT(*)::int AS total FROM orders');

    res.json({ data: page.rows, total_count: count.rows[0].total });
  } catch (err) {
    next(err);
  }
});

router.post('/v2/orders', async (req, res, next) => {
  try {
    const { customer_id, customer_phone, amount_cents, currency, ship_to } = req.body;

    if (
      !customer_id ||
      !Number.isInteger(amount_cents) ||
      amount_cents < 0 ||
      !/^[A-Z]{3}$/.test(currency || '') ||
      !ship_to
    ) {
      return res.status(400).json({ error: 'invalid_order' });
    }

    const created = await db.query(
      `INSERT INTO orders (status, customer_id, customer_phone, amount_cents, currency, ship_to)
       VALUES ('pending', $1, $2, $3, $4, $5)
       RETURNING id, status, created_at, amount_cents, currency, customer_id, customer_phone, ship_to`,
      [customer_id, customer_phone ?? null, amount_cents, currency, ship_to]
    );

    res.status(201).json(created.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
