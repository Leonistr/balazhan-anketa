/**
 * Анкеты родителей — Balazhan
 * Google Apps Script web app, привязанный к таблице «Анкеты родителей — Balazhan».
 *
 * Что делает:
 *  1) Принимает анкету с сайта-формы (POST, тело — JSON в text/plain) и пишет строку в лист «Ответы».
 *     Защита от дублей: ключ — ИИН (для иностранцев без ИИН — паспорт или ФИО+дата рождения).
 *       • если строка с таким ключом ещё НЕ создана в Balazhan (статус new/error) — строка ОБНОВЛЯЕТСЯ
 *         новыми данными (новая строка не добавляется), счётчик «Повторных отправок» +1;
 *       • если студент уже создан (created/duplicate/processing) — данные не трогаются, только счётчик +1.
 *  2) Отдаёт обработчику (worker) новые строки и принимает от него статусы — только с секретом
 *     WORKER_TOKEN из листа «Настройки» (ячейка B2).
 *
 * Развёртывание: Расширения → Apps Script → вставить этот файл → Развернуть → Новое развертывание →
 *   тип «Веб-приложение», «Выполнять от имени: Я», «У кого есть доступ: Все» → скопировать URL /exec.
 */

var SHEET_ANSWERS = 'Ответы';
var SHEET_SETTINGS = 'Настройки';
// [key, header]. Генерируется tools/build_schema.py — порядок колонок в таблице может быть любым,
// скрипт ищет колонки по тексту заголовка.
var COLUMNS = [["received_at", "Получено"], ["updated_at", "Обновлено"], ["group_code", "Код группы"], ["course", "Курс"], ["group", "Группа"], ["fullName", "ФИО студента"], ["iin", "ИИН"], ["gender", "Пол"], ["foreign", "Иностранный гражданин"], ["country", "Страна гражданства"], ["passport", "Паспорт"], ["birthDate", "Дата рождения"], ["nationality", "Национальность"], ["nationality__other", "Национальность — уточнение"], ["fatherName", "Отец"], ["motherName", "Мать"], ["guardianName", "Опекун / попечитель"], ["fatherEducation", "Образование отца"], ["fatherEducation__other", "Образование отца — уточнение"], ["motherEducation", "Образование матери"], ["motherEducation__other", "Образование матери — уточнение"], ["fatherWorkplace", "Место работы отца"], ["motherWorkplace", "Место работы матери"], ["guardianWorkplace", "Место работы опекуна"], ["address", "Адрес проживания"], ["residenceLocality", "Место проживания"], ["housingType", "Тип жилья"], ["housingType__other", "Тип жилья — уточнение"], ["motherPhone", "Телефон матери"], ["fatherPhone", "Телефон отца"], ["phone", "Телефон студента"], ["familyType", "Состав семьи"], ["incompleteReason", "Наличие родителей"], ["livesWith", "Проживает с (отчим / мачеха / сожитель родителя)"], ["childrenCount", "Количество детей в семье"], ["childBirthOrder", "Которым по счёту ребёнком является"], ["childrenAdult", "Из них совершеннолетних"], ["childrenSchoolAge", "Из них школьного возраста"], ["childrenPreschool", "Из них дошкольного возраста"], ["socialCategories", "Социальные категории"], ["attentionChildrenReasons", "Основания повышенного внимания"], ["studentCategories", "Категории обучающихся"], ["governmentServices", "Получатель госуслуг"], ["filledBy", "Кто заполнил"], ["comment", "Комментарий родителя"], ["consent", "Согласие на обработку ПД"], ["status", "Статус"], ["status_at", "Дата статуса"], ["bz_username", "Логин студента (Balazhan)"], ["bz_student_id", "ID студента (Balazhan)"], ["message", "Сообщение обработчика"], ["dup_count", "Повторных отправок"], ["last_dup_at", "Последняя повторная отправка"], ["submission_id", "ID заявки"]];
var GROUPS = {"T110": {"code": "T110", "course": 1, "courseLabel": "1 курс", "group": "Т110", "title": "1 курс · Т110"}, "PO306": {"code": "PO306", "course": 3, "courseLabel": "3 курс", "group": "ПО306", "title": "3 курс · ПО306"}};
var WORKER_EDITABLE = ['status', 'status_at', 'bz_username', 'bz_student_id', 'message'];
var LOCKED_STATUSES = ['created', 'duplicate', 'processing'];

