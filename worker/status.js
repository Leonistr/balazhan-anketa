#!/usr/bin/env node
// Состояние конвейера анкет: пульс userscript-а, счётчики статусов, ошибки.
// Использование: node status.js [--json]     (читает APPS_SCRIPT_URL и WORKER_TOKEN из .env)
// Код выхода: 0 — всё в порядке; 1 — есть ошибки/зависшие строки или пульс старше 15 мин / сессия не ok; 2 — нет связи.
const fs = require('fs'), path = require('path');
const env = {};
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); } } catch {}
const URL_ = process.env.APPS_SCRIPT_URL || env.APPS_SCRIPT_URL, TOKEN = process.env.WORKER_TOKEN || env.WORKER_TOKEN;
const STALE_MIN = 15;
async function call(action, extra = {}) {
  const r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, token: TOKEN, ...extra }), redirect: 'follow' });
  const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error('ответ не JSON, HTTP ' + r.status); }
}
const parseTs = (s) => { const m = String(s || '').match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/); return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+05:00`) : NaN; };
(async () => {
  if (!URL_ || !TOKEN) { console.error('Нет APPS_SCRIPT_URL / WORKER_TOKEN в .env'); process.exit(2); }
  let st, legacy = false;
  try {
    st = await call('status');
    if (!st.ok && /unknown_action/.test(st.error || '')) {
      legacy = true;
      const l = await call('list', { statuses: ['*'] });
      if (!l.ok) throw new Error(l.error);
      const counts = {}; for (const r of l.rows) counts[r.status || 'new'] = (counts[r.status || 'new'] || 0) + 1;
      st = { ok: true, heartbeat: {}, counts, total: l.rows.length, problems: l.rows.filter((r) => ['error', 'processing'].includes(r.status)).map((r) => ({ row: r._row, fullName: r.fullName, group: r.group, status: r.status, status_at: r.status_at, message: r.message })) };
    } else if (!st.ok) throw new Error(st.error);
  } catch (e) { console.error('Нет связи с Apps Script:', e.message); process.exit(2); }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(st, null, 2)); }
  const hb = st.heartbeat || {}; let bad = false;
  if (!process.argv.includes('--json')) {
    console.log('Пульс обработчика' + (legacy ? ' (развёрнута старая версия Code.gs — пульса нет, нужен redeploy)' : '') + ':');
    const age = (Date.now() - parseTs(hb.HB_LAST_SEEN)) / 60000;
    console.log(`  последний раз: ${hb.HB_LAST_SEEN || '—'}${isFinite(age) ? ` (${Math.round(age)} мин назад)` : ''}  [${hb.HB_AGENT || '—'}]`);
    console.log(`  сессия Balazhan: ${hb.HB_SESSION || '—'}${hb.HB_SESSION_ENDS_AT ? `, истекает ~${hb.HB_SESSION_ENDS_AT}` : ''}${hb.HB_USER ? ` · ${hb.HB_USER}` : ''}`);
    console.log(`  последний цикл: ${hb.HB_LAST_RESULT || '—'}`);
    if (hb.HB_LAST_ERROR) console.log(`  последняя ошибка (${hb.HB_LAST_ERROR_AT || '?'}): ${hb.HB_LAST_ERROR}`);
    if (!legacy && (!isFinite(age) || age > STALE_MIN)) { console.log(`  ⚠ пульса нет дольше ${STALE_MIN} мин — вкладка закрыта или скрипт не работает`); bad = true; }
    if (!legacy && hb.HB_SESSION && hb.HB_SESSION !== 'ok') { console.log('  ⚠ нужен вход в Balazhan через oqu.edu.kz (ЭЦП)'); bad = true; }
    const c = st.counts || {};
    console.log(`\nСтроки (всего ${st.total}): ` + ['new', 'processing', 'created', 'duplicate', 'error', 'test', 'skip'].map((k) => `${k}=${c[k] || 0}`).join('  ') +
      Object.keys(c).filter((k) => !['new', 'processing', 'created', 'duplicate', 'error', 'test', 'skip'].includes(k)).map((k) => `  ${k}=${c[k]}`).join(''));
    const probs = st.problems || [];
    if (probs.length) { bad = true; console.log('\nТребуют внимания:'); for (const p of probs) console.log(`  строка ${p.row}: ${p.fullName} (${p.group || '—'}) — ${p.status} ${p.status_at || ''}: ${p.message || ''}`); }
    else console.log('Ошибок нет.');
  }
  process.exit(bad ? 1 : 0);
})();
