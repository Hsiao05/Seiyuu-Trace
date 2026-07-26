const API = 'https://api.bgm.tv';
const DATA_SCHEMA = 6;
const ROLE = {
  main: { label: '主角', weight: 4 },
  support: { label: '配角', weight: 2 },
  guest: { label: '客串', weight: 1 },
  minor: { label: '闲角', weight: 0.5 }
};
const ROLE_ORDER = ['main', 'support', 'guest', 'minor'];
const today = new Date();

const state = {
  anime: [],
  actors: [],
  characters: [],
  manualActors: [],
  source: 'Waiting for import',
  collectionScope: 'watched',
  view: 'stats',
  mode: 'weighted',
  role: 'all',
  query: '',
  characterQuery: '',
  characterRole: 'all',
  characterGender: 'all',
  characterSubject: 'all',
  actorLibraryQuery: '',
  actorLibraryGender: 'all',
  actorLibrarySubject: 'all',
  libraryQuery: '',
  calendarQuery: '',
  calendarView: 'month',
  calendarEntity: 'all',
  calendarYear: today.getFullYear(),
  calendarMonth: today.getMonth(),
  characterLibraryLoaded: false,
  actorLibraryLoaded: false,
  controller: null
};

let recapIndex = 0;
let recapTimer = null;
let recapPlaying = true;
let needsCacheUpgrade = false;
let characterDetailPromise = null;
let actorDetailPromise = null;
let birthdayProfilePromise = null;
let subjectDetailPromise = null;
let calendarPointerStart = null;
let sidebarPointerStart = null;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));
const placeholder = (name = '?') => `https://ui-avatars.com/api/?name=${encodeURIComponent(name.slice(0, 2))}&background=e4f4f0&color=278d7d&size=128`;
const animeById = id => state.anime.find(item => String(item.id) === String(id));
const characterById = id => state.characters.find(item => String(item.id) === String(id));
const actorById = id => [...state.actors, ...state.manualActors].find(item => String(item.id) === String(id));
const unique = values => [...new Set(values.filter(Boolean))];

function flattenInfoValue(value) {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.v || item.value || item.k || '';
      return String(item ?? '');
    }).filter(Boolean);
  }
  if (value && typeof value === 'object') return [value.v || value.value || value.k || ''].filter(Boolean);
  return value == null ? [] : [String(value)];
}

function infoEntries(infobox = []) {
  return infobox.map(item => ({
    key: String(item.key || '').trim(),
    values: flattenInfoValue(item.value)
  })).filter(item => item.key && item.values.length);
}

function infoValue(entries, keys) {
  const wanted = keys.map(key => key.toLowerCase());
  const found = entries.find(item => wanted.includes(item.key.toLowerCase()));
  return found?.values.join('、') || '';
}

function aliasData(infobox = []) {
  const aliases = [];
  let kana = '';
  let romaji = '';
  let english = '';
  for (const item of infobox) {
    const key = String(item.key || '').trim();
    if (!/别名|別名|alias/i.test(key)) continue;
    const values = Array.isArray(item.value) ? item.value : [item.value];
    for (const entry of values) {
      const label = String(entry?.k || '').trim();
      const value = String(entry?.v ?? entry ?? '').trim();
      if (!value) continue;
      aliases.push(value);
      if (/假名|かな|kana/i.test(label)) kana ||= value;
      if (/罗马|羅馬|roman|romaji/i.test(label)) romaji ||= value;
      if (/英文|english/i.test(label)) english ||= value;
    }
  }
  return { aliases: unique(aliases), kana, romaji, english };
}

function normalizeGender(gender, entries = []) {
  const value = String(gender || infoValue(entries, ['性别', '性別']) || '').toLowerCase();
  if (value === 'male' || value.includes('男')) return 'male';
  if (value === 'female' || value.includes('女')) return 'female';
  return 'other';
}

function normalizeBlood(value, entries) {
  const fromInfo = infoValue(entries, ['血型']);
  if (fromInfo) return fromInfo;
  const map = { 1: 'A型', 2: 'B型', 3: 'AB型', 4: 'O型' };
  return map[value] || '';
}

function normalizeSubject(raw) {
  const subject = raw.subject || raw;
  const entries = infoEntries(subject.infobox || []);
  const alias = aliasData(subject.infobox || []);
  const nameCn = String(subject.name_cn || '').trim();
  const originalName = String(subject.name || '').trim();
  return {
    id: subject.id,
    name: nameCn || originalName || `#${subject.id}`,
    nameCn,
    originalName,
    aliases: alias.aliases,
    kana: alias.kana,
    romaji: alias.romaji,
    english: alias.english,
    date: String(subject.date || '').slice(0, 4),
    image: subject.images?.large || subject.images?.common || subject.images?.medium || '',
    infoEntries: entries,
    detailLoaded: Boolean(subject.infobox)
  };
}

function mapRole(item) {
  const relation = String(item.relation || '').trim().toLowerCase();
  if (/主角|main(?: character)?/.test(relation)) return 'main';
  if (/配角|support(?:ing)?(?: character)?/.test(relation)) return 'support';
  if (/客串|guest|cameo/.test(relation)) return 'guest';
  return 'minor';
}

function bestRole(roles) {
  return ROLE_ORDER.find(role => roles.includes(role)) || 'minor';
}

function applyCharacterBirthday(character, detail) {
  const entries = infoEntries(detail.infobox || []);
  const alias = aliasData(detail.infobox || []);
  const nameCn = infoValue(entries, ['简体中文名', '簡體中文名']);
  return {
    ...character,
    name: detail.name || character.name,
    nameCn: nameCn || character.nameCn || '',
    aliases: unique([...(character.aliases || []), ...alias.aliases]),
    kana: alias.kana || character.kana || '',
    romaji: alias.romaji || character.romaji || '',
    english: alias.english || character.english || '',
    image: detail.images?.medium || detail.images?.large || character.image || '',
    gender: normalizeGender(detail.gender, entries),
    birthYear: Number(detail.birth_year) || null,
    birthMonth: Number(detail.birth_mon) || null,
    birthDay: Number(detail.birth_day) || null,
    bloodType: normalizeBlood(detail.blood_type, entries),
    birthdayLoaded: true
  };
}

function applyCharacterDetail(character, detail) {
  const entries = infoEntries(detail.infobox || []);
  return {
    ...applyCharacterBirthday(character, detail),
    summary: detail.summary || character.summary || '',
    height: infoValue(entries, ['身高']),
    weight: infoValue(entries, ['体重', '體重']),
    moe: infoValue(entries, ['萌点', '萌點']),
    infoEntries: entries,
    detailLoaded: true
  };
}

function applyActorBirthday(actor, detail) {
  const entries = infoEntries(detail.infobox || []);
  const alias = aliasData(detail.infobox || []);
  const nameCn = infoValue(entries, ['简体中文名', '簡體中文名']);
  return {
    ...actor,
    name: detail.name || actor.name,
    nameCn: nameCn || actor.nameCn || '',
    aliases: unique([...(actor.aliases || []), ...alias.aliases]),
    kana: alias.kana || actor.kana || '',
    romaji: alias.romaji || actor.romaji || '',
    english: alias.english || actor.english || '',
    image: detail.images?.medium || detail.images?.large || detail.img || actor.image || '',
    gender: normalizeGender(detail.gender, entries),
    birthYear: Number(detail.birth_year) || null,
    birthMonth: Number(detail.birth_mon) || null,
    birthDay: Number(detail.birth_day) || null,
    bloodType: normalizeBlood(detail.blood_type, entries),
    birthdayLoaded: true
  };
}

function applyActorDetail(actor, detail) {
  const entries = infoEntries(detail.infobox || []);
  return {
    ...applyActorBirthday(actor, detail),
    summary: detail.summary || actor.summary || '',
    career: detail.career || actor.career || [],
    infoEntries: entries,
    detailLoaded: true
  };
}

function subjectSearchText(subject) {
  return [subject.name, subject.nameCn, subject.originalName, subject.kana, subject.romaji, subject.english, ...(subject.aliases || [])]
    .filter(Boolean).join(' ').toLowerCase();
}

function characterSubjectRefs(character) {
  const imported = (character.subjects || []).map(ref => {
    const subject = animeById(ref.id);
    return subject ? { ...ref, name: subject.name, nameCn: subject.nameCn, originalName: subject.originalName } : ref;
  });
  return [...new Map([...imported, ...(character.externalSubjects || [])].map(ref => [String(ref.id), ref])).values()];
}

function characterSearchText(character) {
  const subjects = characterSubjectRefs(character);
  const actors = (character.actorIds || []).map(actorById).filter(Boolean);
  return [
    character.name, character.nameCn, character.kana, character.romaji, character.english,
    ...(character.aliases || []),
    ...subjects.flatMap(subject => [subject.name, subject.nameCn, subject.originalName, ...(subject.aliases || [])]),
    ...actors.flatMap(actor => [actor.name, actor.nameCn, actor.kana, actor.romaji, actor.english, ...(actor.aliases || [])]),
    ...(character.manualActors || []).flatMap(actor => [actor.name, actor.nameCn, actor.subjectName, actor.subjectNameCn])
  ].filter(Boolean).join(' ').toLowerCase();
}

function actorSearchText(actor) {
  return [
    actor.name, actor.nameCn, actor.kana, actor.romaji, actor.english, ...(actor.aliases || []),
    ...(actor.credits || []).flatMap(credit => {
      const subject = animeById(credit.subjectId);
      const character = characterById(credit.characterId);
      return [credit.anime, credit.animeOriginal, credit.character, subject && subjectSearchText(subject), character && characterSearchText(character)];
    })
  ].filter(Boolean).join(' ').toLowerCase();
}

function voiceActorLibraryItems() {
  return [...new Map([...state.manualActors, ...state.actors].map(actor => [String(actor.id), actor])).values()];
}

function persistState() {
  try {
    localStorage.setItem('seitrace-data', JSON.stringify({
      schemaVersion: DATA_SCHEMA,
      anime: state.anime,
      actors: state.actors,
      characters: state.characters,
      manualActors: state.manualActors,
      source: state.source,
      collectionScope: state.collectionScope,
      characterLibraryLoaded: state.characterLibraryLoaded,
      actorLibraryLoaded: state.actorLibraryLoaded,
      savedAt: Date.now()
    }));
  } catch {
    notice('数据量较大，本机缓存空间不足；当前结果仍可继续使用。');
  }
}

function weightedScore(actor) {
  return actor.credits.reduce((sum, credit) => sum + (ROLE[credit.role]?.weight || ROLE.minor.weight), 0);
}

function score(actor) {
  return state.mode === 'weighted' ? weightedScore(actor) : actor.credits.length;
}

function counts(actor) {
  return actor.credits.reduce((result, credit) => {
    result[credit.role in ROLE ? credit.role : 'minor']++;
    return result;
  }, { main: 0, support: 0, guest: 0, minor: 0 });
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    },
    signal: options.signal
  });
  if (!response.ok) throw new Error(response.status === 404 ? '没有找到对应数据' : `Bangumi API 返回 ${response.status}`);
  return response.json();
}

