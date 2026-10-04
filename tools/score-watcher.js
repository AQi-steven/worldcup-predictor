// 世界杯比分开机一次性同步 v4
// 开机时运行一次，同步关机期间错过的比分，然后退出
// 后续比分同步由云端94个精准定时自动化处理

const https = require('https');
const fs = require('fs');
const path = require('path');

const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');
const API_HOST = 'worldcup26.ir';
const LOG_FILE = path.join(__dirname, 'score-watcher.log');

// ====== 文件日志（VBS后台启动无控制台） ======
let logWriteOk = true;
function log(msg) {
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    const line = `[${ts}] ${msg}`;
    // console.log 可能因 EPIPE 崩溃（VBS启动时stdout已关闭），只写文件
    if (logWriteOk) {
        try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch { logWriteOk = false; }
    }
}

const PID_FILE = path.join(__dirname, 'score-watcher.pid');

// ====== 单实例检测（必须在 log() 定义之后） ======
if (fs.existsSync(PID_FILE)) {
    const oldPid = fs.readFileSync(PID_FILE, 'utf8').trim();
    try {
        process.kill(parseInt(oldPid), 0); // 检查进程是否存在
        console.log(`⚠️ 已有实例在运行 (PID: ${oldPid})，退出`);
        process.exit(0);
    } catch (e) {
        // 进程不存在，删除旧的 PID 文件
        try { fs.unlinkSync(PID_FILE); } catch {}
    }
}

// 写入当前 PID
fs.writeFileSync(PID_FILE, process.pid.toString(), 'utf8');

// 进程退出时删除 PID 文件
process.on('exit', () => {
    try { fs.unlinkSync(PID_FILE); } catch {}
});
process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });

// ====== 全局错误处理（防止未捕获异常导致进程崩溃） ======
let lastErrorTime = 0;
let errorCount = 0;
process.on('uncaughtException', (err) => {
    const now = Date.now();
    // 防止同一错误在1秒内无限循环写日志（EPIPE风暴）
    if (now - lastErrorTime < 1000) {
        errorCount++;
        return; // 静默丢弃，不写日志
    }
    if (errorCount > 0) {
        log(`💥 之前有 ${errorCount} 条同类异常被静默丢弃`);
        errorCount = 0;
    }
    lastErrorTime = now;
    log('💥 未捕获异常: ' + err.message);
});
process.on('unhandledRejection', (reason) => {
    log('💥 未处理的Promise拒绝: ' + (reason?.message || reason));
});

// ====== 中国日期（GMT+8） ======
function getChinaDateStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ====== 加载 MATCH_DATA 中的比赛日期映射 ======
let matchDateMap = {};
try {
    const mdPath = path.join(__dirname, 'deploy', 'match_data.js');
    const mdContent = fs.readFileSync(mdPath, 'utf8').replace(/^const\s+MATCH_DATA/, 'var MATCH_DATA');
    eval(mdContent);
    if (typeof MATCH_DATA !== 'undefined') {
        MATCH_DATA.forEach(m => {
            if (m.bjDate) matchDateMap[String(m.id)] = m.bjDate.split(' ')[0];
        });
        log('📅 已加载 MATCH_DATA 日期映射: ' + Object.keys(matchDateMap).length + ' 场');
    }
} catch (e) {
    log('⚠️ 加载 match_data.js 失败: ' + e.message);
}

// ====== Node.js 原生 HTTPS 请求（替代 curl，消除 TLS 间歇失败） ======
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
        // worldcup26.ir 仅支持 TLS 1.2，Node.js 默认 TLS 1.3 会握手失败
        if (options.hostname === API_HOST || !options.hostname) {
            const tls = require('tls');
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
                    reject(new Error(`HTTP ${res.statusCode}: ${raw.substring(0,200)}`));
                    return;
                }
                try { resolve(JSON.parse(raw)); }
                catch { resolve(raw); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// ====== 带重试的请求 ======
async function requestWithRetry(options, body, maxRetries = 3) {
    let lastErr;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await httpsRequest(options, body);
        } catch (e) {
            lastErr = e;
            if (i < maxRetries - 1) {
                await new Promise(r => setTimeout(r, 5000)); // 等5秒重试
            }
        }
    }
    throw lastErr;
}

