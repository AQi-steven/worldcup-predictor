const https = require('https');
const fs = require('fs');
const NPOINT = 'https://api.npoint.io/REPLACE_WITH_NPOINT_ID';

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}}); }).on('error',reject);
  });
}
function putJSON(url, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = https.request(url, { method:'POST', headers:{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body)} }, res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(d));});
    req.on('error',reject); req.write(body); req.end();
  });
}

(async () => {
  const data = await getJSON(NPOINT);
  fs.writeFileSync('npoint_backup_before_clear_peeksB.json', JSON.stringify(data,null,2));
  const oldLen = (data.peeks_B||[]).length;
  data.peeks_B = [];
  console.log('Cleared peeks_B from', oldLen, '-> 0');
  const r = await putJSON(NPOINT, data);
  console.log('POST len', r.length, '| DONE');
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
