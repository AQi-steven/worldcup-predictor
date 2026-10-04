const https = require('https');
const fs = require('fs');

console.log('='.repeat(80));
console.log('安全上传：先GET最新数据 → 修改 → POST回去');
console.log('='.repeat(80));
console.log();

// 1. 先GET最新数据
console.log('[1/3] GET 最新数据从 npoint.io...');

const getOptions = {
    hostname: 'api.npoint.io',
    path: '/REPLACE_WITH_NPOINT_ID',
    method: 'GET'
};

const getReq = https.request(getOptions, (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        if (res.statusCode === 200) {
            console.log('[OK] GET 成功');
            let npointData;
            try {
                npointData = JSON.parse(data);
                console.log(`  当前预测数：${npointData.predictions ? npointData.predictions.length : '?'}`);
                console.log(`  当前B组预测数：${npointData.predictions_B ? npointData.predictions_B.length : '?'}`);
            } catch (e) {
                console.log('[ERROR] 解析JSON失败：' + e.message);
                process.exit(1);
            }
            
            // 2. 读取本地修复后的数据
            console.log();
            console.log('[2/3] 读取本地修复后的数据...');
            let localData;
            try {
                localData = JSON.parse(fs.readFileSync('npoint_latest.json', 'utf8'));
                console.log('[OK] 读取成功');
                console.log(`  本地预测数：${localData.predictions ? localData.predictions.length : '?'}`);
                console.log(`  本地B组预测数：${localData.predictions_B ? localData.predictions_B.length : '?'}`);
            } catch (e) {
                console.log('[ERROR] 读取文件失败：' + e.message);
                process.exit(1);
            }
            
            // 3. 用本地数据替换npoint数据（安全：只替换predictions和predictions_B）
            console.log();
            console.log('[3/3] 上传修复后的数据到 npoint.io...');
            
            // 保留npoint上的scores/comments，只替换predictions
            npointData.predictions = localData.predictions;
            npointData.predictions_B = localData.predictions_B;
            
            const postData = JSON.stringify(npointData);
            const postOptions = {
                hostname: 'api.npoint.io',
                path: '/REPLACE_WITH_NPOINT_ID',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };
            
            const postReq = https.request(postOptions, (postRes) => {
                let postResponse = '';
                postRes.on('data', (chunk) => {
                    postResponse += chunk;
                });
                postRes.on('end', () => {
                    console.log(`  状态码: ${postRes.statusCode}`);
                    if (postRes.statusCode === 200) {
                        console.log('[OK] 上传成功！');
                        try {
                            const result = JSON.parse(postResponse);
                            console.log('  响应：' + JSON.stringify(result).substring(0, 200) + '...');
                        } catch (e) {
                            console.log('  响应：' + postResponse.substring(0, 200) + '...');
                        }
                    } else {
                        console.log('[ERROR] 上传失败: ' + postRes.statusCode);
                        console.log('  响应：' + postResponse);
                    }
                    console.log();
                    console.log('='.repeat(80));
                    console.log('完成！');
                    console.log('='.repeat(80));
                });
            });
            
            postReq.on('error', (e) => {
                console.log('[ERROR] 上传失败：' + e.message);
            });
            
            postReq.write(postData);
            postReq.end();
        } else {
            console.log('[ERROR] GET 失败: ' + res.statusCode);
            console.log('  响应：' + data);
        }
    });
});

getReq.on('error', (e) => {
    console.log('[ERROR] GET 失败：' + e.message);
});

getReq.end();
