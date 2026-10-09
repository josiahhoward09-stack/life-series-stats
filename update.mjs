import fs from 'node:fs/promises';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {initialize,accumulate,manage,recordLogs} from './series.mjs';

const token = process.env.EXAROTON_API_TOKEN;
const address = (process.env.SERVER_ADDRESS || 'Life_Series.exaroton.me').toLowerCase();
const base = 'https://api.exaroton.com/v1/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function request(endpoint, raw = false) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(base + endpoint, {
      headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(60000)
    });
    if ((r.status === 429 || r.status >= 500) && attempt < 3) {
      await sleep(2000 * 2 ** attempt); continue;
    }
    if (!r.ok) throw new Error(`API HTTP ${r.status} for ${endpoint}`);
    if (raw === 'buffer') return Buffer.from(await r.arrayBuffer());
    if (raw) return r.text();
    const result = await r.json();
    if (!result.success) throw new Error(`API refused ${endpoint}: ${result.error}`);
    return result.data;
  }
}
const normalize = id => id.replaceAll('-', '').toLowerCase();
async function resolveSkin(uuid, prior = {}) {
  const cached = {};
  for (const key of ['skin','skinModel','skinChecked']) if (prior[key]) cached[key] = prior[key];
  if (Date.now() - Date.parse(prior.skinChecked || '') < 24 * 60 * 60 * 1000) return cached;
  const result = {...cached, skinChecked: new Date().toISOString()};
  try {
    const id = normalize(uuid);
    if (!/^[0-9a-f]{32}$/.test(id)) return result;
    const profile = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`, {signal: AbortSignal.timeout(12000)});
    if (!profile.ok) return result;
    const data = await profile.json();
    const value = data.properties?.find(p => p.name === 'textures')?.value;
    if (!value) return result;
    const skin = JSON.parse(Buffer.from(value,'base64').toString('utf8')).textures?.SKIN;
    if (!skin?.url) return result;
    const url = new URL(skin.url);
    if (url.hostname !== 'textures.minecraft.net' || !/^\/texture\/[a-f0-9]+$/i.test(url.pathname)) return result;
    url.protocol = 'https:';
    const response = await fetch(url, {signal: AbortSignal.timeout(12000), redirect:'error'});
    if (!response.ok || Number(response.headers.get('content-length')) > 2000000) return result;
    const png = Buffer.from(await response.arrayBuffer());
    if (png.length < 24 || png.length > 2000000 || png.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') return result;
    const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
    if (width !== 64 || ![32,64].includes(height)) return result;
    result.skin = 'data:image/png;base64,' + png.toString('base64');
    result.skinModel = skin.metadata?.model === 'slim' ? 'slim' : 'default';
  } catch { /* Preserve the previous skin if Mojang is unavailable. */ }
  return result;
}
async function main() {
  if (!token) throw new Error('Add the EXAROTON_API_TOKEN repository secret first.');
  const servers = await request('servers/');
  const server = servers.find(s => s.address.toLowerCase() === address);
  if (!server) throw new Error(`Token cannot access ${address}. Check SERVER_ADDRESS and account access.`);
  const prefix = `servers/${encodeURIComponent(server.id)}/`;
  const current = await request(prefix);
  if (current.status !== 0) {
    if(process.env.SERIES_ACTION && process.env.SERIES_ACTION !== 'sync') throw Error('Stop the server fully before managing a series.');
    console.log('Server is not fully offline. Keeping the published snapshot.'); return;
  }
  const info = p => request(prefix + 'files/info/' + encodeURIComponent(p) + '/');
  const read = p => request(prefix + 'files/data/' + encodeURIComponent(p) + '/', true);
  let folder = (process.env.STATS_PATH || '').trim().replace(/^\/+|\/+$/g, '');
  if (!folder) {
    let world = 'world';
    try {
      const options = await request(prefix + 'files/config/server.properties/');
      world = options.find(o => o.key === 'level-name')?.value || world;
    } catch { console.log('Could not read level-name; trying the default world folder.'); }
    const found = [];
    for (const candidate of [`${world}/players/stats`, `${world}/stats`]) {
      try {
        const entry = await info(candidate);
        if (entry.isDirectory) found.push(candidate);
      } catch { /* Some versions do not have this path. */ }
    }
    if (found.length !== 1) throw new Error('Could not choose a unique stats folder. Set the STATS_PATH repository variable to the exact folder shown in exaroton, e.g. world/players/stats.');
    folder = found[0];
  }
  const directory = await info(folder);
  if (!directory.isDirectory || !Array.isArray(directory.children)) throw new Error('STATS_PATH is not a readable directory listing.');
  let previous = null;
  try { previous = JSON.parse(await fs.readFile('site/stats.json', 'utf8')); } catch(e) { if(e.code !== 'ENOENT') throw Error('Existing snapshot cannot be read. Refusing to overwrite the archive.'); }
  const previousPlayers = previous?.lastRaw || previous?.players || []; 
  const names = new Map(previousPlayers.filter(p => p.name !== p.uuid).map(p => [normalize(p.uuid), p.name]));
  // Only UUIDs and names are extracted; these server files are never published.
  for (const filename of ['usercache.json', 'whitelist.json', 'ops.json']) {
    try {
      const entries = JSON.parse(await read(filename));
      for (const entry of entries) if (entry.uuid && entry.name) names.set(normalize(entry.uuid), entry.name);
    } catch { console.log(`Optional name source ${filename} unavailable.`); }
  }
  const overrides = JSON.parse(await fs.readFile('names.json', 'utf8'));
  for (const [uuid, name] of Object.entries(overrides)) names.set(normalize(uuid), name);
  const players = [];
  for (const child of directory.children) {
    const filename = typeof child === 'string' ? path.posix.basename(child) : child.name || path.posix.basename(child.path || '');
    if (!/^[0-9a-f-]{32,36}\.json$/i.test(filename)) continue;
    const uuid = filename.slice(0, -5);
    const document = JSON.parse(await read(`${folder}/${filename}`));
    if (!document.stats || typeof document.stats !== 'object' || Array.isArray(document.stats)) throw new Error(`Invalid stats document: ${filename}`);
    for (const entries of Object.values(document.stats)) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.values(entries).some(v => !Number.isFinite(v) || v < 0)) throw new Error(`Invalid stat values: ${filename}`);
    }
    const prior = previousPlayers.find(p => normalize(p.uuid) === normalize(uuid));
    const appearance = await resolveSkin(uuid, prior);
    players.push({uuid, name: names.get(normalize(uuid)) || uuid, stats: document.stats, ...appearance});
    await sleep(150);
  }
  if (!players.length && !previousPlayers.length) throw new Error('No player stats found. Play and stop the server once, or check STATS_PATH.');
  if ((await request(prefix)).status !== 0) throw new Error('Server started during collection. Keeping the previous snapshot; retry after stopping.');
  players.sort((a, b) => a.uuid.localeCompare(b.uuid));
  const now = new Date().toISOString();
  const snapshot = initialize(previous, previous?.players || players, now);
  snapshot.server=address;
  snapshot.repository=process.env.GITHUB_REPOSITORY || 'josiahhoward09-stack/life-series-stats';
  accumulate(snapshot, players);
  const logs=[];let available=false;
  try {
    const listing=await info('logs');
    const files=(listing.children||[]).map(c=>typeof c==='string'?path.posix.basename(c):c.name||path.posix.basename(c.path||''))
      .filter(name=>/^\d{4}-\d{2}-\d{2}-\d+\.log(?:\.gz)?$/.test(name)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
    for(const file of files){
      if(snapshot.tracking.files.includes(file))continue;
      if(!snapshot.tracking.archivedInitialized){logs.push({file,content:''});snapshot.tracking.files.push(file);continue;}
      const bytes=await request(prefix+'files/data/'+encodeURIComponent('logs/'+file)+'/','buffer');
      const content=bytes[0]===31&&bytes[1]===139?gunzipSync(bytes,{maxOutputLength:32_000_000}).toString('utf8'):bytes.toString('utf8');
      logs.push({file,content,date:file.slice(0,10)});
    }
    snapshot.tracking.archivedInitialized=true;
  } catch { console.log('Archived logs unavailable; latest-log tracking remains available.'); }
  try { const log=await request(prefix+'logs/');logs.push({file:'latest',content:log.content});available=true; }
  catch { console.log('Latest server log unavailable. Session counts may be incomplete.'); }
  recordLogs(snapshot,logs,now,{available:available||logs.length>0});
  manage(snapshot,{action:process.env.SERIES_ACTION||'sync',name:process.env.SERIES_NAME||'',expected:process.env.EXPECTED_SERIES_ID||'',requestId:process.env.GITHUB_RUN_ID||''},now);
  if ((await request(prefix)).status !== 0) throw Error('Server started while processing history. Retry after stopping.');
  snapshot.updated=previous?.updated||now;
  const unchanged=JSON.stringify(snapshot)===JSON.stringify(previous);
  if(!unchanged)snapshot.updated=now;
  const template = await fs.readFile('viewer.html', 'utf8');
  const embedded = JSON.stringify(snapshot).replaceAll('<', '\\u003c');
  const html = template.replace('/*__SNAPSHOT__*/null', () => embedded);
  await fs.mkdir('site', {recursive: true});
  await fs.writeFile('site/stats.json', JSON.stringify(snapshot, null, 2) + '\n');
  await fs.writeFile('site/index.html', html);
  await fs.writeFile('site/.nojekyll', '');
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, 'publish=true\n');
  console.log(`Prepared ${snapshot.players.length} players and ${snapshot.series.length} series from ${folder}. ${unchanged ? 'Stats unchanged.' : 'New snapshot saved.'}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
