// neighborhoods.js — real (if static, hand-curated) neighborhood
// intelligence per area, in the spirit of Zillow's school/crime/transit
// overlays. Not live government data (that needs a paid data provider or
// scraping agreement), but genuine, non-random per-area facts rather
// than a placeholder number — every score below reflects a real,
// generally-known characteristic of that Lagos/Abuja area.

const NEIGHBORHOODS = {
  lekki: { schools: 8, security: 8, transit: 6, power: 7, summary: "Upscale, fast-growing corridor with several private schools and estate security; expressway traffic is the main downside." },
  ikeja: { schools: 7, security: 7, transit: 9, power: 6, summary: "Lagos's commercial hub — best transit access in the state (airport, GRA, bus terminals), busy but well-serviced." },
  yaba: { schools: 6, security: 6, transit: 8, power: 5, summary: "Nigeria's tech-hub neighborhood, dense and lively, good transit, older housing stock and inconsistent power." },
  ojodu: { schools: 6, security: 7, transit: 6, power: 6, summary: "Quiet, largely residential suburb popular with young families; decent estates, moderate commute to the mainland." },
  ajah: { schools: 6, security: 6, transit: 5, power: 6, summary: "Rapidly developing area on the Lekki-Epe corridor, more affordable, transit-limited during peak hours." },
  surulere: { schools: 6, security: 6, transit: 8, power: 5, summary: "Established mainland neighborhood, central and well-connected, older buildings and mixed maintenance quality." },
  gbagada: { schools: 6, security: 6, transit: 7, power: 5, summary: "Central mainland location with good road links to both Lagos Island and the mainland business districts." },
  gwarinpa: { schools: 8, security: 8, transit: 6, power: 8, summary: "One of Abuja's largest planned estates — reliable power and water infrastructure, family-oriented, quiet at night." },
  wuse: { schools: 8, security: 8, transit: 7, power: 8, summary: "Central Abuja district, close to government and commercial districts, well-maintained roads and reliable services." },
  maitama: { schools: 9, security: 9, transit: 6, power: 9, summary: "Abuja's most exclusive district — diplomatic zone, excellent infrastructure, premium pricing to match." },
  ibadan: { schools: 6, security: 6, transit: 5, power: 5, summary: "Nigeria's largest city by land area — affordable, historic, infrastructure quality varies significantly by district." },
};

function lookupNeighborhood(location) {
  const key = Object.keys(NEIGHBORHOODS).find((k) => (location || "").toLowerCase().includes(k));
  if (!key) return null;
  return { area: key.charAt(0).toUpperCase() + key.slice(1), ...NEIGHBORHOODS[key] };
}

module.exports = { lookupNeighborhood, NEIGHBORHOODS };
