// 一次性重算积分脚本（修复平局规则后使用）
// 从npoint.io读取所有预测，用新规则重算积分，写回
// 运行：node recalc-pts.js

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');

function npointGet() {
    const result = execSync(`curl -s https://api.npoint.io/${NPOINT_ID}`, { timeout: 15000 }).toString();
    return JSON.parse(result);
}

function npointPost(data) {
    const body = JSON.stringify(data);
    const tmpFile = path.join(__dirname, '_tmp_recalc.json');
    fs.writeFileSync(tmpFile, body, 'utf8');
    const result = execSync(`curl -s -X POST https://api.npoint.io/${NPOINT_ID} -H "Content-Type: application/json; charset=utf-8" -d @"${tmpFile}"`, { timeout: 15000 }).toString();
    fs.unlinkSync(tmpFile);
    return JSON.parse(result);
}

// 新规则积分计算（修复平局4分bug）
function calcPts(ah, aa, ph, pa) {
    if (ah === ph && aa === pa) return 5;                       // 完整比分相同 → 5分
    const diff = ah - aa, pdiff = ph - pa;
    if (diff === pdiff && diff !== 0) return 4;                 // 净胜球相同（非平局）→ 4分
    const ar = ah > aa ? 'w' : ah < aa ? 'l' : 'd';
    const pr = ph > pa ? 'w' : ph < pa ? 'l' : 'd';
    if (ar === pr) return 3;                                    // 胜负平相同 → 3分
    return 1;                                                   // 都不对 → 1分
}

async function main() {
    console.log('读取云端数据...');
    const data = npointGet();
    const scores = data.scores || {};

    // 重算 predictions（实例A）
    let changed = 0;
    for (const key of ['predictions', 'predictions_B']) {
        const preds = data[key];
        if (!Array.isArray(preds)) continue;
        preds.forEach(p => {
            const s = scores[String(p.matchId)];
            if (!s || s.homeScore == null || s.awayScore == null) return;
            if (s.status !== 'finished') return;
            const newPts = calcPts(s.homeScore, s.awayScore, p.homePred, p.awayPred);
            if (p.points !== newPts) {
                console.log(`  [${key}] ${p.userName} 比赛${p.matchId}: ${s.homeScore}:${s.awayScore} 预测${p.homePred}:${p.awayPred} 原${p.points}分 → 新${newPts}分`);
                p.points = newPts;
                changed++;
            }
        });
    }

    if (changed === 0) {
        console.log('✅ 没有需要修改的积分记录（所有结果均一致）');
        return;
    }

    console.log(`\n共有 ${changed} 条记录需要更新，写回中...`);
    // 写回完整data对象，保留scores、predictions_B等所有字段
    const result = npointPost(data);
    console.log('✅ 写回成功！积分已全部用新规则重算完毕。');
}

main().catch(e => console.error('出错:', e));
