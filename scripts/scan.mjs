// TV de Tubo — coletor de lives brasileiras (YouTube + Twitch + Kick)
// Roda no GitHub Actions. Lê a programação anterior de ./prev e grava a nova em ./out.
// Segredos chegam só por variáveis de ambiente e nunca são impressos.
// Uso: node scripts/scan.mjs <pastaAnterior> <pastaSaida>

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const [, , PREV = 'prev', OUT = 'out'] = process.argv;
const env = (k) => (process.env[k] || '').trim();
const YT_KEY = env('YT_API_KEY');
const TW_ID = env('TWITCH_CLIENT_ID'), TW_SECRET = env('TWITCH_CLIENT_SECRET');
const KK_ID = env('KICK_CLIENT_ID'), KK_SECRET = env('KICK_CLIENT_SECRET');
const RSS_MAX = 400;                       // canais do catálogo conferidos por rodada
const EXTRA_YT = Math.max(0, Math.min(40, parseInt(env('EXTRA_YT_SEARCHES') || '0', 10) || 0));

const log = (...a) => console.log('[scan]', ...a);
const now = Date.now();

// ---------- utilidades de segurança ----------
const str = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const int = (n) => { const v = Math.round(Number(n)); return Number.isFinite(v) && v >= 0 ? v : 0; };
const okId = (s, re) => (typeof s === 'string' && re.test(s) ? s : null);
const IMG_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(ytimg\.com|ggpht\.com|jtvnw\.net|kick\.com)\//i;
const img = (u) => (typeof u === 'string' && IMG_HOSTS.test(u) ? u.slice(0, 400) : '');

