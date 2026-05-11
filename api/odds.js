/**
 * /api/odds
 * 
 * Trae cuotas reales de las casas de apuestas para los partidos próximos.
 * Usa The Odds API (https://the-odds-api.com/)
 * 
 * Plan free: 500 calls/mes. Con caché edge de 30 min, alcanza para
 * ~720 visitas al día sin agotar la cuota.
 * 
 * Mercados pedidos:
 *   - h2h (1X2 ganador)
 *   - totals (Over/Under 2.5 goles)
 *   - btts (Both Teams To Score)
 */

// Ligas que cubrimos (códigos The Odds API)
const SPORT_KEYS = {
  PL: "soccer_epl",
  LL: "soccer_spain_la_liga",
  SA: "soccer_italy_serie_a",
  BL: "soccer_germany_bundesliga",
  L1: "soccer_france_ligue_one",
};

// Casas de apuestas a consultar (priorizar las más confiables)
const BOOKMAKERS = "pinnacle,bet365,williamhill,marathonbet,unibet";

async function fetchOddsForLeague(sportKey, apiKey) {
  // markets: h2h (1X2) + totals (over/under) + btts
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?regions=eu,uk&markets=h2h,totals&bookmakers=${BOOKMAKERS}&apiKey=${apiKey}&oddsFormat=decimal`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.warn(`Odds API ${sportKey}: HTTP ${r.status}`);
      return [];
    }
    return await r.json();
  } catch (err) {
    console.warn(`Odds API ${sportKey} error: ${err.message}`);
    return [];
  }
}

/**
 * Para cada partido, calcula la cuota PROMEDIO ponderada de todas
 * las casas. Más casas = más confiable la cuota.
 */
function averageOdds(oddsArray) {
  if (!oddsArray || oddsArray.length === 0) return null;
  const sum = oddsArray.reduce((a, b) => a + b, 0);
  return sum / oddsArray.length;
}

/**
 * Procesa un partido de la respuesta del API y extrae todas las cuotas
 * de los mercados que nos interesan.
 */
function processMatchOdds(match) {
  const result = {
    home: match.home_team,
    away: match.away_team,
    commenceTime: match.commence_time,
    odds: {
      home: null,    // 1
      draw: null,    // X
      away: null,    // 2
      over25: null,  // Over 2.5
      under25: null, // Under 2.5
    },
    bookmakerCount: 0,
  };

  if (!match.bookmakers || match.bookmakers.length === 0) return result;

  // Arrays para promediar entre todas las casas
  const homeOdds = [], drawOdds = [], awayOdds = [];
  const overOdds = [], underOdds = [];

  for (const bookie of match.bookmakers) {
    if (!bookie.markets) continue;

    for (const market of bookie.markets) {
      // 1X2
      if (market.key === "h2h") {
        for (const outcome of market.outcomes) {
          if (outcome.name === match.home_team) homeOdds.push(outcome.price);
          else if (outcome.name === match.away_team) awayOdds.push(outcome.price);
          else if (outcome.name === "Draw") drawOdds.push(outcome.price);
        }
      }
      // Over/Under
      else if (market.key === "totals") {
        for (const outcome of market.outcomes) {
          if (outcome.point === 2.5) {
            if (outcome.name === "Over") overOdds.push(outcome.price);
            else if (outcome.name === "Under") underOdds.push(outcome.price);
          }
        }
      }
    }
  }

  result.odds.home = averageOdds(homeOdds);
  result.odds.draw = averageOdds(drawOdds);
  result.odds.away = averageOdds(awayOdds);
  result.odds.over25 = averageOdds(overOdds);
  result.odds.under25 = averageOdds(underOdds);
  result.bookmakerCount = match.bookmakers.length;

  return result;
}

export default async function handler(req, res) {
  // CORS + caché edge 30 min
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=600");

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "ODDS_API_KEY no configurado en Vercel Environment Variables",
    });
  }

  try {
    const allOdds = {};

    // Una llamada por liga (5 ligas = 5 calls)
    for (const [leagueCode, sportKey] of Object.entries(SPORT_KEYS)) {
      const matches = await fetchOddsForLeague(sportKey, apiKey);

      for (const match of matches) {
        const processed = processMatchOdds(match);
        // Clave única: "home|away" (normalizada para hacer match con football-data.org)
        const key = `${processed.home}|${processed.away}`.toLowerCase();
        allOdds[key] = {
          ...processed,
          league: leagueCode,
        };
      }
    }

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      oddsCount: Object.keys(allOdds).length,
      odds: allOdds,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