async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await worker(items[cursor++]);
  });
  await Promise.all(runners);
}

function setProgress(done, total, title, detail = '') {
  const percent = total ? Math.round(done / total * 100) : 0;
  $('#progressPanel').hidden = false;
  $('#progressText').textContent = title;
  $('#progressPercent').textContent = `${percent}%`;
  $('#progressBar').style.width = `${percent}%`;
  $('#progressDetail').textContent = detail;
}

function notice(message) {
  $('#notice').textContent = message;
  $('#notice').hidden = !message;
}

function cloneCharacter(character) {
  return {
    ...character,
    roles: [...(character.roles || [])],
    subjects: (character.subjects || []).map(subject => ({ ...subject, actorIds: [...(subject.actorIds || [])] })),
    actorIds: [...(character.actorIds || [])],
    externalSubjects: (character.externalSubjects || []).map(subject => ({ ...subject })),
    manualActors: (character.manualActors || []).map(actor => ({ ...actor }))
  };
}

function cloneActor(actor) {
  return { ...actor, credits: (actor.credits || []).map(credit => ({ ...credit })) };
}

function removeSubjectIdsFromData(characters, actors, subjectIds) {
  const removed = new Set([...subjectIds].map(String));
  const nextCharacters = characters.map(cloneCharacter).map(character => {
    character.subjects = character.subjects.filter(subject => !removed.has(String(subject.id)));
    character.actorIds = unique(character.subjects.flatMap(subject => subject.actorIds || []));
    character.roles = unique([
      ...character.subjects.map(subject => subject.role),
      ...(character.externalSubjects || []).map(subject => subject.role)
    ]);
    character.role = bestRole(character.roles);
    return character;
  }).filter(character => character.manual || character.subjects.length);
  const prunedActors = actors.map(cloneActor).map(actor => ({
    ...actor,
    credits: actor.credits.filter(credit => !removed.has(String(credit.subjectId)))
  }));
  const nextActors = prunedActors.filter(actor => actor.credits.length);
  const detachedActors = prunedActors.filter(actor => actor.manual && !actor.credits.length);
  return { characters: nextCharacters, actors: nextActors, detachedActors };
}

async function hydrateBirthdayProfiles(characters, actors, signal, title = '加载角色与声优生日') {
  const tasks = [
    ...characters.filter(character => !character.birthdayLoaded).map(character => ({ type: 'character', item: character })),
    ...actors.filter(actor => !actor.birthdayLoaded).map(actor => ({ type: 'actor', item: actor }))
  ];
  if (!tasks.length) return { total: 0, failed: 0 };
  let done = 0;
  let failed = 0;
  setProgress(0, tasks.length, title, `已解析生日 0 / ${tasks.length}`);
  await pool(tasks, 8, async task => {
    try {
      if (task.type === 'character') {
        const detail = await api(`/v0/characters/${task.item.id}`, { signal });
        Object.assign(task.item, state.characterLibraryLoaded
          ? applyCharacterDetail(task.item, detail)
          : applyCharacterBirthday(task.item, detail));
      } else {
        const detail = await api(`/v0/persons/${task.item.id}`, { signal });
        Object.assign(task.item, state.actorLibraryLoaded
          ? applyActorDetail(task.item, detail)
          : applyActorBirthday(task.item, detail));
      }
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      failed++;
    }
    done++;
    setProgress(done, tasks.length, title, `已解析生日 ${done} / ${tasks.length}`);
  });
  return { total: tasks.length, failed };
}

async function ensureBirthdayProfiles() {
  if (birthdayProfilePromise) return birthdayProfilePromise;
  const actors = [...state.actors, ...state.manualActors];
  if (![...state.characters, ...actors].some(item => !item.birthdayLoaded)) return;
  birthdayProfilePromise = (async () => {
    state.controller?.abort();
    state.controller = new AbortController();
    try {
      const result = await hydrateBirthdayProfiles(state.characters, actors, state.controller.signal, '补全生日日历资料');
      persistState();
      renderCurrent();
      if (result.failed) notice(`${result.failed} 个生日资料暂时读取失败，下次打开时会自动重试。`);
    } catch (error) {
      if (error.name !== 'AbortError') notice(error.message || '生日资料加载失败，请稍后重试。');
    } finally {
      $('#progressPanel').hidden = true;
      state.controller = null;
      birthdayProfilePromise = null;
    }
  })();
  return birthdayProfilePromise;
}

async function ensureSubjectDetails() {
  if (subjectDetailPromise) return subjectDetailPromise;
  const missing = state.anime.filter(subject => !subject.detailLoaded);
  if (!missing.length) return;
  subjectDetailPromise = (async () => {
    if (birthdayProfilePromise) await birthdayProfilePromise;
    state.controller?.abort();
    state.controller = new AbortController();
    const signal = state.controller.signal;
    let done = 0;
    setProgress(0, missing.length, '补全作品搜索资料', `0 / ${missing.length} 部作品`);
    try {
      await pool(missing, 6, async subject => {
        try {
          Object.assign(subject, normalizeSubject(await api(`/v0/subjects/${subject.id}`, { signal })));
        } catch (error) {
          if (error.name === 'AbortError') throw error;
        }
        done++;
        setProgress(done, missing.length, '补全作品搜索资料', `${done} / ${missing.length} 部作品`);
      });
      persistState();
      renderCurrent();
    } catch (error) {
      if (error.name !== 'AbortError') notice(error.message || '作品搜索资料加载失败，请稍后重试。');
    } finally {
      $('#progressPanel').hidden = true;
      state.controller = null;
      subjectDetailPromise = null;
    }
  })();
  return subjectDetailPromise;
}

async function importSubjects(subjects, source, scope = state.collectionScope, options = {}) {
  state.controller?.abort();
  state.controller = new AbortController();
  const signal = state.controller.signal;
  const incomingIds = new Set(subjects.map(subject => String(subject.id)));
  const currentById = new Map(state.anime.map(subject => [String(subject.id), subject]));
  const removedIds = new Set(state.anime.filter(subject => !incomingIds.has(String(subject.id))).map(subject => String(subject.id)));
  if (options.force) state.anime.forEach(subject => incomingIds.has(String(subject.id)) && removedIds.add(String(subject.id)));
  const retainedData = removeSubjectIdsFromData(state.characters, state.actors, removedIds);
  const characterMap = new Map(retainedData.characters.map(character => [String(character.id), character]));
  const actorMap = new Map(retainedData.actors.map(actor => [String(actor.id), actor]));
  const relationRows = new Map();
  const failedSubjects = [];
  const pendingSubjects = subjects.filter(subject => options.force || !currentById.has(String(subject.id)));
  notice('');
  setView('stats');

  try {
    let subjectDone = 0;
    if (pendingSubjects.length) {
      setProgress(0, pendingSubjects.length, '读取新增作品与角色关联', `0 / ${pendingSubjects.length} 部作品`);
      await pool(pendingSubjects, 4, async inputSubject => {
        let rows = [];
        try {
          rows = await api(`/v0/subjects/${inputSubject.id}/characters`, { signal });
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          failedSubjects.push(inputSubject.name);
        }
        relationRows.set(String(inputSubject.id), rows);
        subjectDone++;
        setProgress(subjectDone, pendingSubjects.length, '读取新增作品与角色关联', `${subjectDone} / ${pendingSubjects.length} 部作品`);
      });
    }

    const normalizedSubjects = subjects.map(input => currentById.get(String(input.id)) || input);
    const normalizedById = new Map(normalizedSubjects.map(subject => [String(subject.id), subject]));

    for (const inputSubject of pendingSubjects) {
      const subject = normalizedById.get(String(inputSubject.id)) || inputSubject;
      for (const row of relationRows.get(String(subject.id)) || []) {
        const id = String(row.id);
        const role = mapRole(row);
        const existing = characterMap.get(id);
        const character = existing || {
          id: row.id,
          name: row.name || `#${row.id}`,
          nameCn: '',
          aliases: [],
          image: row.images?.medium || row.images?.large || '',
          summary: row.summary || '',
          roles: [],
          subjects: [],
          actorIds: [],
          externalSubjects: [],
          manualActors: [],
          birthdayLoaded: false,
          detailLoaded: false,
          manual: false
        };
        character.name ||= row.name || `#${row.id}`;
        character.image ||= row.images?.medium || row.images?.large || '';
        let subjectRef = character.subjects.find(item => String(item.id) === String(subject.id));
        if (!subjectRef) {
          subjectRef = { id: subject.id, role, actorIds: [] };
          character.subjects.push(subjectRef);
        }

        for (const person of row.actors || []) {
          const personId = String(person.id);
          subjectRef.actorIds = unique([...(subjectRef.actorIds || []), person.id]);
          const actor = actorMap.get(personId) || {
            id: person.id,
            name: person.name || `#${person.id}`,
            nameCn: '',
            aliases: [],
            image: person.images?.medium || person.images?.large || '',
            credits: [],
            birthdayLoaded: false,
            detailLoaded: false
          };
          const creditKey = `${subject.id}:${row.id}`;
          if (!actor.credits.some(credit => `${credit.subjectId}:${credit.characterId}` === creditKey)) {
            actor.credits.push({
              anime: subject.name,
              animeOriginal: subject.originalName,
              character: row.name || `#${row.id}`,
              characterId: row.id,
              role,
              subjectId: subject.id
            });
          }
          actorMap.set(personId, actor);
        }
        character.actorIds = unique(character.subjects.flatMap(item => item.actorIds || []));
        character.roles = unique([
          ...character.subjects.map(item => item.role),
          ...(character.externalSubjects || []).map(item => item.role)
        ]);
        character.role = bestRole(character.roles);
        characterMap.set(id, character);
      }
    }

    const characters = [...characterMap.values()];
    const manualActorPool = [...new Map([...state.manualActors, ...retainedData.detachedActors].map(actor => [String(actor.id), actor])).values()];
    const manualActorMap = new Map(manualActorPool.map(actor => [String(actor.id), actor]));
    const actors = [...actorMap.values()].map(actor => {
      const manual = manualActorMap.get(String(actor.id));
      return manual ? { ...actor, ...manual, credits: actor.credits, manual: true } : actor;
    });
    const remainingManualActors = manualActorPool.filter(actor => !actorMap.has(String(actor.id)));
    const birthdayResult = await hydrateBirthdayProfiles(characters, actors, signal);

    const finalCharacterMap = new Map(characters.map(item => [String(item.id), item]));
    for (const actor of actors) {
      for (const credit of actor.credits) {
        const character = finalCharacterMap.get(String(credit.characterId));
        if (character) credit.character = character.nameCn || character.name;
      }
    }

    state.anime = normalizedSubjects;
    state.characters = characters;
    state.actors = actors;
    state.manualActors = remainingManualActors;
    state.source = source;
    state.collectionScope = scope;
    persistState();
    $('#syncTitle').textContent = source;
    $('#syncTime').textContent = '刚刚同步';
    $('#syncDot').classList.remove('empty');
    $('#syncDot').style.background = 'var(--mint)';
    if (failedSubjects.length) notice(`${failedSubjects.length} 部作品未能读取角色关系，其余数据已完成。`);
    else if (birthdayResult.failed) notice(`${birthdayResult.failed} 个生日资料暂时读取失败，下次打开时会自动重试。`);
    else if (!pendingSubjects.length && !removedIds.size) notice('片目与本机缓存一致，无需重复读取。');
    renderCurrent();
  } catch (error) {
    if (error.name !== 'AbortError') notice(error.message || '导入失败，请稍后重试。');
  } finally {
    $('#progressPanel').hidden = true;
    state.controller = null;
  }
}

