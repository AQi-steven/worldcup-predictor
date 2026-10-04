// 世界杯比分同步脚本 (curl版) - 先用curl --tlsv1.2拉取API数据，再同步到npoint
const https = require('https');
const fs = require('fs');
const path = require('path');

const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');
const LOG_FILE = path.join(__dirname, 'sync-scores.log');
const API_FILE = path.join(__dirname, 'tmp_api.json');

function log(msg) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
}

function getChinaDateStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function calcPts(ah, aa, ph, pa) {
  if (ah === ph && aa === pa) return 5;
  const diff = ah - aa, pdiff = ph - pa;
  if (diff === pdiff && diff !== 0) return 4;
  const ar = ah > aa ? 'w' : ah < aa ? 'l' : 'd';
  const pr = ph > pa ? 'w' : ph < pa ? 'l' : 'd';
  if (ar === pr) return 3;
  return 1;
}

function npointGet() {
  return new Promise((resolve, reject) => {
    https.get('https://api.npoint.io/' + NPOINT_ID, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

function npointPost(data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = https.request('https://api.npoint.io/' + NPOINT_ID, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`POST ${res.statusCode}: ${body.substring(0, 200)}`));
          return;
        }
        resolve(JSON.parse(body));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function syncScores() {
  log('⚽ 开始同步比分 (curl模式)...');

  // 1. 从本地文件读取API数据
  let apiData;
  try {
    apiData = JSON.parse(fs.readFileSync(API_FILE, 'utf8'));
  } catch (e) {
    log('❌ 读取API文件失败: ' + e.message);
    return;
  }

  if (!apiData.games) {
    log('❌ API返回数据格式异常');
    return;
  }

  const games = Object.values(apiData.games);

  // 2. 构建比分map
  const apiScores = {};
  games.forEach(g => {
    if (g.finished === 'TRUE') {
      apiScores[g.id] = {
        homeScore: parseInt(g.home_score),
        awayScore: parseInt(g.away_score),
        status: 'finished',
        timeElapsed: g.time_elapsed || 'finished'
      };
    } else if (g.time_elapsed && g.time_elapsed !== 'notstarted') {
      apiScores[g.id] = {
        homeScore: parseInt(g.home_score) || 0,
        awayScore: parseInt(g.away_score) || 0,
        status: 'live',
        timeElapsed: g.time_elapsed
      };
    }
  });

  const finishedCount = Object.values(apiScores).filter(s => s.status === 'finished').length;
  log(`📊 API数据: ${games.length}场, 已结束${finishedCount}`);

  // 3. 加载MATCH_DATA日期映射
  let matchDateMap = {};
  try {
    const mdPath = path.join(__dirname, 'deploy', 'match_data.js');
    if (fs.existsSync(mdPath)) {
      const mdContent = fs.readFileSync(mdPath, 'utf8').replace(/^const\s+MATCH_DATA/, 'var MATCH_DATA');
      eval(mdContent);
      if (typeof MATCH_DATA !== 'undefined') {
        MATCH_DATA.forEach(m => { if (m.bjDate) matchDateMap[String(m.id)] = m.bjDate.split(' ')[0]; });
      }
    }
  } catch (e) { /* 忽略 */ }

  // 4. 读取 npoint 当前数据
  let currentData;
  try {
    currentData = await npointGet();
  } catch (e) {
    log('❌ npoint读取失败: ' + e.message);
    return;
  }

  const oldScores = currentData.scores || {};
  const todayStr = getChinaDateStr();

  // 5. 处理settledDate
  for (const [mid, s] of Object.entries(apiScores)) {
    if (s.status === 'finished') {
      const old = oldScores[mid];
      if (old && old.status === 'finished') {
        s.settledDate = old.settledDate || matchDateMap[mid] || todayStr;
      } else {
        s.settledDate = matchDateMap[mid] || todayStr;
      }
    }
  }

  // 6. 合并比分
  const mergedScores = { ...oldScores, ...apiScores };
  const newFinished = finishedCount - Object.values(oldScores).filter(s => s.status === 'finished').length;

  log(`📋 原有已结束: ${Object.values(oldScores).filter(s => s.status === 'finished').length}, 新增已结束: ${newFinished}`);

  // 7. 计算积分
  let pointsUpdated = 0;
  for (const key of ['predictions', 'predictions_B']) {
    const preds = currentData[key];
    if (!Array.isArray(preds)) continue;
    preds.forEach(p => {
      const s = mergedScores[p.matchId] || mergedScores[String(p.matchId)];
      if (s && s.status === 'finished' && p.homePred != null) {
        const correctPts = calcPts(s.homeScore, s.awayScore, p.homePred, p.awayPred);
        if (p.points === null || p.points !== correctPts) {
          p.points = correctPts;
          p.settledDate = s.settledDate || todayStr;
          pointsUpdated++;
        }
      }
    });
  }

  // 8. 清理无效数据
  let cleaned = 0;
  for (const key of ['predictions', 'predictions_B']) {
    const preds = currentData[key];
    if (!Array.isArray(preds)) continue;
    for (let i = preds.length - 1; i >= 0; i--) {
      if (!preds[i].userName || preds[i].userName === 'null') {
        preds.splice(i, 1);
        cleaned++;
      }
    }
  }

  // 9. 写回 npoint
  try {
    await npointPost({ ...currentData, scores: mergedScores });
    log(`✅ 同步完成! ${Object.keys(mergedScores).length}场比分, ${pointsUpdated}条积分更新, 清理${cleaned}条`);
  } catch (e) {
    log('❌ npoint写入失败: ' + e.message);
  }

  // 10. 统计
  const totalPreds = (currentData.predictions || []).length + (currentData.predictions_B || []).length;
  const withPoints = (currentData.predictions || []).filter(p => p.points !== null && p.points !== undefined).length +
                     (currentData.predictions_B || []).filter(p => p.points !== null && p.points !== undefined).length;
  log(`📊 预测总数: ${totalPreds}, 已计分: ${withPoints}`);

  // 11. 检查今日是否全部完成
  const todayMatches = [];
  for (const [mid, dateStr] of Object.entries(matchDateMap)) {
    if (dateStr === todayStr) {
      todayMatches.push(mid);
    }
  }
  if (todayMatches.length > 0) {
    const allFinished = todayMatches.every(mid => {
      const s = mergedScores[mid];
      return s && s.status === 'finished';
    });
    if (allFinished) {
      log(`🏁 TODAY_COMPLETE 今日${todayMatches.length}场比赛全部结束 (${todayStr})`);
    } else {
      const done = todayMatches.filter(mid => {
        const s = mergedScores[mid];
        return s && s.status === 'finished';
      }).length;
      log(`⏳ 今日进度: ${done}/${todayMatches.length} 场已完成`);
    }
  }

  return { mergedScores, currentData, totalPreds, withPoints, finishedCount };
}

syncScores().then(result => {
  log('🔄 同步脚本执行完毕');
  process.exit(0);
}).catch(e => {
  log('❌ 未知错误: ' + e.message);
  process.exit(1);
});
