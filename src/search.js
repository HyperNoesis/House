// search.js — natural-language query parsing + grounded ranking.
//
// Two parsing paths:
//  1. `parseQueryHeuristic` — regex/keyword extraction. Zero cost, zero
//     dependencies, works offline, always available.
//  2. `parseQueryLLM` — if ANTHROPIC_API_KEY is set in the environment,
//     this asks Claude to do structured extraction instead, which
//     handles phrasing the regex path can't ("somewhere quiet with easy
//     access to the mainland", "my budget is about 3 million naira a
//     year"). It returns the exact same shape as the heuristic parser,
//     so everything downstream (scoring, explanations) is unchanged —
//     only the extraction step is smarter when a key is configured.
//
// Ranking and explanation generation are always grounded in real
// listing fields — nothing about a match is invented by the LLM path;
// it only extracts what the user asked for, and the same deterministic
// scoreProperty() function does the rest either way.

const NIGERIAN_LOCATIONS = [
  "lekki", "ikeja", "yaba", "ojodu", "ajah", "surulere", "gbagada",
  "maryland", "ikoyi", "victoria island", "vi", "magodo", "ikorodu",
  "festac", "apapa", "ogba", "isolo", "wuse", "gwarinpa", "maitama",
  "garki", "asokoro", "jabi", "lugbe", "ibadan", "abeokuta", "ogun",
  "port harcourt", "gra port harcourt", "benin", "benin city", "enugu",
  "kano", "kaduna", "jos", "calabar", "warri", "uyo", "abuja", "lagos",
];

const AMENITY_SYNONYMS = {
  parking: ["parking", "car park", "garage"],
  water: ["water", "borehole", "running water"],
  power: ["power", "electricity", "light"],
  generator: ["generator", "gen", "24/7 power", "steady power"],
  security: ["security", "secure", "gated", "guard", "estate"],
  furnished: ["furnished", "furniture"],
  serviced: ["serviced"],
  garden: ["garden", "compound"],
  pool: ["pool", "swimming"],
  gated: ["gated", "estate", "gate house"],
};
const KNOWN_AMENITIES = Object.keys(AMENITY_SYNONYMS);

function parseQueryHeuristic(text) {
  const t = (text || "").toLowerCase();

  // Budget: supports "2.5m", "₦2.5m", "under 3m", "between 2m and 4m",
  // "around 3 million".
  let budget = null;
  let budgetMin = null;
  const between = t.match(/between\s*₦?\s?([\d.]+)\s?m?\s*(?:and|-)\s*₦?\s?([\d.]+)\s?m/);
  const millionWord = t.match(/([\d.]+)\s*million/);
  const simpleM = t.match(/₦?\s?([\d.]+)\s?m\b/);
  if (between) {
    budgetMin = parseFloat(between[1]);
    budget = parseFloat(between[2]);
  } else if (millionWord) {
    budget = parseFloat(millionWord[1]);
  } else if (simpleM) {
    budget = parseFloat(simpleM[1]);
  }

  const bedsMatch = t.match(/(\d+)\s?[- ]?(?:bed|bedroom)/);
  const location = NIGERIAN_LOCATIONS.find((loc) => t.includes(loc)) || null;
  const amenities = KNOWN_AMENITIES.filter((key) => AMENITY_SYNONYMS[key].some((syn) => t.includes(syn)));

  return {
    budget,
    budgetMin,
    beds: bedsMatch ? parseInt(bedsMatch[1], 10) : null,
    location,
    amenities,
    source: "heuristic",
  };
}

async function parseQueryLLM(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const prompt = `Extract structured house-hunting criteria from this query. Respond with ONLY a JSON object, no markdown, no prose, matching exactly this shape:
{"budget": number|null, "budgetMin": number|null, "beds": number|null, "location": string|null, "amenities": string[]}
"budget" and "budgetMin" are in millions of naira. "amenities" must only contain values from this list: ${KNOWN_AMENITIES.join(", ")}. "location" should be a single lowercase place name if one is mentioned, else null.

Query: "${text}"`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) return null;
    const parsed = JSON.parse(textBlock.text.trim());
    return { ...parsed, source: "llm" };
  } catch {
    return null; // any failure here silently falls back to the heuristic parser
  }
}

async function parseQuery(text) {
  const llmResult = await parseQueryLLM(text);
  return llmResult || parseQueryHeuristic(text);
}

function scoreProperty(p, parsed) {
  let score = 40;
  const reasons = [];
  let tradeoff = null;
  const amenities = JSON.parse(p.amenities || "[]");

  if (parsed.budget != null) {
    const min = parsed.budgetMin;
    if (min != null && p.price_value >= min && p.price_value <= parsed.budget) {
      score += 28;
      reasons.push(`Within your ₦${min}m–₦${parsed.budget}m range`);
    } else if (min == null && p.price_value <= parsed.budget) {
      score += 25;
      reasons.push(`Within your ₦${parsed.budget}m budget`);
    } else {
      const over = (((p.price_value - parsed.budget) / parsed.budget) * 100).toFixed(0);
      tradeoff = `About ${over}% above your stated budget`;
    }
  }

  if (parsed.beds != null) {
    if (p.beds === parsed.beds) {
      score += 20;
      reasons.push(`${p.beds} bedrooms, exactly as requested`);
    } else if (Math.abs(p.beds - parsed.beds) === 1) {
      score += 8;
      tradeoff = tradeoff || `${p.beds} bedroom${p.beds > 1 ? "s" : ""}, ${p.beds < parsed.beds ? "one fewer" : "one more"} than requested`;
    }
  }

  if (parsed.location) {
    if (p.location.toLowerCase().includes(parsed.location)) {
      score += 20;
      reasons.push(`Located in ${p.location}`);
    } else {
      tradeoff = tradeoff || `In ${p.location}, not your requested area`;
    }
  }

  const matchedAmenities = (parsed.amenities || []).filter((a) => amenities.includes(a));
  if (matchedAmenities.length) {
    score += matchedAmenities.length * 6;
    reasons.push(`Has ${matchedAmenities.join(", ")}`);
  }

  if (!p.verified) tradeoff = tradeoff || "Not yet verified by our team";
  if (reasons.length === 0) reasons.push("Close to your general criteria");

  return {
    ...p,
    amenities,
    verified: !!p.verified,
    match: Math.min(97, score),
    matchReasons: reasons,
    tradeoff: tradeoff || "No major trade-offs found",
  };
}

async function rankProperties(properties, query) {
  const parsed = await parseQuery(query);
  const ranked = properties
    .filter((p) => p.status !== "removed")
    .map((p) => scoreProperty(p, parsed))
    .sort((a, b) => b.match - a.match);
  return { ranked, parsed };
}

module.exports = { parseQuery, parseQueryHeuristic, scoreProperty, rankProperties, KNOWN_AMENITIES, NIGERIAN_LOCATIONS };
