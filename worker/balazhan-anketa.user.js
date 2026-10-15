// ==UserScript==
// @name         Balazhan — автодобавление студентов из анкет родителей
// @namespace    https://leonistr.github.io/balazhan-anketa/
// @version      1.0.0
// @description  Пока открыт кабинет Balazhan, раз в 3 минуты забирает новые анкеты из Google Таблицы и создаёт студентов (соцпаспорт + наблюдения куратора).
// @match        https://balazhan.nedb.kz/*
// @require      https://leonistr.github.io/balazhan-anketa/worker/core.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==
/* Работает в ВАШЕМ браузере и использует вашу текущую сессию Balazhan (вход через oqu.edu.kz).
   Никакие пароли/куки никуда не передаются: запросы к Balazhan идут с той же вкладки. */
(function () {
  'use strict';
  const core = globalThis.BalazhanCore;
  if (!core) return console.warn('[anketa] core.js не загрузился');
  const INTERVAL_MIN = 3;
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
  GM_registerMenuCommand('Настроить (URL Apps Script и токен)', configure);
  GM_registerMenuCommand('Проверить анкеты сейчас', () => tick(true));
  function configure() {
    const u = prompt('URL веб-приложения Apps Script (…/exec):', GM_getValue('url', ''));
    if (u !== null) GM_setValue('url', u.trim());
    const t = prompt('WORKER_TOKEN из листа «Настройки» таблицы:', GM_getValue('token', ''));
    if (t !== null) GM_setValue('token', t.trim());
  }
  // ---------- panel ----------
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:#fff;border:1px solid #d0d7e2;border-radius:10px;padding:8px 10px;font:12px/1.35 system-ui,sans-serif;color:#1d2433;box-shadow:0 4px 14px rgba(0,0,0,.12);max-width:300px;cursor:pointer';
  panel.title = 'Нажмите, чтобы проверить анкеты сейчас';
  panel.onclick = () => tick(true);
  const setPanel = (t) => { panel.textContent = '📝 Анкеты: ' + t; };
  setPanel('ожидание…');
  document.body.appendChild(panel);

  function sheet(action, extra) {
    const url = GM_getValue('url', ''), token = GM_getValue('token', '');
    if (!url || !token) return Promise.reject(new Error('не настроено — меню Tampermonkey → «Настроить»'));
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'POST', url, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, data: JSON.stringify({ action, token, ...extra }), timeout: 60000,
      onload: (r) => { try { const j = JSON.parse(r.responseText); j.ok === false ? reject(new Error(j.error)) : resolve(j); } catch (e) { reject(new Error('Apps Script: ответ не JSON')); } },
      onerror: () => reject(new Error('нет связи с Apps Script')), ontimeout: () => reject(new Error('таймаут Apps Script')),
    }));
  }
  let csrf = '', user = null;
  function assignmentHeader() { try { const a = JSON.parse(sessionStorage.getItem('mental-health-staff-assignment') || 'null'); return a && a.assignmentId ? { 'X-Staff-Assignment': a.assignmentId } : {}; } catch { return {}; } }
  async function req(method, p, body) {
    const h = { Accept: 'application/json', ...assignmentHeader() };
    if (csrf) h['X-CSRF-Token'] = csrf;
    if (method !== 'GET') { h['Content-Type'] = 'application/json'; if (user) h['X-Expected-User-ID'] = user.id; }
    for (let i = 0; ; i++) {
      const r = await fetch(p, { method, headers: h, credentials: 'same-origin', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
      if ((r.status === 409 && json && /busy/.test(json.code || json.error || '')) || r.status === 429 || r.status >= 500) { if (i < 3) { await new Promise((s) => setTimeout(s, 3000 * (i + 1))); continue; } }
      return { status: r.status, ok: r.ok, json, text };
    }
  }
  let busy = false;
  async function tick(manual) {
    if (busy) return; busy = true;
    // одна вкладка за раз
    const lock = Number(localStorage.getItem('anketa-worker-lock') || 0);
    if (!manual && Date.now() - lock < 120000) { busy = false; return; }
    localStorage.setItem('anketa-worker-lock', String(Date.now()));
    try {
      const year = core.academicYearNow();
      const me = await req('GET', '/api/auth/me?academicYear=' + encodeURIComponent(year));
      if (!me.ok || !me.json || !me.json.user) { setPanel('войдите в кабинет'); return; }
      csrf = me.json.csrfToken || ''; user = me.json.user;
      if (user.role !== 'teacher') { setPanel('нужна роль куратора группы'); return; }
      const { rows } = await sheet('list', { statuses: ['new'] });
      if (!rows.length) { setPanel('новых нет · ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })); return; }
      const forms = {};
      for (const slug of ['social-passport', 'teacher-observation']) forms[slug] = (await req('GET', '/api/forms/' + slug)).json;
      const rosterRes = await req('GET', '/api/cabinet/roster?academicYear=' + encodeURIComponent(year));
      const roster = rosterRes.ok && rosterRes.json ? rosterRes.json : { students: [] };
      let done = 0;
      for (const row of rows) {
        setPanel(`обрабатываю ${done + 1}/${rows.length}: ${row.fullName}`);
        try { await sheet('claim', { row: row._row, key: row._key }); } catch (e) { continue; }
        let res;
        try { res = await core.processRow(row, { req, user, forms, roster, academicYear: year, groups: GROUPS, obs: OBS, dry: false, fillExisting: true, log: (...m) => console.log('[anketa]', ...m) }); }
        catch (e) { res = e.session ? { status: 'new', message: 'сессия истекла — повторю после входа' } : { status: 'error', message: String(e.message || e) }; }
        await sheet('update', { row: row._row, key: row._key, fields: { status: res.status, message: res.message, bz_student_id: res.bz_student_id || '', bz_username: res.bz_username || '' } }).catch(() => {});
        if (res.status === 'created') { done++; const r2 = await req('GET', '/api/cabinet/roster?academicYear=' + encodeURIComponent(year)); if (r2.ok && r2.json) roster.students = r2.json.students || roster.students; }
        if (res.status === 'new') break;
      }
      setPanel(`создано ${done} из ${rows.length} · ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (e) { setPanel('ошибка: ' + e.message); }
    finally { busy = false; localStorage.removeItem('anketa-worker-lock'); }
  }
  setTimeout(() => tick(false), 5000);
  setInterval(() => tick(false), INTERVAL_MIN * 60000);
})();
