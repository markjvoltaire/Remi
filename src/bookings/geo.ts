/**
 * Infer Resy search/slots geo from free text so we don't default to NYC when the guest names another city.
 * Coordinates align with typical api.resy.com usage (see browser Network tab for each market).
 */

export interface InferredResyGeo {
  lat: number;
  lng: number;
  label: string;
}

const CITY_RULES: Array<{ test: RegExp; geo: InferredResyGeo }> = [
  {
    test: /\b(miami|south beach|brickell|wynwood|coral gables|little havana|design district|miami beach)\b/i,
    geo: { lat: 25.76898, lng: -80.13417, label: 'Miami' },
  },
  {
    test: /\b(los angeles|beverly hills|west hollywood|santa monica|pasadena|weho)\b/i,
    geo: { lat: 34.0522, lng: -118.2437, label: 'Los Angeles' },
  },
  { test: /\b(san francisco|\bsf\b|bay area|oakland|berkeley)\b/i, geo: { lat: 37.7749, lng: -122.4194, label: 'San Francisco' } },
  { test: /\b(chicago|river north|wicker park)\b/i, geo: { lat: 41.8781, lng: -87.6298, label: 'Chicago' } },
  { test: /\b(las vegas|vegas|summerlin)\b/i, geo: { lat: 36.1699, lng: -115.1398, label: 'Las Vegas' } },
  { test: /\b(boston|cambridge ma|back bay)\b/i, geo: { lat: 42.3601, lng: -71.0589, label: 'Boston' } },
  { test: /\b(washington dc|\bdc\b|georgetown)\b/i, geo: { lat: 38.9072, lng: -77.0369, label: 'Washington DC' } },
  { test: /\b(seattle|bellevue|capitol hill seattle)\b/i, geo: { lat: 47.6062, lng: -122.3321, label: 'Seattle' } },
  { test: /\b(austin|south lamar)\b/i, geo: { lat: 30.2672, lng: -97.7431, label: 'Austin' } },
  { test: /\b(new orleans|nola|french quarter)\b/i, geo: { lat: 29.9511, lng: -90.0715, label: 'New Orleans' } },
  { test: /\b(denver|boulder)\b/i, geo: { lat: 39.7392, lng: -104.9903, label: 'Denver' } },
  { test: /\b(philadelphia|rittenhouse|old city)\b/i, geo: { lat: 39.9526, lng: -75.1652, label: 'Philadelphia' } },
  { test: /\b(atlanta|buckhead|midtown atlanta)\b/i, geo: { lat: 33.749, lng: -84.388, label: 'Atlanta' } },
];

/** Concatenate recent thread text + current message for city detection. */
export function threadSnippetForGeo(userMessage: string, recentLines: string[]): string {
  return [userMessage, ...recentLines].filter(Boolean).join('\n');
}

/**
 * Return geo when any rule matches the combined text (message + recent history).
 */
export function inferResyGeoFromText(...chunks: string[]): InferredResyGeo | undefined {
  const combined = chunks.filter(c => c && c.trim()).join('\n');
  if (!combined.trim()) return undefined;

  for (const { test, geo } of CITY_RULES) {
    if (test.test(combined)) {
      console.log(`[resy] Inferred geo: ${geo.label} (${geo.lat}, ${geo.lng})`);
      return { lat: geo.lat, lng: geo.lng, label: geo.label };
    }
  }
  return undefined;
}