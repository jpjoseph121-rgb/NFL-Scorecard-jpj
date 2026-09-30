// NFL Scorecard — read-only proxy to ESPN's public NFL data.
//
// Locked to exactly two endpoint types:
//   ?type=schedule&dates=YYYYMMDD              (one game day, Aug 2026 – Feb 2027)
//   ?type=schedule&week=1..18                  (2026 regular season)
//   ?type=standings
// Everything else is rejected. There is no open passthrough: the upstream URL is
// built from validated values only. Responses are cached ~30s (in-memory + CDN).

const SEASON = 2026;
const BASE_SCORE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const BASE_STAND = 'https://site.api.espn.com/apis/v2/sports/football/nfl/standings';
const TTL = 30_000;
const MIN_DATE = Date.UTC(2026, 7, 1);   // Aug 1, 2026
const MAX_DATE = Date.UTC(2027, 1, 28);  // Feb 28, 2027 (covers postseason)

const cache = new Map();

const H = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=30, s-maxage=30',
  'netlify-cdn-cache-control': 'public, max-age=30, stale-while-revalidate=60',
};

const json = (status, obj, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...H, 'x-server-time': String(Date.now()), ...extra,
      ...(status >= 400 ? { 'cache-control': 'no-store', 'netlify-cdn-cache-control': 'no-store' } : {}) },
  });

const ymd = /^(\d{4})(\d{2})(\d{2})$/;
function parseYmd(s) {
  const m = ymd.exec(s || '');
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return t;
}

function buildUpstream(p) {
  const type = p.get('type');
  if (type === 'standings') {
    const season = p.get('season');
    if (season && season !== String(SEASON)) return null;
    return `${BASE_STAND}?season=${SEASON}&level=3`;
  }
  if (type === 'schedule') {
    const week = p.get('week');
    if (week !== null) {
      if (!/^\d{1,2}$/.test(week)) return null;
      const w = +week;
      if (w < 1 || w > 18) return null;
      return `${BASE_SCORE}?dates=${SEASON}&seasontype=2&week=${w}&limit=100`;
    }
    // Single game-day only: ESPN's scoreboard answers multi-day ranges with HTTP 400.
    const dates = p.get('dates') || '';
    const t = parseYmd(dates);
    if (t == null || t < MIN_DATE || t > MAX_DATE) return null;
    return `${BASE_SCORE}?dates=${dates}&limit=100`;
  }
  return null;
}

export default async (req) => {
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: { ...H, 'access-control-allow-methods': 'GET, OPTIONS' } });
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const url = buildUpstream(new URL(req.url).searchParams);
  if (!url) return json(400, { error: 'Unsupported or invalid request. Allowed: type=schedule (dates|week) and type=standings.' });

  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < TTL) return json(200, hit.body, { 'x-cache': 'HIT' });

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (!r.ok) throw new Error('upstream ' + r.status);
    const body = await r.json();
    cache.set(url, { t: Date.now(), body });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return json(200, body, { 'x-cache': 'MISS' });
  } catch (e) {
    if (hit) return json(200, hit.body, { 'x-cache': 'STALE' });
    return json(502, { error: 'Data source unavailable' });
  }
};

export const config = { path: '/api/nfl' };
