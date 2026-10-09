import fs from 'node:fs/promises';
import path from 'node:path';

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
    if (raw) return r.text();
    const result = await r.json();
    if (!result.success) throw new Error(`API refused ${endpoint}: ${result.error}`);
    return result.data;
  }
}
const normalize = id => id.replaceAll('-', '').toLowerCase();
async function main() {
  if (!token) throw new Error('Add the EXAROTON_API_TOKEN repository secret first.');
  const servers = await request('servers/');
  const server = servers.find(s => s.address.toLowerCase() === address);
  if (!server) throw new Error(`Token cannot access ${address}. Check SERVER_ADDRESS and account access.`);
  const prefix = `servers/${encodeURIComponent(server.id)}/`;
  const current = await request(prefix);
  if (current.status !== 0) {
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
  let previous = {players: []};
  try { previous = JSON.parse(await fs.readFile('site/stats.json', 'utf8')); } catch {}
  const names = new Map(previous.players.filter(p => p.name !== p.uuid).map(p => [normalize(p.uuid), p.name]));
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
    players.push({uuid, name: names.get(normalize(uuid)) || uuid, stats: document.stats});
    await sleep(150);
  }
  if (!players.length) throw new Error('No player stats found. Play and stop the server once, or check STATS_PATH. Existing website preserved.');
  if ((await request(prefix)).status !== 0) throw new Error('Server started during collection. Keeping the previous snapshot; retry after stopping.');
  players.sort((a, b) => a.uuid.localeCompare(b.uuid));
  const unchanged = JSON.stringify(players) === JSON.stringify(previous.players);
  const snapshot = {server: address, updated: unchanged ? previous.updated : new Date().toISOString(), players};
  const template = await fs.readFile('viewer.html', 'utf8');
  const embedded = JSON.stringify(snapshot).replaceAll('<', '\\u003c');
  const html = template.replace('/*__SNAPSHOT__*/null', embedded);
  await fs.mkdir('site', {recursive: true});
  await fs.writeFile('site/stats.json', JSON.stringify(snapshot, null, 2) + '\n');
  await fs.writeFile('site/index.html', html);
  await fs.writeFile('site/.nojekyll', '');
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, 'publish=true\n');
  console.log(`Prepared ${players.length} players from ${folder}. ${unchanged ? 'Stats unchanged.' : 'New snapshot saved.'}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
