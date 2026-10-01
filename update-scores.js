#!/usr/bin/env node
// =============================================================================
// Checks API-Football for finished results and writes them into the same
// Supabase row your website already reads/writes (table "app_state", row
// id "main"). Runs on a schedule via .github/workflows/update-scores.yml —
// see that file and SETUP.md for how to wire it up.
//
// Design goal: spend as few of the 100 free daily requests as possible.
//   - If nothing is due to be checked, it makes ZERO API calls.
//   - Otherwise it makes exactly one API call per (league, date) pair that
//     has at least one of your matches still waiting on a result.
// =============================================================================

const SUPABASE_URL = 'https://ilrvrxqclvxefzdbdgfq.supabase.co';
const STATE_ROW_ID = 'main';

const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

if (!SUPABASE_SERVICE_ROLE_KEY || !API_FOOTBALL_KEY) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY or API_FOOTBALL_KEY environment variable. See scripts/SETUP.md.');
    process.exit(1);
}

const fs = require('fs');
const path = require('path');
const LEAGUE_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'league-map.json'), 'utf8'));

// API-Football fixture status codes that mean "this match is over, use the score".
// (FT = full time, AET = after extra time, PEN = decided on penalties,
//  AWD/WO = awarded/walkover.) Postponed, cancelled, suspended etc. are left alone.
const FINISHED_CODES = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);

function normalizeTeam(name) {
    return String(name || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\b(fc|cf|afc|sc|ac|cd|ud|sd|calcio|club)\b/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}
function sameTeam(a, b) {
    a = normalizeTeam(a); b = normalizeTeam(b);
    if (!a || !b) return false;
    return a === b || (a.length > 3 && b.includes(a)) || (b.length > 3 && a.includes(b));
}

async function supabaseGetState() {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.${STATE_ROW_ID}&select=data`, {
        headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
    });
    if (!res.ok) throw new Error(`Supabase read failed: HTTP ${res.status} ${await res.text()}`);
    const rows = await res.json();
    if (!rows.length) throw new Error('No app_state row found (expected id = "main").');
    return rows[0].data;
}

async function supabaseSaveState(data) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.${STATE_ROW_ID}`, {
        method: 'PATCH',
        headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
        },
        body: JSON.stringify({ data, updated_at: new Date().toISOString() })
    });
    if (!res.ok) throw new Error(`Supabase write failed: HTTP ${res.status} ${await res.text()}`);
}

async function fetchFixturesForDate(league, season, date) {
    const url = `https://v3.football.api-sports.io/fixtures?league=${league}&season=${season}&date=${date}`;
    const res = await fetch(url, { headers: { 'x-apisports-key': API_FOOTBALL_KEY } });
    if (!res.ok) throw new Error(`API-Football request failed: HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors && Object.keys(json.errors).length) throw new Error(`API-Football error: ${JSON.stringify(json.errors)}`);
    return json.response || [];
}

// Picks out which of your matches are actually worth a request: already past
// their deadline (so the game has or should have kicked off), not FINISHED
// yet, and belonging to a competition that's mapped to a league id.
function matchesDueForCheck(db) {
    const now = new Date();
    return db.matches.filter(m => {
        if (m.status === 'FINISHED') return false;
        if (new Date(m.deadline) > now) return false;
        const comp = db.competitions.find(c => c.id === m.compId);
        return comp && LEAGUE_MAP[comp.name];
    });
}

async function main() {
    console.log(`[${new Date().toISOString()}] Checking for results...`);
    const db = await supabaseGetState();

    const due = matchesDueForCheck(db);
    if (!due.length) {
        console.log('Nothing due for a result check — no API calls made.');
        return;
    }

    // Group by (league, season, date) so each distinct combination costs exactly one request.
    const groups = new Map();
    due.forEach(m => {
        const comp = db.competitions.find(c => c.id === m.compId);
        const { league, season } = LEAGUE_MAP[comp.name];
        const date = m.deadline.slice(0, 10);
        const key = `${league}|${season}|${date}`;
        if (!groups.has(key)) groups.set(key, { league, season, date, matches: [] });
        groups.get(key).matches.push(m);
    });

    console.log(`${due.length} match(es) due, across ${groups.size} API request(s).`);

    let updated = 0;
    for (const { league, season, date, matches } of groups.values()) {
        let fixtures;
        try {
            fixtures = await fetchFixturesForDate(league, season, date);
        } catch (e) {
            console.error(`  league ${league} season ${season} date ${date}: ${e.message}`);
            continue;
        }

        matches.forEach(m => {
            const fx = fixtures.find(f =>
                FINISHED_CODES.has(f.fixture?.status?.short) &&
                sameTeam(f.teams?.home?.name, m.homeTeam) &&
                sameTeam(f.teams?.away?.name, m.awayTeam)
            );
            if (!fx) return;
            const h = fx.goals?.home, a = fx.goals?.away;
            if (h === null || a === null || h === undefined || a === undefined) return;

            m.scoreHome = h;
            m.scoreAway = a;
            m.status = 'FINISHED';
            updated++;
            console.log(`  settled: ${m.homeTeam} ${h}-${a} ${m.awayTeam}`);
        });
    }

    if (updated > 0) {
        await supabaseSaveState(db);
        console.log(`Saved ${updated} updated match(es) to Supabase.`);
    } else {
        console.log('No matches had a finished score yet.');
    }
}

main().catch(e => { console.error('Run failed:', e); process.exit(1); });
