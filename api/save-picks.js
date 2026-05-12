/**
 * /api/save-picks
 * 
 * Recibe los value bets del frontend y los guarda en Supabase.
 * - Solo guarda picks con edge >= 3%
 * - Evita duplicados (mismo match_id + selection_code)
 * - Devuelve estadísticas: guardados, duplicados, errores
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MIN_EDGE = 3.0; // Solo guardar value bets con edge >= 3%

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({
      error: 'Supabase credentials no configuradas en Vercel'
    });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { picks } = req.body || {};

    if (!Array.isArray(picks)) {
      return res.status(400).json({ error: 'Se esperaba un array "picks"' });
    }

    // Filtrar solo value bets reales
    const validPicks = picks.filter(p =>
      p.edge !== undefined &&
      p.edge >= MIN_EDGE &&
      p.matchId &&
      p.selectionCode
    );

    if (validPicks.length === 0) {
      return res.status(200).json({
        saved: 0,
        duplicates: 0,
        skipped: picks.length,
        message: 'No hay value bets con edge >= 3%'
      });
    }

    // Verificar duplicados — buscar los que ya existen
    const matchIds = [...new Set(validPicks.map(p => p.matchId))];
    const { data: existing } = await supabase
      .from('picks')
      .select('match_id, selection_code')
      .in('match_id', matchIds);

    const existingSet = new Set(
      (existing || []).map(e => `${e.match_id}|${e.selection_code}`)
    );

    // Preparar inserción
    const toInsert = validPicks
      .filter(p => !existingSet.has(`${p.matchId}|${p.selectionCode}`))
      .map(p => ({
        match_id: String(p.matchId),
        match_date: p.matchDate,
        league: p.league,
        home_team: p.homeTeam,
        away_team: p.awayTeam,
        market: p.market,
        selection: p.selection,
        selection_code: p.selectionCode,
        model_prob: p.modelProb,
        market_prob: p.marketProb,
        odds: p.odds,
        edge: p.edge,
        status: 'pending'
      }));

    const duplicates = validPicks.length - toInsert.length;

    let saved = 0;
    if (toInsert.length > 0) {
      const { error, data } = await supabase
        .from('picks')
        .insert(toInsert)
        .select();

      if (error) {
        console.error('Error al insertar:', error);
        return res.status(500).json({ error: error.message });
      }
      saved = data ? data.length : 0;
    }

    return res.status(200).json({
      saved,
      duplicates,
      skipped: picks.length - validPicks.length,
      message: `${saved} picks guardados, ${duplicates} duplicados ignorados`
    });

  } catch (err) {
    console.error('Error general:', err);
    return res.status(500).json({ error: err.message });
  }
}
