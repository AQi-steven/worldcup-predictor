const https = require('https');
const fs = require('fs');
const path = require('path');

const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');
const NPOINT_URL = 'https://api.npoint.io/' + NPOINT_ID;
const BACKUP_DIR = path.join(__dirname, 'backups');

function npointGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {minVersion:'TLSv1.2'}, res => {
      let data=''; res.on('data',c=>data+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(data));}catch(e){reject(new Error('JSON parse: '+e.message));} });
    });
    req.on('error', reject);
    req.setTimeout(25000, ()=>{req.destroy(); reject(new Error('GET timeout'));});
  });
}

async function npointGetRobust(url) {
  let best=null, bestCount=-1, errors=[];
  for (let i=0;i<3;i++){
    try {
      const d = await npointGet(url + '?_t=' + Date.now());
      const count = (d.predictions||[]).length + (d.predictions_B||[]).length;
      const picked = count > bestCount;
      if (picked) { bestCount=count; best=d; }
      console.log(`  GET 第${i+1}次: A=${(d.predictions||[]).length} B=${(d.predictions_B||[]).length}, 采纳=${picked}`);
    } catch(e){ errors.push(e.message); console.log(`  GET 第${i+1}次失败: ${e.message}`); }
    if (i<2) await new Promise(r=>setTimeout(r,600));
  }
  if (!best) throw new Error('全部 GET 失败: '+errors.join('; '));
  return best;
}

function npointPost(url, obj) {
  const body = JSON.stringify(obj);
  const buf = Buffer.from(body,'utf8');
  return new Promise((resolve,reject)=>{
    const req = https.request(url, {
      method:'POST',
      minVersion:'TLSv1.2',
      headers:{'Content-Type':'application/json; charset=utf-8','Content-Length':buf.length}
    }, res=>{
      let data=''; res.on('data',c=>data+=c);
      res.on('end',()=>resolve({status:res.statusCode, body:data}));
    });
    req.on('error', reject);
    req.setTimeout(25000,()=>{req.destroy(); reject(new Error('POST timeout'));});
    req.write(buf); req.end();
  });
}

(async()=>{
  console.log('=== 1. 拉取当前 npoint 文档 ===');
  const doc = await npointGetRobust(NPOINT_URL);
  console.log('当前字段:', Object.keys(doc).join(', '));
  console.log(`predictions(A): ${(doc.predictions||[]).length}, predictions_B: ${(doc.predictions_B||[]).length}`);
  console.log(`comments_A: ${(doc.comments_A||[]).length}, comments_B: ${(doc.comments_B||[]).length}`);
  console.log(`peeks_A: ${(doc.peeks_A||[]).length}, peeks_B: ${(doc.peeks_B||[]).length}`);
  console.log(`scores 比赛数: ${Object.keys(doc.scores||{}).length}`);

  console.log('\n=== 2. 备份当前文档到本地 ===');
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, {recursive:true});
  const bak = path.join(BACKUP_DIR, 'npoint_mirror_backup_'+new Date().toISOString().slice(0,10)+'.json');
  fs.writeFileSync(bak, JSON.stringify(doc, null, 2), 'utf8');
  console.log('已备份到:', bak);

  console.log('\n=== 3. 构造镜像（A -> B）===');
  const mirrored = {
    ...doc,
    predictions_B: doc.predictions || [],
    comments_B: doc.comments_A || [],
    peeks_B: doc.peeks_A || []
  };
  console.log(`predictions_B <- predictions (${(mirrored.predictions_B).length})`);
  console.log(`comments_B <- comments_A (${(mirrored.comments_B).length})`);
  console.log(`peeks_B <- peeks_A (${(mirrored.peeks_B).length})`);
  console.log('scores 保持不变（A/B 共享同一份）');

  console.log('\n=== 4. POST 回写 npoint ===');
  const r = await npointPost(NPOINT_URL, mirrored);
  console.log('POST 状态:', r.status);
  if (r.status !== 200) { console.log('POST 返回:', r.body); throw new Error('POST 失败'); }

  console.log('\n=== 5. 校验回读 ===');
  const verify = await npointGetRobust(NPOINT_URL);
  const aP=(doc.predictions||[]).length, aC=(doc.comments_A||[]).length, aK=(doc.peeks_A||[]).length;
  console.log(`校验 predictions_B: ${(verify.predictions_B||[]).length} (应=${aP})`);
  console.log(`校验 comments_B: ${(verify.comments_B||[]).length} (应=${aC})`);
  console.log(`校验 peeks_B: ${(verify.peeks_B||[]).length} (应=${aK})`);
  const ok = (verify.predictions_B||[]).length===aP && (verify.comments_B||[]).length===aC && (verify.peeks_B||[]).length===aK;
  console.log(ok ? '\n✅ 镜像成功！B组现已等于A组数据。' : '\n❌ 校验失败，请检查。');
  if (!ok) process.exit(1);
})().catch(e=>{ console.error('失败:', e.message); process.exit(1); });
