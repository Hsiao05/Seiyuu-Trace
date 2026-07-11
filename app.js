const API = 'https://api.bgm.tv';
const ROLE = {
  main: { label: '主角', weight: 4 },
  support: { label: '配角', weight: 2 },
  guest: { label: '客串', weight: 1 },
  minor: { label: '闲角', weight: 0.5 }
};

const state = {
  anime: [],
  actors: [],
  source: 'Waiting for import',
  mode: 'weighted', role: 'all', query: '', controller: null
};
let recapIndex = 0;
let recapTimer = null;
let recapPlaying = true;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const placeholder = (name='?') => `https://ui-avatars.com/api/?name=${encodeURIComponent(name.slice(0,2))}&background=e4f4f0&color=278d7d&size=96`;
const animeById = id => state.anime.find(a => String(a.id) === String(id));

function weightedScore(actor) { return actor.credits.reduce((n,c) => n + ROLE[c.role].weight, 0); }
function score(actor) { return state.mode === 'weighted' ? weightedScore(actor) : actor.credits.length; }
function counts(actor) { return actor.credits.reduce((o,c) => (o[c.role]++, o), {main:0,support:0,guest:0,minor:0}); }

function render() {
  const q = state.query.trim().toLowerCase();
  const actors = state.actors.filter(a => {
    const roleMatch = state.role === 'all' || a.credits.some(c => c.role === state.role);
    const text = [a.name,a.latin,...a.credits.flatMap(c => [c.anime,c.character])].join(' ').toLowerCase();
    return roleMatch && (!q || text.includes(q));
  }).sort((a,b) => score(b) - score(a) || b.credits.length - a.credits.length);
  const roles = state.actors.reduce((n,a) => n + a.credits.length, 0);
  $('#animeCount').textContent = state.anime.length;
  $('#actorCount').textContent = state.actors.length;
  $('#roleCount').textContent = roles;
  $('#navAnimeCount').textContent = state.anime.length;
  $('#sourceLabel').textContent = state.source.toUpperCase();
  $('#mobileImportGuide').hidden = state.anime.length > 0 || state.actors.length > 0;
  $('#scoreHeading').textContent = state.mode === 'weighted' ? '出演数 / 加权分' : '出演数';
  $('#rankingHint').textContent = state.mode === 'weighted' ? '综合角色类型与出演次数计算熟悉度' : '每条出演记录等权，按总次数排序';
  $('#rankingList').innerHTML = actors.map((a,i) => actorHTML(a,i)).join('');
  $('#emptyState').hidden = actors.length > 0;
  $('#rankingList').hidden = actors.length === 0;
  if (!actors.length) {
    const isEmpty = !state.anime.length && !state.actors.length;
    $('#emptyState').innerHTML = isEmpty
      ? '<i data-lucide="inbox"></i><strong>还没有导入片单</strong><span>从左侧输入 Bangumi UID，或按作品 ID 批量导入</span><button id="emptyImportBtn" class="primary-btn" type="button"><i data-lucide="download"></i>开始导入</button>'
      : '<i data-lucide="search-x"></i><strong>没有找到匹配结果</strong><span>换个关键词或角色分类试试</span>';
    $('#emptyImportBtn')?.addEventListener('click', () => $('#batchDialog').showModal());
  }
  $$('.actor-summary').forEach(el => el.addEventListener('click', () => el.parentElement.classList.toggle('open')));
  $$('.actor-summary').forEach(el => el.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }}));
  $$('.bgm-link').forEach(el => el.addEventListener('click', e => e.stopPropagation()));
  if (window.lucide) lucide.createIcons();
}

