// 世界杯比分每日同步规划器
// 读取 MATCH_DATA，并可选地从 API 校验比赛时间，为明天的比赛创建一次性同步计划
// 输出 JSON 格式，供 WorkBuddy 自动化读取并创建一次性任务
//
// v2: 嵌入体育场时区映射，优先使用 API local_date + 时区计算北京时间
//     避免 MATCH_DATA.bjDate 潜在的时区错误（如墨西哥已取消夏令时）

const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');

// === 体育场时区映射（UTC偏移量）===
// 墨西哥已于2022年取消夏令时，永久 UTC-6
// 美国/加拿大赛事期间为夏令时
const STADIUM_TZ = {
  1: -6,  // Mexico City (永久UTC-6)
  2: -6,  // Guadalajara (永久UTC-6)
  3: -6,  // Monterrey (永久UTC-6)
  4: -5,  // Dallas (CDT)
  5: -5,  // Houston (CDT)
  6: -5,  // Kansas City (CDT)
  7: -4,  // Atlanta (EDT)
  8: -4,  // Miami (EDT)
  9: -4,  // Boston (EDT)
  10: -4, // Philadelphia (EDT)
  11: -4, // New York (EDT)
  12: -4, // Toronto (EDT)
  13: -7, // Vancouver (PDT)
  14: -7, // Seattle (PDT)
  15: -7, // San Francisco (PDT)
  16: -7, // Los Angeles (PDT)
};

const API_HOST = 'worldcup26.ir';
const API_PATH = '/get/games';
const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');

// === 工具函数 ===
function getBeijingDate(offset = 0) {
  // offset: 0=今天, 1=明天, -1=昨天
  const d = new Date();
  d.setHours(d.getHours() + 8 + offset * 24); // UTC+8
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0');
}

function parseTimeToMinutes(timeStr) {
  // "03:00" → 180
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// === API 获取 ===
function fetchAPI() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      path: API_PATH,
      method: 'GET',
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      timeout: 15000,
      headers: { 'Accept': 'application/json' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.data?.games || json.data || json);
        } catch (e) {
          reject(new Error('API JSON parse failed: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
    req.end();
  });
}

// === 时区转换：API local_date + stadium_id → 北京时间 ===
function apiToBeijingTime(localDateStr, stadiumId) {
  // localDateStr format: "MM/DD/YYYY HH:MM"
  const tzOffset = STADIUM_TZ[stadiumId];
  if (tzOffset === undefined) return null;

  const match = localDateStr.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!match) return null;

  const [, mo, d, y, h, mi] = match;
  const localDate = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));

  // 北京时间 = 当地时间 + (8 - utcOffset) 小时
  const beijingOffset = 8 - tzOffset;
  const bjDate = new Date(localDate.getTime() + beijingOffset * 3600000);

  const bjY = bjDate.getUTCFullYear();
  const bjMo = String(bjDate.getUTCMonth() + 1).padStart(2, '0');
  const bjD = String(bjDate.getUTCDate()).padStart(2, '0');
  const bjH = String(bjDate.getUTCHours()).padStart(2, '0');
  const bjMi = String(bjDate.getUTCMinutes()).padStart(2, '0');

  return `${bjY}-${bjMo}-${bjD} ${bjH}:${bjMi}`;
}

