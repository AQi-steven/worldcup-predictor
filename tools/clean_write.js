const https = require('https');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { spawn } = require('child_process');

const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');
const NPOINT_URL = 'https://api.npoint.io/' + NPOINT_ID;
const OUT_DIR = path.join(__dirname, 'backups');
const POLLER_JS = path.join(__dirname, 'score-poller.js');
const NODE_EXE = process.env.NODE_EXE || 'node';  // 默认走 PATH 中的 node；可用环境变量 NODE_EXE 指定
const POLLER_PID = path.join(__dirname, 'score-poller.pid');

// 需要清除的测试/混乱账号
const JUNK = new Set([]);  // 示例占位：请按需填写需清除的测试账号

const garb = n => !!(n && n.includes('�'));
const isJunk = u => JUNK.has(u);
const normMid = m => String(m == null ? '' : m).replace(/^M/, '');
const deepCopy = a => JSON.parse(JSON.stringify(a));

function httpsReq(opts, bodyObj) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.npoint.io', path: '/' + NPOINT_ID, method: opts.method || 'GET',
      rejectUnauthorized: false, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
      secureOptions: tls.SSL_OP_NO_TLSv1_3 | tls.SSL_OP_NO_SSLv3,
      headers: opts.headers || {}
    }, res => { let c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(c) })); });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyObj) req.write(Buffer.from(JSON.stringify(bodyObj), 'utf8'));
    req.end();
  });
}

async function getRobust() {
  let best = null, bestCount = -1;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await httpsReq({ method: 'GET' });
      if (r.status !== 200) { console.log('GET' + (i + 1) + ' HTTP ' + r.status); continue; }
      const obj = JSON.parse(r.buf.toString('utf8'));
      const cnt = (obj.predictions || []).length + (obj.predictions_B || []).length +
        (obj.comments_A || []).length + (obj.comments_B || []).length +
        (obj.peeks_A || []).length + (obj.peeks_B || []).length;
      console.log('GET' + (i + 1) + ' total=' + cnt);
      if (cnt > bestCount) { bestCount = cnt; best = obj; }
    } catch (e) { console.log('GET' + (i + 1) + ' ERR ' + e.message); }
  }
  if (!best) throw new Error('GET 全部失败');
  return best;
}

// canonName（与前端一致）：按保留字符唯一匹配名册；无法唯一解析 -> null（视为删除）
function makeCanon(preds) {
  const clean = new Set(preds.filter(p => p.userName && p.userName !== 'null' && !garb(p.userName)).map(p => p.userName));
  return n => {
    if (!n || n === 'null' || !garb(n)) return n;
    const cl = [...n].filter(c => c !== '�');
    if (!cl.length) return null;
    const hits = [...clean].filter(u => cl.every(ch => [...u].includes(ch)));
    return hits.length === 1 ? hits[0] : null;
  };
}

function cleanPredictions(arr, canon) {
  const out = [], seen = new Set();
  arr.forEach(p => {
    const u = canon(p.userName);
    if (!u || isJunk(u)) return;
    const m = normMid(p.matchId);
    const k = u + '#' + m;
    if (seen.has(k)) {
      const ex = out.find(x => x.userName === u && normMid(x.matchId) === m);
      if (ex && (typeof ex.points !== 'number') && typeof p.points === 'number') Object.assign(ex, p);
      return;
    }
    seen.add(k);
    out.push({ ...p, userName: u, matchId: m });
  });
  return out;
}

function cleanMeta(arr, canon) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  arr.forEach(c => {
    const u = canon(c.userName);
    if (!u || isJunk(u)) return;
    out.push({ ...c, userName: u });
  });
  return out;
}

function recKey(rec, isPred) {
  if (isPred) return (rec.userName || '') + '#' + normMid(rec.matchId);
  return (rec.userName || '') + '#' + normMid(rec.matchId) + '#' + (rec.ts || rec.text || JSON.stringify(rec));
}

