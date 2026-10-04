const https = require('https');
const fs = require('fs');
const NPOINT = 'https://api.npoint.io/REPLACE_WITH_NPOINT_ID';

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function putJSON(url, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

(async () => {
  const data = await getJSON(NPOINT);
  fs.writeFileSync('npoint_backup_before_copyA2B_v2.json', JSON.stringify(data, null, 2));
  console.log('Backup saved. predictions len=', data.predictions.length, ' predictions_B len=', data.predictions_B.length);

  // Copy A (main predictions) -> B
  data.predictions_B = JSON.parse(JSON.stringify(data.predictions));
  console.log('Copied predictions -> predictions_B (len ' + data.predictions_B.length + ')');

  // Copy comments_A -> comments_B
  if ('comments_A' in data) {
    data.comments_B = JSON.parse(JSON.stringify(data.comments_A));
    console.log('Copied comments_A -> comments_B (len ' + data.comments_B.length + ')');
  }

  // Peeks: A has no peeks_A field; leave peeks_B untouched (report only)
  console.log('peeks_B currently len =', (data.peeks_B||[]).length, '(A has no peeks_A; left as-is)');

  const r = await putJSON(NPOINT, data);
  console.log('POST result len:', r.length, '| DONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
