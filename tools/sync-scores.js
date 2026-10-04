// 世界杯比分同步脚本 - 独立运行，供自动化和手动调用
// 从 worldcup26.ir 获取最新比赛数据，同步到 npoint.io

const https = require('https');
const fs = require('fs');
const path = require('path');
const tls = require('tls');

const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');
const API_HOST = 'worldcup26.ir';
const LOG_FILE = path.join(__dirname, 'sync-scores.log');

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

function calcPts(ah, aa, ph, pa, phase) {
  // 基础得分：5-4-3-1
  let basePts;
  if (ah === ph && aa === pa) basePts = 5;
  else {
    const diff = ah - aa, pdiff = ph - pa;
    if (diff === pdiff && diff !== 0) basePts = 4;
    else {
      const ar = ah > aa ? 'w' : ah < aa ? 'l' : 'd';
      const pr = ph > pa ? 'w' : ph < pa ? 'l' : 'd';
      basePts = (ar === pr) ? 3 : 1;
    }
  }
  
  // 根据比赛阶段计算倍数
  const multipliers = {
    '小组赛': 1, '十六分之一决赛': 2, '八分之一决赛': 3, '四分之一决赛': 4,
    '半决赛': 5, '季军赛': 5, '决赛': 6
  };
  const multiplier = multipliers[phase] || 1;
  // 四分之一决赛起（倍率≥4）：参与奖/方向对且猜中任一队比分 → +0.5 基础分
  if (multiplier >= 4 && (basePts === 1 || basePts === 3)) {
    if (ph === ah || pa === aa) basePts += 0.5;
  }
  return basePts * multiplier;
}

// 淘汰赛：从scorers字段计算90分钟+加时赛总比分（排除点球大战进球）
// scorers格式: {"J. Quiñones 9'","R. Jiménez 67'"} 或 "null"
// 加时赛进球: 时间 > 90 (如 105', 120'+2')
// 点球大战进球: 通常标注为 (pen.) 或时间 > 120
// 注意: FIFA规则中点球大战进球不计入球员个人进球，通常不在scorers中出现
function calcRegTimeScore(homeScorers, awayScorers) {
  let homeGoals = 0, awayGoals = 0;

  function countGoals(scorersStr) {
    if (!scorersStr || scorersStr === 'null') return 0;
    let count = 0;
    // 解析scorers中的每个进球，格式: {"Name 45'+2'","Name 67'"} 或类似
    // 使用正则匹配进球时间
    const goalPattern = /(\d+)('\+?\d*'?)/g;
    let match;
    while ((match = goalPattern.exec(scorersStr)) !== null) {
      const minute = parseInt(match[1]);
      // 排除点球大战进球(>120分钟) — 加时赛进球(91-120分钟)保留
      if (minute <= 120) {
        count++;
      }
      // minute > 120 的进球视为点球大战，排除
    }
    return count;
  }

  try {
    homeGoals = countGoals(homeScorers);
    awayGoals = countGoals(awayScorers);
    return { home: homeGoals, away: awayGoals };
  } catch {
    return null;
  }
}

// === HTTPS 请求 ===
function apiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: API_HOST,
      path: path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json; charset=utf-8' },
      rejectUnauthorized: false,
      secureOptions: tls.SSL_OP_NO_TLSv1_3 | tls.SSL_OP_NO_SSLv3,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      timeout: 30000
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
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

