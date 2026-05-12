/**
 * /api/fixtures
 *
 * Versión 4 — Definitiva:
 * - Rango de 9 días (bajo el límite de la API)
 * - Tolerancia total a fallos (siempre devuelve 200)
 * - Caché agresivo
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
    try {
      const r = await fetch(url, { headers: { "X-Auth-Token": token } });
      if (r.ok) return await r.json();
      if (r.status === 429 && attempt < retries) {
        console.warn(`⏳ 429 hit, waiting 12s...`);
        await sleep(12000);
        continue;
      }
      console.warn(`⚠️ HTTP ${r.status} from ${url}`);
      return null;
    } catch (err) {
      console.warn(`Network error from ${url}: ${err.message}`);
      return null;
    }
  }
  return null;
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=600");

  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    return res.status(200).json({
      matches: [], teamForms: {},
      error: "FOOTBALL_DATA_TOKEN no configurado"
    });
  }

  try {
    // ✅ 9 días (justo bajo el límite de 10 días de la API)
    const today = new Date();
    const future = new Date();
    future.setDate(today.getDate() + 9);

    const matchesURL = `https://api.football-data.org/v4/matches?dateFrom=${toISO(today)}&dateTo=${toISO(future)}`;
    console.log(`📅 Pidiendo: ${matchesURL}`);

    const upcoming = await callAPI(matchesURL, token);

    if (!upcoming) {
      console.warn("⚠️ Sin datos de upcoming — devolviendo respuesta vacía");
      return res.status(200).json({
        generatedAt: new Date().toISOString(),
        matches: [],
        teamForms: {},
        note: "API no disponible temporalmente"
      });
    }

    const validMatches = (upcoming.matches || []).filter(
      m => COMPETITION_NAME_TO_CODE[m.competition.name]
    );

    console.log(`✅ ${validMatches.length} partidos válidos en ligas soportadas`);

    // Si NO hay partidos, devolvemos respuesta vacía válida (sin pedir más a la API)
    if (validMatches.length === 0) {
      return res.status(200).json({
        generatedAt: new Date().toISOString(),
        matches: [],
        teamForms: {},
        note: "No hay partidos próximos en las ligas configuradas"
      });
    }

    // Calcular forma de equipos por liga (1 call por liga)
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

      const url = `https://api.football-data.org/v4/competitions/${apiCode}/matches?status=FINISHED&${range}`;
      const data = await callAPI(url, token);

      if (data === null) {
        leaguesSkipped++;
        console.warn(`⏭️ Saltando ${leagueCode}`);
      } else {
        const teamData = buildTeamFormsFromMatches(data.matches || []);
        Object.assign(allTeamForms, teamData);
        leaguesLoaded++;
      }

      await sleep(7500);
    }

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
    // Siempre devolvemos 200 con respuesta válida
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      matches: [],
      teamForms: {},
      error: err.message
    });
  }
}
