// 世界杯比分守护进程 v2
// 开机启动：①开机立即同步一次（拉数据）②之后每日北京时间12:00同步一次（安全兜底）
// 不再每15分钟高频轮询 → 独立于WorkBuddy Token配额，且大幅降低写入出错面

const https = require('https');
const fs = require('fs');
const path = require('path');
const tls = require('tls');

const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');
const API_HOST = 'worldcup26.ir';
const LOG_FILE = path.join(__dirname, 'score-poller.log');
const PID_FILE = path.join(__dirname, 'score-poller.pid');
const DAILY_SYNC_HOUR_BEIJING = 12;            // 每日安全同步时刻（北京时间12:00，覆盖凌晨比赛结果）
const ONCE = process.argv.includes('--once');  // 单次强制同步模式：node score-poller.js --once（仅同步一次后退出，用于定时任务在指定时刻强制结算）

// ====== 防级联硬地板：历史峰值水位线（持久化，跨重启保留）======
// 作用：即便 npoint 极罕见地全部副本同时返回 stale 残缺副本，也不会把全量预测覆盖成残缺版。
// 任何一次写回，若预测数远低于历史峰值，直接拒绝 POST（等下次同步，npoint 收敛后自愈）。
const HWM_FILE = path.join(__dirname, 'pred_highmark.json');
let predHighMark = 0;
try { const h = JSON.parse(fs.readFileSync(HWM_FILE, 'utf8')); if (h && typeof h.mark === 'number') predHighMark = h.mark; } catch {}
function saveHighMark() { try { fs.writeFileSync(HWM_FILE, JSON.stringify({ mark: predHighMark, updated: Date.now() })); } catch {} }

// ====== 日志 ======
let logWriteOk = true;
function log(msg) {
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    const line = `[${ts}] ${msg}`;
    if (logWriteOk) {
        try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch { logWriteOk = false; }
    }
}

// ====== 单实例检测 ======
if (!ONCE && fs.existsSync(PID_FILE)) {
    const oldPid = fs.readFileSync(PID_FILE, 'utf8').trim();
    try {
        process.kill(parseInt(oldPid), 0);
        log('⚠️ 已有轮询实例运行中 (PID: ' + oldPid + ')，退出');
        process.exit(0);
    } catch (e) {
        try { fs.unlinkSync(PID_FILE); } catch {}
    }
}
if (!ONCE) fs.writeFileSync(PID_FILE, process.pid.toString(), 'utf8');
if (!ONCE) process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });
process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });

// ====== 全局错误处理 ======
let lastErrorTime = 0, errorCount = 0;
process.on('uncaughtException', (err) => {
    const now = Date.now();
    if (now - lastErrorTime < 1000) { errorCount++; return; }
    if (errorCount > 0) { log('💥 之前有 ' + errorCount + ' 条同类异常被静默丢弃'); errorCount = 0; }
    lastErrorTime = now;
    log('💥 未捕获异常: ' + err.message);
});
process.on('unhandledRejection', (reason) => {
    log('💥 未处理的Promise拒绝: ' + (reason?.message || reason));
});

// ====== 北京时间辅助函数 ======
function getChinaDateStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function getMsUntilNextBeijingHour(targetHour) {
    const now = new Date();
    const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000); // UTC → 北京时间
    const target = new Date(beijingNow);
    target.setUTCHours(targetHour, 0, 0, 0);
    let diff = target.getTime() - beijingNow.getTime();
    if (diff <= 0) diff += 24 * 60 * 60 * 1000; // 已过今日该时刻 → 排到明天
    return diff;
}

