// netlify/functions/league.js  (ESM)
// AUTHORITATIVE league server for the NFL 2026 scorecard.
//
// 1. TAMPER-PROOF — devices never send points, only picks. The server fetches
//    official results from ESPN's NFL data and computes every score itself,
//    so a leaderboard total can't be inflated by editing localStorage.
// 2. LOCK ENFORCEMENT — a pick is stored only if the server confirms from the
//    official schedule that the game hasn't kicked off. Late picks get 409,
//    whatever the device clock says.
// 3. NO WRITE COLLISIONS — each player owns one blob key (m:CODE:PID), so
//    25 people picking at once can't clobber each other (a single shared blob is
//    last-write-wins and would lose picks).
// 4. CAPACITY — one board per code, capped at MAX_PLAYERS (default 25).
//
// Storage: Netlify Blobs (zero config, no keys).
//   m:CODE:PID -> { name, joinedAt, picks:{ gameId:{a,h,at,d} } }
//   sched      -> { gameId:{iso,state,a,h,fetchedAt} }   game cache
//   cache:CODE -> { computedAt, board }                  leaderboard cache

import { getStore } from "@netlify/blobs";

// Roster cap. Change here (or set a MAX_PLAYERS env var in Netlify) to raise/lower it.
export const MAX_PLAYERS = Math.max(1, parseInt(process.env.MAX_PLAYERS || "", 10) || 25);
const BOARD_CACHE_MS = 15000;
const LIVE_REFRESH_MS = 45000;
const DAY = 86400000;
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const json = (s, b) => new Response(JSON.stringify(b), { status: s, headers: CORS });
const okCode = (c) => typeof c === "string" && /^[A-Za-z0-9_-]{2,24}$/.test(c);
const okPid = (p) => typeof p === "string" && /^[A-Za-z0-9_-]{4,40}$/.test(p);
const okId = (v) => /^\d{6,12}$/.test(String(v));
const okDate = (v) => /^\d{8}$/.test(String(v));
const pts = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= 99 ? n : null; };
const clean = (s, n) => (typeof s === "string" ? s.trim().replace(/[<>&"]/g, "").replace(/\s+/g, " ").slice(0, n) : "");

// Scoring — identical rules on the client:
//   +5 exact final score · +3 both scores within 5 points · +1 right winner (or tie) · else 0
export function points(pa, ph, oa, oh) {
  if (pa === oa && ph === oh) return 5;
  if (Math.abs(pa - oa) <= 5 && Math.abs(ph - oh) <= 5) return 3;
  return Math.sign(pa - ph) === Math.sign(oa - oh) ? 1 : 0;
}
const winnerRight = (pa, ph, oa, oh) => Math.sign(pa - ph) === Math.sign(oa - oh);

let makeStore = () => getStore({ name: "nfl2026-league", consistency: "strong" });
export function __setStoreFactory(f) { makeStore = f; }
const store = () => makeStore();

const parseIso = (s) => Date.parse(/T\d\d:\d\dZ$/.test(s || "") ? s.replace("Z", ":00Z") : s);
const ymd8 = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
const t8 = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));

async function loadSched(st) { return (await st.get("sched", { type: "json" })) || {}; }

// Pull the scoreboard for the day before/of/after `date` (covers any timezone quirk) and cache every game seen.
async function refreshDates(st, sched, dates) {
  const now = Date.now();
  let changed = false;
  for (const d of dates) {
    const t = t8(d);
    // ESPN rejects multi-day ranges, so read the day before/of/after separately (covers any timezone quirk).
    for (const day of [t - DAY, t, t + DAY]) {
      let data;
      try {
        const r = await fetch(`${ESPN}?dates=${ymd8(day)}&limit=100`,
          { headers: { "User-Agent": "nfl-2026-scorecard", accept: "application/json" } });
        if (!r.ok) continue;
        data = await r.json();
      } catch { continue; }
      for (const ev of data.events || []) {
        const c = (ev.competitions || [])[0] || {};
        const type = (c.status || ev.status || {}).type || {};
        const home = (c.competitors || []).find((x) => x.homeAway === "home");
        const away = (c.competitors || []).find((x) => x.homeAway === "away");
        if (!home || !away) continue;
        const fin = type.state === "post" && type.completed;
        sched[String(ev.id)] = {
          iso: ev.date, state: type.state || "pre",
          a: fin || type.state === "in" ? Number(away.score) : null,
          h: fin || type.state === "in" ? Number(home.score) : null,
          final: !!fin, fetchedAt: now,
        };
        changed = true;
      }
    }
  }
  if (changed) await st.setJSON("sched", sched);
  return sched;
}

const isStale = (g) => !g || (!g.final && Date.now() - (g.fetchedAt || 0) > LIVE_REFRESH_MS);

async function getGame(st, id, date) {
  let sched = await loadSched(st);
  if (isStale(sched[id])) sched = await refreshDates(st, sched, [date]);
  return sched[id] || null;
}

async function loadMembers(st, code) {
  const prefix = `m:${code}:`;
  const { blobs } = await st.list({ prefix });
  const recs = await Promise.all((blobs || []).map(async (b) => {
    const rec = await st.get(b.key, { type: "json" });
    return rec && rec.name ? { pid: b.key.slice(prefix.length), ...rec } : null;
  }));
  return recs.filter(Boolean);
}

async function computeBoard(st, code, force) {
  if (!force) {
    const c = await st.get(`cache:${code}`, { type: "json" });
    if (c && Date.now() - c.computedAt < BOARD_CACHE_MS) return c.board;
  }
  const members = await loadMembers(st, code);
  let sched = await loadSched(st);
  const now = Date.now();

  // games with a pick that we don't yet know the outcome of (only ones that could have started)
  const needDates = new Set();
  for (const m of members) for (const [id, p] of Object.entries(m.picks || {})) {
    const g = sched[id];
    const started = g ? (g.state !== "pre" || parseIso(g.iso) <= now) : true;
    if (started && isStale(g) && p.d) needDates.add(p.d);
  }
  if (needDates.size) sched = await refreshDates(st, sched, [...needDates]);

  const rows = members.map((m) => {
    let total = 0, decided = 0, correct = 0, exact = 0, close = 0, pending = 0;
    const picks = m.picks || {};
    for (const id of Object.keys(picks)) {
      const g = sched[id], p = picks[id];
      if (g && g.final && g.a != null && g.h != null) {
        const s = points(p.a, p.h, g.a, g.h);
        total += s; decided++;
        if (winnerRight(p.a, p.h, g.a, g.h)) correct++;
        if (s === 5) exact++;
        if (s === 3) close++;
      } else pending++;
    }
    return { pid: m.pid, name: m.name, points: total, predicted: Object.keys(picks).length,
      decided, correct, exact, close, pending, joinedAt: m.joinedAt || 0 };
  });

  rows.sort((a, b) => b.points - a.points || b.exact - a.exact || b.decided - a.decided ||
    b.predicted - a.predicted || a.name.localeCompare(b.name));

  const board = { code, capacity: MAX_PLAYERS, count: rows.length,
    full: rows.length >= MAX_PLAYERS, updatedAt: Date.now(), members: rows };
  await st.setJSON(`cache:${code}`, { computedAt: Date.now(), board });
  return board;
}

// Picks visible in the "picks" modal: only games that have started (never leak open picks).
async function memberPicks(st, code, who) {
  const rec = await st.get(`m:${code}:${who}`, { type: "json" });
  if (!rec) return null;
  let sched = await loadSched(st);
  const now = Date.now();
  const dates = new Set();
  for (const [id, p] of Object.entries(rec.picks || {})) if (p.d && isStale(sched[id]) && (p.k || 0) <= now) dates.add(p.d);
  if (dates.size) sched = await refreshDates(st, sched, [...dates]);
  const list = [];
  for (const [id, p] of Object.entries(rec.picks || {})) {
    const g = sched[id];
    const started = g ? (g.state !== "pre" || parseIso(g.iso) <= now) : false;
    if (!started) continue;
    const fin = g && g.final && g.a != null && g.h != null;
    list.push({ id, a: p.a, h: p.h, an: p.an || "", hn: p.hn || "", d: p.d, iso: g.iso,
      final: fin ? { a: g.a, h: g.h } : null, points: fin ? points(p.a, p.h, g.a, g.h) : null });
  }
  list.sort((x, y) => parseIso(y.iso) - parseIso(x.iso));
  return { name: rec.name, picks: list };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  const st = store();
  try {
    if (req.method === "GET") {
      const u = new URL(req.url);
      const code = u.searchParams.get("code") || "", pid = u.searchParams.get("pid") || "";
      if (!okCode(code)) return json(400, { error: "bad code" });
      const who = u.searchParams.get("who");
      if (who) {
        if (!okPid(who)) return json(400, { error: "bad player id" });
        const mp = await memberPicks(st, code, who);
        return mp ? json(200, mp) : json(404, { error: "not_found" });
      }
      const board = await computeBoard(st, code, false);
      let mine = null;
      if (okPid(pid)) {
        const rec = await st.get(`m:${code}:${pid}`, { type: "json" });
        if (rec) mine = { name: rec.name, picks: rec.picks || {} };
      }
      return json(200, { ...board, mine });
    }
    if (req.method !== "POST") return json(405, { error: "method not allowed" });

    let body; try { body = await req.json(); } catch { return json(400, { error: "bad JSON" }); }
    const code = body.code, pid = body.pid, action = body.action || "pick";
    if (!okCode(code)) return json(400, { error: "bad code" });
    if (!okPid(pid)) return json(400, { error: "bad player id" });
    const key = `m:${code}:${pid}`;

    if (action === "join") {
      const name = clean(body.name, 24);
      if (!name) return json(400, { error: "name required" });
      const existing = await st.get(key, { type: "json" });
      if (!existing) {
        const members = await loadMembers(st, code);
        if (members.length >= MAX_PLAYERS)
          return json(409, { error: "league_full", capacity: MAX_PLAYERS,
            message: `This league is full (${MAX_PLAYERS} players).` });
        if (members.some((m) => m.name.toLowerCase() === name.toLowerCase() && m.pid !== pid))
          return json(409, { error: "name_taken", message: "That name is taken — try another." });
      } else {
        const others = await loadMembers(st, code);
        if (others.some((m) => m.name.toLowerCase() === name.toLowerCase() && m.pid !== pid))
          return json(409, { error: "name_taken", message: "That name is taken — try another." });
      }
      const joinedAt = existing?.joinedAt || Date.now();
      await st.setJSON(key, { name, joinedAt, picks: existing?.picks || {} });
      if (!existing) {
        // Roster-cap race guard: if simultaneous joins overshot the cap, the latest joiners are removed.
        const after = (await loadMembers(st, code)).sort((x, y) => (x.joinedAt - y.joinedAt) || x.pid.localeCompare(y.pid));
        if (after.findIndex((m) => m.pid === pid) >= MAX_PLAYERS) {
          await st.delete(key);
          return json(409, { error: "league_full", capacity: MAX_PLAYERS,
            message: `This league is full (${MAX_PLAYERS} players).` });
        }
      }
      const board = await computeBoard(st, code, true);
      return json(200, { ...board, mine: { name, picks: existing?.picks || {} } });
    }

    if (action === "pick") {
      const rec = await st.get(key, { type: "json" });
      if (!rec) return json(403, { error: "not_joined", message: "Join the league first." });
      const id = String(body.gameId || "");
      if (!okId(id)) return json(400, { error: "bad gameId" });
      if (!okDate(body.date)) return json(400, { error: "bad date" });
      const a = pts(body.a), h = pts(body.h);
      if (a === null || h === null) return json(400, { error: "points must be 0-99" });

      const g = await getGame(st, id, String(body.date));
      if (!g) return json(404, { error: "unknown_game", message: "Game not found in the official schedule." });
      // THE tamper check: the official kickoff time and status decide, not the device.
      if (g.state !== "pre" || parseIso(g.iso) <= Date.now())
        return json(409, { error: "locked", message: "That game has already kicked off.", iso: g.iso });

      rec.picks = rec.picks || {};
      rec.picks[id] = { a, h, at: Date.now(), d: String(body.date), k: parseIso(g.iso),
        an: clean(body.an, 4), hn: clean(body.hn, 4) };
      await st.setJSON(key, rec);
      const board = await computeBoard(st, code, true);
      return json(200, { ...board, saved: { gameId: id, a, h }, mine: { name: rec.name, picks: rec.picks } });
    }
    return json(400, { error: "unknown action" });
  } catch (err) {
    return json(500, { error: "league error", detail: String(err) });
  }
};

export const config = { path: "/api/league" };
