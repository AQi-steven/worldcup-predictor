// 清除 A组 8 条三无空记录（P06/P07/P08/P11 @ M99/M100，无比分预测/无X选择/无分数）
// 恢复数据时误并入的垃圾。删除采用：robust读取最全副本→只删严格匹配的空记录→多次POST逼收敛。
const https = require('https');
const fs = require('fs');
const path = require('path');

const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');
const TARGET_USERS = ['P06','P07','P08','P11'];
const TARGET_MATCHES = ['99','100'];

function req(method, body) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.npoint.io', path: '/' + NPOINT_ID, method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json; charset=utf-8' } : {},
      rejectUnauthorized: false, timeout: 30000
    }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode)); return; }
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function getRobust(tries = 6) {
  let best = null, bestSize = -1;
  for (let i = 0; i < tries; i++) {
    try {
      const d = await req('GET');
      const size = (d.predictions?.length || 0) + (d.predictions_B?.length || 0);
      if (size > bestSize) { bestSize = size; best = d; }
    } catch (e) { console.log('   GET ' + (i+1) + ' 失败: ' + e.message); }
    if (i < tries - 1) await new Promise(r => setTimeout(r, 700));
  }
  if (!best) throw new Error('全部GET失败');
  return best;
}
// 是否为「三无空记录」：目标用户+目标场次+无比分预测+无X选择+无分数
function isJunk(p) {
  return TARGET_USERS.includes(p.userName)
    && TARGET_MATCHES.includes(String(p.matchId))
    && (p.homePred == null && p.awayPred == null)
    && (p.xChoices == null || (typeof p.xChoices === 'object' && Object.keys(p.xChoices).length === 0))
    && (p.points == null)
    && (p.xPoints == null);
}

(async () => {
  console.log('① robust 拉取最全副本...');
  const d = await getRobust();
  const A0 = (d.predictions || []).length, B0 = (d.predictions_B || []).length;
  console.log('   当前 A=' + A0 + ' B=' + B0);
  if (A0 < 900) { console.log('🛑 A组过低，疑似残缺副本，终止'); process.exit(1); }

  // 备份
  const bkDir = path.join(__dirname, 'backups');
  try { fs.mkdirSync(bkDir, { recursive: true }); } catch {}
  const bkPath = path.join(bkDir, 'before_cleanup8_' + new Date().toISOString().replace(/[:.]/g,'-') + '.json');
  fs.writeFileSync(bkPath, JSON.stringify(d));
  console.log('   已备份: ' + bkPath);

  const junk = (d.predictions || []).filter(isJunk);
  console.log('② 命中三无空记录 ' + junk.length + ' 条:');
  junk.forEach(p => console.log('   - ' + p.userName + ' M' + p.matchId));
  if (junk.length === 0) { console.log('   无需清理'); process.exit(0); }
  if (junk.length > 8) { console.log('🛑 命中过多(>8)，异常，终止防误删'); process.exit(1); }

  d.predictions = (d.predictions || []).filter(p => !isJunk(p));
  const A1 = d.predictions.length;
  console.log('③ 清理后 A=' + A1 + ' (删除 ' + (A0 - A1) + ' 条)');
  if (A0 - A1 !== junk.length) { console.log('🛑 删除数不符，终止'); process.exit(1); }

  // 多次POST逼收敛
  for (let i = 0; i < 4; i++) {
    console.log('④ 写回 npoint 第' + (i+1) + '轮...');
    await req('POST', d);
    await new Promise(r => setTimeout(r, 900));
  }

  console.log('⑤ 校验收敛...');
  const v = await getRobust(6);
  const remain = (v.predictions || []).filter(isJunk).length;
  const Av = (v.predictions||[]).length, Bv = (v.predictions_B||[]).length;
  console.log('   校验 A=' + Av + ' B=' + Bv + ' | 残留空记录=' + remain);

  // 更新水位线
  const hwm = path.join(__dirname, 'pred_highmark.json');
  const newMark = Math.max(Av, Bv);
  fs.writeFileSync(hwm, JSON.stringify({ mark: newMark, updated: Date.now() }));
  console.log('⑥ 已更新 pred_highmark.json → mark=' + newMark);

  console.log(remain === 0 ? '✅ 清理成功' : '⚠️ 仍有残留，可能需再跑一次');
  process.exit(remain === 0 ? 0 : 1);
})().catch(e => { console.log('💥 ' + e.message); process.exit(1); });
