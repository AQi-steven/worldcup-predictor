// 将API比赛数据写入腾讯文档的脚本
// 读取worldcup26.ir的比赛数据，然后通过腾讯文档MCP写入

// worldcup26.ir 的 API Token（JWT）。从环境变量读取，勿硬编码真实值。
const TOKEN = process.env.WC26_API_TOKEN || 'REPLACE_WITH_WC26_API_TOKEN';
const API_URL = 'https://worldcup26.ir/get/games';

const https = require('https');

function fetchGames() {
    return new Promise((resolve, reject) => {
        const options = {
            headers: { 'Authorization': 'Bearer ' + TOKEN }
        };
        https.get(API_URL, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function main() {
    const data = await fetchGames();
    const games = data.games || [];
    console.log(`获取到 ${games.length} 场比赛`);
    
    // 输出CSV格式供参考
    console.log('match_id,date_bj,home,away,home_score,away_score,phase,status,home_cn,away_cn');
    games.forEach(g => {
        console.log(`${g.id},${g.local_date},${g.home_team_name_en},${g.away_team_name_en},${g.home_score||''},${g.away_score||''},${g.type||g.group||''},${g.finished==='TRUE'?'finished':'upcoming'},,`);
    });
}

main().catch(console.error);