async function getJSON(url, opt = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(20000) });
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue; }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${new URL(url).host} ${r.status} ${str(body?.error?.message || body?.message || '', 120)}`);
    return body;
  }
  throw new Error(`${new URL(url).host} indisponível`);
}
const readPrev = async (f, d) => { try { return JSON.parse(await readFile(`${PREV}/${f}`, 'utf8')); } catch { return d; } };

// Conteúdo de aposta/cassino fica fora da programação
const GAMBLING = /(slots?\b|cassino|casino|roleta|roulette|blackjack|tigrinho|fortune tiger|aviator|crash game|apostas?\b|gambling)/i;
const isGambling = (...t) => t.some((x) => GAMBLING.test(String(x || '')));

// ---------- YouTube ----------
const YT_API = 'https://www.googleapis.com/youtube/v3/';
const YT_CATS = { 1: 'Filmes e Animação', 2: 'Carros', 10: 'Música', 15: 'Animais e Natureza', 17: 'Esportes', 19: 'Viagem', 20: 'Games', 22: 'Pessoas e Blogs', 23: 'Humor', 24: 'Entretenimento', 25: 'Notícias', 26: 'Estilo e Culinária', 27: 'Educação', 28: 'Ciência e Tecnologia', 29: 'Causas' };
const CAT_SEARCH = [17, 20, 10, 24, 25, 27, 28, 22, 23, 26, 15, 19];
const TERMS = { 'futebol': 'Futebol', 'podcast': 'Podcasts', 'fofoca': 'Fofoca', 'famosos': 'Fofoca', 'biologia': 'Ciência', 'natureza animais': 'Animais e Natureza', 'ciência': 'Ciência', 'astronomia': 'Ciência', 'culinária receita': 'Estilo e Culinária', 'culto igreja': 'Religião', 'missa': 'Religião', 'rádio ao vivo': 'Rádio 24h', 'jornal ao vivo': 'Notícias', 'política': 'Política', 'economia mercado': 'Economia', 'free fire': 'Games', 'minecraft': 'Games', 'gta rp': 'Games', 'pagode': 'Música', 'sertanejo': 'Música', 'funk': 'Música', 'lofi': 'Música', 'reality show': 'Reality', 'basquete': 'Esportes', 'vôlei': 'Esportes', 'tecnologia': 'Ciência e Tecnologia', 'react': 'React', 'desenho infantil': 'Infantil', 'câmera ao vivo': 'Câmeras 24h', 'talk show entrevista': 'Podcasts' };
// Rodízio: categorias aparecem 2x por ciclo, temas 1x
const PLAN = [...CAT_SEARCH.map((c) => [{ videoCategoryId: String(c) }, YT_CATS[c]]), ...Object.entries(TERMS).map(([q, t]) => [{ q }, t]), ...CAT_SEARCH.map((c) => [{ videoCategoryId: String(c) }, YT_CATS[c]])];
const yt = (path, params) => getJSON(YT_API + path + '?' + new URLSearchParams({ ...params, key: YT_KEY }));

async function scanYouTube(prevLives, catalog) {
  if (!YT_KEY) { log('YouTube: sem chave, mantendo lives anteriores'); return prevLives.filter((l) => l.p === 'yt'); }
  const found = new Map();
  prevLives.filter((l) => l.p === 'yt').forEach((l) => found.set(l.id, { id: l.id, ch: l.ch, tags: new Set(l.tags || []) }));
  // 1 busca por execução (rodízio a cada 20 min) + buscas extras quando rodado manualmente
  const slot = Math.floor(now / (20 * 60e3));
  const n = 1 + EXTRA_YT;
  for (let k = 0; k < n; k++) {
    const [params, tag] = PLAN[(slot + k) % PLAN.length];
    try {
      const r = await yt('search', { part: 'snippet', type: 'video', eventType: 'live', regionCode: 'BR', relevanceLanguage: 'pt', maxResults: '50', ...params });
      for (const it of r.items || []) {
        const id = okId(it?.id?.videoId, /^[\w-]{11}$/); const ch = okId(it?.snippet?.channelId, /^UC[\w-]{22}$/);
        if (!id || !ch) continue;
        const f = found.get(id) || { id, ch, tags: new Set() }; f.tags.add(tag); found.set(id, f);
      }
      log(`YouTube busca "${tag}": ${r.items?.length || 0}`);
    } catch (e) { log('YouTube busca falhou:', e.message); if (/quota/i.test(e.message)) break; }
  }
  // Canais do catálogo: o feed público de cada canal (sem custo de cota) lista os
  // vídeos mais recentes, inclusive a live em andamento. Só os IDs novos vão para
  // videos.list (1 unidade a cada 50). Assim o YouTube cresce sem gastar buscas.
  const tracked = new Set([...found.values()].map((f) => f.ch));
  const cands = Object.values(catalog)
    .filter((c) => c.p === 'yt' && okId(c.id, /^UC[\w-]{22}$/) && !tracked.has(c.id))
    .sort((a, b) => (b.lastLive || 0) - (a.lastLive || 0))
    .slice(0, RSS_MAX);
  let rssOk = 0, rssFail = 0;
  const week = 7 * 864e5;
  for (let i = 0; i < cands.length; i += 12) {
    await Promise.all(cands.slice(i, i + 12).map(async (c) => {
      try {
        const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${c.id}`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) { rssFail++; return; }
        const xml = (await r.text()).slice(0, 200000); rssOk++;
        for (const e of xml.split('<entry>').slice(1, 3)) {          // 2 vídeos mais recentes
          const id = okId((e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1], /^[\w-]{11}$/);
          const pub = Date.parse((e.match(/<published>([^<]+)<\/published>/) || [])[1] || '');
          if (!id || found.has(id) || !(now - pub < week)) continue;
          found.set(id, { id, ch: c.id, tags: new Set(), viaFeed: true });
        }
      } catch { rssFail++; }
    }));
  }
  if (cands.length) log(`YouTube feeds: ${rssOk} canais lidos, ${rssFail} falhas, ${[...found.values()].filter((f) => f.viaFeed).length} vídeos a conferir`);
  const items = [...found.values()]; const ids = items.map((f) => f.id); const det = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const r = await yt('videos', { part: 'snippet,status,liveStreamingDetails', id: ids.slice(i, i + 50).join(',') });
    for (const v of r.items || []) det.set(v.id, v);
  }
  const needCh = [...new Set(items.map((f) => f.ch))].filter((c) => !catalog[`yt:${c}`] || now - (catalog[`yt:${c}`].upd || 0) > 864e5);
  for (let i = 0; i < needCh.length; i += 50) {
    const r = await yt('channels', { part: 'snippet,statistics', id: needCh.slice(i, i + 50).join(',') });
    for (const c of r.items || []) {
      const key = `yt:${c.id}`;
      catalog[key] = { ...(catalog[key] || {}), p: 'yt', id: c.id, name: str(c.snippet?.title, 100), handle: str(c.snippet?.customUrl, 60), country: str(c.snippet?.country, 2), lang: str(c.snippet?.defaultLanguage, 10), subs: c.statistics?.hiddenSubscriberCount ? null : int(c.statistics?.subscriberCount), upd: now };
    }
  }
  const out = [];
  for (const f of items) {
    const v = det.get(f.id); if (!v || v.snippet?.liveBroadcastContent !== 'live') continue;
    const c = catalog[`yt:${f.ch}`] || {};
    const lang = (v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || c.lang || '').toLowerCase();
    const br = c.country ? c.country === 'BR' : (/^pt/.test(lang) && lang !== 'pt-pt');
    if (!br) continue;
    const cat = YT_CATS[+v.snippet.categoryId];
    const title = str(v.snippet.title);
    if (isGambling(title)) continue;
    out.push({ p: 'yt', id: f.id, ch: f.ch, chTitle: str(v.snippet.channelTitle, 100), title, tags: [...new Set([...f.tags, cat].filter(Boolean))], viewers: int(v.liveStreamingDetails?.concurrentViewers), subs: c.subs ?? null, embed: v.status?.embeddable !== false, start: str(v.liveStreamingDetails?.actualStartTime, 30), thumb: `https://i.ytimg.com/vi/${f.id}/mqdefault_live.jpg` });
  }
  log(`YouTube: ${out.length} lives brasileiras`);
  return out;
}

