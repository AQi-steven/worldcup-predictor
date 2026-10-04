// 跨多副本合并 + 归一化，清理 A 组 npoint 乱码/脏数据（同一套前端 canonName 逻辑）
// 默认 dry-run（只读审计+计划）；WRITE=1 才写回。
const https = require('https');
const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');
const URL = 'https://api.npoint.io/' + NPOINT_ID;
const WRITE = process.env.WRITE === '1';
const FIXED = ['P01','P02','P03','P04','P05','P06','P07','P08','P09','P10','P11','P12','P13','P14','P15','P16','P17','P18'];
const FFFD = '�';

function getOnce() {
  return new Promise((res, rej) => {
    const r = https.get(URL, { minVersion: 'TLSv1.2', timeout: 15000 }, x => {
      let b = ''; x.on('data', d => b += d); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    r.on('error', rej); r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
  });
}
function canonName(n, cleanNames) {
  if (!n || n === 'null' || !n.includes(FFFD)) return n;
  const clean = [...n].filter(c => c !== FFFD);
  if (!clean.length) return n;
  const hits = [...cleanNames].filter(u => clean.every(ch => [...u].includes(ch)));
  return hits.length === 1 ? hits[0] : n;
}
function isEffective(p) {
  return (typeof p.points === 'number' && !isNaN(p.points)) || p.homePred != null || p.awayPred != null
    || ((p.xChoices && Object.keys(p.xChoices).length)) || typeof p.xPoints === 'number';
}

(async () => {
  // ---- 取多副本 ----
  const copies = [];
  for (let i = 0; i < 8; i++) { try { copies.push(await getOnce()); } catch (e) { console.error('GET err', e.message); } }
  if (!copies.length) throw new Error('all GET failed');
  const junkAll = new Set();
  copies.forEach(c => (c.predictions || []).forEach(p => { if (p.userName && p.userName.includes(FFFD)) junkAll.add(p.userName); }));
  const maxPreds = Math.max(...copies.map(c => (c.predictions || []).length));
  const maxEff = Math.max(...copies.map(c => (c.predictions || []).filter(p => typeof p.points === 'number' && !isNaN(p.points)).length));
  console.log(`[multiGet] ${copies.length} 次成功，最大 predictions=${maxPreds}，最大有效分=${maxEff}，发现乱码名=${[...junkAll].map(n=>JSON.stringify(n)).join(',')||'无'}`);

  // ---- 派生 cleanNames（跨副本非乱码名并集） ----
  const cleanNames = new Set();
  copies.forEach(c => (c.predictions || []).forEach(p => { if (p.userName && p.userName !== 'null' && !p.userName.includes(FFFD)) cleanNames.add(p.userName); }));

  // ---- 跨副本合并 + 归一 + 去重 ----
  const merged = new Map();
  let ambig = 0;
  copies.forEach(c => (c.predictions || []).forEach(p => {
    if (!p.userName || p.userName === 'null') return;
    const name = canonName(p.userName, cleanNames);
    if (p.userName.includes(FFFD) && name === p.userName) ambig++; // 无法归一（歧义），保留原样
    const mid = String(p.matchId).replace(/^M/, '');
    const key = name + '@' + mid;
    const ex = merged.get(key);
    if (!ex) merged.set(key, Object.assign({}, p, { userName: name, matchId: mid }));
    else {
      const np = Object.assign({}, ex);
      np.userName = name; np.matchId = mid;
      if ((typeof ex.points !== 'number' || isNaN(ex.points)) && typeof p.points === 'number' && !isNaN(p.points)) Object.assign(np, p);
      if (typeof ex.xPoints !== 'number' && typeof p.xPoints === 'number') np.xPoints = p.xPoints;
      if (!ex.xChoices && p.xChoices) np.xChoices = p.xChoices;
      merged.set(key, np);
    }
  }));
  const deduped = [...merged.values()];

  // ---- 审计 ----
  const effTotal = deduped.filter(p => typeof p.points === 'number' && !isNaN(p.points)).length;
  const external = [...new Set(deduped.map(p => p.userName).filter(n => n && n !== 'null' && !n.includes(FFFD) && !FIXED.includes(n)))];
  const protect = [];
  FIXED.forEach(name => {
    const before = Math.max(...copies.map(c => (c.predictions || []).filter(p => p.userName === name && typeof p.points === 'number' && !isNaN(p.points)).length));
    const after = deduped.filter(p => p.userName === name && typeof p.points === 'number' && !isNaN(p.points)).length;
    if (after < before) protect.push(`${name}: ${before}->${after}`);
  });
  console.log(`\n========== 跨副本合并审计 (A 组) ==========`);
  console.log(`合并后 predictions: ${deduped.length}（基准最大 ${maxPreds}，减少 ${maxPreds - deduped.length} 为冗余乱码副本）`);
  console.log(`合并后有效分: ${effTotal}（基准最大 ${maxEff}，差异 ${effTotal - maxEff}）`);
  console.log(`乱码名能否全部归一: ${[...junkAll].every(n => canonName(n, cleanNames) !== n) ? '✅ 全部可归一' : '⚠️ 有不可归一(歧义)' + (ambig ? ' 歧义'+ambig+'条' : '')}`);
  console.log(`非名册非乱码外部名: ${external.length ? '⚠️ ' + external.join(', ') : '（无）'}`);
  console.log(`逐人有效分保护: ${protect.length ? '❌ ' + protect.join('; ') : '✅ 无丢失'}`);

  // comments_A / peeks_A 归一
  const cA = (copies[0]['comments_A'] || []).map(c => c.userName ? { ...c, userName: canonName(c.userName, cleanNames) } : c);
  const pA = (copies[0]['peeks_A'] || []).map(pk => pk.userName ? { ...pk, userName: canonName(pk.userName, cleanNames) } : pk);
  console.log(`comments_A 原乱码: ${[...new Set((copies[0]['comments_A']||[]).map(c=>c.userName).filter(n=>n&&n.includes(FFFD)))].length}  peeks_A 原乱码: ${[...new Set((copies[0]['peeks_A']||[]).map(pk=>pk.userName).filter(n=>n&&n.includes(FFFD)))].length}`);

  if (!WRITE) { console.log('\n[DRY-RUN] 未写回。确认后运行 WRITE=1 node canonicalize_a.js'); return; }

  // ---- 写回 ----
  if (protect.length) { console.error('\n❌ 保护触发，拒绝写回：' + protect.join('; ')); process.exit(2); }
  const base = copies[0];
  const out = Object.assign({}, base, { predictions: deduped, comments_A: cA, peeks_A: pA });
  const body = JSON.stringify(out);
  console.log(`\n[WRITE] POST predictions=${deduped.length} body=${body.length}bytes`);
  let ok = 0;
  for (let i = 0; i < 6; i++) {
    try {
      await new Promise((res, rej) => {
        const r = https.request(URL, { method: 'POST', minVersion: 'TLSv1.2', timeout: 20000,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json' } }, x => {
          let b = ''; x.on('data', d => b += d); x.on('end', () => { try { const j = JSON.parse(b); const pn = (j.predictions || []).length; if (pn >= deduped.length - 3 && pn <= deduped.length + 3) ok++; else rej(new Error('回写副本 predictions 异常=' + pn)); } catch (e) { rej(e); } });
        });
        r.on('error', rej); r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
        r.write(body); r.end();
      });
      console.log(`  POST #${i + 1} OK`);
    } catch (e) { console.error(`  POST #${i + 1} FAIL:`, e.message); }
  }
  console.log(ok ? `\n✅ 写回成功 ${ok} 次` : `\n❌ 写回失败`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
