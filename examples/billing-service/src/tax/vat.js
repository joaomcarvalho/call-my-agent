const VAT_RATES = {
  BE: 0.21,
  DE: 0.19,
  ES: 0.21,
  FR: 0.2,
  IE: 0.23,
  IT: 0.22,
  NL: 0.21,
  PL: 0.23,
  PT: 0.23,
  SE: 0.25,
};

function vatRateFor(order) {
  const country = order.ship_to && order.ship_to.country;
  return VAT_RATES[country] ?? 0;
}

module.exports = { VAT_RATES, vatRateFor };