// ---------- Twitch ----------
async function scanTwitch() {
  if (!TW_ID || !TW_SECRET) { log('Twitch: sem credenciais'); return null; }
  const tok = await getJSON('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: TW_ID, client_secret: TW_SECRET, grant_type: 'client_credentials' }) });
  const H = { 'Client-Id': TW_ID, Authorization: `Bearer ${tok.access_token}` };
  const out = [], seen = new Set(); let cursor = '';
  // A Twitch devolve das mais vistas para as menos vistas; para chegar aos canais
  // pequenos é preciso paginar fundo. Até 25 páginas (2.500 lives), ~25 pontos do
  // limite de 800/min do token de app.
  for (let page = 0; page < 25; page++) {
    const r = await getJSON('https://api.twitch.tv/helix/streams?' + new URLSearchParams({ language: 'pt', type: 'live', first: '100', ...(cursor ? { after: cursor } : {}) }), { headers: H });
    for (const s of r.data || []) {
      const login = okId(s.user_login, /^[a-z0-9_]{2,25}$/i); if (!login) continue;
      if (seen.has(login.toLowerCase())) continue;   // a ordem muda entre páginas e pode repetir canal
      seen.add(login.toLowerCase());
      const game = str(s.game_name, 80), title = str(s.title);
      if (isGambling(game, title)) continue;
      out.push({ p: 'tw', id: login.toLowerCase(), ch: str(s.user_id, 20), chTitle: str(s.user_name, 60), title, tags: [twitchTag(game)].filter(Boolean), game, viewers: int(s.viewer_count), subs: null, embed: true, start: str(s.started_at, 30), thumb: img(String(s.thumbnail_url || '').replace('{width}', '320').replace('{height}', '180')) });
    }
    cursor = r.pagination?.cursor; if (!cursor) break;
  }
  // revoga o token de app no fim (higiene)
  fetch('https://id.twitch.tv/oauth2/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: TW_ID, token: tok.access_token }) }).catch(() => {});
  log(`Twitch: ${out.length} lives em português`);
  return out;
}
function twitchTag(game) {
  const g = game.toLowerCase();
  if (!g) return 'Twitch';
  // nomes exatos das categorias "não-jogo" da Twitch/Kick; todo o resto é jogo
  if (g === 'just chatting') return 'Papo';
  if (g === 'irl') return 'IRL';
  if (/^(music|música)$|^dj$/.test(g)) return 'Música';
  if (/^(sports|soccer|futebol|basketball|mma|motorsport)$|^ea sports fc|^fifa/.test(g)) return 'Esportes';
  if (/^(talk shows & podcasts|podcasts?)$/.test(g)) return 'Podcasts';
  if (/^science & technology$|^software and game development$/.test(g)) return 'Ciência e Tecnologia';
  if (/^food & drink$/.test(g)) return 'Estilo e Culinária';
  if (/^travel & outdoors$/.test(g)) return 'Viagem';
  if (/^(art|makers & crafting)$/.test(g)) return 'Arte';
  if (/^(politics|news|política)$/.test(g)) return 'Notícias';
  return 'Games';
}

// ---------- Kick ----------
async function scanKick() {
  if (!KK_ID || !KK_SECRET) { log('Kick: sem credenciais'); return null; }
  const tok = await getJSON('https://id.kick.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: KK_ID, client_secret: KK_SECRET, grant_type: 'client_credentials' }) });
  const H = { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } };
  const url = (sort) => 'https://api.kick.com/public/v1/livestreams?' + new URLSearchParams({ language: 'pt', limit: '100', sort });
  // A API pública não pagina: 100 mais vistas + 100 que começaram por último
  // (a segunda lista traz os canais pequenos). Se a segunda falhar, segue com a primeira.
  const top = await getJSON(url('viewer_count'), H);
  let fresh = { data: [] };
  try { fresh = await getJSON(url('started_at'), H); } catch (e) { log('Kick (recentes) falhou:', e.message); }
  const out = [], seen = new Set();
  for (const s of [...(top.data || []), ...(fresh.data || [])]) {
    const slug = okId(s.slug, /^[a-z0-9_-]{1,40}$/i); if (!slug) continue;
    const id = slug.toLowerCase(); if (seen.has(id)) continue;
    const cat = str(s.category?.name, 80), title = str(s.stream_title);
    if (s.has_mature_content || isGambling(cat, title)) continue;
    seen.add(id);
    out.push({ p: 'kk', id, ch: str(s.broadcaster_user_id, 20), chTitle: str(slug, 60), title, tags: [twitchTag(cat)].filter(Boolean), game: cat, viewers: int(s.viewer_count), subs: null, embed: true, start: str(s.started_at, 30), thumb: img(s.thumbnail) });
  }
  log(`Kick: ${out.length} lives em português`);
  return out;
}

// ---------- principal ----------
const prev = await readPrev('lives.json', { lives: [] });
const prevLives = Array.isArray(prev.lives) ? prev.lives : [];
const catalogDoc = await readPrev('catalog.json', { channels: {} });
const catalog = catalogDoc.channels && typeof catalogDoc.channels === 'object' ? catalogDoc.channels : {};

const errors = [];
const safe = async (name, fn) => { try { return await fn(); } catch (e) { errors.push(name); log(`${name} falhou:`, e.message); return null; } };
const [ytL, twL, kkL] = await Promise.all([
  safe('YouTube', () => scanYouTube(prevLives, catalog)),
  safe('Twitch', scanTwitch),
  safe('Kick', scanKick),
]);
// Se uma plataforma falhar, mantém as lives anteriores dela (no máximo 1 h)
const keep = (p, list) => list ?? prevLives.filter((l) => l.p === p && now - (prev.updatedAt || 0) < 36e5);
// Proporção da programação: 60% YouTube, 20% Twitch, 20% Kick.
// Twitch e Kick ficam com até 1/3 do total do YouTube cada (mínimo 20), escolhendo
// metade entre as mais vistas e o resto espalhado do meio até as menores.
const ytFinal = keep('yt', ytL);
const cap = Math.max(20, Math.ceil(ytFinal.length / 3));
function mix(list) {
  const s = [...list].sort((a, b) => b.viewers - a.viewers);
  if (s.length <= cap) return s;
  const top = Math.ceil(cap / 2), rest = s.slice(top), k = cap - top, pick = s.slice(0, top);
  for (let i = 0; i < k; i++) pick.push(rest[Math.round(((i + 1) * (rest.length - 1)) / k)]);
  return [...new Set(pick)];
}
const twFinal = mix(keep('tw', twL)), kkFinal = mix(keep('kk', kkL));
log(`Proporção: YouTube ${ytFinal.length} · Twitch ${twFinal.length} · Kick ${kkFinal.length} (teto ${cap})`);
const lives = [...ytFinal, ...twFinal, ...kkFinal];

// Catálogo acumulado de canais brasileiros, de todas as plataformas
for (const l of lives) {
  const key = `${l.p}:${l.p === 'yt' ? l.ch : l.id}`;
  const c = catalog[key] || { p: l.p, id: l.p === 'yt' ? l.ch : l.id, name: l.chTitle };
  c.name = l.chTitle || c.name;
  // YouTube acumula temas das buscas; Twitch/Kick usam a categoria atual da live
  c.tags = l.p === 'yt' ? [...new Set([...(c.tags || []), ...l.tags])].slice(0, 12) : l.tags.slice(0, 3);
  if (!c.lastLive || now - c.lastLive > 30 * 60e3) c.seen = (c.seen || 0) + 1;
  c.lastLive = now; c.peak = Math.max(c.peak || 0, l.viewers); catalog[key] = c;
}
for (const k of Object.keys(catalog)) if (!catalog[k].lastLive) delete catalog[k];   // só canais vistos ao vivo no Brasil

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/lives.json`, JSON.stringify({ updatedAt: now, errors, lives }));
await writeFile(`${OUT}/catalog.json`, JSON.stringify({ updatedAt: now, channels: catalog }));
log(`Total: ${lives.length} lives · catálogo: ${Object.keys(catalog).length} canais · falhas: ${errors.join(', ') || 'nenhuma'}`);
if (errors.length === 3) process.exit(1);
