const { listOrders } = require('../clients/ordersClient');
const { vatRateFor } = require('../tax/vat');

const PAGE_SIZE = 100;

function renderPageSummary({ page, totalCount, pageSize }) {
  const pages = Math.max(1, Math.ceil(totalCount / pageSize));
  return `Showing page ${page} of ${pages} (${totalCount} orders)`;
}

async function fetchAllOrders() {
  const orders = [];
  let offset = 0;
  let totalCount = 0;

  do {
    const result = await listOrders({ limit: PAGE_SIZE, offset });
    totalCount = result.total_count;
    orders.push(...result.orders);
    if (result.orders.length === 0) break;
    offset += PAGE_SIZE;
  } while (offset < totalCount);

  return { orders, totalCount };
}

function monthKey(isoDate) {
  return isoDate.slice(0, 7);
}

async function monthlyRevenue(month) {
  const { orders, totalCount } = await fetchAllOrders();
  const inMonth = orders.filter((order) => monthKey(order.created_at) === month);

  let grossCents = 0;
  let vatCents = 0;
  for (const order of inMonth) {
    grossCents += order.amount_cents;
    vatCents += Math.round(order.amount_cents * vatRateFor(order));
  }

  return {
    month,
    orderCount: inMonth.length,
    grossCents,
    vatCents,
    netCents: grossCents - vatCents,
    summary: renderPageSummary({ page: 1, totalCount, pageSize: PAGE_SIZE }),
  };
}

module.exports = { monthlyRevenue, renderPageSummary };
