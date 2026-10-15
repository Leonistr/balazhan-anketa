'use strict';
/**
 * Чистая логика (без сети): превращает строку таблицы в запросы Balazhan.
 * Повторяет то, что делает сам сайт в окне «Добавить 1 студента» (legacy-интерфейс, PsychologistCabinet + index bundle):
 *   POST /api/students/username  → { username, existing, iinHash, academicYear }
 *   POST /api/students/bulk       { students:[student], accesses:[access] }
 *   PUT  /api/students/:id/form-submissions/social-passport?academicYear=Y
 *   PUT  /api/students/:id/form-submissions/teacher-observation?academicYear=Y&quarter=Q
 */

const HIDDEN_SP = new Set(['fatherStudyPlace', 'motherStudyPlace', 'parentsEducation']);
const CHILD_NUM = new Set(['childrenCount', 'childBirthOrder', 'childrenAdult', 'childrenSchoolAge', 'childrenPreschool']);

function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
function clean(s) { return String(s == null ? '' : s).normalize('NFC').replace(/[\s\u00a0\u202f]+/g, ' ').trim(); }
function normName(s) { return clean(s).toLowerCase().replace(/ё/g, 'е'); }

function iinValid(s) {
  if (!/^\d{12}$/.test(s)) return false;
  const n = s.split('').map(Number);
  const sum = (w) => w.reduce((a, x, i) => a + x * n[i], 0) % 11;
  let c = sum([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  if (c === 10) c = sum([3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2]);
  return c !== 10 && c === n[11];
}
// как eL() на сайте: 1234******56
function maskIin(s) { const t = digits(s); return /^\d{12}$/.test(t) ? `${t.slice(0, 4)}******${t.slice(10)}` : ''; }
// как IA() на сайте
function fmtPhone(v) {
  const t = String(v || '').trim(), n = t.replace(/\D/g, '');
  if (!n) return '';
  const r = n.length === 10 ? `7${n}` : n.length === 11 && n.startsWith('8') ? `7${n.slice(1)}` : n.length === 11 && n.startsWith('7') ? n : '';
  return r ? `+7 ${r.slice(1, 4)} ${r.slice(4, 7)} ${r.slice(7, 9)} ${r.slice(9, 11)}` : (n.length >= 7 && n.length <= 15 ? `+${n}` : t);
}
// UUID v4-формата, детерминированный от ключа (повторный запуск даёт тот же id → идемпотентность)
function hexHash(str) { // детерминированный 128-битный хеш (не криптографический), работает и в браузере
  let out = '';
  for (let k = 0; k < 4; k++) {
    let h = 0x811c9dc5 ^ (k * 0x9e3779b1);
    const s = k + ':' + str;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
    out += ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }
  return out;
}
function stableUuid(seed) {
  const h = hexHash(String(seed));
  const v = '89ab'[parseInt(h[16], 16) % 4];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Учебный год как et() на сайте: новый год с 15 сентября, время UTC+5
function academicYearNow(d = new Date()) {
  const t = new Date(d.getTime() + 5 * 3600e3);
  const y = t.getUTCFullYear(), m = t.getUTCMonth(), day = t.getUTCDate();
  const start = m > 8 || (m === 8 && day >= 15) ? y : y - 1;
  return `${start}-${start + 1}`;
}
// Период для наблюдений: колледж → семестр (Xn(...,"semester")), школа → четверть
function observationPeriod(academicYear, college = true, d = new Date()) {
  const t = new Date(d.getTime() + 5 * 3600e3);
  const startYear = Number(String(academicYear).split('-')[0]);
  if (college) return { academicYear, quarter: t.getUTCFullYear() === startYear ? 1 : 2 };
  const mo = t.getUTCMonth() + 1, day = t.getUTCDate();
  let q = 4;
  if ((mo === 9 && day >= 15) || mo === 10 || mo === 11) q = 1; else if (mo === 12 || mo === 1) q = 2; else if (mo >= 2 && mo <= 4) q = 3;
  return { academicYear, quarter: q };
}

function splitMulti(v) {
  if (Array.isArray(v)) return v.map(clean).filter(Boolean);
  return String(v || '').split(/\s*;\s*|\n+/).map(clean).filter(Boolean);
}
function matchOption(q, text) {
  const t = clean(text).toLowerCase().replace(/ё/g, 'е');
  if (!t) return null;
  return (q.options || []).find((o) => [o.value, o.labelRu, o.labelKz].filter(Boolean).some((x) => clean(x).toLowerCase().replace(/ё/g, 'е') === t)) || null;
}

/** visibility like ol() */
function visible(q, answers) {
  if (!q.showIf) return true;
  const a = answers[q.showIf.questionKey];
  const r = a && a.value;
  if (q.showIf.value === undefined || q.showIf.value === '') return Array.isArray(r) ? r.length > 0 : typeof r === 'string' ? r.trim() !== '' : r != null;
  return Array.isArray(r) ? r.includes(q.showIf.value) : typeof r === 'string' && r === q.showIf.value;
}
function isEmpty(a) {
  if (!a) return true;
  if (Array.isArray(a.value)) return a.value.length === 0 && !String(a.otherText || '').trim();
  return !String(a.value == null ? '' : a.value).trim() && !String(a.otherText || '').trim();
}

/** Ответы родителей (строка таблицы, ключи = ключи вопросов) → answers соцпаспорта в формате сайта */
function buildSocialAnswers(form, row, { foreign = false } = {}) {
  const warnings = [];
  const raw = {};
  for (const q of form.questions) {
    if (HIDDEN_SP.has(q.key)) continue;
    const cell = row[q.key];
    const other = clean(row[`${q.key}__other`]);
    if (q.type === 'text') { const v = clean(cell); if (v) raw[q.key] = { value: v, otherText: '' }; }
    else if (q.type === 'phone') { const v = fmtPhone(cell); if (v) raw[q.key] = { value: v, otherText: '' }; }
    else if (q.type === 'number') { const v = digits(cell); if (v !== '') raw[q.key] = { value: String(Number(v)), otherText: '' }; }
    else if (q.type === 'single') {
      const txt = clean(cell);
      if (!txt) continue;
      const o = matchOption(q, txt);
      const otherOpt = (q.options || []).find((x) => x.allowsOther);
      if (o) raw[q.key] = { value: o.value, otherText: o.allowsOther ? other : '' };
      else if (otherOpt) { raw[q.key] = { value: otherOpt.value, otherText: other || txt }; warnings.push(`${q.labelRu}: «${txt}» → «Другое»`); }
      else warnings.push(`${q.labelRu}: неизвестный вариант «${txt}» пропущен`);
    } else if (q.type === 'multiple') {
      const vals = [], extra = [];
      for (const part of splitMulti(cell)) {
        const o = matchOption(q, part);
        if (o) { if (!vals.includes(o.value)) vals.push(o.value); }
        else extra.push(part);
      }
      const otherOpt = (q.options || []).find((x) => x.allowsOther);
      if (extra.length) {
        if (otherOpt) { if (!vals.includes(otherOpt.value)) vals.push(otherOpt.value); }
        else warnings.push(`${q.labelRu}: неизвестные варианты пропущены: ${extra.join('; ')}`);
      }
      const hasOther = otherOpt && vals.includes(otherOpt.value);
      const otherText = hasOther ? [other, ...(otherOpt ? extra : [])].filter(Boolean).join(', ') : '';
      if (vals.length) raw[q.key] = { value: vals, otherText };
    }
  }
  // правила сайта
  if (raw.incompleteReason && raw.incompleteReason.value.includes('father_deceased') && raw.incompleteReason.value.includes('mother_deceased')) {
    warnings.push('Наличие родителей: «Папа умер» и «Мама умерла» одновременно — сайт так не позволяет, оставлено первое');
    raw.incompleteReason.value = raw.incompleteReason.value.filter((v) => v !== 'mother_deceased');
  }
  if (foreign) { // ct(): иностранцу добавляется категория «Учащиеся-граждане другого государства»
    const sc = raw.socialCategories || { value: [], otherText: '' };
    if (!sc.value.includes('foreign_citizen_student')) sc.value.push('foreign_citizen_student');
    raw.socialCategories = sc;
  }
  if (!raw.familyType) raw.familyType = { value: 'full', otherText: '' }; // обязательный на сайте; по умолчанию «Полная семья»
  // mj(): видимые пустые детские числа → "0"
  for (const q of form.questions) if (q.type === 'number' && CHILD_NUM.has(q.key) && visible(q, raw) && isEmpty(raw[q.key])) raw[q.key] = { value: '0', otherText: '' };
  // EA(): только видимые и непустые
  const answers = {};
  for (const q of form.questions) if (visible(q, answers) && raw[q.key] && !isEmpty(raw[q.key])) answers[q.key] = raw[q.key];
  // проверки как на сайте
  const errors = [];
  for (const q of form.questions) if (visible(q, answers) && q.required && isEmpty(answers[q.key])) errors.push(`не заполнено обязательное «${q.labelRu}»`);
  const num = (k) => (answers[k] ? Number(answers[k].value) : null);
  if (num('childrenCount') !== null) {
    const parts = ['childrenAdult', 'childrenSchoolAge', 'childrenPreschool'].map(num);
    if (parts.some((x) => x !== null)) {
      const s = parts.reduce((a, x) => a + (x || 0), 0);
      if (s !== num('childrenCount')) errors.push(`сумма детей по возрастам (${s}) ≠ количеству детей (${num('childrenCount')})`);
    }
    if (num('childBirthOrder') !== null && (num('childBirthOrder') < 1 || num('childBirthOrder') > num('childrenCount'))) errors.push('«Которым по счёту» больше количества детей');
  }
  for (const k of ['motherPhone', 'fatherPhone', 'phone']) if (answers[k]) { const d = digits(answers[k].value); if (d.length < 7 || d.length > 15) errors.push(`неверный формат телефона (${k})`); }
  return { answers, warnings, errors };
}

function buildObservationAnswers(form, defaults) {
  const answers = {}, errors = [];
  for (const q of form.questions) {
    const d = defaults[q.key];
    if (!d) { if (q.required) errors.push(`нет значения по умолчанию для «${q.labelRu}»`); continue; }
    const vals = Array.isArray(d.value) ? d.value : [d.value];
    for (const v of vals) if (!(q.options || []).some((o) => o.value === v)) errors.push(`«${q.labelRu}»: вариант ${v} отсутствует в форме сайта`);
    const otherOpt = (q.options || []).find((o) => o.allowsOther);
    const needsOther = otherOpt && vals.includes(otherOpt.value);
    if (needsOther && !String(d.otherText || '').trim()) errors.push(`«${q.labelRu}»: для «Другое» нужен текст`);
    answers[q.key] = { value: q.type === 'multiple' ? vals : vals[0], otherText: needsOther ? String(d.otherText) : '' };
  }
  return { answers, errors };
}

/** Данные студента из строки (до обращения к сайту) */
function parseStudent(row) {
  const errors = [];
  const fullName = clean(row.fullName);
  if (!fullName || fullName.length > 200) errors.push('нет ФИО');
  const iin = digits(row.iin);
  const foreign = /^да$/i.test(clean(row.foreign));
  if ((!foreign || iin) && !iinValid(iin)) errors.push('некорректный ИИН');
  const g = clean(row.gender).toLowerCase();
  const gender = g.startsWith('мальч') || g === 'male' ? 'male' : g.startsWith('девоч') || g === 'female' ? 'female' : undefined;
  let citizenship = {};
  if (foreign) {
    const code = clean(row.country).split(/\s*[—-]\s*/)[0].toUpperCase();
    const dob = clean(row.birthDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) errors.push('для иностранца нужна дата рождения ГГГГ-ММ-ДД');
    citizenship = { foreignCitizen: true, ...(/^[A-Z]{2}$/.test(code) && code !== 'KZ' ? { citizenshipCountry: code } : {}), dateOfBirth: dob,
      creationRequestId: stableUuid(`foreign:${iin || clean(row.passport) || normName(fullName) + dob}`) };
    const pass = clean(row.passport);
    if (pass) citizenship.passport = { number: pass.slice(0, 64) };
  }
  return { fullName, iin, foreign, gender, citizenship, errors };
}

/** Студент + доступ для POST /api/students/bulk — как Ni() на сайте */
function buildBulk({ st, user, grade, letter, academicYear, username, iinHash, region, now = new Date().toISOString() }) {
  const c = st.citizenship;
  const idOverride = c.foreignCitizen && !st.iin && !(c.citizenshipCountry && c.passport && c.passport.number) && c.creationRequestId ? `student-${c.creationRequestId}` : null;
  const student = JSON.parse(JSON.stringify({
    id: idOverride || stableUuid(`student:${st.iin || c.creationRequestId}:${academicYear}`),
    username, gender: st.gender, ...c, fullName: st.fullName, iin: maskIin(st.iin), iinHash: iinHash || undefined,
    grade, letter, schoolId: user.schoolId, school: user.school, region: region || '', district: '', parentPhone: '',
    academicYear: academicYear || undefined, createdAt: now,
  }));
  const access = JSON.parse(JSON.stringify({
    username, grade, letter, createdBy: user.id, schoolId: user.schoolId, school: user.school, used: false, createdAt: now,
    iin: student.iin, studentId: student.id, fullName: student.fullName, academicYear: student.academicYear,
  }));
  return { students: [student], accesses: [access] };
}

function regionOf(user) {
  const r = clean(user && user.region);
  return /^(все регионы|барлық өңірлер)$/i.test(r) ? '' : r;
}

const LOOKALIKE = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };
function normLetter(s) { return clean(s).toUpperCase().replace(/[ABCEHKMOPTXY]/g, (ch) => LOOKALIKE[ch]).replace(/\s+/g, ''); }


// ------------------------------------------------------------ class resolution
function resolveClass(user, code, GROUPS) {
  const g = GROUPS[code];
  if (!g) return { error: `неизвестный код группы «${code}» (нет в groups.json)` };
  const year = academicYearNow();
  const assigned = [];
  if (user) {
    for (const c of user.assignedClasses || []) assigned.push(c);
    if (user.classAssignmentsByYear && user.classAssignmentsByYear[year]) for (const c of user.classAssignmentsByYear[year]) assigned.push(c);
    if (user.grade && user.letter) assigned.push({ grade: user.grade, letter: user.letter });
  }
  if (!assigned.length) return { grade: g.grade, letter: g.letter, verified: false };
  const hit = assigned.find((c) => Number(c.grade) === Number(g.grade) && normLetter(c.letter) === normLetter(g.letter));
  if (!hit) return { error: `группа ${g.title} не назначена этому куратору в Balazhan (назначены: ${assigned.map((c) => `${c.grade}/${c.letter}`).join(', ')})` };
  return { grade: Number(hit.grade), letter: hit.letter, verified: true };
}

// ------------------------------------------------------------ one row
async function processRow(row, ctx) {
  const { req, forms, roster, academicYear, groups: GROUPS, obs: OBS, dry: DRY, fillExisting: FILL_EXISTING, log } = ctx;
  const bz = { user: ctx.user, req };
  const st = parseStudent(row);
  if (st.errors.length) return { status: 'error', message: st.errors.join('; ') };
  const sp = buildSocialAnswers(forms['social-passport'], row, { foreign: st.foreign });
  if (sp.errors.length) return { status: 'error', message: 'Соцпаспорт: ' + sp.errors.join('; ') };
  const obs = buildObservationAnswers(forms['teacher-observation'], OBS);
  if (obs.errors.length) return { status: 'error', message: 'Наблюдения: ' + obs.errors.join('; ') };
  const cls = resolveClass(bz.user, row.group_code, GROUPS);
  if (cls.error) return { status: 'error', message: cls.error };
  const period = observationPeriod(academicYear, Number(cls.grade) > 100);
  const user = bz.user || { id: '<user.id>', schoolId: '<user.schoolId>', school: '<user.school>', region: '' };

  // 1) дубль в своей группе — по маске ИИН + ФИО (до любых запросов на запись)
  const masked = maskIin(st.iin);
  const rosterStudents = (roster && roster.students) || [];
  let existing = st.iin ? rosterStudents.find((s) => s.iin === masked && normName(s.fullName) === normName(st.fullName)) : null;

  // 2) проверка ИИН на сервере + код ученика
  let lookup = null;
  if (!existing) {
    const body = { fullName: st.fullName, iin: st.iin || undefined, academicYear, ...(st.foreign ? st.citizenship : {}) };
    if (DRY) { log('  DRY POST /api/students/username', JSON.stringify(body).replace(/"iin":"\d+"/, '"iin":"<ИИН>"')); lookup = { username: '<код-ученика>', existing: false, iinHash: '<iinHash>', academicYear: '' }; }
    else {
      const r = await bz.req('POST', '/api/students/username', body);
      if (r.status === 401) throw Object.assign(new Error('session'), { session: true });
      if (!r.ok || !r.json || !r.json.username) {
        const code = (r.json && (r.json.code || r.json.error)) || `HTTP ${r.status}`;
        if (code === 'student_iin_conflict' || r.status === 409) return { status: 'duplicate', message: `ИИН уже связан с другой карточкой в Balazhan (${code})${r.json && r.json.existingStudent ? ': ' + JSON.stringify(r.json.existingStudent) : ''}` };
        return { status: 'error', message: `проверка ИИН не прошла: ${code}` };
      }
      lookup = { username: String(r.json.username).trim().toLowerCase(), existing: !!r.json.existing, iinHash: r.json.iinHash || '', academicYear: r.json.academicYear || '', existingStudent: r.json.existingStudent };
    }
    if (lookup.existing) {
      existing = rosterStudents.find((s) => (lookup.iinHash && s.iinHash === lookup.iinHash) || String(s.username || '').toLowerCase() === lookup.username) || null;
      if (!existing && lookup.academicYear === academicYear) return { status: 'duplicate', message: `студент с этим ИИН уже есть в Balazhan за ${academicYear}, но не в вашей группе${lookup.existingStudent ? ': ' + JSON.stringify(lookup.existingStudent) : ''}` };
    }
    if (!existing && !lookup.iinHash && !st.foreign) return { status: 'error', message: 'сервер не подтвердил ИИН (нет iinHash) — повторите позже' };
    if (!existing && !lookup.iinHash && rosterStudents.some((s) => Number(s.grade) === Number(cls.grade) && normLetter(s.letter) === normLetter(cls.letter) && normName(s.fullName) === normName(st.fullName)))
      return { status: 'duplicate', message: 'в группе уже есть студент с таким ФИО' };
  }

  let studentId, username, iinHash, created = false;
  if (existing) {
    studentId = existing.id; username = existing.username; iinHash = existing.iinHash || (lookup && lookup.iinHash) || '';
    if (!FILL_EXISTING) return { status: 'duplicate', message: 'студент уже есть в группе', bz_student_id: studentId, bz_username: username };
  } else {
    const bulk = buildBulk({ st, user, grade: cls.grade, letter: cls.letter, academicYear, username: lookup.username, iinHash: lookup.iinHash, region: regionOf(user) });
    studentId = bulk.students[0].id; username = lookup.username; iinHash = lookup.iinHash;
    if (DRY) log('  DRY POST /api/students/bulk', JSON.stringify(bulk, null, 1));
    else {
      const r = await bz.req('POST', '/api/students/bulk', bulk, { retries: 0 });
      if (r.status === 401) throw Object.assign(new Error('session'), { session: true });
      const j = r.json || {};
      const okSaved = r.ok && j.savedStudents >= 1 && j.savedAccesses >= 1 && j.skipped === 0;
      if (!okSaved) return { status: 'error', message: `создание не подтверждено: HTTP ${r.status} ${j.code || j.error || ''} saved=${j.savedStudents}/${j.savedAccesses} skipped=${j.skipped}. Строка будет проверена на дубль при следующем запуске, если поставить статус new.` };
    }
    created = true;
  }

  // 3) соцпаспорт и наблюдения куратора
  const notes = [];
  for (const [slug, answers, params] of [['social-passport', sp.answers, { academicYear }], ['teacher-observation', obs.answers, period]]) {
    const qs = new URLSearchParams({ academicYear: params.academicYear, ...(params.quarter ? { quarter: String(params.quarter) } : {}) }).toString();
    const p = `/api/students/${encodeURIComponent(studentId)}/form-submissions/${slug}?${qs}`;
    let prev = null;
    if (!DRY || bz.user) {
      const g = DRY && created ? { ok: false, status: 404 } : await bz.req('GET', p);
      if (g.status === 401) throw Object.assign(new Error('session'), { session: true });
      prev = g.ok && g.json && !('submission' in g.json) ? g.json : null;
    }
    if (existing && prev && prev.answers && Object.keys(prev.answers).length) { notes.push(`${slug}: уже заполнен — не трогаю`); continue; }
    const body = { answers, academicYear: params.academicYear, quarter: params.quarter, expectedUpdatedAt: (prev && prev.updatedAt) || '', expectedIinHash: iinHash || '' };
    if (DRY) { log(`  DRY PUT ${p}`, JSON.stringify(body, null, 1)); continue; }
    const r = await bz.req('PUT', p, body);
    if (r.status === 401) throw Object.assign(new Error('session'), { session: true });
    if (!r.ok) notes.push(`${slug}: НЕ сохранён (HTTP ${r.status} ${(r.json && (r.json.code || r.json.error)) || ''})`);
    else notes.push(`${slug}: сохранён`);
  }
  const failed = notes.some((n) => n.includes('НЕ сохранён'));
  const msg = [(DRY ? '(dry-run) ' : '') + (created ? 'Студент создан' : 'Студент уже был в группе'), ...notes, ...sp.warnings].join('; ');
  return { status: failed ? 'error' : created ? 'created' : 'duplicate', message: msg, bz_student_id: studentId, bz_username: username };
}


const API = { digits, clean, normName, iinValid, maskIin, fmtPhone, stableUuid, academicYearNow, observationPeriod,
  buildSocialAnswers, buildObservationAnswers, parseStudent, buildBulk, regionOf, normLetter, visible, isEmpty, resolveClass, processRow };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else globalThis.BalazhanCore = API;