// ====== npoint.io 读写（Node 原生） ======
async function npointGet() {
    const res = await httpsRequest({
        hostname: 'api.npoint.io',
        path: '/' + NPOINT_ID,
        method: 'GET'
    });
    // API可能直接返回数据或包裹在对象中
    if (res.scores || res.predictions) return res;
    if (typeof res === 'string') return JSON.parse(res);
    return res;
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
    if (s.startsWith('陆')) return 'P03';
    if (s.startsWith('王') && s.endsWith('斌')) return '王红斌';
    if (s.startsWith('旺') && s.endsWith('财')) return 'P06';
    return u;
}
async function npointPost(data) {
    const bodyJson = JSON.stringify(data);
    if (Array.isArray(data.predictions)) data.predictions.forEach(r => { if (r.userName) r.userName = repairUserName(r.userName); });
    if (Array.isArray(data.predictions_B)) data.predictions_B.forEach(r => { if (r.userName) r.userName = repairUserName(r.userName); });
    return httpsRequest({
        hostname: 'api.npoint.io',
        path: '/' + NPOINT_ID,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }, data);
}

// ====== worldcup26.ir API ======
async function apiPost(p, bodyObj) {
    return httpsRequest({
        hostname: API_HOST,
        path: p,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }, bodyObj);
}

async function apiGet(p, token) {
    return httpsRequest({
        hostname: API_HOST,
        path: p,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + token }
    });
}

// ====== 积分计算（与前端完全一致） ======
function calcPts(ah, aa, ph, pa) {
    if (ah === ph && aa === pa) return 5;
    const diff = ah - aa, pdiff = ph - pa;
    if (diff === pdiff && diff !== 0) return 4;
    const ar = ah > aa ? 'w' : ah < aa ? 'l' : 'd';
    const pr = ph > pa ? 'w' : ph < pa ? 'l' : 'd';
    if (ar === pr) return 3;
    return 1;
}

// 淘汰赛：从scorers字段计算90分钟+加时赛总比分（排除点球大战进球）
// 规则：预测比分 = 90分钟+加时赛总比分，不含点球决胜进球
function calcRegTimeScore(homeScorers, awayScorers) {
    let homeGoals = 0, awayGoals = 0;
    function countGoals(scorersStr) {
        if (!scorersStr || scorersStr === 'null') return 0;
        let count = 0;
        const goalPattern = /(\d+)('\+?\d*'?)/g;
        let match;
        while ((match = goalPattern.exec(scorersStr)) !== null) {
            const minute = parseInt(match[1]);
            if (minute <= 120) count++; // 保留常规+加时赛进球
            // minute > 120 = 点球大战，排除
        }
        return count;
    }
    try {
        homeGoals = countGoals(homeScorers);
        awayGoals = countGoals(awayScorers);
        return { home: homeGoals, away: awayGoals };
    } catch { return null; }
}

// ====== 主更新逻辑 ======
let isUpdating = false;  // 防止并发执行
let isRunning = false; // 单实例检测