function actorHTML(a, i) {
  const c = counts(a), total = Math.max(1,a.credits.length), weighted = weightedScore(a);
  const bars = Object.keys(ROLE).map(r => `<span data-role="${r}" style="width:${c[r]/total*100}%"></span>`).join('');
  const labels = Object.keys(ROLE).filter(r => c[r]).map(r => `<span><i class="dot ${r}"></i>${ROLE[r].label} ${c[r]}</span>`).join('');
  const credits = a.credits.map(cr => {
    const anime = animeById(cr.subjectId);
    const subjectUrl = `https://bgm.tv/subject/${encodeURIComponent(cr.subjectId)}`;
    const characterUrl = cr.characterId ? `https://bgm.tv/character/${encodeURIComponent(cr.characterId)}` : `https://bgm.tv/mono_search/${encodeURIComponent(cr.character)}?cat=crt`;
    return `<div class="credit"><a class="cover-link bgm-link" href="${subjectUrl}" target="_blank" rel="noopener"><img class="credit-cover" src="${esc(anime?.image || '')}" alt="${esc(cr.anime)}" onerror="this.style.visibility='hidden'"></a><div><a class="bgm-link" href="${subjectUrl}" target="_blank" rel="noopener"><strong>${esc(cr.anime)}</strong></a><a class="bgm-link" href="${characterUrl}" target="_blank" rel="noopener"><small>${esc(cr.character)}</small></a></div><span class="role-badge">${ROLE[cr.role].label}</span></div>`;
  }).join('');
  const personUrl = `https://bgm.tv/person/${encodeURIComponent(a.id)}`;
  const scoreNote = state.mode === 'weighted' ? `加权分 ${Number.isInteger(weighted)?weighted:weighted.toFixed(1)}` : '次出演';
  return `<article class="actor-row"><div class="actor-summary" role="button" aria-label="展开 ${esc(a.name)} 的出演详情" tabindex="0"><div class="actor-identity"><span class="rank ${i<3?'top':''}">${String(i+1).padStart(2,'0')}</span><a class="avatar-link bgm-link" href="${personUrl}" target="_blank" rel="noopener"><img class="avatar" src="${esc(a.image || placeholder(a.name))}" alt="${esc(a.name)}" onerror="this.src='${placeholder(a.name)}'"></a><div class="actor-name"><a class="bgm-link" href="${personUrl}" target="_blank" rel="noopener"><strong>${esc(a.name)}</strong></a><small>${esc(a.latin || `${a.credits.length} 条出演记录`)}</small></div></div><div class="composition"><div class="bar">${bars}</div><div class="counts">${labels}</div></div><div class="score"><strong>${a.credits.length}</strong><small>${scoreNote}</small></div><i class="chevron" data-lucide="chevron-down"></i></div><div class="actor-detail"><div class="credit-grid">${credits}</div></div></article>`;
}

