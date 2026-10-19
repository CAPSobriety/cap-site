// Proxy Gemini : la clé API reste dans les variables d'environnement Netlify (GEMINI_API_KEY).
const MODELS = (process.env.GEMINI_MODELS || 'gemini-3.8-flash,gemini-3.6-flash,gemini-2.5-flash')
  .split(',').map(s => s.trim()).filter(Boolean);

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Méthode non autorisée' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(500, { error: 'GEMINI_API_KEY manquante côté serveur' });

  // Garde-fou simple : si ALLOWED_ORIGIN est défini, on refuse les autres sites
  const allowed = process.env.ALLOWED_ORIGIN;
  const origin = event.headers.origin || event.headers.Origin;
  if (allowed && origin && origin !== allowed) return json(403, { error: 'Origine refusée' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON invalide' }); }

  const msgs = Array.isArray(payload.messages) ? payload.messages : [];
  if (!msgs.length || msgs.length > 20) return json(400, { error: 'Nombre de messages invalide' });

  let total = 0, system = '';
  const contents = [];
  for (const m of msgs) {
    if (!m || typeof m.content !== 'string' || !['system', 'user', 'assistant'].includes(m.role)) {
      return json(400, { error: 'Message invalide' });
    }
    total += m.content.length;
    if (total > 20000) return json(413, { error: 'Conversation trop longue' });
    if (m.role === 'system') { system += (system ? '\n' : '') + m.content; continue; }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n' + m.content;
    else contents.push({ role, parts: [{ text: m.content }] });
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Bonjour' }] });

  const maxOutputTokens = Math.min(Math.max(parseInt(payload.maxTokens, 10) || 1024, 64), 2048);
  const body = { contents, generationConfig: { maxOutputTokens, temperature: 0.75 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  let lastErr = 'Gemini indisponible';
  for (const model of MODELS) {
    try {
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) }
      );
      const t = await res.text();
      if (!res.ok) {
        let d = t.slice(0, 200);
        try { const j = JSON.parse(t); d = (j.error && (j.error.message || j.error.status)) || d; } catch {}
        lastErr = 'HTTP ' + res.status + ' ' + d + ' (' + model + ')';
        continue;
      }
      const data = JSON.parse(t);
      const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      const text = parts && parts.map(p => p.text || '').join('');
      if (!text) { lastErr = 'Réponse vide (' + model + ')'; continue; }
      return json(200, { text: text.trim() });
    } catch (e) { lastErr = String((e && e.message) || e); }
  }
  return json(502, { error: lastErr });
};
