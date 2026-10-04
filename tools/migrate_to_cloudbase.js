// migrate_to_cloudbase.js
// 从 npoint 读 B 组数据 → 写入 CloudBase 单文档（集合 worldcup / 文档 data）
// 运行：NODE_PATH=<你的 node_modules 路径> node migrate_to_cloudbase.js
const https = require('https');
const tcb = require('@cloudbase/node-sdk');

const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');
const NPOINT_URL = 'https://api.npoint.io/' + NPOINT_ID;

// ===== 填入你的 CloudBase 凭证（控制台→访问管理→API密钥 拿 secretId/secretKey；环境页拿 env/region）=====
const CB = {
  secretId: 'REPLACE_WITH_CLOUDBASE_SECRET_ID',
  secretKey: 'REPLACE_WITH_CLOUDBASE_SECRET_KEY',
  env: 'aqi-d6gu2fdshadb5e4a4',
  region: 'ap-shanghai' // 与前端 CLOUDBASE.region 保持一致
};

function npointGet() {
  return new Promise((resolve, reject) => {
    const url = NPOINT_URL + '?_t=' + Date.now();
    const req = https.get(url, { minVersion: 'TLSv1.2' }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('npoint 超时')); });
  });
}

(async () => {
  console.log('1) 读取 npoint B 组数据...');
  const np = await npointGet();
  const b = {
    predictions_B: np.predictions_B || [],
    scores: np.scores || {},
    comments_B: np.comments_B || [],
    peeks_B: np.peeks_B || []
  };
  console.log('   predictions_B:', b.predictions_B.length, '| scores 比赛:', Object.keys(b.scores).length, '| comments:', b.comments_B.length, '| peeks:', b.peeks_B.length);
  console.log('   单文档体积:', (JSON.stringify(b).length / 1024).toFixed(1), 'KB');

  console.log('2) 连接 CloudBase (env=' + CB.env + ', region=' + CB.region + ')...');
  const app = tcb.init({ secretId: CB.secretId, secretKey: CB.secretKey, env: CB.env, region: CB.region });
  const db = app.database();

  console.log('3) 写入集合 worldcup / 文档 data ...');
  const r = await db.collection('worldcup').doc('data').set(b);
  console.log('   写入结果:', JSON.stringify(r));

  console.log('4) 回读校验...');
  const back = await db.collection('worldcup').doc('data').get();
  const d = (back.data && back.data[0]) || {};
  const okPred = (d.predictions_B || []).length === b.predictions_B.length;
  const okScore = Object.keys(d.scores || {}).length === Object.keys(b.scores).length;
  console.log('   回读 predictions_B:', (d.predictions_B || []).length, '| 一致:', okPred);
  console.log('   回读 scores:', Object.keys(d.scores || {}).length, '| 一致:', okScore);
  console.log(okPred && okScore ? '\n✅ 迁移成功！把 env/region 填进前端 CLOUDBASE 配置即可。' : '\n⚠️ 校验不一致，请检查。');
  process.exit(okPred && okScore ? 0 : 2);
})().catch(e => { console.error('迁移失败:', e && e.message ? e.message : e); process.exit(1); });