// 合并补齐：把 fresh 中【非junk且非乱码且不在 cleaned 中】的记录加回（防操作期间新提交丢失）
function mergeProtect(cleaned, fresh) {
  for (const key of ['predictions', 'predictions_B', 'comments_A', 'comments_B', 'peeks_A', 'peeks_B']) {
    const isPred = key.indexOf('predictions') === 0;
    const a = cleaned[key] = cleaned[key] || [];
    const b = fresh[key] || [];
    const seen = new Set(a.map(x => recKey(x, isPred)));
    let added = 0;
    for (const rec of b) {
      const u = rec.userName;
      if (!u || isJunk(u) || garb(u)) continue;
      const k = recKey(rec, isPred);
      if (!seen.has(k)) { a.push(rec); seen.add(k); added++; }
    }
    if (added) console.log('  mergeProtect 补齐 ' + added + ' 条 ' + key);
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('=== 1. 终止 score-poller 防止覆盖 ===');
  try {
    const pid = fs.readFileSync(POLLER_PID, 'utf8').trim();
    if (pid) { spawn('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' }); console.log('  已请求终止 PID ' + pid); }
  } catch (e) { console.log('  PID文件读取失败: ' + e.message); }
  await new Promise(r => setTimeout(r, 1500));

  console.log('\n=== 2. 拉取当前 npoint（基线）===');
  const base = await getRobust();

  console.log('\n=== 3. 清洗 A组 ===');
  const canonA = makeCanon(base.predictions || []);
  const cleanA_pred = cleanPredictions(base.predictions || [], canonA);
  const cleanA_comments = cleanMeta(base.comments_A || [], canonA);
  const cleanA_peeks = cleanMeta(base.peeks_A || [], canonA);
  console.log('  A预测清洗: ' + (base.predictions || []).length + ' -> ' + cleanA_pred.length +
    ' (删 ' + ((base.predictions || []).length - cleanA_pred.length) + ' 条junk/乱码)');

  console.log('\n=== 4. 二次拉取做 mergeProtect（防操作期间新提交丢失）===');
  const fresh = await getRobust();
  const cleaned = {
    predictions: cleanA_pred,
    comments_A: cleanA_comments,
    peeks_A: cleanA_peeks,
    scores: base.scores || {}
  };
  mergeProtect(cleaned, fresh);
  // 镜像 B = A（mergeProtect 之后固化，保证一致）
  cleaned.predictions_B = deepCopy(cleaned.predictions);
  cleaned.comments_B = deepCopy(cleaned.comments_A);
  cleaned.peeks_B = deepCopy(cleaned.peeks_A);

  console.log('\n=== 5. 校验 ===');
  let gc = 0, jc = 0;
  ['predictions', 'predictions_B', 'comments_A', 'comments_B', 'peeks_A', 'peeks_B'].forEach(k =>
    (cleaned[k] || []).forEach(r => { if (garb(r.userName)) gc++; if (isJunk(r.userName)) jc++; }));
  console.log('A预测:', cleaned.predictions.length, '| B预测:', cleaned.predictions_B.length, '(应相等=镜像)');
  console.log('残留乱码名:', gc, '| 残留junk:', jc, '| scores场数:', Object.keys(cleaned.scores).length);
  if (gc > 0 || jc > 0) throw new Error('清洗不彻底，中止写回');
  if (cleaned.predictions_B.length !== cleaned.predictions.length) throw new Error('B未正确镜像A');

  console.log('\n=== 6. POST 写回 npoint（charset=utf-8）===');
  const postRes = await httpsReq({ method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' } }, cleaned);
  console.log('POST 状态:', postRes.status);
  if (postRes.status !== 200) { console.log(postRes.buf.toString('utf8').slice(0, 300)); throw new Error('POST 失败'); }

  console.log('\n=== 7. 回读校验 ===');
  const verify = await getRobust();
  const vGarb = ['predictions', 'predictions_B'].reduce((s, k) => s + (verify[k] || []).filter(r => garb(r.userName)).length, 0);
  const vJunk = ['predictions', 'predictions_B'].reduce((s, k) => s + (verify[k] || []).filter(r => isJunk(r.userName)).length, 0);
  console.log('回读 A:', (verify.predictions || []).length, 'B:', (verify.predictions_B || []).length);
  console.log('回读乱码:', vGarb, '| 回读junk:', vJunk);
  if (vGarb > 0 || vJunk > 0 || (verify.predictions_B || []).length !== (verify.predictions || []).length) throw new Error('回读校验失败');

  console.log('\n=== 8. 保存干净备份 ===');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = path.join(OUT_DIR, 'clean_A_mirroredB_' + ts + '.json');
  fs.writeFileSync(bak, JSON.stringify(cleaned, null, 2), 'utf8');
  console.log('干净备份 -> ' + bak);

  console.log('\n=== 9. 重启 score-poller ===');
  try {
    const child = spawn(NODE_EXE, [POLLER_JS], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log('poller 已重启 PID=' + child.pid);
  } catch (e) { console.log('重启失败(需手动): ' + e.message); }

  console.log('\n✅ 完成：A组已清洗并写回，B组镜像A，无乱码无junk，已备份。');
})().catch(e => { console.error('\n❌ 失败:', e.message); process.exit(1); });
