// 全面体检：数据准确性 + 潜在bug扫描
const https = require('https');

const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');

function req(path) {
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname: 'api.npoint.io', path: '/' + NPOINT_ID, method: 'GET', rejectUnauthorized: false, timeout: 30000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}
async function getRobust(tries = 6) {
  let best = null, bestSize = -1; const sizes = [];
  for (let i = 0; i < tries; i++) {
    try {
      const d = await req();
      const size = (d.predictions?.length || 0) + (d.predictions_B?.length || 0);
      sizes.push((d.predictions?.length || 0) + '/' + (d.predictions_B?.length || 0));
      if (size > bestSize) { bestSize = size; best = d; }
    } catch (e) { sizes.push('ERR'); }
    if (i < tries - 1) await new Promise(r => setTimeout(r, 700));
  }
  return { best, sizes };
}

const A_WHITELIST = ['P01','P02','P03','P04','P05','P06','P07','P08','P09','P10','P11','P12','P13','P14','P16','P17','P15','P18'];

(async () => {
  const { best: d, sizes } = await getRobust();
  console.log('==== npoint 读后一致性采样(A/B) ====');
  console.log('   ' + sizes.join('  |  '));
  console.log('');

  const A = d.predictions || [];
  const B = d.predictions_B || [];
  const scores = d.scores || {};

  // 1. 预测数
  console.log('==== ① 预测数 ====');
  console.log('   A组 predictions   = ' + A.length);
  console.log('   B组 predictions_B = ' + B.length);

  // 2. 用户名统计 + 乱码
  function userStats(arr, label, whitelist) {
    const names = {};
    let garbled = 0; const garbledSamples = [];
    arr.forEach(p => {
      const u = p.userName || '(空)';
      names[u] = (names[u] || 0) + 1;
      if (u.includes('\uFFFD')) { garbled++; garbledSamples.push(u); }
    });
    const uniq = Object.keys(names);
    console.log('==== ② ' + label + ' 用户 ====');
    console.log('   独立用户数 = ' + uniq.length + ' | 乱码记录 = ' + garbled + (garbledSamples.length ? ' 例:' + [...new Set(garbledSamples)].slice(0,5).join(',') : ''));
    if (whitelist) {
      const unknown = uniq.filter(u => u !== '(空)' && !whitelist.includes(u) && !u.includes('\uFFFD'));
      if (unknown.length) console.log('   ⚠️ 名册外用户: ' + unknown.join(', '));
      const missing = whitelist.filter(w => !uniq.includes(w));
      if (missing.length) console.log('   ⚠️ 名册中未出现: ' + missing.join(', '));
    }
    return names;
  }
  const aNames = userStats(A, 'A组', A_WHITELIST);
  const bNames = userStats(B, 'B组', null);

  // 3. 重复记录 (userName + matchId)
  function dupCheck(arr, label) {
    const seen = {}; let dup = 0; const samples = [];
    arr.forEach(p => {
      const k = (p.userName || '') + '#' + p.matchId;
      seen[k] = (seen[k] || 0) + 1;
      if (seen[k] === 2) { dup++; if (samples.length < 5) samples.push(k); }
    });
    console.log('==== ③ ' + label + ' 重复(同人同场) = ' + dup + (samples.length ? ' 例:' + samples.join(',') : '') + ' ====');
  }
  dupCheck(A, 'A组');
  dupCheck(B, 'B组');

  // 4. 比分结算数
  const finished = Object.entries(scores).filter(([,s]) => s.status === 'finished');
  console.log('==== ④ 比分 ====');
  console.log('   scores 总场次 = ' + Object.keys(scores).length + ' | finished = ' + finished.length);

  // 5. X因素答案检查
  console.log('==== ⑤ X因素答案锁定 ====');
  ['101','102','103','104'].forEach(mid => {
    const s = scores[mid] || {};
    console.log('   M' + mid + ': status=' + (s.status||'-') + ' xStats=' + JSON.stringify(s.xStats||{}) + ' xOutcomes=' + JSON.stringify(s.xOutcomes||{}));
  });

  // 6. points/xPoints 空值或异常
  function scoreCheck(arr, label) {
    let nullPts = 0, hasXP = 0, negXP = 0;
    arr.forEach(p => {
      if (p.points == null) nullPts++;
      if (typeof p.xPoints === 'number') { hasXP++; if (p.xPoints < 0) negXP++; }
    });
    console.log('   ' + label + ': points为空=' + nullPts + ' | 有xPoints=' + hasXP + ' | 负xPoints=' + negXP);
  }
  console.log('==== ⑥ 积分字段 ====');
  scoreCheck(A, 'A组');
  scoreCheck(B, 'B组');

  // 7. 字段完整性抽查
  console.log('==== ⑦ 字段完整性 ====');
  function fieldCheck(arr, label) {
    let noMatch = 0, noPred = 0;
    arr.forEach(p => {
      if (p.matchId == null) noMatch++;
      if (p.homePred == null || p.awayPred == null) noPred++;
    });
    console.log('   ' + label + ': 缺matchId=' + noMatch + ' | 缺比分预测=' + noPred);
  }
  fieldCheck(A, 'A组');
  fieldCheck(B, 'B组');

  console.log('\n==== 体检完成 ====');
})().catch(e => { console.log('💥 ' + e.message); process.exit(1); });
