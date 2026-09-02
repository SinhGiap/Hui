'use strict';
// Third-party (non-AWS) APIs. Both are keyless and free, so no credential ever
// has to live in the Learner Lab environment.
// [1] Nager.Date Public Holiday API. https://date.nager.at/swagger/index.html
// [2] ExchangeRate-API open endpoint. https://www.exchangerate-api.com/docs/free

const cache = new Map(); // per-container memo; a cold start just re-fetches.
const TTL_MS = 6 * 60 * 60 * 1000;

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await fn();
  cache.set(key, { value, at: Date.now() });
  return value;
}

// Public holidays for the group's country, used to shift contribution due dates
// off days when banks are shut. Returns a Set of YYYY-MM-DD.
async function publicHolidays(countryCode, years) {
  const all = new Set();
  for (const year of years) {
    const dates = await cached(`hol:${countryCode}:${year}`, async () => {
      const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`);
      if (!res.ok) return []; // a holiday lookup failing must not block starting a group
      const body = await res.json();
      return body.map((h) => h.date);
    });
    dates.forEach((d) => all.add(d));
  }
  return all;
}

// Members of a diaspora group often think in a different currency than the pot
// is denominated in, so group pages show both.
async function convert(amount, from, to) {
  if (!to || from === to) return null;
  const rates = await cached(`fx:${from}`, async () => {
    const res = await fetch(`https://open.er-api.com/v6/latest/${from}`);
    if (!res.ok) return null;
    return (await res.json()).rates;
  });
  const rate = rates && rates[to];
  return rate ? { amount: Math.round(amount * rate * 100) / 100, currency: to, rate } : null;
}

module.exports = { publicHolidays, convert };