async function importUid() {
  const uid = $('#uidInput').value.trim();
  if (!uid) return notice('请输入 Bangumi UID 或用户名。');
  const scope = $('input[name="collectionScope"]:checked')?.value || 'watched';
  const scopeLabel = scope === 'all' ? '全部列表' : '已看过';
  const typeFilter = scope === 'watched' ? '&type=2' : '';
  state.controller?.abort();
  state.controller = new AbortController();
  const signal = state.controller.signal;
  const rows = [];
  let offset = 0;
  notice('');
  setProgress(0, 1, scope === 'all' ? '读取全部动画收藏' : '读取看过的动画', '连接 Bangumi');
  try {
    while (true) {
      const page = await api(`/v0/users/${encodeURIComponent(uid)}/collections?subject_type=2${typeFilter}&limit=50&offset=${offset}`, { signal });
      rows.push(...(page.data || []));
      const total = page.total || rows.length;
      setProgress(rows.length, total, scope === 'all' ? '读取全部动画收藏' : '读取看过的动画', `${Math.min(rows.length, total)} / ${total} 部作品`);
      if (!page.data?.length || rows.length >= total) break;
      offset += page.data.length;
    }
    const subjects = [...new Map(rows.map(row => {
      const subject = normalizeSubject(row);
      return [subject.id, subject];
    })).values()];
    if (!subjects.length) throw new Error(scope === 'all' ? '该用户没有公开的动画收藏，或收藏设置为私密。' : '该用户没有公开的“看过”动画，或收藏设置为私密。');
    await importSubjects(subjects, `Bangumi · ${uid} · ${scopeLabel}`, scope);
  } catch (error) {
    $('#progressPanel').hidden = true;
    if (error.name !== 'AbortError') notice(error.message || 'UID 导入失败，请确认用户存在且收藏公开。');
  }
}

async function importIds(idsInput = null) {
  const raw = idsInput == null ? $('#batchInput').value : String(idsInput);
  const ids = unique(raw.split(/\s+/).map(value => value.trim()).filter(value => /^\d+$/.test(value)));
  if (!ids.length) return notice('请至少输入一个有效的数字作品 ID。');
  $('#batchDialog')?.close();
  state.controller?.abort();
  state.controller = new AbortController();
  const signal = state.controller.signal;
  const subjects = [];
  let done = 0;
  setProgress(0, ids.length, '读取作品信息', `0 / ${ids.length} 部作品`);
  try {
    await pool(ids, 4, async id => {
      try {
        subjects.push(normalizeSubject(await api(`/v0/subjects/${id}`, { signal })));
      } finally {
        done++;
        setProgress(done, ids.length, '读取作品信息', `${done} / ${ids.length} 部作品`);
      }
    });
    const merged = [...new Map([...state.anime, ...subjects].map(subject => [subject.id, subject])).values()];
    await importSubjects(merged, '手动添加片目', 'custom');
    $('#libraryIdInput').value = '';
  } catch (error) {
    $('#progressPanel').hidden = true;
    if (error.name !== 'AbortError') notice(error.message || '作品导入失败。');
  }
}

async function ensureCharacterDetails({ markLibraryLoaded = false } = {}) {
  if (characterDetailPromise) {
    await characterDetailPromise;
    if (markLibraryLoaded && !state.characterLibraryLoaded) {
      state.characterLibraryLoaded = true;
      persistState();
    }
    return;
  }
  const missing = state.characters.filter(character => !character.detailLoaded);
  if (!missing.length) {
    if (markLibraryLoaded) {
      state.characterLibraryLoaded = true;
      persistState();
      renderCurrent();
    }
    return;
  }

  characterDetailPromise = (async () => {
    if (birthdayProfilePromise) await birthdayProfilePromise;
    state.controller?.abort();
    state.controller = new AbortController();
    const signal = state.controller.signal;
    let done = 0;
    const title = markLibraryLoaded ? '首次加载角色库' : '更新角色库资料';
    setProgress(0, missing.length, title, `已解析角色 0 / ${missing.length}`);
    try {
      await pool(missing, 4, async character => {
        try {
          const detail = await api(`/v0/characters/${character.id}`, { signal });
          Object.assign(character, applyCharacterDetail(character, detail));
        } catch (error) {
          if (error.name === 'AbortError') throw error;
        }
        done++;
        setProgress(done, missing.length, title, `已解析角色 ${done} / ${missing.length}`);
      });
      const characterMap = new Map(state.characters.map(character => [String(character.id), character]));
      for (const actor of state.actors) {
        for (const credit of actor.credits) {
          const character = characterMap.get(String(credit.characterId));
          if (character) credit.character = character.nameCn || character.name;
        }
      }
      if (markLibraryLoaded) state.characterLibraryLoaded = true;
      persistState();
      renderCurrent();
    } catch (error) {
      if (error.name !== 'AbortError') notice(error.message || '角色资料加载失败，请稍后重试。');
    } finally {
      $('#progressPanel').hidden = true;
      state.controller = null;
      characterDetailPromise = null;
    }
  })();
  await characterDetailPromise;
}

async function ensureActorDetails({ markLibraryLoaded = false } = {}) {
  if (actorDetailPromise) {
    await actorDetailPromise;
    if (markLibraryLoaded && !state.actorLibraryLoaded) {
      state.actorLibraryLoaded = true;
      persistState();
    }
    return;
  }
  const missing = voiceActorLibraryItems().filter(actor => !actor.detailLoaded);
  if (!missing.length) {
    if (markLibraryLoaded) {
      state.actorLibraryLoaded = true;
      persistState();
      renderCurrent();
    }
    return;
  }

  actorDetailPromise = (async () => {
    if (birthdayProfilePromise) await birthdayProfilePromise;
    state.controller?.abort();
    state.controller = new AbortController();
    const signal = state.controller.signal;
    let done = 0;
    const title = markLibraryLoaded ? '首次加载声优库' : '更新声优库资料';
    setProgress(0, missing.length, title, `已解析声优 0 / ${missing.length}`);
    try {
      await pool(missing, 4, async actor => {
        try {
          const detail = await api(`/v0/persons/${actor.id}`, { signal });
          Object.assign(actor, applyActorDetail(actor, detail));
        } catch (error) {
          if (error.name === 'AbortError') throw error;
        }
        done++;
        setProgress(done, missing.length, title, `已解析声优 ${done} / ${missing.length}`);
      });
      if (markLibraryLoaded) state.actorLibraryLoaded = true;
      persistState();
      renderCurrent();
    } catch (error) {
      if (error.name !== 'AbortError') notice(error.message || '声优资料加载失败，请稍后重试。');
    } finally {
      $('#progressPanel').hidden = true;
      state.controller = null;
      actorDetailPromise = null;
    }
  })();
  await actorDetailPromise;
}

