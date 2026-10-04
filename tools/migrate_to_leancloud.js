// 一次性迁移脚本：把 npoint 的 B 组数据迁到 LeanCloud（分块存储）
// 用法（在 shell 里先 export 凭证，再运行）：
//   export LC_BASE="https://xxxx.lc-cn-n1-shared.com/1.1"
//   export LC_APP_ID="你的AppId"
//   export LC_MASTER_KEY="你的MasterKey"
//   node migrate_to_leancloud.js
// 运行后会打印 metaObjectId，把它填进 deploy2-lc/index.html 的 LEANCLOUD.metaObjectId

const https = require('https');
const { URL } = require('url');

const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');
const NPOINT_URL = 'https://api.npoint.io/' + NPOINT_ID;

const LC_BASE = process.env.LC_BASE;
const LC_APP_ID = process.env.LC_APP_ID;
const LC_MASTER_KEY = process.env.LC_MASTER_KEY;
const CHUNK_SIZE = 300;

if (!LC_BASE || !LC_APP_ID || !LC_MASTER_KEY) {
  console.error('缺少凭证！请先 export LC_BASE / LC_APP_ID / LC_MASTER_KEY');
  process.exit(1);
}

function npointGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { minVersion: 'TLSv1.2' }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('npoint GET timeout')); });
  });
}

function lcRequest(method, path, bodyObj) {
  const url = new URL(LC_BASE + path);
  const body = bodyObj ? JSON.stringify(bodyObj) : null;
  const buf = body ? Buffer.from(body, 'utf8') : null;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      minVersion: 'TLSv1.2',
      headers: {
        'X-LC-Id': LC_APP_ID,
        'X-LC-Key': LC_MASTER_KEY + ',master',  // Master Key 绕过 ACL，用于建类/设公开写
        'Content-Type': 'application/json'
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const txt = d;
        try { resolve({ status: res.statusCode, json: txt ? JSON.parse(txt) : null, raw: txt }); }
        catch (e) { resolve({ status: res.statusCode, json: null, raw: txt }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('LC timeout')); });
    if (buf) req.write(buf);
    req.end();
  });
}

const PUBLIC_ACL = { '*': { read: true, write: true } };

(async () => {
  console.log('1. 拉取 npoint B 组数据 ...');
  const doc = await npointGet(NPOINT_URL + '?_t=' + Date.now());
  const preds = doc.predictions_B || [];
  const scores = doc.scores || {};
  const comments_B = doc.comments_B || [];
  const peeks_B = doc.peeks_B || [];
  console.log(`   predictions_B=${preds.length}, scores=${Object.keys(scores).length}, comments_B=${comments_B.length}, peeks_B=${peeks_B.length}`);

  console.log('2. 创建 Meta 对象（比分/留言/偷看）...');
  const meta = await lcRequest('POST', '/1.1/classes/WorldCupMeta', {
    scores, comments_B, peeks_B, ACL: PUBLIC_ACL
  });
  if (meta.status < 200 || meta.status >= 300) throw new Error('Meta 创建失败: ' + meta.status + ' ' + meta.raw);
  const metaObjectId = meta.json.objectId;
  console.log('   Meta objectId =', metaObjectId);

  console.log('3. 预测分块写入 PredChunk（每块 ' + CHUNK_SIZE + ' 条）...');
  const chunks = [];
  for (let i = 0; i < preds.length; i += CHUNK_SIZE) chunks.push(preds.slice(i, i + CHUNK_SIZE));
  console.log(`   共 ${chunks.length} 块`);
  for (let i = 0; i < chunks.length; i++) {
    const r = await lcRequest('POST', '/1.1/classes/PredChunk', {
      game: 'B', chunk: i, predictions_B: chunks[i], ACL: PUBLIC_ACL
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`块 ${i} 写入失败: ` + r.status + ' ' + r.raw);
    console.log(`   块 ${i}: ${chunks[i].length} 条 ✓`);
  }

  console.log('4. 回读校验 ...');
  const mBack = await lcRequest('GET', '/1.1/classes/WorldCupMeta/' + metaObjectId);
  if (mBack.status !== 200) throw new Error('Meta 回读失败: ' + mBack.status);
  const pBack = await lcRequest('GET', '/1.1/classes/PredChunk?where=' + encodeURIComponent(JSON.stringify({ game: 'B' })) + '&limit=1000');
  if (pBack.status !== 200) throw new Error('PredChunk 回读失败: ' + pBack.status);
  let backPreds = [];
  (pBack.json.results || []).forEach(r => { backPreds = backPreds.concat(r.predictions_B || []); });
  const okMeta = (mBack.json.comments_B || []).length === comments_B.length && (mBack.json.peeks_B || []).length === peeks_B.length;
  const okPreds = backPreds.length === preds.length;
  console.log(`   预测回读=${backPreds.length} (应=${preds.length}) ${okPreds ? '✓' : '✗'}`);
  console.log(`   Meta回读 comments_B=${ (mBack.json.comments_B||[]).length } peeks_B=${ (mBack.json.peeks_B||[]).length } ${okMeta ? '✓' : '✗'}`);
  if (!okPreds || !okMeta) throw new Error('回读校验不一致！');

  console.log('\n✅ 迁移完成！');
  console.log('请把下面这行填进 deploy2-lc/index.html 的 LEANCLOUD.metaObjectId：');
  console.log('  metaObjectId: ' + JSON.stringify(metaObjectId));
})().catch(e => { console.error('迁移失败:', e.message); process.exit(1); });
