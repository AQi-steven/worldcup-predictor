// 从已恢复的 npoint 拉取最新全量，生成 WC_NPOINT_RAW 快照写入 4 个 deploy 目录的 data.js
const https = require('https');
const fs = require('fs');
const NPOINT = 'https://api.npoint.io/REPLACE_WITH_NPOINT_ID';
const DIRS = ['deploy', 'deploy2', 'deploy_wx', 'deploy2_wx'];

function robustGet(tries = 3) {
  return new Promise((resolve, reject) => {
    let best = null, done = 0;
    for (let i = 0; i < tries; i++) {
      const r = https.request(NPOINT, { method: 'GET', headers: { 'Cache-Control': 'no-cache' } }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(d);
            const size = (data.predictions?.length || 0) + (data.predictions_B?.length || 0) + Object.keys(data.scores || {}).length;
            if (!best || size > (best.predictions?.length || 0) + (best.predictions_B?.length || 0) + Object.keys(best.scores || {}).length) best = data;
          } catch (e) {}
          if (++done === tries) resolve(best);
        });
      });
      r.on('error', () => { if (++done === tries) resolve(best); });
      r.end();
      r.setTimeout(20000, () => { r.destroy(); if (++done === tries) resolve(best); });
    }
  });
}

(async () => {
  const data = await robustGet(3);
  if (!data) { console.log('拉取失败'); process.exit(1); }
  const nPred = (data.predictions || []).length;
  const nUsers = new Set((data.predictions || []).map(p => p.userName)).size;
  console.log('npoint 全量: predictions=' + nPred + ' 用户=' + nUsers + ' 比分=' + Object.keys(data.scores || {}).length);
  if (nPred < 900) { console.log('⚠️ 数量异常偏少，疑似拉到损坏副本，中止生成'); process.exit(1); }
  const out = 'const WC_NPOINT_RAW = ' + JSON.stringify(data) + ';\n';
  for (const dir of DIRS) {
    const p = dir + '/data.js';
    if (fs.existsSync(p)) { fs.writeFileSync(p, out); console.log('  写入 ' + p + ' (' + out.length + ' 字节)'); }
    else console.log('  跳过(不存在) ' + p);
  }
  console.log('DONE');
})();