function parseCharacterId(value) {
  const raw = String(value || '').trim();
  const urlMatch = raw.match(/^(?:https?:\/\/)?(?:www\.)?(?:bangumi|bgm)\.tv\/character\/([^/?#]+)/i);
  const id = urlMatch ? urlMatch[1] : raw;
  return /^\d+$/.test(id) ? id : '';
}

async function importCharacter() {
  const id = parseCharacterId($('#characterIdInput').value);
  if (!id) return notice('请输入有效的 Bangumi 角色 ID，或角色页面链接。');
  if (birthdayProfilePromise) await birthdayProfilePromise;
  state.controller?.abort();
  state.controller = new AbortController();
  const signal = state.controller.signal;
  notice('');
  setProgress(0, 3, '读取角色资料', '正在连接 Bangumi');
  try {
    const [detailResult, subjectResult, personResult] = await Promise.allSettled([
      api(`/v0/characters/${encodeURIComponent(id)}`, { signal }),
      api(`/v0/characters/${encodeURIComponent(id)}/subjects`, { signal }),
      api(`/v0/characters/${encodeURIComponent(id)}/persons`, { signal })
    ]);
    if (detailResult.status === 'rejected') throw detailResult.reason;
    setProgress(3, 3, '读取角色资料', '正在写入本机缓存');
    const detail = detailResult.value;
    const existingIndex = state.characters.findIndex(character => String(character.id) === String(detail.id));
    const existing = existingIndex >= 0 ? cloneCharacter(state.characters[existingIndex]) : {
      id: detail.id,
      name: detail.name || `#${detail.id}`,
      nameCn: '',
      aliases: [],
      image: detail.images?.medium || detail.images?.large || '',
      roles: [],
      subjects: [],
      actorIds: [],
      externalSubjects: [],
      manualActors: [],
      detailLoaded: false
    };
    const externalSubjects = (subjectResult.status === 'fulfilled' ? subjectResult.value : [])
      .filter(subject => Number(subject.type) === 2)
      .map(subject => ({
        id: subject.id,
        name: subject.name_cn || subject.name || `#${subject.id}`,
        nameCn: subject.name_cn || '',
        originalName: subject.name || '',
        image: subject.image || '',
        role: mapRole({ relation: subject.staff })
      }));
    const manualActors = [...new Map((personResult.status === 'fulfilled' ? personResult.value : [])
      .filter(person => Number(person.type) === 1)
      .map(person => [String(person.id), {
        id: person.id,
        name: person.name || `#${person.id}`,
        image: person.images?.medium || person.images?.large || '',
        subjectName: person.subject_name || '',
        subjectNameCn: person.subject_name_cn || ''
      }])).values()];
    const character = applyCharacterDetail({
      ...existing,
      manual: true,
      externalSubjects: [...new Map([...(existing.externalSubjects || []), ...externalSubjects].map(subject => [String(subject.id), subject])).values()],
      manualActors: [...new Map([...(existing.manualActors || []), ...manualActors].map(actor => [String(actor.id), actor])).values()]
    }, detail);
    character.roles = unique([
      ...(character.subjects || []).map(subject => subject.role),
      ...(character.externalSubjects || []).map(subject => subject.role)
    ]);
    character.role = bestRole(character.roles);
    if (existingIndex >= 0) state.characters.splice(existingIndex, 1, character);
    else state.characters.push(character);
    if (state.characters.every(item => item.manual || item.detailLoaded)) state.characterLibraryLoaded = true;
    $('#characterIdInput').value = '';
    persistState();
    setView('characters', { skipCharacterPrompt: true });
    notice(`已添加角色：${character.nameCn || character.name}`);
  } catch (error) {
    if (error.name !== 'AbortError') notice(error.message || '角色导入失败，请检查 ID 后重试。');
  } finally {
    $('#progressPanel').hidden = true;
    state.controller = null;
  }
}

function parseActorId(value) {
  const raw = String(value || '').trim();
  const urlMatch = raw.match(/^(?:https?:\/\/)?(?:www\.)?(?:bangumi|bgm)\.tv\/person\/([^/?#]+)/i);
  const id = urlMatch ? urlMatch[1] : raw;
  return /^\d+$/.test(id) ? id : '';
}

async function importActor() {
  const id = parseActorId($('#actorLibraryIdInput').value);
  if (!id) return notice('请输入有效的 Bangumi 声优 ID，或 person 页面链接。');
  if (birthdayProfilePromise) await birthdayProfilePromise;
  state.controller?.abort();
  state.controller = new AbortController();
  const signal = state.controller.signal;
  notice('');
  setProgress(0, 2, '读取声优资料', '正在连接 Bangumi');
  try {
    const [detailResult, characterResult] = await Promise.allSettled([
      api(`/v0/persons/${encodeURIComponent(id)}`, { signal }),
      api(`/v0/persons/${encodeURIComponent(id)}/characters`, { signal })
    ]);
    if (detailResult.status === 'rejected') throw detailResult.reason;
    setProgress(2, 2, '读取声优资料', '正在写入本机缓存');
    const detail = detailResult.value;
    const relatedCharacters = (characterResult.status === 'fulfilled' ? characterResult.value : [])
      .filter(row => Number(row.subject_type) === 2)
      .map(row => ({
        anime: row.subject_name_cn || row.subject_name || `#${row.subject_id}`,
        animeOriginal: row.subject_name || '',
        character: row.name || `#${row.id}`,
        characterId: row.id,
        role: mapRole({ relation: row.staff }),
        subjectId: row.subject_id
      }));
    const statsIndex = state.actors.findIndex(actor => String(actor.id) === String(detail.id));
    const manualIndex = state.manualActors.findIndex(actor => String(actor.id) === String(detail.id));
    const existing = statsIndex >= 0
      ? cloneActor(state.actors[statsIndex])
      : manualIndex >= 0
        ? cloneActor(state.manualActors[manualIndex])
        : { id: detail.id, name: detail.name || `#${detail.id}`, credits: [], aliases: [], manual: true };
    const actor = applyActorDetail({
      ...existing,
      manual: true,
      credits: statsIndex >= 0
        ? existing.credits
        : [...new Map([...(existing.credits || []), ...relatedCharacters].map(credit => [`${credit.subjectId}:${credit.characterId}`, credit])).values()]
    }, detail);
    if (statsIndex >= 0) state.actors.splice(statsIndex, 1, actor);
    else if (manualIndex >= 0) state.manualActors.splice(manualIndex, 1, actor);
    else state.manualActors.push(actor);
    if (voiceActorLibraryItems().every(item => item.detailLoaded)) state.actorLibraryLoaded = true;
    $('#actorLibraryIdInput').value = '';
    persistState();
    setView('actors', { skipActorPrompt: true });
    notice(`已添加声优：${actor.name}`);
  } catch (error) {
    if (error.name !== 'AbortError') notice(error.message || '声优导入失败，请检查 ID 后重试。');
  } finally {
    $('#progressPanel').hidden = true;
    state.controller = null;
  }
}

async function searchApi() {
  const query = $('#apiSearchInput').value.trim();
  if (!query) return;
  $('#apiSearchProgress').hidden = false;
  $('#apiResults').innerHTML = '';
  try {
    const data = await api('/v0/search/subjects', {
      method: 'POST',
      body: JSON.stringify({ keyword: query, filter: { type: [2] } })
    });
    const rows = (data.data || []).map(normalizeSubject)
      .sort((a, b) => Number(b.nameCn === query) - Number(a.nameCn === query) || Number(b.name === query) - Number(a.name === query))
      .slice(0, 12);
    $('#apiResults').innerHTML = rows.length ? rows.map(subject => {
      const url = `https://bgm.tv/subject/${subject.id}`;
      const original = subject.originalName && subject.originalName !== subject.name ? `${subject.originalName} · ` : '';
      const exists = state.anime.some(item => String(item.id) === String(subject.id));
      return `<div class="api-result"><a class="cover-link bgm-link" href="${url}" target="_blank" rel="noopener"><img src="${esc(subject.image)}" alt="${esc(subject.name)}"></a><div><a class="bgm-link" href="${url}" target="_blank" rel="noopener"><strong>${esc(subject.name)}</strong></a><small>${esc(original)}${esc(subject.date || '年份未知')} · ID ${subject.id}</small></div><button class="secondary-btn add-result" type="button" data-id="${subject.id}" ${exists ? 'disabled' : ''}>${exists ? '已添加' : '添加'}</button></div>`;
    }).join('') : '<p class="dialog-placeholder">没有找到动画结果</p>';
    $$('.add-result:not([disabled])').forEach(button => button.addEventListener('click', () => {
      $('#apiDialog').close();
      importIds(button.dataset.id);
    }));
  } catch (error) {
    $('#apiResults').innerHTML = `<p class="dialog-placeholder">${esc(error.message)}</p>`;
  } finally {
    $('#apiSearchProgress').hidden = true;
  }
}

function setView(view, options = {}) {
  if (!['stats', 'calendar', 'characters', 'actors', 'library'].includes(view)) return;
  if (view === 'characters' && state.characters.length && !state.characterLibraryLoaded && !options.skipCharacterPrompt) {
    closeSidebar();
    $('#characterLoadDialog').showModal();
    return;
  }
  if (view === 'actors' && voiceActorLibraryItems().length && !state.actorLibraryLoaded && !options.skipActorPrompt) {
    closeSidebar();
    $('#actorLoadDialog').showModal();
    return;
  }
  state.view = view;
  $$('.app-view').forEach(section => {
    const active = section.dataset.view === view;
    section.hidden = !active;
    section.classList.toggle('active', active);
  });
  $$('.nav-item[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  const placeholders = {
    stats: '搜索声优、角色或动画…',
    calendar: '搜索日文、英文、罗马音或简体中文生日对象…',
    characters: '搜索角色、作品或声优…',
    actors: '搜索声优、角色或作品…',
    library: '搜索日文、英文、罗马音或简体中文作品名…'
  };
  $('#searchInput').placeholder = placeholders[view];
  $('#searchInput').value = view === 'stats'
    ? state.query
    : view === 'characters'
      ? state.characterQuery
      : view === 'actors'
        ? state.actorLibraryQuery
        : view === 'library'
          ? state.libraryQuery
          : state.calendarQuery;
  closeSidebar();
  renderCurrent();
  if (view === 'library') ensureSubjectDetails();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderCurrent() {
  $('#navAnimeCount').textContent = state.anime.length;
  $('#navCharacterCount').textContent = state.characters.length;
  $('#navActorCount').textContent = voiceActorLibraryItems().length;
  if (state.view === 'stats') renderStats();
  if (state.view === 'calendar') renderCalendar();
  if (state.view === 'characters') renderCharacters();
  if (state.view === 'actors') renderActorLibrary();
  if (state.view === 'library') renderLibraryPage();
  if (window.lucide) lucide.createIcons();
}

function renderStats() {
  const query = state.query.trim().toLowerCase();
  const actors = state.actors.filter(actor => {
    const roleMatch = state.role === 'all' || actor.credits.some(credit => credit.role === state.role);
    return roleMatch && (!query || actorSearchText(actor).includes(query));
  }).sort((a, b) => score(b) - score(a) || b.credits.length - a.credits.length);
  const roleCount = state.actors.reduce((total, actor) => total + actor.credits.length, 0);
  const allCollections = state.collectionScope === 'all';
  const customCollection = state.collectionScope === 'custom';
  $('#animeCount').textContent = state.anime.length;
  $('#actorCount').textContent = state.actors.length;
  $('#roleCount').textContent = roleCount;
  $('#sourceLabel').textContent = state.source.toUpperCase();
  $('#mobileImportGuide').hidden = state.anime.length > 0 || state.actors.length > 0;
  $('#animeMetricLabel').textContent = allCollections ? '列表动画' : customCollection ? '导入动画' : '看过动画';
  $('#animeDelta').textContent = allCollections ? '全部收藏状态' : customCollection ? '手动导入片目' : '已完成收藏';
  $('#actorMetricLabel').textContent = allCollections || customCollection ? '涉及声优' : '听过声优';
  $('#collectionDescription').textContent = allCollections ? '从你的 Bangumi 动画列表中，查看所有相关声优。' : customCollection ? '从导入的动画中，查看相关声优与角色。' : '从看过的动画中，找出最熟悉的那些声音。';
  $('#scoreHeading').textContent = state.mode === 'weighted' ? '出演数 / 加权分' : '出演数';
  $('#rankingHint').textContent = state.mode === 'weighted' ? '综合角色类型与出演次数计算熟悉度' : '每条出演记录等权，按总次数排序';
  $('#rankingList').innerHTML = actors.map(actorHTML).join('');
  $('#rankingList').hidden = actors.length === 0;
  $('#emptyState').hidden = actors.length > 0;
  if (!actors.length) {
    const noData = !state.anime.length;
    $('#emptyState').innerHTML = noData
      ? '<i data-lucide="inbox"></i><strong>还没有导入片单</strong><span>从左侧输入 Bangumi UID，或前往片目库添加作品</span><button class="primary-btn" type="button" data-action="open-import"><i data-lucide="download"></i>开始导入</button>'
      : '<i data-lucide="search-x"></i><strong>没有找到匹配结果</strong><span>换个关键词或角色分类试试</span>';
  }
  bindRenderedActions();
}

function actorHTML(actor, index) {
  const composition = counts(actor);
  const total = Math.max(1, actor.credits.length);
  const weighted = weightedScore(actor);
  const bars = ROLE_ORDER.map(role => `<span data-role="${role}" style="width:${composition[role] / total * 100}%"></span>`).join('');
  const labels = ROLE_ORDER.filter(role => composition[role]).map(role => `<span><i class="dot ${role}"></i>${ROLE[role].label} ${composition[role]}</span>`).join('');
  const credits = actor.credits.map(credit => {
    const subject = animeById(credit.subjectId);
    const character = characterById(credit.characterId);
    const subjectUrl = `https://bgm.tv/subject/${credit.subjectId}`;
    const characterUrl = `https://bgm.tv/character/${credit.characterId}`;
    return `<div class="credit"><a class="cover-link bgm-link" href="${subjectUrl}" target="_blank" rel="noopener"><img class="credit-cover" src="${esc(subject?.image || '')}" alt="${esc(credit.anime)}" onerror="this.style.visibility='hidden'"></a><div><a class="bgm-link" href="${subjectUrl}" target="_blank" rel="noopener"><strong>${esc(subject?.name || credit.anime)}</strong></a><a class="bgm-link" href="${characterUrl}" target="_blank" rel="noopener"><small>${esc(character?.nameCn || character?.name || credit.character)}</small></a></div><span class="role-badge">${ROLE[credit.role]?.label || ROLE.minor.label}</span></div>`;
  }).join('');
  const displayName = actor.name || actor.nameCn || `#${actor.id}`;
  const nameMarkup = actor.kana && actor.kana !== displayName
    ? `<ruby>${esc(displayName)}<rt>${esc(actor.kana)}</rt></ruby>`
    : esc(displayName);
  const secondaryName = unique([actor.nameCn, actor.romaji, actor.english])
    .filter(name => name !== displayName && name !== actor.kana)
    .join(' · ') || `${actor.credits.length} 条出演记录`;
  const personUrl = `https://bgm.tv/person/${actor.id}`;
  const scoreNote = state.mode === 'weighted' ? `加权分 ${Number.isInteger(weighted) ? weighted : weighted.toFixed(1)}` : '次出演';
  return `<article class="actor-row"><div class="actor-summary" role="button" aria-label="展开 ${esc(displayName)} 的出演详情" tabindex="0"><div class="actor-identity"><span class="rank ${index < 3 ? 'top' : ''}">${String(index + 1).padStart(2, '0')}</span><a class="avatar-link bgm-link" href="${personUrl}" target="_blank" rel="noopener"><img class="avatar" src="${esc(actor.image || placeholder(displayName))}" alt="${esc(displayName)}" onerror="this.src='${placeholder(displayName)}'"></a><div class="actor-name"><a class="bgm-link" href="${personUrl}" target="_blank" rel="noopener"><strong>${nameMarkup}</strong></a><small>${esc(secondaryName)}</small></div></div><div class="composition"><div class="bar">${bars}</div><div class="counts">${labels}</div></div><div class="score"><strong>${actor.credits.length}</strong><small>${scoreNote}</small></div><i class="chevron" data-lucide="chevron-down"></i></div><div class="actor-detail"><div class="credit-grid">${credits}</div></div></article>`;
}

function renderLibraryPage() {
  const query = state.libraryQuery.trim().toLowerCase();
  const subjects = state.anime.filter(subject => !query || subjectSearchText(subject).includes(query));
  $('#libraryViewCount').textContent = `共 ${state.anime.length} 部动画`;
  $('#libraryPageGrid').innerHTML = subjects.map(subject => {
    const url = `https://bgm.tv/subject/${subject.id}`;
    const secondary = subject.originalName && subject.originalName !== subject.name ? subject.originalName : `${subject.date || '年份未知'} · ID ${subject.id}`;
    return `<article class="library-page-card"><div class="library-page-cover"><a href="${url}" target="_blank" rel="noopener"><img src="${esc(subject.image)}" alt="${esc(subject.name)}" onerror="this.style.visibility='hidden'"></a><button class="library-delete" type="button" data-remove-subject="${subject.id}" aria-label="删除 ${esc(subject.name)}"><i data-lucide="trash-2"></i></button></div><a href="${url}" target="_blank" rel="noopener"><strong>${esc(subject.name)}</strong></a><small>${esc(secondary)}</small></article>`;
  }).join('');
  $('#libraryPageGrid').hidden = subjects.length === 0;
  $('#libraryEmpty').hidden = subjects.length > 0;
  if (!subjects.length && state.anime.length) {
    $('#libraryEmpty').innerHTML = '<i data-lucide="search-x"></i><strong>没有匹配的片目</strong><span>尝试其他语言的标题或清空搜索</span>';
  } else if (!state.anime.length) {
    $('#libraryEmpty').innerHTML = '<i data-lucide="library-big"></i><strong>片目库还是空的</strong><span>输入 Bangumi ID、搜索添加，或从 UID 导入</span><button class="primary-btn" type="button" data-action="open-import">从 UID 导入</button>';
  }
  bindRenderedActions();
}

function removeSubject(subjectId) {
  const id = String(subjectId);
  state.anime = state.anime.filter(subject => String(subject.id) !== id);
  const nextData = removeSubjectIdsFromData(state.characters, state.actors, new Set([id]));
  state.characters = nextData.characters;
  state.actors = nextData.actors;
  state.manualActors = [...new Map([...state.manualActors, ...nextData.detachedActors].map(actor => [String(actor.id), actor])).values()];
  if (!state.anime.length) {
    state.source = 'Waiting for import';
    state.collectionScope = 'watched';
    $('#syncTitle').textContent = '尚未导入';
    $('#syncTime').textContent = '导入后将缓存在本机';
    $('#syncDot').removeAttribute('style');
    $('#syncDot').classList.add('empty');
  }
  persistState();
  renderCurrent();
}

function renderCharacters() {
  const query = state.characterQuery.trim().toLowerCase();
  const subjectSelect = $('#characterSubjectFilter');
  const currentSubject = state.characterSubject;
  const subjectOptions = [...new Map([
    ...state.anime.map(subject => [String(subject.id), { id: subject.id, name: subject.name }]),
    ...state.characters.flatMap(character => (character.externalSubjects || []).map(subject => [String(subject.id), { id: subject.id, name: subject.nameCn || subject.name }]))
  ]).values()];
  subjectSelect.innerHTML = '<option value="all">全部作品</option>' + subjectOptions.map(subject => `<option value="${subject.id}">${esc(subject.name)}</option>`).join('');
  subjectSelect.value = subjectOptions.some(subject => String(subject.id) === String(currentSubject)) ? currentSubject : 'all';
  state.characterSubject = subjectSelect.value;
  const characters = state.characters.filter(character => {
    const roleMatch = state.characterRole === 'all' || character.roles.includes(state.characterRole);
    const genderMatch = state.characterGender === 'all' || character.gender === state.characterGender;
    const subjectMatch = state.characterSubject === 'all' || characterSubjectRefs(character).some(subject => String(subject.id) === String(state.characterSubject));
    return roleMatch && genderMatch && subjectMatch && (!query || characterSearchText(character).includes(query));
  }).sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || (a.nameCn || a.name).localeCompare(b.nameCn || b.name, 'zh-CN'));
  $('#characterViewCount').textContent = `显示 ${characters.length} / ${state.characters.length} 个角色`;
  $('#characterGrid').innerHTML = characters.map(characterHTML).join('');
  $('#characterGrid').hidden = characters.length === 0;
  $('#characterEmpty').hidden = characters.length > 0;
  if (!characters.length && state.characters.length) {
    $('#characterEmpty').innerHTML = '<i data-lucide="search-x"></i><strong>没有匹配的角色</strong><span>调整角色类型、性别、作品或搜索词</span>';
  } else if (!state.characters.length) {
    $('#characterEmpty').innerHTML = '<i data-lucide="users-round"></i><strong>没有角色数据</strong><span>导入片单后会自动解析角色详情</span><button class="primary-btn" type="button" data-action="open-import">去导入</button>';
  }
  bindRenderedActions();
}

function characterHTML(character) {
  const displayName = character.nameCn || character.name;
  const originalParts = unique([character.name, character.kana, character.romaji, character.english]).filter(value => value !== displayName);
  const actors = [...new Map([
    ...(character.actorIds || []).map(id => actorById(id)).filter(Boolean),
    ...(character.manualActors || [])
  ].map(actor => [String(actor.id), actor])).values()];
  const actorLinks = actors.map(actor => `<a href="https://bgm.tv/person/${actor.id}" target="_blank" rel="noopener">配音 · ${esc(actor.nameCn || actor.name)}</a>`).join('');
  const subjectLinks = characterSubjectRefs(character).map(subject => (
    `<a href="https://bgm.tv/subject/${subject.id}" target="_blank" rel="noopener">《${esc(subject.nameCn || subject.name)}》</a>`
  )).join('');
  const coreMeta = [
    ROLE[character.role]?.label,
    character.gender === 'male' ? '男性' : character.gender === 'female' ? '女性' : '',
    character.birthMonth && character.birthDay ? `${character.birthMonth}月${character.birthDay}日` : '',
    character.bloodType,
    character.height
  ].filter(Boolean).map(value => `<span class="meta-chip">${esc(value)}</span>`).join('');
  const detailEntries = (character.infoEntries || []).map(item => `<dt>${esc(item.key)}</dt><dd>${esc(item.values.join('、'))}</dd>`).join('');
  return `<article class="character-card"><div class="character-card-main"><a href="https://bgm.tv/character/${character.id}" target="_blank" rel="noopener"><img class="character-portrait" src="${esc(character.image || placeholder(displayName))}" alt="${esc(displayName)}" onerror="this.src='${placeholder(displayName)}'"></a><div class="character-card-copy"><a class="bgm-link" href="https://bgm.tv/character/${character.id}" target="_blank" rel="noopener"><h3>${esc(displayName)}</h3></a><p class="original-name">${esc(originalParts.join(' · ') || character.name)}</p><div class="character-meta">${coreMeta}</div><div class="character-links">${subjectLinks}${actorLinks}</div></div></div><details><summary>查看 Bangumi 全部资料</summary><div class="character-detail-body">${detailEntries ? `<dl class="character-info-list">${detailEntries}</dl>` : '<p class="character-summary">暂无结构化资料</p>'}${character.summary ? `<p class="character-summary">${esc(character.summary)}</p>` : ''}</div></details></article>`;
}

function renderActorLibrary() {
  const query = state.actorLibraryQuery.trim().toLowerCase();
  const subjectSelect = $('#actorLibrarySubjectFilter');
  const currentSubject = state.actorLibrarySubject;
  const allActors = voiceActorLibraryItems();
  const subjectOptions = [...new Map([
    ...state.anime.map(subject => [String(subject.id), { id: subject.id, name: subject.name }]),
    ...allActors.flatMap(actor => (actor.credits || []).map(credit => [
      String(credit.subjectId),
      { id: credit.subjectId, name: animeById(credit.subjectId)?.name || credit.anime }
    ]))
  ]).values()];
  subjectSelect.innerHTML = '<option value="all">全部作品</option>' + subjectOptions.map(subject => `<option value="${subject.id}">${esc(subject.name)}</option>`).join('');
  subjectSelect.value = subjectOptions.some(subject => String(subject.id) === String(currentSubject)) ? currentSubject : 'all';
  state.actorLibrarySubject = subjectSelect.value;
  const actors = allActors.filter(actor => {
    const genderMatch = state.actorLibraryGender === 'all' || actor.gender === state.actorLibraryGender;
    const subjectMatch = state.actorLibrarySubject === 'all' || (actor.credits || []).some(credit => String(credit.subjectId) === String(state.actorLibrarySubject));
    return genderMatch && subjectMatch && (!query || actorSearchText(actor).includes(query));
  }).sort((a, b) => (a.name || a.nameCn).localeCompare(b.name || b.nameCn, 'ja'));
  $('#actorLibraryViewCount').textContent = `显示 ${actors.length} / ${allActors.length} 位声优`;
  $('#actorLibraryGrid').innerHTML = actors.map(actorLibraryHTML).join('');
  $('#actorLibraryGrid').hidden = actors.length === 0;
  $('#actorLibraryEmpty').hidden = actors.length > 0;
  if (!actors.length && allActors.length) {
    $('#actorLibraryEmpty').innerHTML = '<i data-lucide="search-x"></i><strong>没有匹配的声优</strong><span>调整性别、作品或搜索词</span>';
  } else if (!allActors.length) {
    $('#actorLibraryEmpty').innerHTML = '<i data-lucide="mic-2"></i><strong>没有声优数据</strong><span>导入片单或在上方手动添加声优</span><button class="primary-btn" type="button" data-action="open-import">去导入</button>';
  }
  bindRenderedActions();
}

function actorLibraryHTML(actor) {
  const displayName = actor.name || actor.nameCn || `#${actor.id}`;
  const nameMarkup = actor.kana && actor.kana !== displayName
    ? `<ruby>${esc(displayName)}<rt>${esc(actor.kana)}</rt></ruby>`
    : esc(displayName);
  const secondary = unique([actor.nameCn, actor.romaji, actor.english])
    .filter(name => name !== displayName && name !== actor.kana)
    .join(' · ');
  const credits = actor.credits || [];
  const creditLink = credit => {
    const subject = animeById(credit.subjectId);
    const character = characterById(credit.characterId);
    const subjectName = subject?.name || credit.anime;
    const characterName = character?.name || credit.character;
    return `<a href="https://bgm.tv/subject/${credit.subjectId}" target="_blank" rel="noopener">《${esc(subjectName)}》</a><a href="https://bgm.tv/character/${credit.characterId}" target="_blank" rel="noopener">配音 · ${esc(characterName)}</a>`;
  };
  const previewLinks = credits.slice(0, 3).map(creditLink).join('');
  const visibleDetailCredits = credits.slice(0, 24);
  const allCreditLinks = visibleDetailCredits.map(creditLink).join('');
  const coreMeta = [
    actor.gender === 'male' ? '男性' : actor.gender === 'female' ? '女性' : '',
    actor.birthMonth && actor.birthDay ? `${actor.birthMonth}月${actor.birthDay}日` : '',
    actor.bloodType,
    credits.length ? `${credits.length} 次出演` : '手动添加'
  ].filter(Boolean).map(value => `<span class="meta-chip">${esc(value)}</span>`).join('');
  const detailEntries = (actor.infoEntries || []).map(item => `<dt>${esc(item.key)}</dt><dd>${esc(item.values.join('、'))}</dd>`).join('');
  const remainingCredits = credits.length > visibleDetailCredits.length
    ? `<span class="voice-credit-more">另有 ${credits.length - visibleDetailCredits.length} 条出演，可前往 Bangumi 查看</span>`
    : '';
  const detailCredits = allCreditLinks ? `<div class="character-links voice-credit-links">${allCreditLinks}${remainingCredits}</div>` : '';
  return `<article class="character-card voice-card"><div class="character-card-main"><a href="https://bgm.tv/person/${actor.id}" target="_blank" rel="noopener"><img class="character-portrait" src="${esc(actor.image || placeholder(displayName))}" alt="${esc(displayName)}" onerror="this.src='${placeholder(displayName)}'"></a><div class="character-card-copy"><a class="bgm-link" href="https://bgm.tv/person/${actor.id}" target="_blank" rel="noopener"><h3>${nameMarkup}</h3></a><p class="original-name">${esc(secondary || `Bangumi ID ${actor.id}`)}</p><div class="character-meta">${coreMeta}</div><div class="character-links">${previewLinks}</div></div></div><details><summary>查看 Bangumi 全部资料与出演</summary><div class="character-detail-body">${detailEntries ? `<dl class="character-info-list">${detailEntries}</dl>` : '<p class="character-summary">暂无结构化资料</p>'}${actor.summary ? `<p class="character-summary">${esc(actor.summary)}</p>` : ''}${detailCredits}</div></details></article>`;
}

function birthdayEvents() {
  const events = [];
  for (const character of state.characters) {
    if (!character.birthMonth || !character.birthDay) continue;
    const subjectNames = unique(characterSubjectRefs(character).map(ref => ref.nameCn || ref.name)).slice(0, 3);
    const voiceNames = unique([
      ...(character.actorIds || []).map(id => actorById(id)?.name),
      ...(character.manualActors || []).map(actor => actor.name)
    ]).filter(Boolean);
    events.push({
      type: 'character',
      id: character.id,
      name: character.nameCn || character.name,
      originalName: character.name,
      image: character.image,
      month: character.birthMonth,
      day: character.birthDay,
      year: character.birthYear,
      subtitle: `${subjectNames.map(name => `《${name}》`).join('、')}${voiceNames.length ? ` · ${voiceNames.join('、')}` : ''}`,
      searchText: characterSearchText(character),
      url: `https://bgm.tv/character/${character.id}`
    });
  }
  for (const actor of voiceActorLibraryItems()) {
    if (!actor.birthMonth || !actor.birthDay) continue;
    const creditText = (actor.credits || []).slice(0, 3).map(credit => {
      const subjectName = animeById(credit.subjectId)?.name || credit.anime;
      const characterName = characterById(credit.characterId)?.name || credit.character;
      return `《${subjectName}》的「${characterName}」`;
    }).join('、');
    events.push({
      type: 'actor',
      id: actor.id,
      name: actor.name || actor.nameCn,
      originalName: actor.name,
      image: actor.image,
      month: actor.birthMonth,
      day: actor.birthDay,
      year: actor.birthYear,
      subtitle: creditText,
      searchText: actorSearchText(actor),
      url: `https://bgm.tv/person/${actor.id}`
    });
  }
  const query = state.calendarQuery.trim().toLowerCase();
  return events.filter(event => (state.calendarEntity === 'all' || event.type === state.calendarEntity) && (!query || event.searchText.includes(query)));
}

function renderCalendar() {
  const events = birthdayEvents();
  const hasBirthdayData = state.characters.some(item => item.birthMonth && item.birthDay) || voiceActorLibraryItems().some(item => item.birthMonth && item.birthDay);
  const birthdayPending = [...state.characters, ...voiceActorLibraryItems()].some(item => !item.birthdayLoaded);
  $('#calendarEmpty').hidden = hasBirthdayData;
  $('#monthCalendar').hidden = !hasBirthdayData || state.calendarView !== 'month';
  $('#yearBirthdayList').hidden = !hasBirthdayData || state.calendarView !== 'year';
  $$('.calendar-view-switch button').forEach(button => button.classList.toggle('active', button.dataset.calendarView === state.calendarView));
  $$('.calendar-entity-filter button').forEach(button => button.classList.toggle('active', button.dataset.entity === state.calendarEntity));
  if (!hasBirthdayData) {
    $('#calendarEmpty').innerHTML = birthdayPending
      ? '<i data-lucide="loader-circle"></i><strong>正在补全生日资料</strong><span>角色与声优生日加载完成后会自动更新日历</span>'
      : state.anime.length
      ? '<i data-lucide="cake-slice"></i><strong>片单中暂无生日资料</strong><span>Bangumi 尚未收录这些角色或声优的生日</span>'
      : '<i data-lucide="cake-slice"></i><strong>还没有生日数据</strong><span>导入片单后会自动解析角色与声优生日</span><button class="primary-btn" type="button" data-action="open-import">去导入</button>';
    bindRenderedActions();
    return;
  }
  renderMonthCalendar(events);
  renderYearBirthdays(events);
}

function renderMonthCalendar(events) {
  const year = state.calendarYear;
  const month = state.calendarMonth;
  $('#calendarMonthLabel').textContent = `${year} 年 ${month + 1} 月`;
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();
  const cells = [];
  for (let index = 0; index < 42; index++) {
    let cellMonth = month;
    let cellYear = year;
    let day = index - firstWeekday + 1;
    let outside = false;
    if (day <= 0) {
      day = prevMonthDays + day;
      cellMonth--;
      outside = true;
    } else if (day > daysInMonth) {
      day -= daysInMonth;
      cellMonth++;
      outside = true;
    }
    if (cellMonth < 0) { cellMonth = 11; cellYear--; }
    if (cellMonth > 11) { cellMonth = 0; cellYear++; }
    const dayEvents = events.filter(event => event.month === cellMonth + 1 && event.day === day);
    const isToday = cellYear === today.getFullYear() && cellMonth === today.getMonth() && day === today.getDate();
    const dots = dayEvents.slice(0, 5).map(event => `<i class="${event.type}"></i>`).join('');
    cells.push(`<button class="calendar-day ${outside ? 'outside' : ''} ${isToday ? 'today' : ''}" type="button" role="gridcell" data-calendar-date="${cellYear}-${cellMonth + 1}-${day}" aria-label="${cellMonth + 1}月${day}日，${dayEvents.length}个生日"><span class="day-number">${day}</span>${dayEvents.length ? `<span class="birthday-dots">${dots}</span><span class="birthday-count">${dayEvents.length} 个生日</span>` : ''}</button>`);
  }
  $('#calendarGrid').innerHTML = cells.join('');
  $$('.calendar-day[data-calendar-date]').forEach(button => button.addEventListener('click', () => {
    const [, monthValue, dayValue] = button.dataset.calendarDate.split('-').map(Number);
    openBirthdayDrawer(monthValue, dayValue, events);
  }));
}

function renderYearBirthdays(events) {
  const groups = Array.from({ length: 12 }, (_, index) => {
    const monthEvents = events.filter(event => event.month === index + 1).sort((a, b) => a.day - b.day || a.name.localeCompare(b.name, 'zh-CN'));
    if (!monthEvents.length) return '';
    const rows = monthEvents.map(event => birthdayRowHTML(event)).join('');
    return `<section class="birthday-month-group"><div class="birthday-month-label">${index + 1}月</div><div class="birthday-list-items">${rows}</div></section>`;
  }).join('');
  $('#yearBirthdayList').innerHTML = groups || '<div class="page-empty"><i data-lucide="search-x"></i><strong>没有匹配的生日</strong><span>调整对象筛选或搜索词</span></div>';
}

function birthdayRowHTML(event) {
  return `<div class="birthday-list-row"><span class="birthday-date">${event.month}/${event.day}</span><a href="${event.url}" target="_blank" rel="noopener"><img src="${esc(event.image || placeholder(event.name))}" alt="${esc(event.name)}" onerror="this.src='${placeholder(event.name)}'"></a><div><a class="bgm-link" href="${event.url}" target="_blank" rel="noopener"><strong>${esc(event.name)}</strong></a><small>${esc(event.subtitle || event.originalName || '')}</small></div><span class="entity-badge ${event.type}">${event.type === 'character' ? '角色' : '声优'}</span></div>`;
}

function openBirthdayDrawer(month, day, events = birthdayEvents()) {
  const matches = events.filter(event => event.month === month && event.day === day);
  if (!matches.length) return;
  $('#birthdayDrawerTitle').textContent = `${month} 月 ${day} 日`;
  $('#birthdayDrawerList').innerHTML = matches.map(event => `<div class="drawer-birthday"><a href="${event.url}" target="_blank" rel="noopener"><img src="${esc(event.image || placeholder(event.name))}" alt="${esc(event.name)}" onerror="this.src='${placeholder(event.name)}'"></a><div><a class="bgm-link" href="${event.url}" target="_blank" rel="noopener"><strong>${esc(event.name)}</strong></a><small>${esc(event.subtitle || event.originalName || '')}</small></div></div>`).join('');
  $('#birthdayDrawer').classList.add('open');
  $('#birthdayDrawer').setAttribute('aria-hidden', 'false');
  $('#birthdayDrawerBackdrop').classList.add('open');
}

function closeBirthdayDrawer() {
  $('#birthdayDrawer').classList.remove('open');
  $('#birthdayDrawer').setAttribute('aria-hidden', 'true');
  $('#birthdayDrawerBackdrop').classList.remove('open');
}

function changeMonth(delta) {
  const date = new Date(state.calendarYear, state.calendarMonth + delta, 1);
  state.calendarYear = date.getFullYear();
  state.calendarMonth = date.getMonth();
  renderCalendar();
}

function bindRenderedActions() {
  $$('.actor-summary').forEach(element => {
    element.addEventListener('click', () => element.parentElement.classList.toggle('open'));
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        element.click();
      }
    });
  });
  $$('.bgm-link').forEach(element => element.addEventListener('click', event => event.stopPropagation()));
  $$('[data-remove-subject]').forEach(button => button.addEventListener('click', () => removeSubject(button.dataset.removeSubject)));
  $$('[data-action="open-import"]').forEach(button => button.addEventListener('click', () => openSidebar(true)));
  if (window.lucide) lucide.createIcons();
}

function openSidebar(focusImport = false) {
  $('.sidebar').classList.add('open');
  document.body.classList.add('sidebar-open');
  $('#menuBtn').setAttribute('aria-expanded', 'true');
  $('#menuBtn').setAttribute('aria-label', '收起菜单');
  window.setTimeout(() => (focusImport ? $('#uidInput') : $('#sidebarClose')).focus(), 220);
}

function closeSidebar(returnFocus = false) {
  $('.sidebar').classList.remove('open');
  document.body.classList.remove('sidebar-open');
  $('#menuBtn').setAttribute('aria-expanded', 'false');
  $('#menuBtn').setAttribute('aria-label', '打开菜单');
  if (returnFocus) $('#menuBtn').focus();
}

function toggleSidebar() {
  $('.sidebar').classList.contains('open') ? closeSidebar(true) : openSidebar();
}

function openApiSearch() {
  $('#apiDialog').showModal();
  window.setTimeout(() => $('#apiSearchInput').focus(), 50);
}

function recapSlides() {
  const ranked = [...state.actors].sort((a, b) => weightedScore(b) - weightedScore(a) || b.credits.length - a.credits.length);
  const top = ranked[0];
  const roleTotals = state.actors.reduce((all, actor) => {
    actor.credits.forEach(credit => all[credit.role in ROLE ? credit.role : 'minor']++);
    return all;
  }, { main: 0, support: 0, guest: 0, minor: 0 });
  const roles = Object.values(roleTotals).reduce((sum, value) => sum + value, 0);
  const familiar = [...state.actors].sort((a, b) => new Set(b.credits.map(credit => credit.subjectId)).size - new Set(a.credits.map(credit => credit.subjectId)).size || weightedScore(b) - weightedScore(a))[0];
  const familiarWorks = new Set(familiar.credits.map(credit => credit.subjectId)).size;
  const years = state.anime.map(item => Number(item.date)).filter(year => year > 1900).sort((a, b) => a - b);
  const span = years.length > 1 ? years.at(-1) - years[0] + 1 : years.length;
  const podium = ranked.slice(0, 3).map((actor, index) => {
    const className = ['first', 'second', 'third'][index];
    const name = actor.nameCn || actor.name;
    return `<div class="podium-item ${className}"><span class="podium-rank">${index + 1}</span><a href="https://bgm.tv/person/${actor.id}" target="_blank" rel="noopener"><img class="podium-avatar" src="${esc(actor.image || placeholder(name))}" alt="${esc(name)}"></a><strong>${esc(name)}</strong><small>${actor.credits.length} 次出演 · 加权分 ${weightedScore(actor)}</small></div>`;
  }).join('');
  const roleCards = Object.entries(ROLE).map(([key, meta]) => `<div class="recap-role ${key}"><strong>${roleTotals[key]}</strong><span>${meta.label}角色</span></div>`).join('');
  const representative = [...top.credits].sort((a, b) => ROLE[b.role].weight - ROLE[a.role].weight)[0];
  const collectionLabel = state.collectionScope === 'all' ? '列表动画' : state.collectionScope === 'custom' ? '导入动画' : '看过动画';
  return [
    `<div class="recap-slide"><div class="recap-seal"><i data-lucide="award"></i></div><p class="recap-kicker">SEI TRACE AWARDS</p><h2 class="recap-title">恭喜你，成为了<br>名副其实的“声优痴”</h2><p class="recap-subtitle">${state.anime.length} 部动画、${state.actors.length} 种声音，共同组成了只属于你的声音图鉴。</p></div>`,
    `<div class="recap-slide"><p class="recap-kicker">YOUR SOUND UNIVERSE</p><span class="recap-big-number">${state.actors.length}</span><span class="recap-unit">位声优，出现在你的声音图鉴中</span><div class="recap-facts"><div class="recap-fact"><span>${collectionLabel}</span><strong>${state.anime.length} 部</strong></div><div class="recap-fact"><span>关联角色</span><strong>${roles} 个</strong></div><div class="recap-fact"><span>作品年代跨度</span><strong>${span || 0} 年</strong></div></div></div>`,
    `<div class="recap-slide"><p class="recap-kicker">TOP VOICES</p><h2 class="recap-title">你的声优领奖台</h2><p class="recap-subtitle">按角色权重与出演记录综合计算，这是你最熟悉的三种声音。</p><div class="podium">${podium}</div></div>`,
    `<div class="recap-slide"><p class="recap-kicker">ROLE SPECTRUM</p><h2 class="recap-title">你听过的角色，<br>不只一种分量</h2><div class="recap-role-grid">${roleCards}</div><p class="recap-subtitle">其中主角占 ${roles ? Math.round(roleTotals.main / roles * 100) : 0}%，共关联 ${roleTotals.main} 位主角。</p></div>`,
    `<div class="recap-slide"><p class="recap-kicker">MOST FAMILIAR</p><h2 class="recap-title">跨越最多作品的熟悉声线</h2><div class="recap-feature"><a href="https://bgm.tv/person/${familiar.id}" target="_blank" rel="noopener"><img src="${esc(familiar.image || placeholder(familiar.name))}" alt="${esc(familiar.nameCn || familiar.name)}"></a><div><h3>${esc(familiar.nameCn || familiar.name)}</h3><p>${esc(familiar.romaji || familiar.english || familiar.name || '')}</p><p class="recap-stat-line">在 ${familiarWorks} 部不同作品中与你相遇</p></div></div></div>`,
    `<div class="recap-slide"><div class="recap-seal"><i data-lucide="trophy"></i></div><p class="recap-kicker">YOUR NO. 1 VOICE</p><h2 class="recap-title">${esc(top.nameCn || top.name)}</h2><p class="recap-subtitle">凭 ${top.credits.length} 次出演与 ${weightedScore(top)} 加权分，成为你的声音冠军。代表相遇：${esc(representative.anime)}中的${esc(representative.character)}。</p><div class="recap-facts"><div class="recap-fact"><span>声音冠军</span><strong>第 1 名</strong></div><div class="recap-fact"><span>你的声音图鉴</span><strong>${state.actors.length} 位</strong></div><div class="recap-fact"><span>角色生日</span><strong>${state.characters.filter(item => item.birthMonth && item.birthDay).length} 位</strong></div></div></div>`
  ];
}

function renderRecap() {
  const slides = recapSlides();
  recapIndex = Math.max(0, Math.min(recapIndex, slides.length - 1));
  $('#recapStage').innerHTML = slides[recapIndex];
  $('#recapSteps').innerHTML = slides.map((_, index) => `<span class="${index < recapIndex ? 'done' : index === recapIndex ? 'active' : ''}"></span>`).join('');
  $('#recapCounter').textContent = `${recapIndex + 1} / ${slides.length}`;
  $('#recapPrev').disabled = recapIndex === 0;
  $('#recapNext').innerHTML = recapIndex === slides.length - 1 ? '<span>完成</span><i data-lucide="check"></i>' : '<span>继续</span><i data-lucide="arrow-right"></i>';
  $('#recap').classList.toggle('paused', !recapPlaying);
  $('#recapPlay').innerHTML = recapPlaying ? '<i data-lucide="pause"></i>' : '<i data-lucide="play"></i>';
  $('#recapPlay').setAttribute('aria-label', recapPlaying ? '暂停自动播放' : '继续自动播放');
  clearTimeout(recapTimer);
  if (recapPlaying && recapIndex < slides.length - 1) recapTimer = setTimeout(() => {
    recapIndex++;
    renderRecap();
  }, 6000);
  if (window.lucide) lucide.createIcons();
}

function openRecap() {
  if (!state.actors.length) return notice('导入片单并完成统计后，才能生成声迹颁奖礼。');
  closeSidebar();
  recapIndex = 0;
  recapPlaying = true;
  $('#recap').hidden = false;
  document.body.style.overflow = 'hidden';
  renderRecap();
}

function closeRecap() {
  clearTimeout(recapTimer);
  $('#recap').hidden = true;
  document.body.style.overflow = '';
}

function bind() {
  $('#uidImportBtn').addEventListener('click', () => { importUid(); closeSidebar(); });
  $('#uidInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') { importUid(); closeSidebar(); }
  });
  $('#batchToggle').addEventListener('click', () => { closeSidebar(); $('#batchDialog').showModal(); });
  $('#batchImportBtn').addEventListener('click', () => importIds());
  $('#apiSearchBtn').addEventListener('click', openApiSearch);
  $('#libraryApiSearchBtn').addEventListener('click', openApiSearch);
  $('#apiSearchSubmit').addEventListener('click', searchApi);
  $('#apiSearchInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); searchApi(); }
  });
  $('#libraryIdAddBtn').addEventListener('click', () => importIds($('#libraryIdInput').value));
  $('#libraryIdInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') importIds(event.currentTarget.value);
  });
  $('#characterIdAddBtn').addEventListener('click', importCharacter);
  $('#characterIdInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') importCharacter();
  });
  $('#characterLoadConfirmBtn').addEventListener('click', async () => {
    $('#characterLoadDialog').close();
    setView('characters', { skipCharacterPrompt: true });
    await ensureCharacterDetails({ markLibraryLoaded: true });
  });
  $('#actorLibraryIdAddBtn').addEventListener('click', importActor);
  $('#actorLibraryIdInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') importActor();
  });
  $('#actorLoadConfirmBtn').addEventListener('click', async () => {
    $('#actorLoadDialog').close();
    setView('actors', { skipActorPrompt: true });
    await ensureActorDetails({ markLibraryLoaded: true });
  });
  $('#librarySearch').addEventListener('input', event => {
    state.libraryQuery = event.currentTarget.value;
    $('#searchInput').value = state.libraryQuery;
    renderLibraryPage();
    if (state.libraryQuery.trim()) ensureSubjectDetails();
  });
  $('#characterSearch').addEventListener('input', event => {
    state.characterQuery = event.currentTarget.value;
    $('#searchInput').value = state.characterQuery;
    renderCharacters();
  });
  $('#characterGenderFilter').addEventListener('change', event => {
    state.characterGender = event.currentTarget.value;
    renderCharacters();
  });
  $('#characterSubjectFilter').addEventListener('change', event => {
    state.characterSubject = event.currentTarget.value;
    renderCharacters();
  });
  $('#actorLibrarySearch').addEventListener('input', event => {
    state.actorLibraryQuery = event.currentTarget.value;
    $('#searchInput').value = state.actorLibraryQuery;
    renderActorLibrary();
  });
  $('#actorLibraryGenderFilter').addEventListener('change', event => {
    state.actorLibraryGender = event.currentTarget.value;
    renderActorLibrary();
  });
  $('#actorLibrarySubjectFilter').addEventListener('change', event => {
    state.actorLibrarySubject = event.currentTarget.value;
    renderActorLibrary();
  });
  $('#searchInput').addEventListener('input', event => {
    const value = event.currentTarget.value;
    if (state.view === 'stats') state.query = value;
    if (state.view === 'calendar') state.calendarQuery = value;
    if (state.view === 'characters') { state.characterQuery = value; $('#characterSearch').value = value; }
    if (state.view === 'actors') { state.actorLibraryQuery = value; $('#actorLibrarySearch').value = value; }
    if (state.view === 'library') { state.libraryQuery = value; $('#librarySearch').value = value; }
    renderCurrent();
    if (value.trim() && (state.view === 'stats' || state.view === 'library')) ensureSubjectDetails();
  });
  $$('.nav-item[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  $('[data-action="focus-search"]').addEventListener('click', () => {
    setView('library');
    $('#librarySearch').focus();
  });
  $$('[data-action="open-recap"]').forEach(element => element.addEventListener('click', openRecap));
  $$('.segmented button[data-mode]').forEach(button => button.addEventListener('click', () => {
    $$('.segmented button[data-mode]').forEach(item => {
      item.classList.remove('active');
      item.setAttribute('aria-pressed', 'false');
    });
    button.classList.add('active');
    button.setAttribute('aria-pressed', 'true');
    state.mode = button.dataset.mode;
    renderStats();
  }));
  $$('.filter-chip[data-role]').forEach(button => button.addEventListener('click', () => {
    $$('.filter-chip[data-role]').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    state.role = button.dataset.role;
    renderStats();
  }));
  $$('.filter-chip[data-character-role]').forEach(button => button.addEventListener('click', () => {
    $$('.filter-chip[data-character-role]').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    state.characterRole = button.dataset.characterRole;
    renderCharacters();
  }));
  $$('.calendar-view-switch button').forEach(button => button.addEventListener('click', () => {
    state.calendarView = button.dataset.calendarView;
    renderCalendar();
  }));
  $$('.calendar-entity-filter button').forEach(button => button.addEventListener('click', () => {
    state.calendarEntity = button.dataset.entity;
    renderCalendar();
  }));
  $('#prevMonthBtn').addEventListener('click', () => changeMonth(-1));
  $('#nextMonthBtn').addEventListener('click', () => changeMonth(1));
  $('#todayBtn').addEventListener('click', () => {
    state.calendarYear = today.getFullYear();
    state.calendarMonth = today.getMonth();
    renderCalendar();
  });
  $('#calendarGrid').addEventListener('pointerdown', event => {
    calendarPointerStart = { x: event.clientX, y: event.clientY };
  });
  $('#calendarGrid').addEventListener('pointerup', event => {
    if (!calendarPointerStart) return;
    const dx = event.clientX - calendarPointerStart.x;
    const dy = event.clientY - calendarPointerStart.y;
    calendarPointerStart = null;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) changeMonth(dx < 0 ? 1 : -1);
  });
  $('#birthdayDrawerClose').addEventListener('click', closeBirthdayDrawer);
  $('#birthdayDrawerBackdrop').addEventListener('click', closeBirthdayDrawer);
  $('#cancelBtn').addEventListener('click', () => state.controller?.abort());
  $('#refreshBtn').addEventListener('click', () => state.anime.length ? importSubjects(state.anime, state.source, state.collectionScope, { force: true }) : notice('当前没有可重新统计的作品。'));
  $('#menuBtn').addEventListener('click', toggleSidebar);
  $('#sidebarClose').addEventListener('click', () => closeSidebar(true));
  $('#sidebarBackdrop').addEventListener('click', () => closeSidebar(true));
  $('#mobileImportGuide').addEventListener('click', () => openSidebar(true));
  $('.sidebar .brand').addEventListener('click', event => { event.preventDefault(); setView('stats'); });
  $('.sidebar').addEventListener('pointerdown', event => {
    sidebarPointerStart = { x: event.clientX, y: event.clientY };
  });
  $('.sidebar').addEventListener('pointerup', event => {
    if (!sidebarPointerStart) return;
    const dx = event.clientX - sidebarPointerStart.x;
    const dy = event.clientY - sidebarPointerStart.y;
    sidebarPointerStart = null;
    if (dx < -55 && Math.abs(dx) > Math.abs(dy)) closeSidebar(true);
  });
  $('#clearBtn').addEventListener('click', () => {
    localStorage.removeItem('seitrace-data');
    Object.assign(state, {
      anime: [], actors: [], characters: [], manualActors: [], source: 'Waiting for import',
      collectionScope: 'watched', query: '', characterQuery: '', libraryQuery: '', calendarQuery: '',
      characterRole: 'all', characterGender: 'all', characterSubject: 'all',
      actorLibraryQuery: '', actorLibraryGender: 'all', actorLibrarySubject: 'all',
      characterLibraryLoaded: false, actorLibraryLoaded: false
    });
    $('#searchInput').value = '';
    $('#librarySearch').value = '';
    $('#characterSearch').value = '';
    $('#characterIdInput').value = '';
    $('#characterGenderFilter').value = 'all';
    $('#characterSubjectFilter').value = 'all';
    $('#actorLibrarySearch').value = '';
    $('#actorLibraryIdInput').value = '';
    $('#actorLibraryGenderFilter').value = 'all';
    $('#actorLibrarySubjectFilter').value = 'all';
    $('input[name="collectionScope"][value="watched"]').checked = true;
    $('#syncTitle').textContent = '尚未导入';
    $('#syncTime').textContent = '导入后将缓存在本机';
    $('#syncDot').removeAttribute('style');
    $('#syncDot').classList.add('empty');
    notice('已清空本地导入数据。');
    renderCurrent();
  });
  $('#recapBtn').addEventListener('click', openRecap);
  $('#recapClose').addEventListener('click', closeRecap);
  $('.recap-brand').addEventListener('click', event => event.preventDefault());
  $('#recapPrev').addEventListener('click', () => {
    if (recapIndex > 0) { recapIndex--; renderRecap(); }
  });
  $('#recapNext').addEventListener('click', () => {
    const last = recapSlides().length - 1;
    if (recapIndex >= last) closeRecap();
    else { recapIndex++; renderRecap(); }
  });
  $('#recapPlay').addEventListener('click', () => {
    recapPlaying = !recapPlaying;
    renderRecap();
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#searchInput').focus();
    }
    if (event.key === 'Escape') {
      if ($('.sidebar').classList.contains('open')) closeSidebar(true);
      if ($('#birthdayDrawer').classList.contains('open')) closeBirthdayDrawer();
      if (!$('#recap').hidden) closeRecap();
    }
    if (!$('#recap').hidden && event.key === 'ArrowRight') $('#recapNext').click();
    if (!$('#recap').hidden && event.key === 'ArrowLeft') $('#recapPrev').click();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 940 && $('.sidebar').classList.contains('open')) closeSidebar();
  });
}

