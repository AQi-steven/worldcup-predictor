const https = require('https');
const fs = require('fs');

// 读取修复后的数据
const data = JSON.parse(fs.readFileSync('npoint_latest.json', 'utf8'));

// 上传到npoint.io
const options = {
    hostname: 'api.npoint.io',
    path: '/REPLACE_WITH_NPOINT_ID',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(JSON.stringify(data))
    }
};

console.log('='.repeat(80));
console.log('上传修复后的数据到 npoint.io...');
console.log('='.repeat(80));
console.log();

const req = https.request(options, (res) => {
    let responseData = '';
    res.on('data', (chunk) => {
        responseData += chunk;
    });
    res.on('end', () => {
        console.log(`状态码: ${res.statusCode}`);
        if (res.statusCode === 200) {
            console.log('[OK] 上传成功！');
            console.log(`响应: ${responseData}`);
        } else {
            console.log(`[ERROR] 上传失败: ${res.statusCode}`);
            console.log(`响应: ${responseData}`);
        }
        console.log();
        console.log('完成！');
    });
});

req.on('error', (e) => {
    console.log(`[ERROR] 上传失败: ${e.message}`);
    console.log();
    console.log('请手动上传 npoint_latest.json 到 https://api.npoint.io/REPLACE_WITH_NPOINT_ID');
});

req.write(JSON.stringify(data));
req.end();