async function api(path, options={}) {
  const res = await fetch(`${API}${path}`, { ...options, headers: { 'Accept':'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers }, signal: options.signal });
  if (!res.ok) throw new Error(res.status === 404 ? '没有找到对应数据' : `Bangumi API 返回 ${res.status}`);
  return res.json();
}

function setProgress(done,total,text) {
  const p = total ? Math.round(done/total*100) : 0;
  $('#progressPanel').hidden = false; $('#progressText').textContent = text; $('#progressPercent').textContent = `${p}%`; $('#progressBar').style.width = `${p}%`;
}
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = !message; }

async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({length: Math.min(limit,items.length)}, async () => { while(cursor < items.length) { const item = items[cursor++]; await worker(item); } });
  await Promise.all(runners);
}

function normalizeSubject(raw) {
  const s = raw.subject || raw;
  return { id: s.id, name: s.name_cn || s.name || `#${s.id}`, date: String(s.date || '').slice(0,4), image: s.images?.large || s.images?.common || '' };
}
function mapRole(item) {
  const type = Number(item.type ?? item.character?.type);
  const rel = String(item.relation || '').toLowerCase();
  if (type === 1 || /主角|main/.test(rel)) return 'main';
  if (type === 2 || /配角|support/.test(rel)) return 'support';
  if (type === 3 || /客串|guest/.test(rel)) return 'guest';
  return 'minor';
}
function extractActors(subject, characterRows) {
  const out = [];
  for (const row of characterRows || []) {
    const character = row.character || row;
    const role = mapRole(row);
    for (const person of row.actors || character.actors || []) {
      out.push({ person, credit: { anime: subject.name, character: character.name_cn || character.name || '未命名角色', characterId: character.id, role, subjectId: subject.id } });
    }
  }
  return out;
}

async function importSubjects(subjects, source) {
  state.controller?.abort(); state.controller = new AbortController();
  const signal = state.controller.signal, actorMap = new Map(), errors = [];
  setProgress(0, subjects.length, '准备读取作品角色…'); notice('');
  let done = 0;
  try {
    await pool(subjects, 4, async subject => {
      try {
        const rows = await api(`/v0/subjects/${subject.id}/characters`, {signal});
        for (const item of extractActors(subject, rows)) {
          const p = item.person, key = String(p.id || p.name);
          if (!actorMap.has(key)) actorMap.set(key, { id:p.id, name:p.name_cn || p.name, latin:p.name_cn ? p.name : '', image:p.images?.medium || p.images?.small || '', credits:[] });
          actorMap.get(key).credits.push(item.credit);
        }
      } catch (e) { if (e.name !== 'AbortError') errors.push(subject.name); else throw e; }
      done++; setProgress(done,subjects.length,`正在读取角色与声优 · ${subject.name}`);
    });
    state.anime = subjects; state.actors = [...actorMap.values()]; state.source = source;
    localStorage.setItem('seitrace-data', JSON.stringify({anime:state.anime,actors:state.actors,source:state.source,savedAt:Date.now()}));
    $('#syncTitle').textContent = source; $('#syncTime').textContent = '刚刚同步'; $('#syncDot').classList.remove('empty'); $('#syncDot').style.background = 'var(--mint)';
    if (errors.length) notice(`${errors.length} 部作品未能读取角色资料，其余结果已完成。`);
    render();
  } catch(e) {
    if (e.name !== 'AbortError') notice(e.message || '导入失败，请稍后重试。');
  } finally { $('#progressPanel').hidden = true; state.controller = null; }
}

async function importUid() {
  const uid = $('#uidInput').value.trim(); if (!uid) return notice('请输入 Bangumi UID 或用户名。');
  state.controller?.abort(); state.controller = new AbortController();
  const signal = state.controller.signal, rows = []; let offset = 0;
  setProgress(0,1,'正在读取看过的动画…'); notice('');
  try {
    while(true) {
      const page = await api(`/v0/users/${encodeURIComponent(uid)}/collections?subject_type=2&type=2&limit=50&offset=${offset}`, {signal});
      rows.push(...(page.data || []));
      const total = page.total || rows.length; setProgress(rows.length,total,`已读取 ${Math.min(rows.length,total)} / ${total} 部动画`);
      if (!page.data?.length || rows.length >= total) break; offset += page.data.length;
    }
    const unique = [...new Map(rows.map(r => { const s=normalizeSubject(r); return [s.id,s]; })).values()];
    if (!unique.length) throw new Error('该用户没有公开的“看过”动画，或收藏设置为私密。');
    await importSubjects(unique, `Bangumi · ${uid}`);
  } catch(e) { $('#progressPanel').hidden=true; if(e.name!=='AbortError') notice(e.message || 'UID 导入失败，请确认用户存在且收藏公开。'); }
}

async function importIds() {
  const ids = [...new Set($('#batchInput').value.split(/\s+/).map(v=>v.trim()).filter(v=>/^\d+$/.test(v)))];
  if (!ids.length) return notice('请至少输入一个有效的数字作品 ID。');
  $('#batchDialog').close(); state.controller = new AbortController(); const subjects=[]; let done=0;
  setProgress(0,ids.length,'正在读取作品信息…');
  try {
    await pool(ids,4,async id => { try { subjects.push(normalizeSubject(await api(`/v0/subjects/${id}`,{signal:state.controller.signal}))); } catch(e) { if(e.name==='AbortError') throw e; } finally { done++; setProgress(done,ids.length,`正在识别作品 · ${id}`); } });
    const merged = [...new Map([...state.anime,...subjects].map(s=>[s.id,s])).values()];
    await importSubjects(merged,'批量作品 ID');
  } catch(e) { $('#progressPanel').hidden=true; if(e.name!=='AbortError') notice(e.message); }
}

async function searchApi() {
  const q=$('#apiSearchInput').value.trim(); if(!q) return;
  $('#apiSearchProgress').hidden=false; $('#apiResults').innerHTML='';
  try {
    const data=await api('/v0/search/subjects',{method:'POST',body:JSON.stringify({keyword:q,filter:{type:[2]}})});
    const rows=(data.data||[]).slice(0,12);
    $('#apiResults').innerHTML=rows.length?rows.map(raw=>{const s=normalizeSubject(raw);const url=`https://bgm.tv/subject/${s.id}`;return `<div class="api-result"><a class="cover-link bgm-link" href="${url}" target="_blank" rel="noopener"><img src="${esc(s.image)}" alt="${esc(s.name)}"></a><div><a class="bgm-link" href="${url}" target="_blank" rel="noopener"><strong>${esc(s.name)}</strong></a><small>${esc(s.date||'年份未知')} · ID ${s.id}</small></div><button class="secondary-btn add-result" type="button" data-id="${s.id}">添加</button></div>`}).join(''):'<p class="dialog-placeholder">没有找到动画结果</p>';
    $$('.add-result').forEach(btn=>btn.addEventListener('click',()=>{ $('#batchInput').value=btn.dataset.id; $('#apiDialog').close(); importIds(); }));
  } catch(e) { $('#apiResults').innerHTML=`<p class="dialog-placeholder">${esc(e.message)}</p>`; }
  finally { $('#apiSearchProgress').hidden=true; }
}

function renderLibrary() {
  if (!state.anime.length) {
    $('#libraryGrid').innerHTML = '<p class="dialog-placeholder">还没有导入任何片目</p>';
    return;
  }
  $('#libraryGrid').innerHTML=state.anime.map(a=>{const url=`https://bgm.tv/subject/${a.id}`;return `<div class="library-card"><a class="cover-link bgm-link" href="${url}" target="_blank" rel="noopener"><img src="${esc(a.image)}" alt="${esc(a.name)}" onerror="this.style.visibility='hidden'"></a><a class="bgm-link" href="${url}" target="_blank" rel="noopener"><strong>${esc(a.name)}</strong></a><small>${esc(a.date||'年份未知')} · ID ${a.id}</small></div>`}).join('');
}

function recapSlides() {
  const ranked = [...state.actors].sort((a,b) => weightedScore(b) - weightedScore(a) || b.credits.length - a.credits.length);
  const top = ranked[0];
  const roleTotals = state.actors.reduce((all,a) => { a.credits.forEach(c => all[c.role]++); return all; }, {main:0,support:0,guest:0,minor:0});
  const roles = Object.values(roleTotals).reduce((n,v) => n+v, 0);
  const familiar = [...state.actors].sort((a,b) => new Set(b.credits.map(c=>c.subjectId)).size - new Set(a.credits.map(c=>c.subjectId)).size || weightedScore(b)-weightedScore(a))[0];
  const familiarWorks = new Set(familiar.credits.map(c=>c.subjectId)).size;
  const years = state.anime.map(a=>Number(a.date)).filter(y=>y>1900).sort((a,b)=>a-b);
  const span = years.length > 1 ? years.at(-1)-years[0]+1 : years.length;
  const podium = ranked.slice(0,3).map((a,i) => {
    const cls = ['first','second','third'][i];
    return `<div class="podium-item ${cls}"><span class="podium-rank">${i+1}</span><a href="https://bgm.tv/person/${a.id}" target="_blank" rel="noopener"><img class="podium-avatar" src="${esc(a.image||placeholder(a.name))}" alt="${esc(a.name)}"></a><strong>${esc(a.name)}</strong><small>${a.credits.length} 次出演 · 加权分 ${weightedScore(a)}</small></div>`;
  }).join('');
  const roleCards = Object.entries(ROLE).map(([key,meta]) => `<div class="recap-role ${key}"><strong>${roleTotals[key]}</strong><span>${meta.label}角色</span></div>`).join('');
  const representative = [...top.credits].sort((a,b)=>ROLE[b.role].weight-ROLE[a.role].weight)[0];
  return [
    `<div class="recap-slide"><div class="recap-seal"><i data-lucide="award"></i></div><p class="recap-kicker">SEI TRACE AWARDS</p><h2 class="recap-title">恭喜你，成为了<br>名副其实的“声优痴”</h2><p class="recap-subtitle">${state.anime.length} 部动画、${state.actors.length} 种声音，共同组成了只属于你的声音图鉴。</p></div>`,
    `<div class="recap-slide"><p class="recap-kicker">YOUR SOUND UNIVERSE</p><span class="recap-big-number">${state.actors.length}</span><span class="recap-unit">位声优，曾在你的耳边留下声音</span><div class="recap-facts"><div class="recap-fact"><span>看过动画</span><strong>${state.anime.length} 部</strong></div><div class="recap-fact"><span>相遇角色</span><strong>${roles} 个</strong></div><div class="recap-fact"><span>作品年代跨度</span><strong>${span || 0} 年</strong></div></div></div>`,
    `<div class="recap-slide"><p class="recap-kicker">TOP VOICES</p><h2 class="recap-title">你的声优领奖台</h2><p class="recap-subtitle">按角色权重与出演记录综合计算，这是你最熟悉的三种声音。</p><div class="podium">${podium}</div></div>`,
    `<div class="recap-slide"><p class="recap-kicker">ROLE SPECTRUM</p><h2 class="recap-title">你听过的角色，<br>不只一种分量</h2><div class="recap-role-grid">${roleCards}</div><p class="recap-subtitle">其中主角占 ${roles ? Math.round(roleTotals.main/roles*100) : 0}%，你共听过 ${roleTotals.main} 位主角的声音。</p></div>`,
    `<div class="recap-slide"><p class="recap-kicker">MOST FAMILIAR</p><h2 class="recap-title">跨越最多作品的熟悉声线</h2><div class="recap-feature"><a href="https://bgm.tv/person/${familiar.id}" target="_blank" rel="noopener"><img src="${esc(familiar.image||placeholder(familiar.name))}" alt="${esc(familiar.name)}"></a><div><h3>${esc(familiar.name)}</h3><p>${esc(familiar.latin||'')}</p><p class="recap-stat-line">在 ${familiarWorks} 部不同作品中与你相遇</p></div></div></div>`,
    `<div class="recap-slide"><div class="recap-seal"><i data-lucide="trophy"></i></div><p class="recap-kicker">YOUR NO. 1 VOICE</p><h2 class="recap-title">${esc(top.name)}</h2><p class="recap-subtitle">凭 ${top.credits.length} 次出演与 ${weightedScore(top)} 加权分，成为你的年度声音冠军。代表相遇：${esc(representative.anime)}中的${esc(representative.character)}。</p><div class="recap-facts"><div class="recap-fact"><span>声音冠军</span><strong>第 1 名</strong></div><div class="recap-fact"><span>你的声音图鉴</span><strong>${state.actors.length} 位</strong></div><div class="recap-fact"><span>声迹仍在继续</span><strong>${state.anime.length} 部</strong></div></div></div>`
  ];
}

function renderRecap() {
  const slides = recapSlides();
  recapIndex = Math.max(0,Math.min(recapIndex,slides.length-1));
  $('#recapStage').innerHTML = slides[recapIndex];
  $('#recapSteps').innerHTML = slides.map((_,i)=>`<span class="${i<recapIndex?'done':i===recapIndex?'active':''}"></span>`).join('');
  $('#recapCounter').textContent = `${recapIndex+1} / ${slides.length}`;
  $('#recapPrev').disabled = recapIndex === 0;
  $('#recapNext').innerHTML = recapIndex === slides.length-1 ? '<span>完成</span><i data-lucide="check"></i>' : '<span>继续</span><i data-lucide="arrow-right"></i>';
  $('#recap').classList.toggle('paused',!recapPlaying);
  $('#recapPlay').innerHTML = recapPlaying ? '<i data-lucide="pause"></i>' : '<i data-lucide="play"></i>';
  $('#recapPlay').setAttribute('aria-label',recapPlaying?'暂停自动播放':'继续自动播放');
  clearTimeout(recapTimer);
  if (recapPlaying && recapIndex < slides.length-1) recapTimer=setTimeout(()=>{recapIndex++;renderRecap();},6000);
  if(window.lucide) lucide.createIcons();
}

function openRecap() {
  if(!state.actors.length) return notice('导入片单并完成统计后，才能生成你的声迹颁奖礼。');
  recapIndex=0; recapPlaying=true; $('#recap').hidden=false; document.body.style.overflow='hidden'; renderRecap();
}
function closeRecap() { clearTimeout(recapTimer); $('#recap').hidden=true; document.body.style.overflow=''; }

function openSidebar(focusImport=false) {
  $('.sidebar').classList.add('open');
  document.body.classList.add('sidebar-open');
  $('#menuBtn').setAttribute('aria-expanded','true');
  $('#menuBtn').setAttribute('aria-label','收起菜单');
  window.setTimeout(() => (focusImport ? $('#uidInput') : $('#sidebarClose')).focus(), 220);
}
function closeSidebar(returnFocus=false) {
  $('.sidebar').classList.remove('open');
  document.body.classList.remove('sidebar-open');
  $('#menuBtn').setAttribute('aria-expanded','false');
  $('#menuBtn').setAttribute('aria-label','打开菜单');
  if(returnFocus) $('#menuBtn').focus();
}
function toggleSidebar() {
  $('.sidebar').classList.contains('open') ? closeSidebar(true) : openSidebar();
}

function bind() {
  $('#uidImportBtn').addEventListener('click',()=>{importUid();closeSidebar();}); $('#uidInput').addEventListener('keydown',e=>{if(e.key==='Enter'){importUid();closeSidebar();}});
  $('#batchToggle').addEventListener('click',()=>{closeSidebar();$('#batchDialog').showModal();}); $('#batchImportBtn').addEventListener('click',importIds);
  $('#apiSearchBtn').addEventListener('click',()=>{$('#apiDialog').showModal(); setTimeout(()=>$('#apiSearchInput').focus(),50);});
  $('[data-action="focus-search"]').addEventListener('click',()=>$('#searchInput').focus());
  $('[data-action="show-library"]').addEventListener('click',()=>{renderLibrary();$('#libraryDialog').showModal();});
  $('#apiSearchSubmit').addEventListener('click',searchApi); $('#apiSearchInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();searchApi();}});
  $('#searchInput').addEventListener('input',e=>{state.query=e.target.value;render();});
  $$('.segmented button').forEach(b=>b.addEventListener('click',()=>{$$('.segmented button').forEach(x=>{x.classList.remove('active');x.setAttribute('aria-pressed','false')});b.classList.add('active');b.setAttribute('aria-pressed','true');state.mode=b.dataset.mode;render();}));
  $$('.filter-chip').forEach(b=>b.addEventListener('click',()=>{$$('.filter-chip').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.role=b.dataset.role;render();}));
  $('#cancelBtn').addEventListener('click',()=>state.controller?.abort());
  $('#refreshBtn').addEventListener('click',()=>state.anime.length?importSubjects(state.anime,state.source):notice('当前没有可重新统计的作品。'));
  $('#menuBtn').addEventListener('click',toggleSidebar);
  $('#sidebarClose').addEventListener('click',()=>closeSidebar(true));
  $('#sidebarBackdrop').addEventListener('click',()=>closeSidebar(true));
  $('#mobileImportGuide').addEventListener('click',()=>openSidebar(true));
  $$('.sidebar .nav-item').forEach(item=>item.addEventListener('click',()=>closeSidebar()));
  $('.sidebar .brand').addEventListener('click',e=>{e.preventDefault();closeSidebar();});
  $('#clearBtn').addEventListener('click',()=>{localStorage.removeItem('seitrace-data');Object.assign(state,{anime:[],actors:[],source:'Waiting for import',query:'',role:'all'});$('#searchInput').value='';$('#syncTitle').textContent='尚未导入';$('#syncTime').textContent='导入后将保存在本机';$('#syncDot').removeAttribute('style');$('#syncDot').classList.add('empty');notice('已清空本地导入数据。');render();});
  $('#recapBtn').addEventListener('click',openRecap);
  $$('[data-action="open-recap"]').forEach(el=>el.addEventListener('click',openRecap));
  $('#recapClose').addEventListener('click',closeRecap);
  $('.recap-brand').addEventListener('click',e=>e.preventDefault());
  $('#recapPrev').addEventListener('click',()=>{if(recapIndex>0){recapIndex--;renderRecap();}});
  $('#recapNext').addEventListener('click',()=>{const last=recapSlides().length-1;if(recapIndex>=last)closeRecap();else{recapIndex++;renderRecap();}});
  $('#recapPlay').addEventListener('click',()=>{recapPlaying=!recapPlaying;renderRecap();});
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#searchInput').focus();}});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('.sidebar').classList.contains('open'))closeSidebar(true);});
  document.addEventListener('keydown',e=>{if($('#recap').hidden)return;if(e.key==='Escape')closeRecap();if(e.key==='ArrowRight')$('#recapNext').click();if(e.key==='ArrowLeft')$('#recapPrev').click();});
  window.addEventListener('resize',()=>{if(window.innerWidth>940&&$('.sidebar').classList.contains('open'))closeSidebar();});
}

try {
  const saved=JSON.parse(localStorage.getItem('seitrace-data'));
  const isOldDemo=saved?.source==='Demo Collection'||saved?.actors?.some(a=>String(a.id).startsWith('demo-'));
  if(isOldDemo) localStorage.removeItem('seitrace-data');
  else if(saved?.anime?.length && saved?.actors){state.anime=saved.anime;state.actors=saved.actors;state.source=saved.source||'本地收藏';$('#syncTitle').textContent=state.source;$('#syncTime').textContent=new Date(saved.savedAt).toLocaleString('zh-CN');$('#syncDot').classList.remove('empty');$('#syncDot').style.background='var(--mint)';}
} catch {}
bind(); render();
const recapHash = location.hash.match(/^#recap-(\d+)$/);
if (recapHash && state.actors.length) {
  openRecap();
  recapIndex = Math.min(5, Math.max(0, Number(recapHash[1]) - 1));
  renderRecap();
}