// === 主逻辑 ===
async function plan(targetDate) {
  // 1. 读取 MATCH_DATA
  const mdPath = path.join(__dirname, 'deploy', 'match_data.js');
  if (!fs.existsSync(mdPath)) {
    console.error('ERROR: match_data.js not found');
    return null;
  }

  let MATCH_DATA;
  try {
    const raw = fs.readFileSync(mdPath, 'utf8');
    const match = raw.match(/MATCH_DATA\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) throw new Error('Could not find MATCH_DATA array');
    MATCH_DATA = JSON.parse(match[1]);
  } catch (e) {
    console.error('ERROR: Failed to parse match_data.js:', e.message);
    return null;
  }

  // 2. 尝试从 API 获取比赛数据，建立 id → API北京时间 的映射
  let apiTimeMap = {}; // id → { bjDate: "YYYY-MM-DD HH:MM", source: "api" }
  let apiAvailable = false;
  try {
    const apiGames = await fetchAPI();
    if (Array.isArray(apiGames)) {
      apiGames.forEach(g => {
        if (g.local_date && g.stadium_id) {
          const bjTime = apiToBeijingTime(g.local_date, g.stadium_id);
          if (bjTime) {
            apiTimeMap[g.id] = { bjDate: bjTime, source: 'api', localDate: g.local_date, stadiumId: g.stadium_id };
          }
        }
      });
      apiAvailable = Object.keys(apiTimeMap).length > 0;
      console.log(`API校验: 获取到 ${Object.keys(apiTimeMap).length} 场比赛的官方时间`);
    }
  } catch (e) {
    console.log(`API校验: 不可用 (${e.message})，将仅使用 MATCH_DATA`);
  }

  // 3. 筛选目标日期的比赛，优先使用 API 时间
  const targetMatches = [];
  const discrepancies = []; // 记录时间差异

  MATCH_DATA.forEach(m => {
    if (!m.bjDate) return;
    if (!m.bjDate.startsWith(targetDate)) return;

    const mdTime = m.bjDate; // MATCH_DATA 中的时间
    let effectiveTime = mdTime;
    let timeSource = 'match_data';

    // 如果 API 有该比赛的数据，优先使用 API 计算的时间
    const apiEntry = apiTimeMap[m.id];
    if (apiEntry) {
      effectiveTime = apiEntry.bjDate;
      timeSource = 'api';

      // 检测时间差异
      if (apiEntry.bjDate !== mdTime) {
        discrepancies.push({
          id: m.id,
          match: `${m.homeCn || m.home} vs ${m.awayCn || m.away}`,
          matchDataTime: mdTime,
          apiTime: apiEntry.bjDate,
          localDate: apiEntry.localDate,
          stadiumId: apiEntry.stadiumId
        });
      }
    }

    targetMatches.push({
      ...m,
      bjDate: effectiveTime,
      timeSource: timeSource,
      originalBjDate: mdTime
    });
  });

  // 报告时间差异
  if (discrepancies.length > 0) {
    console.log('\n⚠️  检测到时间差异（以API为准）:');
    discrepancies.forEach(d => {
      console.log(`  M${d.id} ${d.match}: MATCH_DATA=${d.matchDataTime} → API=${d.apiTime} (stadium=${d.stadiumId}, local=${d.localDate})`);
    });
  }

  if (targetMatches.length === 0) {
    console.log(`NO_MATCHES: ${targetDate} 无比赛安排`);
    return { date: targetDate, matchCount: 0, slots: [], discrepancies: discrepancies };
  }

  // 4. 按开球时间分组（同时间的比赛批量检查）
  const timeGroups = {};
  targetMatches.forEach(m => {
    const time = m.bjDate.split(' ')[1]; // "03:00"
    if (!timeGroups[time]) timeGroups[time] = [];
    timeGroups[time].push(m);
  });

  // 5. 计算每个时间组的检查时间（双重触发：+2.25h 和 +2.5h，取整到最近的15分钟）
  const slots = [];
  const BUFFER_FIRST = 135;  // 2.25小时 = 135分钟（首次触发）
  const BUFFER_SECOND = 150; // 2.5小时 = 150分钟（二次触发，兜底）

  Object.entries(timeGroups).forEach(([startTime, matches]) => {
    const startMin = parseTimeToMinutes(startTime);
    const matchIds = matches.map(m => m.id).sort((a, b) => +a - +b);
    const matchNames = matches.map(m => {
      const h = m.homeCn || m.home;
      const a = m.awayCn || m.away;
      if (h && a) return `${h} vs ${a}`;
      return `Match${m.id}`;
    }).join(', ');
    const sources = matches.map(m => m.timeSource).filter((v, i, a) => a.indexOf(v) === i).join('+');

    // 首次触发：+2.25h，取整到最近的15分钟
    let checkMin1 = startMin + BUFFER_FIRST;
    checkMin1 = Math.round(checkMin1 / 15) * 15;
    const checkTime1 = minutesToTime(checkMin1);

    // 二次触发：+2.5h，取整到最近的15分钟
    let checkMin2 = startMin + BUFFER_SECOND;
    checkMin2 = Math.round(checkMin2 / 15) * 15;
    const checkTime2 = minutesToTime(checkMin2);

    slots.push({
      startTime: startTime,
      checkTime1: checkTime1,
      checkTime2: checkTime2,
      scheduledAt1: `${targetDate}T${checkTime1}:00+08:00`,
      scheduledAt2: `${targetDate}T${checkTime2}:00+08:00`,
      matchIds: matchIds,
      matchNames: matchNames,
      count: matches.length,
      timeSource: sources
    });
  });

  // 按首次检查时间排序
  slots.sort((a, b) => a.scheduledAt1.localeCompare(b.scheduledAt1));

  return {
    date: targetDate,
    matchCount: targetMatches.length,
    slots: slots,
    discrepancies: discrepancies,
    apiAvailable: apiAvailable
  };
}

// === 输出 ===
const targetDate = process.argv[2] || getBeijingDate(1); // 默认明天

plan(targetDate).then(planResult => {
  if (planResult) {
    // 输出 JSON（自动化读取用）
    console.log('\n' + JSON.stringify(planResult, null, 2));

    // 同时输出人类可读摘要
    if (planResult.slots.length > 0) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📅 ${planResult.date} 比赛安排 (${planResult.matchCount}场)${planResult.apiAvailable ? ' [API已校验]' : ' [仅MATCH_DATA]'}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━');
      planResult.slots.forEach(s => {
        console.log(`⏰ ${s.startTime} 开球 → 🕐 ${s.checkTime1} 首次 + 🕐 ${s.checkTime2} 兜底 (${s.count}场: ${s.matchNames}) [${s.timeSource}]`);
      });
      console.log(`\n将创建 ${planResult.slots.length * 2} 个一次性同步自动化（每场双重触发）`);
    }
  } else {
    console.error('规划失败');
    process.exit(1);
  }
}).catch(e => {
  console.error('规划异常:', e.message);
  process.exit(1);
});