function doGet(e) {
  return json_({ ok: true, service: 'balazhan-anketa', time: now_() });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }
  try {
    var action = body.action || 'submit';
    if (action === 'submit') return json_(submit_(body.data || {}, body.meta || {}));
    // ---- worker API ----
    if (!checkToken_(body.token)) return json_({ ok: false, error: 'forbidden' });
    if (action === 'list') return json_(list_(body.statuses || ['new']));
    if (action === 'claim') return json_(claim_(body.row, body.key));
    if (action === 'update') return json_(update_(body.row, body.key, body.fields || {}));
    if (action === 'ping') return json_({ ok: true, columns: COLUMNS.length });
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ---------------------------------------------------------------- submit
function submit_(d, meta) {
  if (d.website) return { ok: true }; // honeypot: боты заполняют скрытое поле
  var v = validate_(d);
  if (v) return { ok: false, error: 'validation', message: v };
  var g = GROUPS[d.group_code];
  d.course = g.courseLabel;
  d.group = g.group;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_();
    var cols = headerMap_(sh);
    var key = dedupKey_(d);
    var found = findByKey_(sh, cols, key);
    var ts = now_();
    if (found) {
      var status = String(found.values[cols.status] || '').trim();
      var dup = Number(found.values[cols.dup_count] || 0) + 1;
      if (LOCKED_STATUSES.indexOf(status) >= 0) {
        setCells_(sh, cols, found.row, { dup_count: String(dup), last_dup_at: ts });
        return { ok: true, result: 'already_received', status: status };
      }
      var upd = rowFromData_(d);
      upd.updated_at = ts; upd.dup_count = String(dup); upd.last_dup_at = ts;
      upd.status = 'new'; upd.message = 'Обновлено повторной отправкой ' + ts;
      setCells_(sh, cols, found.row, upd);
      return { ok: true, result: 'updated' };
    }
    var rec = rowFromData_(d);
    rec.received_at = ts; rec.updated_at = ts; rec.status = 'new'; rec.status_at = ts;
    rec.dup_count = '0'; rec.submission_id = String(d.submission_id || Utilities.getUuid());
    var lastCol = sh.getLastColumn();
    var arr = [];
    for (var c = 0; c < lastCol; c++) arr.push('');
    Object.keys(rec).forEach(function (k) { if (cols[k] !== undefined) arr[cols[k]] = rec[k]; });
    var r = sh.getLastRow() + 1;
    var range = sh.getRange(r, 1, 1, lastCol);
    range.setNumberFormat('@'); // ИИН и телефоны — как текст (ведущие нули!)
    range.setValues([arr]);
    return { ok: true, result: 'created' };
  } finally {
    lock.releaseLock();
  }
}

function rowFromData_(d) {
  var out = {};
  COLUMNS.forEach(function (c) {
    var k = c[0];
    if (WORKER_EDITABLE.indexOf(k) >= 0 || ['received_at', 'updated_at', 'dup_count', 'last_dup_at', 'submission_id'].indexOf(k) >= 0) return;
    var val = d[k];
    if (val === undefined || val === null) val = '';
    if (Object.prototype.toString.call(val) === '[object Array]') val = val.join('; ');
    out[k] = String(val).slice(0, 2000);
  });
  return out;
}

function validate_(d) {
  if (!GROUPS[d.group_code]) return 'Неизвестная группа';
  var name = String(d.fullName || '').trim();
  if (name.length < 3 || name.length > 200) return 'Укажите ФИО студента';
  var foreign = d.foreign === 'Да';
  var iin = String(d.iin || '').replace(/\D/g, '');
  if (iin || !foreign) {
    if (!iinValid_(iin)) return 'Некорректный ИИН';
    d.iin = iin;
  }
  if (foreign && !d.birthDate) return 'Укажите дату рождения';
  if (['Мальчик', 'Девочка'].indexOf(d.gender) < 0) return 'Укажите пол';
  if (d.consent !== 'Да') return 'Нужно согласие на обработку персональных данных';
  return '';
}

function iinValid_(s) {
  if (!/^\d{12}$/.test(s)) return false;
  var n = s.split('').map(Number);
  var w1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
  var sum = function (w) { var t = 0; for (var i = 0; i < 11; i++) t += n[i] * w[i]; return t % 11; };
  var c = sum(w1);
  if (c === 10) c = sum(w2);
  return c !== 10 && c === n[11];
}

function dedupKey_(d) {
  var iin = String(d.iin || '').replace(/\D/g, '');
  if (iin) return 'IIN:' + iin;
  var p = String(d.passport || '').replace(/\s/g, '').toUpperCase();
  if (p) return 'PASS:' + p;
  return 'NAME:' + normName_(d.fullName) + '|' + String(d.birthDate || '');
}