// ====== MATCH_DATA 日期+阶段映射 ======
let matchDateMap = {};
let phaseMap = {};
let xFactorMap = {};   // { "101": [ {id,q,opts,mode,metric,...}, ... ] }
try {
    const mdPath = path.join(__dirname, 'deploy', 'match_data.js');
    const mdContent = fs.readFileSync(mdPath, 'utf8').replace(/^const\s+MATCH_DATA/, 'var MATCH_DATA');
    eval(mdContent);
    if (typeof MATCH_DATA !== 'undefined') {
        MATCH_DATA.forEach(m => {
            if (m.bjDate) matchDateMap[String(m.id)] = m.bjDate.split(' ')[0];
            if (m.phase) {
                phaseMap[String(m.id)] = m.phase;           // "M73" → "十六分之一决赛"
                phaseMap[String(m.id).replace('M','')] = m.phase; // "73" → "十六分之一决赛"
            }
            if (Array.isArray(m.xFactors) && m.xFactors.length) {
                xFactorMap[String(m.id)] = m.xFactors;
                xFactorMap[String(m.id).replace('M','')] = m.xFactors;
            }
        });
    }
} catch (e) { log('⚠️ 加载 match_data.js 失败: ' + e.message); }

// ====== HTTPS 请求 ======
function httpsRequest(options, body) {
    return new Promise((resolve, reject) => {
        const reqOpts = {
            hostname: options.hostname || API_HOST,
            path: options.path,
            method: options.method || 'GET',
            headers: options.headers || {},
            rejectUnauthorized: false,
            timeout: 30000
        };
        if (options.hostname === API_HOST || !options.hostname) {
            reqOpts.secureOptions = tls.SSL_OP_NO_TLSv1_3 | tls.SSL_OP_NO_SSLv3;
            reqOpts.minVersion = 'TLSv1.2';
            reqOpts.maxVersion = 'TLSv1.2';
        }
        const req = https.request(reqOpts, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 400) {
                    reject(new Error('HTTP ' + res.statusCode + ': ' + raw.substring(0, 200)));
                    return;
                }
                try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function requestWithRetry(options, body, maxRetries = 3) {
    let lastErr;
    for (let i = 0; i < maxRetries; i++) {
        try { return await httpsRequest(options, body); } catch (e) {
            lastErr = e;
            if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 5000));
        }
    }
    throw lastErr;
}

// ====== npoint 读写 ======
async function npointGet() {
    const res = await httpsRequest({ hostname: 'api.npoint.io', path: '/' + NPOINT_ID, method: 'GET' });
    if (res.scores || res.predictions) return res;
    if (typeof res === 'string') return JSON.parse(res);
    return res;
}
// 抗读后不一致：连取多次，取预测记录总数最多的那份（避免 CDN 返回残缺旧副本导致误删）
async function npointGetRobust(tries = 3) {
    let best = null, bestSize = -1;
    const all = [];
    for (let i = 0; i < tries; i++) {
        try {
            const res = await httpsRequest({ hostname: 'api.npoint.io', path: '/' + NPOINT_ID, method: 'GET' });
            let data = res;
            if (typeof res === 'string') data = JSON.parse(res);
            if (!data || typeof data !== 'object') continue;
            const size = (data.predictions?.length || 0) + (data.predictions_B?.length || 0) + (data.scores ? Object.keys(data.scores).length : 0);
            if (size > bestSize) { bestSize = size; best = data; }
            all.push(data);
        } catch (e) { log('⚠️ npointGetRobust 第' + (i + 1) + '次失败: ' + e.message); }
        if (i < tries - 1) await new Promise(r => setTimeout(r, 800));
    }
    if (!best) throw new Error('npointGetRobust 全部失败');
    // 累积 xStats：对抗读后一致性——任何副本含 xStats 即并入 best，避免手动上报数据被旧副本覆盖丢失
    for (const d of all) {
        if (d.scores) for (const [mid, sc] of Object.entries(d.scores)) {
            if (sc && sc.xStats && Object.keys(sc.xStats).length) {
                best.scores[mid] = best.scores[mid] || {};
                if (!best.scores[mid].xStats || !Object.keys(best.scores[mid].xStats).length) best.scores[mid].xStats = sc.xStats;
            }
        }
    }
    return best;
}

// 写前自愈：修复可能因无charset写入导致的中文用户名乱码（依据可读首尾字推断）
function repairUserName(u) {
    if (!u || !String(u).includes('�')) return u;
    const s = String(u);
    if (s.endsWith('手')) return 'P17';
    if (s.startsWith('盛') && s.endsWith('指导')) return 'P09';
    if (s.startsWith('程') && s.endsWith('新')) return 'P02';
    if (s.startsWith('严') && s.endsWith('鹏')) return 'P14';
    if (s.startsWith('李') && s.endsWith('烨')) return 'P01';
    if (s.startsWith('孙') && s.endsWith('敏')) return 'P04';
    if (s.endsWith('子')) return 'P13';
    if (s.startsWith('老') && s.endsWith('王')) return 'P07';
    if (s.startsWith('大') && s.endsWith('魏')) return 'P05';
    if (s.startsWith('陆')) return s.startsWith('P03') ? 'P03' : 'P03';
    if (s.startsWith('王') && s.endsWith('斌')) return '王红斌';
    if (s.startsWith('旺') && s.endsWith('财')) return 'P06';
    return u;
}
async function npointPost(data) {
    if (Array.isArray(data.predictions)) data.predictions.forEach(r => { if (r.userName) r.userName = repairUserName(r.userName); });
    if (Array.isArray(data.predictions_B)) data.predictions_B.forEach(r => { if (r.userName) r.userName = repairUserName(r.userName); });
    return httpsRequest({
        hostname: 'api.npoint.io',
        path: '/' + NPOINT_ID,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }, data);
}

// ====== 积分计算 ======
function getScoreMultiplier(phase) {
    const multipliers = {
        '小组赛': 1,
        '十六分之一决赛': 2,
        '八分之一决赛': 3,
        '四分之一决赛': 4,
        '半决赛': 5,
        '季军赛': 6,
        '决赛': 7
    };
    return multipliers[phase] || 1;
}

function calcPts(ah, aa, ph, pa, phase) {
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
    const multiplier = getScoreMultiplier(phase);
    // 四分之一决赛起（倍率≥4）：参与奖/方向对且猜中任一队比分 → +0.5 基础分
    if (multiplier >= 4 && (basePts === 1 || basePts === 3)) {
        if (ph === ah || pa === aa) basePts += 0.5;
    }
    return basePts * multiplier;
}

function calcRegTimeScore(homeScorers, awayScorers) {
    let homeGoals = 0, awayGoals = 0;
    function countGoals(scorersStr) {
        if (!scorersStr || scorersStr === 'null') return 0;
        let count = 0;
        const goalPattern = /(\d+)('\+?\d*'?)/g;
        let match;
        while ((match = goalPattern.exec(scorersStr)) !== null) {
            if (parseInt(match[1]) <= 120) count++;
        }
        return count;
    }
    try { return { home: countGoals(homeScorers), away: countGoals(awayScorers) }; }
    catch { return null; }
}

// ====== X因素：按时段解析进球（常规≤90 / 加时91-120 / 伤停补时=45+或90+）======
function parseGoalsByPeriod(scorersStr) {
    let reg = 0, extra = 0, first = 0, injury = 0;
    if (!scorersStr || scorersStr === 'null') return { reg, extra, first, injury };
    // 取每个进球的基础分钟（忽略 "+补时"），如 "90+3'" → 90，"120+1'" → 120，"45+2'" → 45
    // 伤停补时进球：基础分钟为45或90且带"+N'"（如 "45+2'", "90+4'"）
    const re = /(\d+)(?:\+(\d+))?'/g;
    let mt;
    while ((mt = re.exec(scorersStr)) !== null) {
        const minute = parseInt(mt[1]);
        const add = mt[2] ? parseInt(mt[2]) : 0;
        if (add > 0 && (minute === 45 || minute === 90)) injury++;  // 上半场/下半场伤停补时进球
        if (minute <= 45) first++;          // 上半场（含补时，"45+2'"→45）
        if (minute <= 90) reg++;
        else if (minute <= 120) extra++;
    }
    return { reg, extra, first, injury };
}

// 解析某队进球分钟列表（用于"第一个进球"判定）
function parseGoalMinutes(scorersStr, team) {
    const arr = [];
    if (!scorersStr || scorersStr === 'null') return arr;
    const re = /(\d+)(?:\+\d+)?'/g;
    let mt;
    while ((mt = re.exec(scorersStr)) !== null) {
        arr.push({ minute: parseInt(mt[1]), team });
    }
    return arr;
}

// ====== X因素：计算某场每题结算结果 xOutcomes = { 题id: 正确选项index }（0=是/大, 1=否/小）======
// s: 该场 mergedScores 记录（含 homeScore/awayScore=常规+加时, xStats=手动上报）
// gameRaw: API 原始 game（含 home_scorers/away_scorers）
function calcXOutcomes(xFactors, s, gameRaw) {
    const outcomes = {};
    if (!Array.isArray(xFactors)) return outcomes;
        const hg = parseGoalsByPeriod(gameRaw ? gameRaw.home_scorers : null);
        const ag = parseGoalsByPeriod(gameRaw ? gameRaw.away_scorers : null);
        const regHome = hg.reg, regAway = ag.reg;
        const regTotal = regHome + regAway;
        const firstTotal = (hg.first || 0) + (ag.first || 0);   // 上半场进球总数
        const injuryTotal = (hg.injury || 0) + (ag.injury || 0); // 伤停补时进球总数
        const finalHome = Number(s.homeScore), finalAway = Number(s.awayScore); // 常规+加时（不含点球）
        const xStats = s.xStats || {};
        for (const xf of xFactors) {
            let outcome = null; // true/false/null(未决)
            if (xf.mode === 'auto') {
                switch (xf.metric) {
                    case 'regGoalAny':   outcome = regTotal > 0; break;
                    case 'firstHalfGoalAny': outcome = firstTotal > 0; break;   // 上半场(≤45')是否有进球
                    case 'regTotalGE':   outcome = regTotal >= xf.threshold; break;
                    case 'regBothScore': outcome = regHome > 0 && regAway > 0; break;
                    case 'toExtraTime':  outcome = regHome === regAway; break;          // 常规打平→进加时
                    case 'penalties':    outcome = finalHome === finalAway; break;      // 常规+加时仍平→点球决胜
                    case 'regInjuryGoalAny': outcome = injuryTotal > 0; break;   // 上下半场伤停补时是否有进球
                    case 'awayFirstGoal': {
                        const homeGoals = parseGoalMinutes(gameRaw ? gameRaw.home_scorers : null, 'home');
                        const awayGoals = parseGoalMinutes(gameRaw ? gameRaw.away_scorers : null, 'away');
                        const allGoals = homeGoals.concat(awayGoals).sort((a, b) => a.minute - b.minute);
                        if (allGoals.length === 0) outcome = false;             // 0-0 无首球
                        else {
                            const firstMin = allGoals[0].minute;
                            const firstGoals = allGoals.filter(g => g.minute === firstMin);
                            outcome = firstGoals.length > 0 && firstGoals.every(g => g.team === 'away');
                        }
                        break;
                    }
                    case 'homeFirstGoal': {
                        const homeGoals = parseGoalMinutes(gameRaw ? gameRaw.home_scorers : null, 'home');
                        const awayGoals = parseGoalMinutes(gameRaw ? gameRaw.away_scorers : null, 'away');
                        const allGoals = homeGoals.concat(awayGoals).sort((a, b) => a.minute - b.minute);
                        if (allGoals.length === 0) outcome = false;             // 0-0 无首球
                        else {
                            const firstMin = allGoals[0].minute;
                            const firstGoals = allGoals.filter(g => g.minute === firstMin);
                            outcome = firstGoals.length > 0 && firstGoals.every(g => g.team === 'home');
                        }
                        break;
                    }
                    default: outcome = null;
                }
        } else if (xf.mode === 'manual') {
            const v = xStats[xf.metric];
            if (typeof v === 'number' && !isNaN(v)) {
                const op = xf.op || '>=';
                if (op === '>=') outcome = v >= xf.threshold;
                else if (op === '>') outcome = v > xf.threshold;
                else if (op === '<=') outcome = v <= xf.threshold;
                else if (op === '<') outcome = v < xf.threshold;
                else if (op === '==') outcome = v === xf.threshold;
            } // 未上报 → null（待结算）
        }
        if (outcome !== null) outcomes[xf.id] = outcome ? 0 : 1; // 0=是/大, 1=否/小
    }
    return outcomes;
}

// ====== X因素：按 xChoices 与 xOutcomes 计算某人本场 X 得分 ======
function calcXPointsForPred(xFactors, xChoices, xOutcomes) {
    if (!Array.isArray(xFactors) || !xChoices) return 0;
    let sum = 0;
    for (const xf of xFactors) {
        const correctIdx = xOutcomes[xf.id];
        if (correctIdx == null) continue;           // 未决的题不计分
        const myIdx = xChoices[xf.id];
        if (myIdx == null) continue;                // 没答的题不计分
        sum += (Number(myIdx) === Number(correctIdx)) ? xf.win : xf.lose;
    }
    return sum;
}

// ====== 主同步逻辑（与 sync-scores.js 完全一致） ======
let isRunning = false;

async function syncScores() {
    if (isRunning) { log('⏭️ 跳过：上一次同步还未完成'); return; }
    isRunning = true;
    const roundStart = Date.now();

    try {
        // 1. API
        const gamesRes = await requestWithRetry({ hostname: API_HOST, path: '/get/games', method: 'GET' });
        if (!gamesRes || !gamesRes.games) { log('❌ API数据异常'); return; }

        const scores = {};
        const rawGameMap = {};   // X因素判定用：保留 API 原始 game（含 scorers）
        gamesRes.games.forEach(g => {
            rawGameMap[String(g.id)] = g;
            const isFinished = g.finished === 'TRUE';
            if (isFinished) {
                let homeScore = parseInt(g.home_score), awayScore = parseInt(g.away_score);
                const isKnockout = ['r32', 'r16', 'qf', 'sf', 'third', 'final'].includes(g.type);
                if (isKnockout) {
                    const rt = calcRegTimeScore(g.home_scorers, g.away_scorers);
                    if (rt) {
                        // 防御：如果calcRegTimeScore结果 < API最终比分，说明可能漏了加时赛进球
                        // 此时相信API的最终比分（淘汰赛API最终比分=90分钟+加时赛，不含点球）
                        if (rt.home < homeScore || rt.away < awayScore) {
                            log('⚠️ M' + g.id + ': calcRegTimeScore结果(' + rt.home + '-' + rt.away + ')小于API最终比分(' + homeScore + '-' + awayScore + ')，相信API最终比分');
                            // homeScore/awayScore保持API值不变
                        } else if (rt.home !== homeScore || rt.away !== awayScore) {
                            log('⚠️ M' + g.id + ': API=' + homeScore + '-' + awayScore + ' 常规+加时=' + rt.home + '-' + rt.away + '，使用常规+加时比分');
                            homeScore = rt.home; awayScore = rt.away;
                        }
                    } else {
                        // calcRegTimeScore返回null（scorers数据不完整），相信API最终比分
                        log('⚠️ M' + g.id + ': 无法解析scorers，相信API最终比分 ' + homeScore + '-' + awayScore);
                    }
                }
                scores[g.id] = { homeScore, awayScore, status: 'finished', timeElapsed: g.time_elapsed || 'finished' };
            } else if (g.time_elapsed && g.time_elapsed !== 'notstarted') {
                scores[g.id] = { homeScore: parseInt(g.home_score) || 0, awayScore: parseInt(g.away_score) || 0, status: 'live', timeElapsed: g.time_elapsed };
            }
        });

        // 2. npoint（抗stale：取记录数最多的副本）
        const currentData = await npointGetRobust();
        predHighMark = Math.max(predHighMark, (currentData.predictions || []).length, (currentData.predictions_B || []).length);
        saveHighMark();
        const oldScores = currentData.scores || {};
        const todayStr = getChinaDateStr();

        // settledDate
        for (const [mid, s] of Object.entries(scores)) {
            if (s.status === 'finished') {
                const old = oldScores[mid];
                s.settledDate = (old && old.settledDate) || matchDateMap[mid] || todayStr;
            }
        }

        const mergedScores = { ...oldScores, ...scores };

        // scoreOverride + xStats（手动上报数据）保护：不被 API 副本覆盖
        for (const [mid, old] of Object.entries(oldScores)) {
            if (old.scoreOverride && mergedScores[mid]) {
                mergedScores[mid].homeScore = old.scoreOverride.home;
                mergedScores[mid].awayScore = old.scoreOverride.away;
                mergedScores[mid].scoreOverride = old.scoreOverride;
            }
            if (old.xStats && mergedScores[mid]) {
                mergedScores[mid].xStats = old.xStats;   // 保留用户赛后手动上报的黄牌/角球数
            }
        }

        // X因素：为已结束且配置了 xFactors 的场次计算 xOutcomes（自动项从scorers派生，手动项读xStats）
        let xOutcomeMatches = 0;
        for (const [mid, s] of Object.entries(mergedScores)) {
            if (s.status !== 'finished') continue;
            const xf = xFactorMap[String(mid)] || xFactorMap[String(mid).replace('M','')];
            if (!xf) continue;
            const gameRaw = rawGameMap[String(mid)] || rawGameMap[String(mid).replace('M','')];
            s.xOutcomes = calcXOutcomes(xf, s, gameRaw);
            xOutcomeMatches++;
        }

        // 积分
        let pointsUpdated = 0;
        let xPointsUpdated = 0;
        for (const key of ['predictions', 'predictions_B']) {
            const preds = currentData[key];
            if (!Array.isArray(preds)) continue;
            preds.forEach(p => {
                const s = mergedScores[p.matchId] || mergedScores[String(p.matchId)];
                // X因素结算：即使 points 已算过也需刷新（手动数据可能后补）
                if (s && s.status === 'finished' && p.xChoices) {
                    const xf = xFactorMap[String(p.matchId)] || xFactorMap[String(p.matchId).replace('M','')];
                    if (xf && s.xOutcomes) {
                        const xp = calcXPointsForPred(xf, p.xChoices, s.xOutcomes);
                        if (p.xPoints !== xp) { p.xPoints = xp; xPointsUpdated++; }
                    }
                }
                if (s && s.status === 'finished' && p.homePred != null) {
                    const phase = phaseMap[String(p.matchId)] || '小组赛';
                    const pts = calcPts(s.homeScore, s.awayScore, p.homePred, p.awayPred, phase);
                    if (p.points === null || p.points !== pts) { p.points = pts; p.settledDate = s.settledDate || todayStr; pointsUpdated++; }
                }
            });
        }

        // 清洗乱码（非破坏式：只修复 A 组已知用户名，绝不删除预测记录，避免永久丢失）
        let repaired = 0, kept = 0;
        const A_WHITELIST = ['P01','P02','P03','P04','P05','P06','P07','P08','P09','P10','P11','P12','P13','P14','P16','P17','P15'];
        for (const key of ['predictions', 'predictions_B']) {
            const preds = currentData[key];
            if (!Array.isArray(preds)) continue;
            for (const p of preds) {
                const u = p.userName;
                if (u && u.includes('\uFFFD')) {
                    if (key === 'predictions') {
                        // A 组：按白名单修复（乱码是用户名中的某个字损坏，其余字仍匹配）
                        const bare = u.replace(/\uFFFD/g, '');
                        let fixed = null;
                        for (const w of A_WHITELIST) {
                            if (u.includes(w) || w.includes(bare) || bare.includes(w)) { fixed = w; break; }
                        }
                        if (fixed) { p.userName = fixed; repaired++; }
                        else { kept++; } // 无法识别，保留记录（前端过滤显示），不删除
                    } else {
                        kept++; // B 组自由文本用户名，无法自动修复，保留记录不删除
                    }
                } else if (!u || u === 'null') {
                    kept++; // 空用户名保留记录不删除（前端过滤），避免丢失预测存在性
                }
            }
        }

        // 写回（含防stale合并补齐：绝不因旧副本误删记录）
        const writeData = { ...currentData, scores: mergedScores };
        try {
            const verify = await npointGetRobust(2);
            for (const key of ['predictions', 'predictions_B']) {
                const a = writeData[key] = writeData[key] || [];
                const b = verify[key] || [];
                const seen = new Set(a.map(p => (p.userName || '') + '#' + p.matchId));
                let addedBack = 0;
                for (const p of b) {
                    const k = (p.userName || '') + '#' + p.matchId;
                    if (!seen.has(k)) { a.push(p); seen.add(k); addedBack++; }
                }
                if (addedBack) log('⚠️ 合并补齐 ' + addedBack + ' 条 ' + key + ' (防stale读漏)');
            }
        } catch (e) { log('⚠️ 合并补齐跳过: ' + e.message); }

        // 防级联硬地板：拒绝写出远低于历史峰值的副本（npoint 罕见的全部 stale 时的最后防线）
        const topN = Math.max((writeData.predictions || []).length, (writeData.predictions_B || []).length);
        let blocked = false;
        if (predHighMark > 50 && topN < predHighMark - 3) {
            blocked = true;
            log('🛑 安全拦截-硬地板：写回预测数(' + topN + ') 远低于历史峰值(' + predHighMark + ')，疑似 npoint 全副本 stale，已阻止覆盖写，等待下次同步');
        }
        const elapsed = ((Date.now() - roundStart) / 1000).toFixed(1);
        if (!blocked) {
            await npointPost(writeData);
            predHighMark = Math.max(predHighMark, topN);
            saveHighMark();
            log('✅ ' + Object.keys(mergedScores).length + '场比分, ' + pointsUpdated + '条积分, X因素' + xOutcomeMatches + '场/' + xPointsUpdated + '条, 修复乱码用户名' + repaired + '条, 保留无法修复' + kept + '条(不删除) (' + elapsed + 's)');
        } else {
            log('⏸️ 本轮跳过写回 (' + elapsed + 's)，未改动线上数据');
        }

        // 今日完成检查
        const todayMatches = Object.entries(matchDateMap).filter(([, d]) => d === todayStr).map(([id]) => id);
        if (todayMatches.length > 0) {
            const done = todayMatches.filter(mid => mergedScores[mid]?.status === 'finished').length;
            if (done === todayMatches.length) log('🏁 TODAY_COMPLETE 今日' + todayMatches.length + '场全部结束');
        }

    } catch (e) {
        log('❌ 同步出错: ' + e.message);
    } finally {
        isRunning = false;
    }
}

// ====== 主循环（v2：开机一次 + 每日一次，不再高频轮询） ======
let pollCount = 0;

async function mainLoop() {
    log('🏆 世界杯比分守护进程 v2 启动');
    log('📌 开机立即同步一次 + 每日 ' + DAILY_SYNC_HOUR_BEIJING + ':00(北京时间) 同步一次 | 独立于Token配额');
    log('━━━━━━━━━━━━━━━━━━━━━━━━');

    // 单次强制同步模式（--once）：仅同步一次结算后退出，供定时任务在指定时刻精确触发
    if (ONCE) {
        log('🏁 单次强制同步模式 (--once)：立即同步并结算一次后退出');
        await syncScores();
        log('✅ 单次同步完成，进程退出');
        process.exit(0);
    }

    // 首次立即同步（开机拉数据）
    log('🔄 开机同步...');
    await syncScores();

    // 每日安全同步：防止开机后一直不关机，漏掉凌晨比赛结果
    scheduleDailySync();
}

function scheduleDailySync() {
    const waitMs = getMsUntilNextBeijingHour(DAILY_SYNC_HOUR_BEIJING);
    const nextTime = new Date(Date.now() + waitMs);
    log('⏰ 下次同步: ' + nextTime.toLocaleString('zh-CN', { hour12: false }) +
        ' (每日 ' + DAILY_SYNC_HOUR_BEIJING + ':00 北京时间) [第' + (++pollCount) + '次排程]');
    setTimeout(async () => {
        try {
            await syncScores();
        } catch (e) {
            log('💥 每日同步异常: ' + e.message);
        }
        scheduleDailySync(); // 排下一天
    }, waitMs);
}

mainLoop().catch(e => {
    log('💥 守护进程致命错误: ' + e.message);
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(1);
});