// === 主同步逻辑 ===
async function syncScores() {
  log('⚽ 开始同步比分...');

  // 加载 MATCH_DATA 以获取 phase 信息
  let phaseMap = {};
  try {
    const filePath = path.join(__dirname, 'match_data.js');
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/const MATCH_DATA = (\[[\s\S]*?\]);/);
    if (match) {
      const MATCH_DATA = new Function('return ' + match[1])();
      MATCH_DATA.forEach(m => {
        if (m.phase) {
          phaseMap[m.id] = m.phase;           // "M73" → "十六分之一决赛"
          phaseMap[m.id.replace('M','')] = m.phase; // "73" → "十六分之一决赛"
        }
      });
      log(`✅ 已加载 ${MATCH_DATA.length} 场比赛的 phase 信息`);
    }
  } catch (e) {
    log('⚠️ 加载 MATCH_DATA 失败，将使用默认倍数: ' + e.message);
  }

  // 1. 获取API比赛数据
  let apiData;
  try {
    apiData = await apiGet('/get/games');
  } catch (e) {
    log('❌ API请求失败: ' + e.message);
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
      let homeScore = parseInt(g.home_score);
      let awayScore = parseInt(g.away_score);
      const isKnockout = ['r32', 'r16', 'qf', 'sf', 'third', 'final'].includes(g.type);

      // 淘汰赛：排除点球大战进球（如果API比分包含了点球）
      // 规则：预测比分 = 90分钟+加时赛总比分，不含点球决胜进球
      // 通过分析scorers中的进球时间来判断
      if (isKnockout) {
        const regTimeScore = calcRegTimeScore(g.home_scorers, g.away_scorers);
        if (regTimeScore !== null) {
          // 防御：如果calcRegTimeScore结果 < API最终比分，说明可能漏了加时赛进球
          // 此时相信API的最终比分（淘汰赛API最终比分=90分钟+加时赛，不含点球）
          if (regTimeScore.home < homeScore || regTimeScore.away < awayScore) {
            log(`⚠️ 淘汰赛M${g.id}: calcRegTimeScore结果(${regTimeScore.home}-${regTimeScore.away})小于API最终比分(${homeScore}-${awayScore})，相信API最终比分`);
            // homeScore/awayScore保持API值不变
          } else if (regTimeScore.home !== homeScore || regTimeScore.away !== awayScore) {
            log(`⚠️ 淘汰赛M${g.id}: API比分${homeScore}-${awayScore}, 常规+加时${regTimeScore.home}-${regTimeScore.away}, 使用常规+加时比分（排除点球）`);
            homeScore = regTimeScore.home;
            awayScore = regTimeScore.away;
          }
        } else {
          // 如果scorers无法解析，保留API比分（相信API最终比分=90分钟+加时赛）
          log(`⚠️ 淘汰赛M${g.id}: 无法解析scorers，相信API最终比分${homeScore}-${awayScore}`);
        }
      }

      apiScores[g.id] = {
        homeScore,
        awayScore,
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

  // 6.5 如果npoint中已有scoreOverride（手动修正的比分），优先使用
  for (const [mid, old] of Object.entries(oldScores)) {
    if (old.scoreOverride && mergedScores[mid]) {
      if (mergedScores[mid].homeScore !== old.scoreOverride.home ||
          mergedScores[mid].awayScore !== old.scoreOverride.away) {
        log(`📝 M${mid}: 使用手动覆盖比分 ${old.scoreOverride.home}-${old.scoreOverride.away} (API=${mergedScores[mid].homeScore}-${mergedScores[mid].awayScore})`);
        mergedScores[mid].homeScore = old.scoreOverride.home;
        mergedScores[mid].awayScore = old.scoreOverride.away;
      }
      // 保留scoreOverride标记
      mergedScores[mid].scoreOverride = old.scoreOverride;
    }
  }

  const newFinished = finishedCount - Object.values(oldScores).filter(s => s.status === 'finished').length;

  // 7. 计算积分
  let pointsUpdated = 0;
  for (const key of ['predictions', 'predictions_B']) {
    const preds = currentData[key];
    if (!Array.isArray(preds)) continue;
    preds.forEach(p => {
      const s = mergedScores[p.matchId] || mergedScores[String(p.matchId)];
      if (s && s.status === 'finished' && p.homePred != null) {
        const phase = phaseMap[String(p.matchId)] || '小组赛';
        const correctPts = calcPts(s.homeScore, s.awayScore, p.homePred, p.awayPred, phase);
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
  let garbledRemoved = 0;
  for (const key of ['predictions', 'predictions_B']) {
    const preds = currentData[key];
    if (!Array.isArray(preds)) continue;
    for (let i = preds.length - 1; i >= 0; i--) {
      const u = preds[i].userName;
      // 删除 null/空用户名
      if (!u || u === 'null') {
        preds.splice(i, 1);
        cleaned++;
      }
      // 删除含乱码字符(U+FFFD)的用户名——删除FFFD后残余名字不完整会污染数据
      else if (u.includes('\uFFFD')) {
        preds.splice(i, 1);
        garbledRemoved++;
      }
    }
  }

  // 9. 写回 npoint
  try {
    await npointPost({ ...currentData, scores: mergedScores });
    log(`✅ 同步完成! ${Object.keys(mergedScores).length}场比分, ${pointsUpdated}条积分, 清理${cleaned}条null, 删除${garbledRemoved}条乱码`);
  } catch (e) {
    log('❌ npoint写入失败: ' + e.message);
  }

  // 10. 检查今日是否全部完成
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
}

// 带重试的同步
async function syncWithRetry(maxRetries = 3) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await syncScores();
      return;
    } catch (e) {
      lastErr = e;
      log(`⚠️ 第${i+1}次尝试失败: ${e.message}`);
      if (i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }
  log(`❌ 同步失败，已重试${maxRetries}次。最后错误: ${lastErr?.message}`);
}

// 执行
syncWithRetry().then(() => {
  log('🔄 同步脚本执行完毕');
  process.exit(0);
}).catch(e => {
  log('❌ 未知错误: ' + e.message);
  process.exit(1);
});
