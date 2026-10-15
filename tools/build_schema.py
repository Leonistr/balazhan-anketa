#!/usr/bin/env python3
"""Generates js/schema.js and apps-script header list from the official balazhan
form definitions (GET https://balazhan.nedb.kz/api/forms/social-passport, public).
Re-run after the site changes its form:  python3 tools/build_schema.py"""
import json, pathlib, re
ROOT = pathlib.Path(__file__).resolve().parent.parent
sp = json.load(open(ROOT/'data/form-social-passport.json', encoding='utf-8'))
countries = json.load(open(ROOT/'data/countries.json', encoding='utf-8'))
Q = {q['key']: q for q in sp['questions']}
HIDDEN_ON_SITE = {'fatherStudyPlace', 'motherStudyPlace', 'parentsEducation'}
NAT_SUGGEST = ["Русский","Узбек","Украинец","Уйгур","Немец","Татарин","Азербайджанец","Кореец","Турок","Дунганин","Белорус","Таджик","Курд","Поляк","Кыргыз","Чеченец","Ингуш","Башкир","Армянин"]

# sheet header overrides (short, readable)
HEADER = {
  'phone': 'Телефон студента',
  'livesWith': 'Проживает с (отчим / мачеха / сожитель родителя)',
  'childBirthOrder': 'Которым по счёту ребёнком является',
  'childrenAdult': 'Из них совершеннолетних',
  'childrenSchoolAge': 'Из них школьного возраста',
  'childrenPreschool': 'Из них дошкольного возраста',
  'studentCategories': 'Категории обучающихся',
  'governmentServices': 'Получатель госуслуг',
  'attentionChildrenReasons': 'Основания повышенного внимания',
}
# parent-form display label overrides (site label kept where it is clear)
LABEL = {'phone': 'Телефон студента', 'guardianName': 'Опекун / попечитель (ФИО)', 'fatherName': 'Отец (ФИО)', 'motherName': 'Мать (ФИО)'}
PLACEHOLDER = {'fatherName':'Фамилия Имя Отчество','motherName':'Фамилия Имя Отчество','guardianName':'Если есть опекун','address':'Город, улица, дом, квартира',
  'fatherWorkplace':'Организация, должность (или «не работает»)','motherWorkplace':'Организация, должность (или «не работает»)','guardianWorkplace':'Если есть опекун'}
# required in the parent form (site itself marks none required except familyType)
REQUIRED = {'nationality','address','residenceLocality','housingType','familyType','childrenCount','childBirthOrder','childrenAdult','childrenSchoolAge','childrenPreschool','studentCategories','governmentServices'}
HELP = {
  'motherPhone':'Формат: +7 7XX XXX XX XX. Нужен хотя бы один телефон родителя.',
  'fatherPhone':'Формат: +7 7XX XXX XX XX',
  'phone':'Формат: +7 7XX XXX XX XX (если есть)',
  'socialCategories':'Отметьте все подходящие. Если ничего не подходит — оставьте пустым.',
  'childrenCount':'Включая самого студента.',
  'childrenAdult':'Сумма трёх полей ниже должна равняться общему числу детей.',
  'studentCategories':'Отметьте подходящее. Если не относится — последний пункт.',
  'governmentServices':'Если не получаете — последний пункт.',
}

def opt(o): return {'value': o['value'], 'label': o['labelRu'], 'other': bool(o.get('allowsOther'))}

sections = []
cur = None
fields = []
for q in sorted(sp['questions'], key=lambda q: q['order']):
    if q['key'] in HIDDEN_ON_SITE: continue
    sec = q.get('sectionRu') or ''
    if not cur or cur['title'] != sec:
        cur = {'title': sec, 'fields': []}; sections.append(cur)
    f = {'key': q['key'], 'type': q['type'], 'label': LABEL.get(q['key'], q['labelRu']),
         'siteLabel': q['labelRu'], 'required': q['key'] in REQUIRED,
         'help': HELP.get(q['key'], (q.get('helpRu') if q['type'] in ('text','phone','number') and q.get('helpRu') and 'Появляется' not in (q.get('helpRu') or '') else '') or ''),
         'header': HEADER.get(q['key'], q['labelRu'])}
    if q['key'] in PLACEHOLDER: f['placeholder'] = PLACEHOLDER[q['key']]
    if q.get('options'): f['options'] = [opt(o) for o in sorted(q['options'], key=lambda o: o['order'])]
    if q.get('showIf'): f['showIf'] = q['showIf']
    if q['key'] == 'nationality': f['suggestions'] = NAT_SUGGEST
    if q['key'] == 'incompleteReason': f['exclusive'] = [['father_deceased','mother_deceased']]
    cur['fields'].append(f); fields.append(f)

# Sheet columns: order matters only for readability; Code.gs / worker address columns by header text.
COLS = [
  ('received_at','Получено'), ('updated_at','Обновлено'), ('group_code','Код группы'), ('course','Курс'), ('group','Группа'),
  ('fullName','ФИО студента'), ('iin','ИИН'), ('gender','Пол'), ('foreign','Иностранный гражданин'),
  ('country','Страна гражданства'), ('passport','Паспорт'), ('birthDate','Дата рождения'),
]
for f in fields:
    COLS.append((f['key'], f['header']))
    if any(o['other'] for o in f.get('options', [])):
        COLS.append((f['key'] + '__other', f['header'] + ' — уточнение'))
COLS += [('filledBy','Кто заполнил'), ('comment','Комментарий родителя'), ('consent','Согласие на обработку ПД'),
  ('status','Статус'), ('status_at','Дата статуса'), ('bz_username','Логин студента (Balazhan)'), ('bz_student_id','ID студента (Balazhan)'),
  ('message','Сообщение обработчика'), ('dup_count','Повторных отправок'), ('last_dup_at','Последняя повторная отправка'), ('submission_id','ID заявки')]

GROUPS = {
  'T110': {'code':'T110','course':1,'courseLabel':'1 курс','group':'Т110','title':'1 курс · Т110'},
  'PO306': {'code':'PO306','course':3,'courseLabel':'3 курс','group':'ПО306','title':'3 курс · ПО306'},
}
schema = {'version': sp['version'], 'groups': GROUPS, 'sections': sections, 'columns': [{'key':k,'header':h} for k,h in COLS],
          'countries': sorted([{'code':c,'name':n} for c,n in countries.items()], key=lambda x: x['name'])}
out = ROOT/'js/schema.js'
out.write_text('/* Generated by tools/build_schema.py from the official balazhan social-passport form v%s. Do not edit by hand. */\nwindow.ANKETA_SCHEMA = %s;\n' % (sp['version'], json.dumps(schema, ensure_ascii=False, indent=1)), encoding='utf-8')
json.dump(schema, open(ROOT/'data/schema.json','w',encoding='utf-8'), ensure_ascii=False, indent=1)
# Code.gs columns block
gs = ROOT/'apps-script/Code.gs'
if gs.exists():
    src = gs.read_text(encoding='utf-8')
    block = 'var COLUMNS = ' + json.dumps([[k,h] for k,h in COLS], ensure_ascii=False) + ';'
    src = re.sub(r'var COLUMNS = .*?;\n', lambda m: block + '\n', src, count=1, flags=re.S)
    block2 = 'var GROUPS = ' + json.dumps(GROUPS, ensure_ascii=False) + ';'
    src = re.sub(r'var GROUPS = .*?;\n', lambda m: block2 + '\n', src, count=1, flags=re.S)
    gs.write_text(src, encoding='utf-8')
print(len(COLS), 'columns;', len(fields), 'fields')
print('\t'.join(h for _,h in COLS))