async function updateScores() {
    // 单实例检测：如果已经在运行，跳过
    if (isRunning) {
        log('⏭️ 跳过：上一次更新还未完成');
        return;
    }
    isRunning = true;

    log('⚽ 开始更新比分...');
    
    try {
        // 1. 获取比赛数据（/get/games 无需认证）
        const gamesRes = await requestWithRetry({
            hostname: API_HOST,
            path: '/get/games',
            method: 'GET'
        });

        if (!gamesRes || !gamesRes.games) {
            log('❌ 比赛数据获取失败');
            return;
        }

        // 3. 提取比分
        const scores = {};
        gamesRes.games.forEach(g => {
            const isFinished = g.finished === 'TRUE';
            if (isFinished) {
                let homeScore = parseInt(g.home_score);
                let awayScore = parseInt(g.away_score);
                const isKnockout = ['r32', 'r16', 'qf', 'sf', 'third', 'final'].includes(g.type);

                // 淘汰赛：排除点球大战进球
                if (isKnockout) {
                    const regTimeScore = calcRegTimeScore(g.home_scorers, g.away_scorers);
                    if (regTimeScore !== null && (regTimeScore.home !== homeScore || regTimeScore.away !== awayScore)) {
                        log(`⚠️ 淘汰赛M${g.id}: API比分${homeScore}-${awayScore}, 常规+加时${regTimeScore.home}-${regTimeScore.away}, 使用常规+加时比分`);
                        homeScore = regTimeScore.home;
                        awayScore = regTimeScore.away;
                    }
                }

                scores[g.id] = {
                    homeScore,
                    awayScore,
                    status: 'finished',
                    timeElapsed: g.time_elapsed || 'finished'
                };
            } else if (g.time_elapsed && g.time_elapsed !== 'notstarted') {
                scores[g.id] = {
                    homeScore: parseInt(g.home_score) || 0,
                    awayScore: parseInt(g.away_score) || 0,
                    status: 'live',
                    timeElapsed: g.time_elapsed
                };
            }
        });

        const finishedCount = Object.values(scores).filter(s => s.status === 'finished').length;
        const liveCount = Object.values(scores).filter(s => s.status === 'live').length;
        log(`📊 API数据: ${Object.keys(gamesRes.games).length}场, 已结束${finishedCount}, 进行中${liveCount}`);

        // 4. 读取 npoint.io
        const currentData = await npointGet();
        const cloudScores = currentData.scores || {};
        if (!cloudScores) log('⚠️ npoint 返回数据格式异常');

        // 4.5 settledDate处理
        const todayStr = getChinaDateStr();
        for (const [mid, s] of Object.entries(scores)) {
            if (s.status === 'finished') {
                const old = cloudScores[mid];
                if (old && old.status === 'finished') {
                    if (old.settledDate) {
                        s.settledDate = old.settledDate;
                    } else if (matchDateMap[mid]) {
                        // 旧记录缺少 settledDate，从 MATCH_DATA 的 bjDate 补充
                        s.settledDate = matchDateMap[mid];
                        log(`📅 补充 settledDate: match ${mid} -> ${matchDateMap[mid]}`);
                    }
                } else {
                    // 新结算的比赛
                    s.settledDate = matchDateMap[mid] || todayStr;
                }
            }
        }

        // 5. 合并比分
        const mergedScores = { ...cloudScores, ...scores };

        // 5.5 如果npoint中已有scoreOverride（手动修正的比分），优先使用
        for (const [mid, old] of Object.entries(cloudScores)) {
            if (old.scoreOverride && mergedScores[mid]) {
                if (mergedScores[mid].homeScore !== old.scoreOverride.home ||
                    mergedScores[mid].awayScore !== old.scoreOverride.away) {
                    log(`📝 M${mid}: 使用手动覆盖比分 ${old.scoreOverride.home}-${old.scoreOverride.away}`);
                    mergedScores[mid].homeScore = old.scoreOverride.home;
                    mergedScores[mid].awayScore = old.scoreOverride.away;
                }
                mergedScores[mid].scoreOverride = old.scoreOverride;
            }
        }

        // 6. 计算积分
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

        // 6.5 乱码防御清洗 + null用户名清理
        let cleaned = 0;
        let nullRemoved = 0;
        for (const key of ['predictions', 'predictions_B']) {
            const preds = currentData[key];
            if (!Array.isArray(preds)) continue;
            for (let i = preds.length - 1; i >= 0; i--) {
                const p = preds[i];
                // 清理 null/空用户名
                if (!p.userName || p.userName === 'null') {
                    preds.splice(i, 1);
                    nullRemoved++;
                    continue;
                }
                // 清理乱码用户名（含U+FFFD的记录直接删除，删除FFFD后残余名字不完整会污染数据）
                if (p.userName.includes('\uFFFD')) {
                    preds.splice(i, 1);
                    cleaned++;
                }
            }
        }
        if (cleaned > 0) log(`🗑️ 删除 ${cleaned} 条乱码用户名记录`);
        if (nullRemoved > 0) log(`🗑️ 删除 ${nullRemoved} 条无效用户名(null)记录`);

        // 7. 写回 npoint.io
        await npointPost({ ...currentData, scores: mergedScores });
        log(`✅ 更新成功! ${Object.keys(mergedScores).length}场比分, ${pointsUpdated}条积分结算${cleaned > 0 ? ', 清洗' + cleaned + '条乱码' : ''}${nullRemoved > 0 ? ', 删除' + nullRemoved + '条null记录' : ''}`);
        
    } catch (e) {
        log(`❌ 更新出错: ${e.message}`);
    } finally {
        isRunning = false;  // 无论成功失败，都重置标志
    }
}

// ====== 开机一次性同步 ======
log('🏆 世界杯比分开机一次性同步 v4');
log('📌 同步完成后自动退出，后续由云端定时任务处理');
log('━━━━━━━━━━━━━━━━━━━━━━━━━━');

// 启动后延迟5秒再同步，确保网络就绪
setTimeout(async () => {
    try {
        await updateScores();
        log('✅ 开机同步完成，进程即将退出');
    } catch (e) {
        log('❌ 开机同步失败: ' + e.message);
    }
    // 无论成功失败，都删除PID文件并退出
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
}, 5000);