function normName_(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function findByKey_(sh, cols, key) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var data = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getDisplayValues();
  for (var i = data.length - 1; i >= 0; i--) {
    var row = {};
    COLUMNS.forEach(function (c) { if (cols[c[0]] !== undefined) row[c[0]] = data[i][cols[c[0]]]; });
    if (dedupKey_(row) === key) return { row: i + 2, values: data[i] };
  }
  return null;
}

// ---------------------------------------------------------------- worker API
function list_(statuses) {
  var sh = sheet_();
  var cols = headerMap_(sh);
  var last = sh.getLastRow();
  var rows = [];
  if (last >= 2) {
    var data = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getDisplayValues();
    for (var i = 0; i < data.length; i++) {
      var st = String(data[i][cols.status] || '').trim() || 'new';
      if (statuses.indexOf(st) < 0 && statuses.indexOf('*') < 0) continue;
      if (!String(data[i][cols.fullName] || '').trim()) continue;
      var obj = { _row: i + 2 };
      COLUMNS.forEach(function (c) { if (cols[c[0]] !== undefined) obj[c[0]] = data[i][cols[c[0]]]; });
      obj.status = st;
      obj._key = dedupKey_(obj);
      rows.push(obj);
    }
  }
  return { ok: true, rows: rows, groups: GROUPS };
}

// Помечает строку «processing», чтобы два обработчика не создали одного студента дважды.
function claim_(row, key) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_(), cols = headerMap_(sh);
    var vals = sh.getRange(row, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    var obj = {};
    COLUMNS.forEach(function (c) { if (cols[c[0]] !== undefined) obj[c[0]] = vals[cols[c[0]]]; });
    if (dedupKey_(obj) !== key) return { ok: false, error: 'row_changed' };
    var st = String(obj.status || '').trim() || 'new';
    if (st !== 'new') return { ok: false, error: 'not_new', status: st };
    setCells_(sh, cols, row, { status: 'processing', status_at: now_(), message: 'Обрабатывается…' });
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function update_(row, key, fields) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_(), cols = headerMap_(sh);
    var vals = sh.getRange(row, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    var obj = {};
    COLUMNS.forEach(function (c) { if (cols[c[0]] !== undefined) obj[c[0]] = vals[cols[c[0]]]; });
    if (key && dedupKey_(obj) !== key) return { ok: false, error: 'row_changed' };
    var upd = {};
    Object.keys(fields).forEach(function (k) { if (WORKER_EDITABLE.indexOf(k) >= 0) upd[k] = String(fields[k]); });
    upd.status_at = now_();
    setCells_(sh, cols, row, upd);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- helpers
function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_ANSWERS);
  if (!sh) sh = ss.insertSheet(SHEET_ANSWERS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS.map(function (c) { return c[1]; })]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function headerMap_(sh) {
  var lastCol = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var byHeader = {};
  head.forEach(function (h, i) { byHeader[String(h).trim()] = i; });
  var map = {};
  var missing = [];
  COLUMNS.forEach(function (c) {
    if (byHeader[c[1]] !== undefined) map[c[0]] = byHeader[c[1]];
    else missing.push(c[1]);
  });
  if (missing.length) { // добавляем недостающие колонки в конец
    sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    return headerMap_(sh);
  }
  return map;
}

function setCells_(sh, cols, row, obj) {
  Object.keys(obj).forEach(function (k) {
    if (cols[k] === undefined) return;
    var cell = sh.getRange(row, cols[k] + 1);
    cell.setNumberFormat('@');
    cell.setValue(obj[k]);
  });
}

function checkToken_(t) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var st = ss.getSheetByName(SHEET_SETTINGS);
  if (!st || !t) return false;
  var data = st.getRange(1, 1, Math.max(st.getLastRow(), 1), 2).getDisplayValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === 'WORKER_TOKEN') return String(data[i][1]).trim() !== '' && String(data[i][1]).trim() === String(t).trim();
  }
  return false;
}

function now_() {
  return Utilities.formatDate(new Date(), 'Asia/Almaty', 'yyyy-MM-dd HH:mm:ss');
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** Запустите вручную один раз из редактора, чтобы выдать скрипту доступ к таблице и проверить заголовки. */
function setup() {
  var sh = sheet_();
  headerMap_(sh);
  sh.getRange('A:BZ').setNumberFormat('@');
  Logger.log('OK: колонок ' + COLUMNS.length);
}
