// 归一化乱码用户名 + 去重，写回 npoint（修复数据丢失后的残留乱码副本）
const https = require('https');
const fs = require('fs');
const NPOINT = 'https://api.npoint.io/REPLACE_WITH_NPOINT_ID';

function repairUserName(u) {
  if (!u || !String(u).includes('�')) return u;
  const s = String(u);
  if (s.endsWith('手')) return 'P17';
  if (s.startsWith('盛') && s.endsWith('指导')) return 'P09';
  if (s.startsWith('程') && s.endsWith('新')) return 'P02';
  if (s.startsWith('严') && s.endsWith('鹏')) return 'P14';
  if (s.startsWith('李') && s.endsWith('烨')) return 'P01';
  if (s.startsWith('孙') && s.endsWith('敏')) return 'P04';
  if (s.endsWith('子')) return 'P13';
  if (s.startsWith('老') && s.endsWith('王')) return 'P07';
  if (s.startsWith('大') && s.endsWith('魏')) return 'P05';
  if (s.startsWith('陆')) return 'P03';
  if (s.startsWith('王') && s.endsWith('斌')) return '王红斌';
  if (s.startsWith('旺') && s.endsWith('财')) return 'P06';
  if (s.startsWith('大')) return 'P05';
  if (s.endsWith('指导')) return 'P09';
  return u;
}

function robustGet(tries = 3) {
  return new Promise((resolve) => {
    let best = null, done = 0;
    for (let i = 0; i < tries; i++) {
      const r = https.request(NPOINT, { method: 'GET', headers: { 'Cache-Control': 'no-cache' } }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { const data = JSON.parse(d); const sz = (data.predictions?.length||0)+Object.keys(data.scores||{}).length; if(!best||sz>(best.predictions?.length||0)+Object.keys(best.scores||{}).length) best=data; } catch(e){} if(++done===tries) resolve(best); });
      });
      r.on('error', () => { if (++done === tries) resolve(best); });
      r.end(); r.setTimeout(20000, () => { r.destroy(); if (++done === tries) resolve(best); });
    }
  });
}
function post(data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const r = https.request(NPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' } }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(res.statusCode)); });
    r.on('error', reject); r.write(body); r.end(); r.setTimeout(20000,()=>{r.destroy();reject(new Error('timeout'));});
  });
}
const keyOf = p => repairUserName(p.userName||'?') + '|' + (p.matchId||'?');
const completeness = p => ['homePred','awayPred','xChoices','xPoints'].filter(k=>p[k]!==undefined&&p[k]!==null).length;

(async () => {
  const data = await robustGet(3);
  if (!data) { console.log('拉取失败'); process.exit(1); }
  const preds = (data.predictions||[]).map(p => ({ ...p, userName: repairUserName(p.userName) }));
  const map = new Map();
  let garbled = 0, dup = 0;
  for (const p of preds) {
    if (String(p.userName).includes('�')) garbled++;
    const k = keyOf(p);
    if (!map.has(k)) map.set(k, p);
    else { dup++; if (completeness(p) > completeness(map.get(k))) map.set(k, p); }
  }
  const merged = [...map.values()];
  const users = new Set(merged.map(p => p.userName));
  console.log('归一前预测:', preds.length, ' 残留乱码:', garbled, ' 去重合并:', dup);
  console.log('归一后预测:', merged.length, ' 用户:', users.size, ' 乱码残留:', [...users].filter(u=>u.includes('�')).length);

  const payload = { ...data, predictions: merged };
  // comments/peeks 也归一用户名
  if (Array.isArray(payload.comments_A)) payload.comments_A.forEach(c => { if (c.userName) c.userName = repairUserName(c.userName); });
  if (Array.isArray(payload.peeks_A)) payload.peeks_A.forEach(c => { if (c.userName) c.userName = repairUserName(c.userName); });

  const st = await post(payload);
  console.log('POST 状态:', st);
  if (st === 200) {
    const v = await robustGet(2);
    const vp = (v && v.predictions) || [];
    const vu = new Set(vp.map(p => p.userName));
    console.log('回读: 预测', vp.length, ' 用户', vu.size, ' 乱码', [...vu].filter(u=>u.includes('�')).length);
    console.log(vp.length === merged.length && vu.size === 18 ? 'RESULT_OK' : 'RESULT_CHECK');
  }
})();
