// 世界杯比分自动更新脚本
// 从 worldcup26.ir 获取最新比分，更新到 npoint.io 云端
// 运行方式：node update-scores.js
// 可设为 Windows 定时任务每30分钟运行一次

const https = require('https');
const http = require('http');

const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');
const API_BASE = 'https://worldcup26.ir';

// ========== HTTP 请求工具 ==========
function httpsGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve(data); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function httpsPost(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        const options = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(bodyStr), ...headers }
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch (e) { resolve({ status: res.statusCode, data }); }
            });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

// ========== 主流程 ==========
async function main() {
    console.log('⚽ 世界杯比分更新开始 -', new Date().toLocaleString('zh-CN'));

    // 1. 注册获取 API Token
    console.log('1. 获取API Token...');
    const authRes = await httpsPost(API_BASE + '/auth/register', {
        name: 'WCScoreBot_' + Math.random().toString(36).substr(2, 6),
        email: 'wcsb_' + Date.now() + '@bot.app',
        password: process.env.WC26_BOT_PASSWORD || 'REPLACE_WITH_BOT_PASSWORD'
    });

    if (!authRes.data || !authRes.data.token) {
        console.error('❌ API注册失败:', JSON.stringify(authRes.data));
        process.exit(1);
    }
    const token = authRes.data.token;
    console.log('✅ Token获取成功');

    // 2. 获取比赛数据
    console.log('2. 获取比赛数据...');
    const gamesRes = await httpsGet(API_BASE + '/get/games', {
        'Authorization': 'Bearer ' + token
    });

    if (!gamesRes.games) {
        console.error('❌ 获取比赛数据失败');
        process.exit(1);
    }
    console.log(`✅ 获取到 ${gamesRes.games.length} 场比赛数据`);

    // 3. 提取最新比分
    const apiScores = {};
    let finishedCount = 0;

    gamesRes.games.forEach(g => {
        const isFinished = g.finished === 'TRUE';
        if (isFinished) {
            finishedCount++;
            apiScores[g.id] = {
                homeScore: parseInt(g.home_score),
                awayScore: parseInt(g.away_score),
                status: 'finished',
                timeElapsed: g.time_elapsed || ''
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

    const liveCount = Object.values(apiScores).filter(s => s.status === 'live').length;
    console.log(`📊 已结束: ${finishedCount}场, 进行中: ${liveCount}场`);

    // 4. 读取 npoint.io 当前数据
    console.log('3. 读取云端数据...');
    const currentData = await httpsGet('https://api.npoint.io/' + NPOINT_ID);
    console.log('   云端数据:', JSON.stringify(currentData).substring(0, 200));
    const predictions = currentData.predictions || [];
    const cloudScores = currentData.scores || {};

    // 4.5 为新结算的比赛标记日期（用于前端"今日积分排名"）
    const todayStr = new Date().toISOString().slice(0, 10);
    for (const [mid, s] of Object.entries(apiScores)) {
        if (s.status === 'finished') {
            const old = cloudScores[mid];
            if (!old || old.status !== 'finished') {
                s.settledDate = todayStr;
            } else if (old.settledDate) {
                s.settledDate = old.settledDate;
            }
        }
    }

    // 5. 对比并更新比分（合并apiScores到cloudScores）
    let updatedCount = 0;
    const mergedScores = { ...cloudScores };
    for (const [matchId, score] of Object.entries(apiScores)) {
        if (!cloudScores[matchId] || cloudScores[matchId].status !== score.status ||
            cloudScores[matchId].homeScore !== score.homeScore ||
            cloudScores[matchId].awayScore !== score.awayScore) {
            updatedCount++;
        }
        mergedScores[matchId] = score;
    }

    // 6. 计算新结算的积分（同时处理A组和B组）
    let pointsUpdated = 0;
    for (const key of ['predictions', 'predictions_B']) {
        const preds = currentData[key];
        if (!Array.isArray(preds)) continue;
        preds.forEach(p => {
            const s = mergedScores[p.matchId];
            if (s && s.status === 'finished' && p.points === null && p.homePred != null) {
                const ah = s.homeScore, aa = s.awayScore, ph = p.homePred, pa = p.awayPred;
                if (ah === ph && aa === pa) p.points = 5;
                else if ((ah - aa) === (ph - pa)) p.points = 4;
                else {
                    const ar = ah > aa ? 'w' : ah < aa ? 'l' : 'd';
                    const pr = ph > pa ? 'w' : ph < pa ? 'l' : 'd';
                    p.points = ar === pr ? 3 : 1;
                }
                pointsUpdated++;
            }
        });
    }

    console.log(`🔄 比分更新: ${updatedCount}场, 积分结算: ${pointsUpdated}条`);

    // 7. 写回 npoint.io —— 保留所有原有字段
    const newData = { ...currentData, scores: mergedScores };
    const postRes = await httpsPost('https://api.npoint.io/' + NPOINT_ID, newData);

    if (postRes.status === 200 || postRes.status === 201) {
        console.log('✅ 云端数据已更新！');
    } else {
        console.error('❌ 云端更新失败:', postRes.status);
    }

    console.log('⚽ 更新完成 -', new Date().toLocaleString('zh-CN'));
}

main().catch(e => {
    console.error('❌ 更新失败:', e.message);
    process.exit(1);
});
