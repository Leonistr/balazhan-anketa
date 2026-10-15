/* Анкета студента для родителей — логика формы. Без зависимостей. */
(function () {
  'use strict';
  var S = window.ANKETA_SCHEMA, CFG = window.ANKETA_CONFIG || {};
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var form = $('#form');

  // ---------- group from URL (?g=T110 | ?g=PO306) ----------
  var params = new URLSearchParams(location.search);
  var gRaw = (params.get('g') || params.get('group') || '').toUpperCase().replace(/[^A-ZА-Я0-9]/g, '');
  var LAT = { 'Т': 'T', 'П': 'P', 'О': 'O' };
  gRaw = gRaw.replace(/[ТПО]/g, function (c) { return LAT[c]; });
  var GROUP = S.groups[gRaw];
  if (!GROUP) { $('#groupError').hidden = false; $('#groupBadge').textContent = 'Группа не указана'; return; }
  $('#groupBadge').textContent = GROUP.title;
  if (CFG.CURATOR_NOTE) $('#intro').textContent = CFG.CURATOR_NOTE;
  document.title = 'Анкета студента · ' + GROUP.title;
  var ENDPOINT = (CFG.ENDPOINT_URL || '').trim();
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(ENDPOINT)) $('#configWarning').hidden = false;
  form.hidden = false;

  // ---------- build dynamic sections from the official form schema ----------
  var SECTION_TITLE = {
    'Сведения о родителях': 'Родители и место проживания',
    'Состав семьи': 'Состав семьи',
    'Социальные категории': 'Социальные категории',
    'Относится к следующим категориям обучающихся и воспитанников': 'Льготы и государственные услуги',
    'Относится к получателям следующих государственных услуг': 'Льготы и государственные услуги'
  };
  var FIELDS = {};
  var NUM_CHILD = ['childBirthOrder', 'childrenAdult', 'childrenSchoolAge', 'childrenPreschool'];
  var NONE_OPTION = { studentCategories: 'student_category_none', governmentServices: 'service_none' };
  var host = $('#dynamicSections');
  var lastTitle = null, card = null, childGrid = null;
  S.sections.forEach(function (sec) {
    var title = SECTION_TITLE[sec.title] || sec.title;
    if (title !== lastTitle) {
      card = el('section', { className: 'card' }); card.appendChild(el('h2', { textContent: title }));
      host.appendChild(card); lastTitle = title;
    }
    sec.fields.forEach(function (f) {
      FIELDS[f.key] = f;
      var node = renderField(f);
      if (NUM_CHILD.indexOf(f.key) >= 0) {
        if (!childGrid) {
          childGrid = el('div', { className: 'sub', id: 'childrenBlock' });
          childGrid.appendChild(el('div', { className: 'grid2', id: 'childrenGrid' }));
          childGrid.appendChild(el('div', { className: 'hint', id: 'childrenSum' }));
          card.appendChild(childGrid);
        }
        $('#childrenGrid', childGrid).appendChild(node);
      } else card.appendChild(node);
    });
  });

  function el(tag, props) { var n = document.createElement(tag); Object.keys(props || {}).forEach(function (k) { n[k] = props[k]; }); return n; }

  function renderField(f) {
    var wrap = el('div', { className: 'field' }); wrap.dataset.key = f.key;
    var id = 'f-' + f.key;
    var lab = el(f.type === 'single' || f.type === 'multiple' ? 'span' : 'label', { className: 'label' });
    if (lab.tagName === 'LABEL') lab.htmlFor = id;
    lab.textContent = f.label + ' ';
    var req = el('b', { className: 'req', textContent: '*' }); req.hidden = !isRequiredStatic(f); lab.appendChild(req);
    wrap.appendChild(lab);
    if (f.type === 'text' || f.type === 'phone' || f.type === 'number') {
      var inp = el('input', { id: id, name: f.key, type: f.type === 'phone' ? 'tel' : 'text', maxLength: f.type === 'text' ? 300 : 20 });
      if (f.type === 'number') { inp.inputMode = 'numeric'; inp.pattern = '[0-9]*'; inp.maxLength = 2; inp.placeholder = '0'; }
      if (f.type === 'phone') { inp.inputMode = 'tel'; inp.placeholder = '+7 700 000 00 00'; inp.autocomplete = 'tel'; }
      if (f.placeholder) inp.placeholder = f.placeholder;
      wrap.appendChild(inp);
    } else {
      var box = el('div', { className: 'choices' });
      f.options.forEach(function (o) {
        var c = el('label', { className: 'choice' });
        var i = el('input', { type: f.type === 'single' ? 'radio' : 'checkbox', name: f.key, value: o.value });
        i.dataset.label = o.label; if (o.other) i.dataset.other = '1';
        c.appendChild(i); c.appendChild(el('span', { textContent: o.label }));
        box.appendChild(c);
      });
      wrap.appendChild(box);
      if (f.options.some(function (o) { return o.other; })) {
        var oi = el('input', { type: 'text', name: f.key + '__other', className: 'other-input', maxLength: 300,
          placeholder: f.key === 'nationality' ? 'Выберите или впишите национальность' : 'Уточните' });
        oi.hidden = true;
        if (f.suggestions) {
          var dl = el('datalist', { id: f.key + '-suggestions' });
          f.suggestions.forEach(function (s) { dl.appendChild(el('option', { value: s })); });
          oi.setAttribute('list', dl.id); wrap.appendChild(dl);
        }
        wrap.appendChild(oi);
      }
    }
    if (f.help) wrap.appendChild(el('div', { className: 'hint', textContent: f.help }));
    return wrap;
  }

  function isRequiredStatic(f) { return !!f.required; }

  // countries
  var csel = $('#f-country');
  S.countries.forEach(function (c) { csel.appendChild(el('option', { value: c.code, textContent: c.name })); });
  $('#f-birthDate').max = new Date().toISOString().slice(0, 10);
  // family type default as on the site
  var ft = $('input[name=familyType][value=full]'); if (ft) ft.checked = true;

  // ---------- helpers ----------
  function val(name) { var n = form.elements[name]; if (!n) return ''; if (n.type === 'checkbox') return n.checked; return (n.value || '').trim(); }
  function checked(name) { return $$('input[name="' + name + '"]:checked'); }
  function selValues(name) { return checked(name).map(function (i) { return i.value; }); }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function iinValid(s) {
    if (!/^\d{12}$/.test(s)) return false;
    var n = s.split('').map(Number), w1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
    var sum = function (w) { var t = 0; for (var i = 0; i < 11; i++) t += n[i] * w[i]; return t % 11; };
    var c = sum(w1); if (c === 10) c = sum(w2);
    return c !== 10 && c === n[11];
  }
  function iinInfo(s) {
    if (!/^\d{12}$/.test(s)) return null;
    var cent = { 1: 1800, 2: 1800, 3: 1900, 4: 1900, 5: 2000, 6: 2000 }[s[6]];
    if (!cent) return null;
    var y = cent + Number(s.slice(0, 2)), m = Number(s.slice(2, 4)), d = Number(s.slice(4, 6));
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return { date: ('0' + d).slice(-2) + '.' + ('0' + m).slice(-2) + '.' + y, gender: Number(s[6]) % 2 ? 'Мальчик' : 'Девочка' };
  }
  function fmtPhone(v) {
    var d = digits(v);
    if (!d) return '';
    if (d[0] === '8') d = '7' + d.slice(1);
    if (d[0] !== '7') d = '7' + d;
    d = d.slice(0, 11);
    var out = '+7';
    if (d.length > 1) out += ' ' + d.slice(1, 4);
    if (d.length > 4) out += ' ' + d.slice(4, 7);
    if (d.length > 7) out += ' ' + d.slice(7, 9);
    if (d.length > 9) out += ' ' + d.slice(9, 11);
    return out;
  }
  function phoneOk(v) { var d = digits(v); return d.length === 11 && d[0] === '7' && /[67]/.test(d[1]); }

  // ---------- dynamic behaviour ----------
  form.addEventListener('input', onChange);
  form.addEventListener('change', onChange);
  function onChange(e) {
    var t = e && e.target;
    if (t) {
      if (t.name === 'iin') { var p = digits(t.value).slice(0, 12); if (p !== t.value) t.value = p; }
      if (t.type === 'tel') { var pos = fmtPhone(t.value); if (e.type === 'input' && pos !== t.value) t.value = pos; }
      if (FIELDS[t.name] && FIELDS[t.name].type === 'number') { var nd = digits(t.value).slice(0, 2); if (nd !== t.value) t.value = nd; }
      if (t.type === 'checkbox' && t.checked && t.name === 'incompleteReason') {
        var ex = { father_deceased: 'mother_deceased', mother_deceased: 'father_deceased' }[t.value];
        if (ex) { var o = $('input[name=incompleteReason][value=' + ex + ']'); if (o) o.checked = false; }
      }
      if (t.type === 'checkbox' && t.checked && NONE_OPTION[t.name]) {
        var none = NONE_OPTION[t.name];
        $$('input[name="' + t.name + '"]').forEach(function (i) { if (t.value === none ? i.value !== none : i.value === none) i.checked = false; });
      }
      var fw = t.closest && t.closest('.field'); if (fw) clearErr(fw);
    }
    refresh();
    saveDraft();
  }

  function refresh() {
    var foreign = $('#f-foreign').checked;
    $('#foreignBlock').hidden = !foreign;
    $('#iinReq').hidden = foreign;
    $('#iinHint').textContent = foreign ? 'Если у студента есть ИИН — обязательно укажите.' : '12 цифр, указан в удостоверении личности студента.';
    var iin = val('iin');
    if (iin.length === 12) {
      var info = iinInfo(iin);
      if (!iinValid(iin)) $('#iinHint').innerHTML = '<span class="sum-bad">ИИН введён с ошибкой — проверьте цифры.</span>';
      else if (info) {
        $('#iinHint').innerHTML = '<span class="sum-ok">✓ ИИН корректный · дата рождения ' + info.date + '</span>';
        if (!checked('gender').length) { var gi = $('input[name=gender][value="' + info.gender + '"]'); if (gi) gi.checked = true; }
      }
    }
    // other inputs
    Object.keys(FIELDS).forEach(function (k) {
      var oi = form.elements[k + '__other'];
      if (oi) { var on = checked(k).some(function (i) { return i.dataset.other; }); oi.hidden = !on; }
    });
    // showIf
    Object.keys(FIELDS).forEach(function (k) {
      var f = FIELDS[k]; if (!f.showIf) return;
      var vis = isVisible(f);
      var w = $('.field[data-key="' + k + '"]'); if (w) w.hidden = !vis;
    });
    var cnt = val('childrenCount');
    $('#childrenBlock').hidden = !cnt;
    if (cnt) {
      var a = Number(val('childrenAdult') || 0), b = Number(val('childrenSchoolAge') || 0), c = Number(val('childrenPreschool') || 0);
      var filled = val('childrenAdult') !== '' && val('childrenSchoolAge') !== '' && val('childrenPreschool') !== '';
      var sum = a + b + c, n = Number(cnt);
      $('#childrenSum').innerHTML = filled ? (sum === n ? '<span class="sum-ok">✓ Сумма по возрастам: ' + sum + ' из ' + n + '</span>' : '<span class="sum-bad">Сумма по возрастам: ' + sum + ', а всего детей ' + n + '</span>') : 'Сумма трёх полей должна равняться общему числу детей (' + n + ').';
    }
    // conditional required marks
    reqMark('fatherEducation', !!val('fatherName'));
    reqMark('motherEducation', !!val('motherName'));
    reqMark('incompleteReason', true);
    reqMark('attentionChildrenReasons', true);
  }
  function reqMark(k, on) { var w = $('.field[data-key="' + k + '"] .req'); if (w) w.hidden = !on; }
  function isVisible(f) {
    if (!f.showIf) return true;
    var dep = FIELDS[f.showIf.questionKey];
    if (dep && dep.type === 'number') return !!val(dep.key);
    var vals = selValues(f.showIf.questionKey);
    if (!f.showIf.value) return vals.length > 0;
    return vals.indexOf(f.showIf.value) >= 0;
  }

  // ---------- validation ----------
  function setErr(key, msg) {
    var w = $('.field[data-key="' + key + '"]'); if (!w) return;
    w.classList.add('invalid');
    var e = $('.err', w); if (!e) { e = el('div', { className: 'err' }); w.appendChild(e); }
    e.textContent = msg;
  }
  function clearErr(w) { w.classList.remove('invalid'); var e = $('.err', w); if (e) e.remove(); }

  function validate() {
    $$('.field.invalid').forEach(clearErr);
    var errs = [];
    function bad(k, m) { errs.push([k, m]); setErr(k, m); }
    var foreign = $('#f-foreign').checked;
    var name = val('fullName');
    if (name.length < 3) bad('fullName', 'Укажите ФИО студента');
    else if (name.split(/\s+/).length < 2) bad('fullName', 'Укажите фамилию и имя');
    var iin = val('iin');
    if (!foreign || iin) {
      if (!/^\d{12}$/.test(iin)) bad('iin', 'ИИН должен состоять из 12 цифр');
      else if (!iinValid(iin)) bad('iin', 'Некорректный ИИН — проверьте цифры');
    }
    if (!checked('gender').length) bad('gender', 'Выберите пол');
    if (foreign) {
      if (!val('country')) bad('country', 'Выберите страну гражданства');
      var bd = val('birthDate');
      if (!bd || bd < '1900-01-01' || bd > new Date().toISOString().slice(0, 10)) bad('birthDate', 'Укажите дату рождения');
    }
    Object.keys(FIELDS).forEach(function (k) {
      var f = FIELDS[k];
      var w = $('.field[data-key="' + k + '"]');
      if (!isVisible(f) || (w && w.hidden) || (NUM_CHILD.indexOf(k) >= 0 && !val('childrenCount'))) return;
      var required = f.required || (k === 'fatherEducation' && val('fatherName')) || (k === 'motherEducation' && val('motherName')) ||
        k === 'incompleteReason' || k === 'attentionChildrenReasons';
      if (f.type === 'single' || f.type === 'multiple') {
        var sel = checked(k);
        if (required && !sel.length) bad(k, f.type === 'single' ? 'Выберите вариант' : 'Отметьте хотя бы один вариант');
        if (sel.some(function (i) { return i.dataset.other; }) && !val(k + '__other')) bad(k, k === 'nationality' ? 'Впишите национальность' : 'Уточните вариант «Другое»');
      } else if (f.type === 'phone') {
        if (val(k) && !phoneOk(val(k))) bad(k, 'Формат: +7 7XX XXX XX XX');
      } else if (f.type === 'number') {
        if (required && val(k) === '') bad(k, 'Укажите число');
      } else if (required && !val(k)) bad(k, 'Заполните поле');
    });
    if (!val('fatherName') && !val('motherName') && !val('guardianName')) bad('motherName', 'Укажите хотя бы одного родителя или опекуна');
    if (!phoneOk(val('motherPhone')) && !phoneOk(val('fatherPhone'))) bad('motherPhone', 'Укажите телефон матери или отца');
    var cnt = val('childrenCount');
    if (cnt !== '') {
      var n = Number(cnt);
      if (n < 1 || n > 20) bad('childrenCount', 'Укажите число от 1 до 20 (включая студента)');
      var ord = Number(val('childBirthOrder'));
      if (val('childBirthOrder') !== '' && (ord < 1 || ord > n)) bad('childBirthOrder', 'От 1 до ' + n);
      var parts = ['childrenAdult', 'childrenSchoolAge', 'childrenPreschool'];
      if (parts.every(function (p) { return val(p) !== ''; })) {
        var sum = parts.reduce(function (s, p) { return s + Number(val(p)); }, 0);
        if (sum !== n) bad('childrenAdult', 'Сумма по возрастам (' + sum + ') должна равняться числу детей (' + n + ')');
      }
    }
    if (!checked('filledBy').length) bad('filledBy', 'Выберите, кто заполняет');
    if (!$('#f-consent').checked) bad('consent', 'Нужно согласие на обработку персональных данных');
    return errs;
  }

  // ---------- collect ----------
  function collect() {
    var foreign = $('#f-foreign').checked;
    var d = { group_code: GROUP.code, fullName: val('fullName').replace(/\s+/g, ' '), iin: val('iin'),
      gender: (checked('gender')[0] || {}).value || '', foreign: foreign ? 'Да' : 'Нет',
      country: foreign ? val('country') : '', passport: foreign ? val('passport') : '', birthDate: foreign ? val('birthDate') : '',
      filledBy: (checked('filledBy')[0] || {}).value || '', comment: val('comment'), consent: $('#f-consent').checked ? 'Да' : 'Нет',
      website: val('website') };
    if (d.country) { var c = S.countries.filter(function (x) { return x.code === d.country; })[0]; d.country = d.country + (c ? ' — ' + c.name : ''); }
    Object.keys(FIELDS).forEach(function (k) {
      var f = FIELDS[k];
      if (!isVisible(f) || (NUM_CHILD.indexOf(k) >= 0 && !val('childrenCount'))) { d[k] = ''; return; }
      if (f.type === 'single') d[k] = ((checked(k)[0] || {}).dataset || {}).label || '';
      else if (f.type === 'multiple') d[k] = checked(k).map(function (i) { return i.dataset.label; });
      else d[k] = val(k);
      if (form.elements[k + '__other']) d[k + '__other'] = checked(k).some(function (i) { return i.dataset.other; }) ? val(k + '__other') : '';
    });
    return d;
  }

  // ---------- draft ----------
  var DKEY = 'anketa-draft-' + GROUP.code;
  function saveDraft() {
    try {
      var st = {};
      $$('input,select,textarea', form).forEach(function (i) {
        if (!i.name || i.name === 'website') return;
        if (i.type === 'radio' || i.type === 'checkbox') { if (i.checked) (st[i.name] = st[i.name] || []).push(i.value || 'on'); }
        else if (i.value) st[i.name] = i.value;
      });
      localStorage.setItem(DKEY, JSON.stringify(st));
    } catch (e) {}
  }
  function loadDraft() {
    try {
      var st = JSON.parse(localStorage.getItem(DKEY) || 'null'); if (!st) return;
      $$('input,select,textarea', form).forEach(function (i) {
        if (!i.name || !(i.name in st)) { if ((i.type === 'radio' || i.type === 'checkbox') && i.name && st[i.name] === undefined && i.name !== 'familyType') i.checked = false; return; }
        if (i.type === 'radio' || i.type === 'checkbox') i.checked = st[i.name].indexOf(i.value || 'on') >= 0;
        else i.value = st[i.name];
      });
    } catch (e) {}
  }
  loadDraft();
  refresh();

  // ---------- submit ----------
  var sending = false;
  var subId = sessionStorage.getItem('anketa-sub-id') || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  sessionStorage.setItem('anketa-sub-id', subId);
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending) return;
    var box = $('#formErrors'); box.hidden = true;
    var errs = validate();
    if (errs.length) {
      box.hidden = false; box.textContent = 'Проверьте поля, отмеченные красным (' + errs.length + ').';
      var first = $('.field.invalid'); if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(ENDPOINT)) { box.hidden = false; box.textContent = 'Форма ещё не подключена к таблице куратора. Попробуйте позже.'; return; }
    var data = collect(); data.submission_id = subId;
    var payload = JSON.stringify({ action: 'submit', data: data, meta: { ua: navigator.userAgent.slice(0, 200), url: location.href } });
    sending = true; var btn = $('#submitBtn'); btn.disabled = true; btn.textContent = 'Отправляем…';
    send(payload).then(function (res) {
      if (res && res.ok === false) throw new Error(res.message || res.error || 'Ошибка');
      try { localStorage.removeItem(DKEY); } catch (e) {}
      sessionStorage.removeItem('anketa-sub-id');
      form.hidden = true; $('#done').hidden = false;
      if (res && res.result === 'updated') $('#doneText').textContent = 'Анкета с этим ИИН уже была — мы обновили её новыми ответами.';
      if (res && res.result === 'already_received') $('#doneText').textContent = 'Анкета на этого студента уже получена и обработана куратором. Если нужно что-то исправить — сообщите куратору.';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }).catch(function (err) {
      box.hidden = false; box.textContent = 'Не удалось отправить: ' + (err && err.message || err) + '. Проверьте интернет и нажмите «Отправить» ещё раз.';
    }).then(function () { sending = false; btn.disabled = false; btn.textContent = 'Отправить анкету'; });
  });

  function send(body) {
    return fetch(ENDPOINT, { method: 'POST', body: body, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' })
      .then(function (r) { return r.text(); })
      .then(function (t) { try { return JSON.parse(t); } catch (e) { return { ok: true }; } })
      .catch(function () {
        // запасной путь: без чтения ответа (opaque). Сервер всё равно запишет данные и не создаст дубль.
        return fetch(ENDPOINT, { method: 'POST', mode: 'no-cors', body: body, headers: { 'Content-Type': 'text/plain;charset=utf-8' } }).then(function () { return { ok: true }; });
      });
  }

  $('#againBtn').addEventListener('click', function () {
    form.reset(); var ft2 = $('input[name=familyType][value=full]'); if (ft2) ft2.checked = true;
    $$('.field.invalid').forEach(clearErr); refresh();
    $('#done').hidden = true; form.hidden = false; window.scrollTo({ top: 0 });
  });
})();
