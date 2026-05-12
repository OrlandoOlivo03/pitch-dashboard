/**
 * /api/fixtures
 *
 * Versión 2 — Resistente a rate limits:
 * - Caché agresivo: 30 min para fixtures, sigue funcionando aunque falle
 * - Tolerancia a 429: si una liga falla, devuelve las demás
 * - No rompe la respuesta completa si una llamada falla
 */

const COMPETITION_NAME_TO_CODE = {
  "Premier League": "PL",
  "Primera Division": "LL",
  "Primera División": "LL",
  "Serie A": "SA",
  "Bundesliga": "BL",
  "Ligue 1": "L1",
};

const COMPETITION_API_CODES = {
  PL: "PL",
  LL: "PD",
  SA: "SA",
  BL: "BL1",
  L1: "FL1",
};

function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callAPI(url, token, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(url, { headers: { "X-Auth-Token": token } });
    if (r.ok) return await r.json();
    if (r.status === 429 && attempt < retries) {
      console.warn(`⏳ 429 hit, waiting 12s before retry...`);
      await sleep(12000);
      continue;
    }
    if (r.status === 429) {
      console.warn(`⚠️ 429 final from ${url} — skipping`);
      return null; // Devuelve null en lugar de tirar error
    }
    throw new Error(`HTTP ${r.status} from ${url}`);
  }
}

function buildTeamFormsFromMatches(matches) {
  const teamMatches = new Map();

  for (const m of matches) {
    if (m.status !== "FINISHED") continue;
    const homeId = m.homeTeam.id;
    const awayId = m.awayTeam.id;
    const date = new Date(m.utcDate);

    if (!teamMatches.has(homeId)) teamMatches.set(homeId, []);
    if (!teamMatches.has(awayId)) teamMatches.set(awayId, []);

    teamMatches.get(homeId).push({
      date,
      goalsFor: m.score?.fullTime?.home ?? 0,
      goalsAgainst: m.score?.fullTime?.away ?? 0,
    });
    teamMatches.get(awayId).push({
      date,
      goalsFor: m.score?.fullTime?.away ?? 0,
      goalsAgainst: m.score?.fullTime?.home ?? 0,
    });
  }

  const teamData = {};
  for (const [teamId, games] of teamMatches.entries()) {
    games.sort((a, b) => b.date - a.date);
    const last5 = games.slice(0, 5);

    const form = last5.map(g => {
      if (g.goalsFor > g.goalsAgainst) return "W";
      if (g.goalsFor < g.goalsAgainst) return "L";
      return "D";
    });
    while (form.length < 5) form.push("D");

    const totalGames = games.length || 1;
    const totalFor = games.reduce((s, g) => s + g.goalsFor, 0);
    const totalAgainst = games.reduce((s, g) => s + g.goalsAgainst, 0);

    teamData[teamId] = {
      form,
      avgFor: totalFor / totalGames,
      avgAgainst: totalAgainst / totalGames,
      played: totalGames,
    };
  }

  return teamData;
}

export default async function handler(req, res) {
  // Caché edge agresivo: 30 min de respuesta válida, 10 min de revalidación
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=600");

  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: "FOOTBALL_DATA_TOKEN no configurado",
    });
  }

  try {
    // 1) Partidos próximos (7 días)
    const today = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);

    const matchesURL = `https://api.football-data.org/v4/matches?dateFrom=${toISO(today)}&dateTo=${toISO(nextWeek)}`;
    const upcoming = await callAPI(matchesURL, token);

    if (!upcoming) {
      // Si esto falla, devolvemos respuesta vacía pero válida
      return res.status(200).json({
        generatedAt: new Date().toISOString(),
        matches: [],
        teamForms: {},
        note: "Rate limit hit on fixtures call"
      });
    }

    const validMatches = (upcoming.matches || []).filter(
      m => COMPETITION_NAME_TO_CODE[m.competition.name]
    );

    // 2) Forma por liga (cacheado por separado, tolerante a fallos)
    const leaguesNeeded = new Set();
    validMatches.forEach(m => {
      leaguesNeeded.add(COMPETITION_NAME_TO_CODE[m.competition.name]);
    });

    const allTeamForms = {};
    const dateTo = new Date();
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - 60);
    const range = `dateFrom=${toISO(dateFrom)}&dateTo=${toISO(dateTo)}`;

    let leaguesLoaded = 0;
    let leaguesSkipped = 0;

    for (const leagueCode of leaguesNeeded) {
      const apiCode = COMPETITION_API_CODES[leagueCode];
      if (!apiCode) continue;

      try {
        const url = `https://api.football-data.org/v4/competitions/${apiCode}/matches?status=FINISHED&${range}`;
        const data = await callAPI(url, token);

        if (data === null) {
          // Rate limit en esta liga — la saltamos pero seguimos
          leaguesSkipped++;
          console.warn(`⏭️ Saltando ${leagueCode} por rate limit`);
        } else {
          const teamData = buildTeamFormsFromMatches(data.matches || []);
          Object.assign(allTeamForms, teamData);
          leaguesLoaded++;
        }

        // Pausa entre llamadas para respetar rate limit
        await sleep(7500);
      } catch (err) {
        console.warn(`Error loading ${leagueCode}:`, err.message);
        leaguesSkipped++;
      }
    }

    // 3) Devolver respuesta (aunque algunas ligas hayan fallado)
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      leaguesLoaded,
      leaguesSkipped,
      matches: validMatches.map(m => ({
        id: m.id,
        competitionName: m.competition.name,
        leagueCode: COMPETITION_NAME_TO_CODE[m.competition.name],
        utcDate: m.utcDate,
        status: m.status,
        minute: m.minute,
        venue: m.venue,
        homeTeam: {
          id: m.homeTeam.id,
          name: m.homeTeam.name,
          tla: m.homeTeam.tla,
        },
        awayTeam: {
          id: m.awayTeam.id,
          name: m.awayTeam.name,
          tla: m.awayTeam.tla,
        },
        score: m.score,
      })),
      teamForms: allTeamForms,
    });
  } catch (err) {
    console.error("Error in /api/fixtures:", err);
    // Aún así devolvemos 200 con datos parciales en lugar de 500
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      matches: [],
      teamForms: {},
      error: err.message
    });
  }
}
