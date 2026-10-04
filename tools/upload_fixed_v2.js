const https = require('https');
const fs = require('fs');

console.log('开始上传...');

// 读取修复后的数据
let data;
try {
    data = JSON.parse(fs.readFileSync('npoint_latest.json', 'utf8'));
    console.log('[OK] 已读取 npoint_latest.json');
    console.log(`  预测数：{data.predictions ? data.predictions.length : '?'}`);
    console.log(`  B组预测数：{data.predictions_B ? data.predictions_B.length : '?'}`);
} catch (e) {
    console.log('[ERROR] 读取文件失败：' + e.message);
    process.exit(1);
}

// 上传到npoint.io
const postData = JSON.stringify(data);
const options = {
    hostname: 'api.npoint.io',
    path: '/REPLACE_WITH_NPOINT_ID',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(postData)
    }
};

console.log('');
console.log('上传到 npoint.io...');

const req = https.request(options, (res) => {
    let responseData = '';
    res.on('data', (chunk) => {
        responseData += chunk;
    });
    res.on('end', () => {
        console.log(`状态码: {res.statusCode}`);
        if (res.statusCode === 200) {
            console.log('[OK] 上传成功！');
            try {
                const result = JSON.parse(responseData);
                console.log('  响应：' + JSON.stringify(result));
            } catch (e) {
                console.log('  响应：' + responseData);
            }
        } else {
            console.log('[ERROR] 上传失败: ' + res.statusCode);
            console.log('  响应：' + responseData);
        }
        console.log('');
        console.log('完成！');
    });
});

req.on('error', (e) => {
    console.log('[ERROR] 上传失败：' + e.message);
    console.log('');
    console.log('请手动上传 npoint_latest.json 到 https://api.npoint.io/REPLACE_WITH_NPOINT_ID');
});

req.write(postData);
req.end();
