/**
 * /api/save-picks
 *
 * Versión 2 — Validación estricta de datos antes de insertar
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MIN_EDGE = 3.0;

// Función helper: convertir selección a código limpio
function getSelectionCode(selection, type) {
  if (!selection || !type) return 'UNKNOWN';
  const s = selection.toLowerCase();

  if (type === '1x2') {
    if (s.includes('local')) return '1';
    if (s.includes('empate')) return 'X';
    if (s.includes('visitante')) return '2';
  }
  if (type === 'ou') {
    if (s.includes('más')) return 'O2.5';
    if (s.includes('menos')) return 'U2.5';
  }
  if (type === 'btts') {
    if (s.includes('sí')) return 'BTTS_Y';
    if (s.includes('no')) return 'BTTS_N';
  }
  return 'UNKNOWN';
}

// Helper: validar que un valor es numérico válido
function safeNumber(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

// Helper: validar string no vacío
function safeString(val, fallback = '') {
  if (val === null || val === undefined) return fallback;
  return String(val).trim() || fallback;
}

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
      error: 'Supabase credentials no configuradas'
    });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { picks } = req.body || {};

    if (!Array.isArray(picks)) {
      return res.status(400).json({ error: 'Se esperaba un array "picks"' });
    }

    console.log(`💾 Recibidos ${picks.length} picks del frontend`);

    // Filtrar y validar
    const validPicks = picks.filter(p => {
      const edge = safeNumber(p.edge, 0);
      return edge >= MIN_EDGE && p.matchId && p.homeTeam && p.awayTeam;
    });

    console.log(`💾 ${validPicks.length} picks válidos con edge >= ${MIN_EDGE}%`);

    if (validPicks.length === 0) {
      return res.status(200).json({
        saved: 0,
        duplicates: 0,
        skipped: picks.length,
        message: 'No hay value bets con edge suficiente'
      });
    }

    // Buscar duplicados existentes
    const matchIds = [...new Set(validPicks.map(p => String(p.matchId)))];
    const { data: existing, error: queryError } = await supabase
      .from('picks')
      .select('match_id, selection_code')
      .in('match_id', matchIds);

    if (queryError) {
      console.error('Error consultando duplicados:', queryError);
      return res.status(500).json({ error: queryError.message });
    }

    const existingSet = new Set(
      (existing || []).map(e => `${e.match_id}|${e.selection_code}`)
    );

    // Preparar inserción con datos validados
    const toInsert = validPicks
      .map(p => {
        const code = getSelectionCode(p.selection, p.type);
        return {
          match_id: safeString(p.matchId),
          match_date: p.matchDate || new Date().toISOString(),
          league: safeString(p.league, 'UNK'),
          home_team: safeString(p.homeTeam),
          away_team: safeString(p.awayTeam),
          market: safeString(p.market, '1X2'),
          selection: safeString(p.selection),
          selection_code: code,
          model_prob: safeNumber(p.modelProb),
          market_prob: safeNumber(p.marketProb),
          odds: safeNumber(p.odds),
          edge: safeNumber(p.edge),
          status: 'pending'
        };
      })
      .filter(p => !existingSet.has(`${p.match_id}|${p.selection_code}`));

    const duplicates = validPicks.length - toInsert.length;

    console.log(`💾 ${toInsert.length} para insertar, ${duplicates} duplicados`);

    let saved = 0;
    if (toInsert.length > 0) {
      // DEBUG: imprimir el primer registro para diagnóstico
      console.log('Primer pick a insertar:', JSON.stringify(toInsert[0]));

      const { error, data } = await supabase
        .from('picks')
        .insert(toInsert)
        .select();

      if (error) {
        console.error('Error al insertar:', error);
        return res.status(500).json({
          error: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint
        });
      }
      saved = data ? data.length : 0;
    }

    return res.status(200).json({
      saved,
      duplicates,
      skipped: picks.length - validPicks.length,
      message: `${saved} picks guardados, ${duplicates} duplicados`
    });

  } catch (err) {
    console.error('Error general:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