try {
  const saved = JSON.parse(localStorage.getItem('seitrace-data'));
  const isOldDemo = saved?.source === 'Demo Collection' || saved?.actors?.some(actor => String(actor.id).startsWith('demo-'));
  if (isOldDemo) {
    localStorage.removeItem('seitrace-data');
  } else if (saved && (saved.anime?.length || saved.actors?.length || saved.characters?.length || saved.manualActors?.length)) {
    const savedSchema = Number(saved.schemaVersion) || 0;
    state.anime = saved.anime || [];
    state.actors = (saved.actors || []).map(actor => ({
      ...actor,
      birthdayLoaded: actor.birthdayLoaded ?? Boolean(actor.detailLoaded),
      detailLoaded: savedSchema >= DATA_SCHEMA ? Boolean(actor.detailLoaded) : false
    }));
    state.characters = (saved.characters || []).map(character => ({
      ...character,
      birthdayLoaded: character.birthdayLoaded ?? Boolean(character.detailLoaded)
    }));
    state.manualActors = (saved.manualActors || []).map(actor => ({
      ...actor,
      birthdayLoaded: actor.birthdayLoaded ?? Boolean(actor.detailLoaded)
    }));
    state.source = saved.source || '本地收藏';
    state.collectionScope = saved.collectionScope || 'watched';
    state.characterLibraryLoaded = saved.characterLibraryLoaded ?? Boolean(
      state.characters.length && state.characters.every(character => character.detailLoaded)
    );
    state.actorLibraryLoaded = savedSchema >= DATA_SCHEMA
      ? Boolean(saved.actorLibraryLoaded)
      : false;
    needsCacheUpgrade = saved.schemaVersion !== DATA_SCHEMA;
    const scopeInput = $(`input[name="collectionScope"][value="${state.collectionScope}"]`);
    if (scopeInput) scopeInput.checked = true;
    $('#syncTitle').textContent = state.source;
    $('#syncTime').textContent = saved.savedAt ? new Date(saved.savedAt).toLocaleString('zh-CN') : '本机缓存';
    $('#syncDot').classList.remove('empty');
    $('#syncDot').style.background = 'var(--mint)';
  }
} catch {}

bind();
renderCurrent();
const recapHash = location.hash.match(/^#recap-(\d+)$/);
if (recapHash && state.actors.length) {
  openRecap();
  recapIndex = Math.min(5, Math.max(0, Number(recapHash[1]) - 1));
  renderRecap();
}
if (needsCacheUpgrade) persistState();
if ([...state.characters, ...state.actors, ...state.manualActors].some(item => !item.birthdayLoaded)) {
  ensureBirthdayProfiles();
}
