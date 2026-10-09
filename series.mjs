import {createHash, randomUUID} from 'node:crypto';

const clone = value => structuredClone(value);
const key = id => id.replaceAll('-', '').toLowerCase();
const gauges = new Set(['minecraft:time_since_death', 'minecraft:time_since_rest']);
export const isGauge = (c,k) => c === 'minecraft:custom' && gauges.has(k);
export function sumPlayers(groups) {
  const map = new Map();
  for (const players of groups) for (const p of players) {
    let out = map.get(key(p.uuid));
    if (!out) { out = {...p, stats:Object.create(null)}; map.set(key(p.uuid),out); }
    for(const field of ['name','skin','skinModel','skinChecked']) if(p[field]) out[field]=p[field];
    for (const [c,values] of Object.entries(p.stats)) for (const [k,v] of Object.entries(values)) {
      out.stats[c] ||= Object.create(null);
      out.stats[c][k] = isGauge(c,k) ? v : (out.stats[c][k] || 0) + v;
    }
  }
  return [...map.values()].sort((a,b)=>a.uuid.localeCompare(b.uuid));
}
export function differences(players, previous) {
  const old = new Map(previous.map(p=>[key(p.uuid),p]));
  return players.map(p=>{const stats=Object.create(null),before=old.get(key(p.uuid))?.stats||{};
    for(const[c,values]of Object.entries(p.stats)){stats[c]=Object.create(null);for(const[k,v]of Object.entries(values)){
      const prior=before[c]?.[k]||0;
      stats[c][k]=isGauge(c,k)?v:v>=prior?v-prior:v;
    }}return {...p,stats};});
}
export function initialize(previous, raw, now) {
  if(previous?.schemaVersion===2) {
    if(!Array.isArray(previous.series)||!previous.series.some(s=>s.id===previous.activeSeriesId)||!Array.isArray(previous.lastRaw))throw Error('Invalid series archive. Restore site/stats.json from Git history before retrying.');
    return clone(previous);
  }
  if(previous && !Array.isArray(previous.players))throw Error('Invalid existing snapshot. Refusing to overwrite it.');
  const id=randomUUID();
  return {schemaVersion:2,server:previous?.server||'',updated:now,activeSeriesId:id,
    series:[{id,name:'Life Series 1',startedAt:now,endedAt:null,imported:true,players:clone(raw),sessions:[]}],
    lastRaw:clone(raw),players:clone(raw),tracking:{files:[],fingerprints:[],initialized:false,notice:''},commands:[]};
}
export function accumulate(archive, raw) {
  const active=archive.series.find(s=>s.id===archive.activeSeriesId);
  active.players=sumPlayers([active.players,differences(raw,archive.lastRaw)]);
  // Preserve absent players' baselines; a temporarily missing file must not double-count later.
  const baseline=new Map(archive.lastRaw.map(p=>[key(p.uuid),p]));
  for(const p of raw)baseline.set(key(p.uuid),clone(p));
  archive.lastRaw=[...baseline.values()];
  archive.players=clone(active.players);
}
export function manage(archive,{action='sync',name='',expected='',requestId=''},now){
  if(action==='sync')return;
  if(!['new','rename'].includes(action))throw Error('Unknown management action.');
  if(requestId&&archive.commands.includes(requestId))return;
  if(expected!==archive.activeSeriesId)throw Error('The current series changed. Copy its latest Series ID from the owner panel.');
  name=name.trim();if(!name||name.length>80||/[\u0000-\u001f\u007f]/.test(name))throw Error('Use a series name between 1 and 80 characters, without control characters.');
  const active=archive.series.find(s=>s.id===archive.activeSeriesId);
  if(action==='rename')active.name=name;
  else {
    if(archive.series.some(s=>s.name.toLowerCase()===name.toLowerCase()))throw Error('Choose a unique series name.');
    active.endedAt=now;const id=randomUUID();
    const players=archive.lastRaw.map(p=>({...p,stats:Object.fromEntries(Object.entries(p.stats).map(([c,values])=>[c,Object.fromEntries(Object.keys(values).map(k=>[k,0]))]))}));
    archive.series.push({id,name,startedAt:now,endedAt:null,players,sessions:[]});
    archive.activeSeriesId=id;archive.players=clone(players);
  }
  if(requestId)archive.commands.push(requestId);
}

// Parse only complete Java start/stop pairs. Wall-clock duration, never player playtime.
export function parseRun(content){
  if(typeof content!=='string'||content.length>32_000_000)return null;
  const lines=content.replace(/\x1b\[[0-9;]*m/g,'').replaceAll('\r','').split('\n');
  let last=null,day=0,start=null,stop=null,clockStart='',clockStop='',end=-1;
  for(let i=0;i<lines.length;i++){
    const match=lines[i].match(/\[(\d{2}):(\d{2}):(\d{2})\]/);if(!match)continue;
    const [,h,m,s]=match.map(Number);if(h>23||m>59||s>59)continue;
    const seconds=h*3600+m*60+s;
    if(last!==null&&seconds<last){if(last-seconds>43200)day++;else return null;}
    last=seconds;const time=day*86400+seconds;
    if(/\[Server thread\/INFO\]: Done \([\d.,]+s\)! For help/.test(lines[i])){start=time;clockStart=match[0].slice(1,-1);}
    if(start!==null&&/\[Server thread\/INFO\]: Stopping (?:the )?server\s*$/i.test(lines[i])){stop=time;clockStop=match[0].slice(1,-1);end=i;break;}
  }
  if(start===null||stop===null||stop<start)return null;
  const fingerprint=createHash('sha256').update(lines.slice(0,end+1).join('\n')).digest('hex');
  return {fingerprint,durationSeconds:stop-start,startClock:clockStart,stopClock:clockStop};
}
export function recordLogs(archive,logs,now,{available=true}={}){
  const tracking=archive.tracking,active=archive.series.find(s=>s.id===archive.activeSeriesId);
  if(!tracking.initialized){
    tracking.files=logs.filter(l=>l.file!=='latest').map(l=>l.file);
    tracking.fingerprints=logs.map(l=>parseRun(l.content)?.fingerprint).filter(Boolean);
    tracking.initialized=true;
    tracking.notice='Tracking begins at installation. Earlier session dates cannot be reconstructed from player totals.';
    return;
  }
  if(!available){tracking.notice='Server logs unavailable. Statistics are saved; session duration could not be verified.';return;}
  let unknown=false;
  for(const log of logs){
    if(log.file!=='latest'&&tracking.files.includes(log.file))continue;
    const run=parseRun(log.content);
    if(!run){unknown=true;continue;}
    if(log.file!=='latest')tracking.files.push(log.file);
    if(tracking.fingerprints.includes(run.fingerprint))continue;
    tracking.fingerprints.push(run.fingerprint);
    active.sessions.push({id:run.fingerprint,...run,recordedAt:now,logDate:log.date||null,
      counted:run.durationSeconds>3600,number:run.durationSeconds>3600?active.sessions.filter(s=>s.counted).length+1:null,
      label:run.durationSeconds>3600?'Session':'Short run'});
  }
  tracking.notice=unknown?'A log has no verifiable start/stop pair. That run has not been counted.':'Sessions require a complete server log and more than 60 minutes online. Short runs still contribute to series statistics.';
}
