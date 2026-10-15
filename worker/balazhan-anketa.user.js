// ==UserScript==
// @name         Balazhan — автодобавление студентов из анкет родителей
// @namespace    https://leonistr.github.io/balazhan-anketa/
// @version      1.1.0
// @description  Пока открыт кабинет Balazhan, раз в 3 минуты забирает новые анкеты из Google Таблицы и создаёт студентов (соцпаспорт + наблюдения куратора). Пишет «пульс» в лист «Настройки».
// @match        https://balazhan.nedb.kz/*
// @noframes
// @require      https://leonistr.github.io/balazhan-anketa/worker/core.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==
/* Работает в браузере с открытым кабинетом и использует его сессию (вход через oqu.edu.kz с ЭЦП).
   Куки и пароли никуда не передаются: запросы к Balazhan идут из этой же вкладки (same-origin). */
(function () {
  'use strict';
  if (location.hostname !== 'balazhan.nedb.kz' || window.top !== window.self) return;
  const BAKED_URL = '__APPS_SCRIPT_URL__';
  const BAKED_TOKEN = '__WORKER_TOKEN__';
  const AGENT = 'tampermonkey';
  const INTERVAL_MIN = 3;          // как часто проверять анкеты
  const RELOAD_MIN = 60;           // перезагрузка вкладки (SPA не «засыпает»), только в простое
  const WATCHDOG_MIN = 15;         // если цикл висит дольше — перезагрузка
  const core = globalThis.BalazhanCore;
  const GROUPS = {
    T110: { grade: 101, letter: 'Т110', title: '1 курс · Т110' },
    PO306: { grade: 103, letter: 'ПО306', title: '3 курс · ПО306' },
  };
  const OBS = {
    behaviorChanges: { value: ['no_changes'], otherText: '' }, socialCircle: { value: ['stable_positive'], otherText: '' },
    classmatesRelationship: { value: ['good'], otherText: '' }, friendsRelationship: { value: ['good'], otherText: '' },
    peerConflicts: { value: ['none'], otherText: '' }, teacherRelationship: { value: ['good'], otherText: '' },
    bullyingFacts: { value: ['none'], otherText: '' }, familyDifficulties: { value: ['other'], otherText: 'Ничего' },
    teacherConclusion: { value: ['other'], otherText: 'Норма' },
  };
  const baked = (v) => v && !/^__.*__$/.test(v) ? v : '';
  const cfg = (k, d) => GM_getValue(k, '') || d;
  const URL_ = () => cfg('url', baked(BAKED_URL));
  const TOKEN = () => cfg('token', baked(BAKED_TOKEN));
  GM_registerMenuCommand('Настроить (URL Apps Script и токен)', () => {
    const u = prompt('URL веб-приложения Apps Script (…/exec):', URL_()); if (u !== null) GM_setValue('url', u.trim());
    const t = prompt('WORKER_TOKEN из листа «Настройки»:', TOKEN()); if (t !== null) GM_setValue('token', t.trim());
  });
  GM_registerMenuCommand('Проверить анкеты сейчас', () => tick(true));

  // ---------- panel ----------
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:#fff;border:1px solid #d0d7e2;border-radius:10px;padding:8px 10px;font:12px/1.35 system-ui,sans-serif;color:#1d2433;box-shadow:0 4px 14px rgba(0,0,0,.12);max-width:320px;cursor:pointer';
  panel.title = 'Нажмите, чтобы проверить анкеты сейчас';
  panel.onclick = () => tick(true);
  const hhmm = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const setPanel = (t) => { panel.textContent = '📝 Анкеты: ' + t; };
  setPanel('ожидание…');
  (document.body || document.documentElement).appendChild(panel);
  if (!core) { setPanel('core.js не загрузился'); return; }

  function sheet(action, extra) {
    const url = URL_(), token = TOKEN();
    if (!url || !token) return Promise.reject(new Error('не настроено: нет URL/токена'));
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'POST', url, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, data: JSON.stringify({ action, token, ...extra }), timeout: 60000,
      onload: (r) => { try { const j = JSON.parse(r.responseText); j.ok === false ? reject(new Error('Apps Script: ' + j.error)) : resolve(j); } catch (e) { reject(new Error('Apps Script: ответ не JSON (HTTP ' + r.status + ')')); } },
      onerror: () => reject(new Error('нет связи с Apps Script')), ontimeout: () => reject(new Error('таймаут Apps Script')),
    }));
  }
  const heartbeat = (hb) => sheet('heartbeat', { hb: { agent: AGENT, ...hb } }).catch((e) => console.warn('[anketa] heartbeat:', e.message));

  let csrf = '', user = null;
  function assignmentHeader() { try { const a = JSON.parse(sessionStorage.getItem('mental-health-staff-assignment') || 'null'); return a && a.assignmentId ? { 'X-Staff-Assignment': a.assignmentId } : {}; } catch { return {}; } }
  async function req(method, p, body) {
    if (!p.startsWith('/api/')) throw new Error('bad path');
    const h = { Accept: 'application/json', ...assignmentHeader() };
    if (csrf) h['X-CSRF-Token'] = csrf;
    if (method !== 'GET') { h['Content-Type'] = 'application/json'; if (user) h['X-Expected-User-ID'] = user.id; }
    for (let i = 0; ; i++) {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 30000);
      let r;
      try { r = await fetch(p, { method, headers: h, credentials: 'same-origin', cache: 'no-store', signal: ctl.signal, body: body === undefined ? undefined : JSON.stringify(body) }); }
      finally { clearTimeout(to); }
      const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
      if ((r.status === 409 && json && /busy/.test(json.code || json.error || '')) || r.status === 429 || r.status >= 500) { if (i < 3) { await new Promise((s) => setTimeout(s, 3000 * (i + 1))); continue; } }
      return { status: r.status, ok: r.ok, json, text };
    }
  }

  let busy = false, busySince = 0, lastActivity = Date.now();
  async function tick(manual) {
    if (busy) { if (Date.now() - busySince > WATCHDOG_MIN * 60000) location.reload(); return; }
    // одна вкладка за раз
    const lock = Number(localStorage.getItem('anketa-worker-lock') || 0);
    if (!manual && Date.now() - lock < WATCHDOG_MIN * 60000) return;
    busy = true; busySince = Date.now();
    localStorage.setItem('anketa-worker-lock', String(Date.now()));
    try {
      const year = core.academicYearNow();
      const me = await req('GET', '/api/auth/me?academicYear=' + encodeURIComponent(year));
      if (me.status === 401 || !me.ok || !me.json || me.json.subjectType !== 'user' || !me.json.user) {
        setPanel('нет входа — войдите через oqu.edu.kz');
        await heartbeat({ session: me.status === 401 || me.ok ? 'expired' : 'error', session_ends_in: '', last_result: 'нет сессии (HTTP ' + me.status + ')' });
        return;
      }
      csrf = me.json.csrfToken || ''; user = me.json.user;
      const endsIn = me.json.sessionEndsInSeconds;
      const who = [user.name || user.fullName || user.id, user.role, user.school].filter(Boolean).join(' · ');
      if (user.role !== 'teacher') {
        setPanel('нужна роль куратора группы (сейчас ' + user.role + ')');
        await heartbeat({ session: 'error', session_ends_in: endsIn ?? '', user: who, last_result: 'роль не teacher', last_error: 'вошли не под куратором группы: ' + user.role });
        return;
      }
      if (!/\/cabinet/.test(location.pathname)) {
        setPanel('откройте /cabinet — здесь не работаю');
        await heartbeat({ session: 'ok', session_ends_in: endsIn ?? '', user: who, last_result: 'вкладка не на /cabinet (' + location.pathname + ')' });
        return;
      }
      const { rows } = await sheet('list', { statuses: ['new'] });
      if (!rows.length) {
        setPanel('новых нет · ' + hhmm());
        await heartbeat({ session: 'ok', session_ends_in: endsIn ?? '', user: who, last_result: 'новых нет' });
        return;
      }
      const forms = {};
      for (const slug of ['social-passport', 'teacher-observation']) {
        const f = await req('GET', '/api/forms/' + slug);
        if (!f.ok || !f.json || !Array.isArray(f.json.questions)) throw new Error('не загрузилась форма ' + slug);
        forms[slug] = f.json;
      }
      const loadRoster = async () => { const r = await req('GET', '/api/cabinet/roster?academicYear=' + encodeURIComponent(year)); return r.ok && r.json ? r.json : null; };
      let roster = await loadRoster();
      if (!roster) throw new Error('не загрузился список студентов (roster)');
      const stat = { created: 0, duplicate: 0, error: 0 };
      let lastErr = '';
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        setPanel(`обрабатываю ${i + 1}/${rows.length}: ${row.fullName}`);
        if (/НЕ ОБРАБАТЫВАТЬ/i.test(row.comment || '')) { await sheet('update', { row: row._row, key: row._key, fields: { status: 'skip', message: 'пропущено: отмечено «НЕ ОБРАБАТЫВАТЬ»' } }).catch(() => {}); continue; }
        try { await sheet('claim', { row: row._row, key: row._key }); } catch (e) { continue; } // уже взята / изменена
        let res;
        try { res = await core.processRow(row, { req, user, forms, roster, academicYear: year, groups: GROUPS, obs: OBS, dry: false, fillExisting: true, log: (...m) => console.log('[anketa]', ...m) }); }
        catch (e) { res = e.session ? { status: 'new', message: 'сессия истекла — строка будет обработана после нового входа' } : { status: 'error', message: String(e.message || e) }; }
        await sheet('update', { row: row._row, key: row._key, fields: { status: res.status, message: res.message, bz_student_id: res.bz_student_id || '', bz_username: res.bz_username || '' } })
          .catch((e) => { lastErr = 'статус строки ' + row._row + ' не записан: ' + e.message; });
        if (stat[res.status] !== undefined) stat[res.status]++;
        if (res.status === 'error') lastErr = `строка ${row._row} (${row.fullName}): ${res.message}`;
        if (res.status === 'new') { lastErr = 'сессия истекла во время обработки'; break; }
        if (res.status === 'created') roster = (await loadRoster()) || roster; // свежий список для проверки следующих дублей
        lastActivity = Date.now();
      }
      const summary = `создано ${stat.created}, дублей ${stat.duplicate}, ошибок ${stat.error} из ${rows.length}`;
      setPanel(summary + ' · ' + hhmm());
      await heartbeat({ session: 'ok', session_ends_in: endsIn ?? '', user: who, last_result: summary, ...(lastErr ? { last_error: lastErr } : {}) });
    } catch (e) {
      setPanel('ошибка: ' + e.message);
      await heartbeat({ session: 'error', last_result: 'цикл прерван', last_error: String(e.message || e) });
    } finally {
      busy = false; localStorage.removeItem('anketa-worker-lock');
    }
  }
  // Перезагрузка вкладки в простое: держит SPA «живой». Сессию не завершает (кука остаётся).
  setInterval(() => {
    if (!busy && Date.now() - lastActivity > 5 * 60000) location.reload();
  }, RELOAD_MIN * 60000);
  setTimeout(() => tick(false), 8000);
  setInterval(() => tick(false), INTERVAL_MIN * 60000);
})();
