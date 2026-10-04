/**
 * 每日快照备份脚本
 * 从 npoint.io 下载完整数据，保存到本地 backups/ 目录
 * 文件名格式：snapshot_YYYY-MM-DD.json
 * 只保留最近30天的备份，自动清理旧文件
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const NPOINT_ID = ((typeof process!=='undefined'&&process.env&&process.env.NPOINT_ID)||(typeof window!=='undefined'&&window.CONFIG&&window.CONFIG.npointId)||'REPLACE_WITH_NPOINT_ID');
const BACKUP_DIR = path.join(__dirname, 'backups');
const MAX_AGE_DAYS = 30;

function fetchNpointData() {
  return new Promise((resolve, reject) => {
    https.get(`https://api.npoint.io/${NPOINT_ID}`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

function cleanupOldBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('snapshot_') && f.endsWith('.json'))
    .map(f => ({
      name: f,
      path: path.join(BACKUP_DIR, f),
      mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_AGE_DAYS);

  let removed = 0;
  files.forEach(f => {
    if (f.mtime < cutoff) {
      fs.unlinkSync(f.path);
      removed++;
    }
  });

  if (removed > 0) {
    console.log(`[清理] 删除了 ${removed} 个超过 ${MAX_AGE_DAYS} 天的旧备份`);
  }
}

async function main() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const filename = `snapshot_${today}.json`;
  const filepath = path.join(BACKUP_DIR, filename);

  // 确保目录存在
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  // 如果今天已有备份，追加时间戳
  let finalPath = filepath;
  if (fs.existsSync(filepath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    finalPath = path.join(BACKUP_DIR, `snapshot_${today}_${ts}.json`);
  }

  console.log(`[快照] 开始下载 npoint.io 数据...`);
  console.log(`[快照] 目标文件: ${path.basename(finalPath)}`);

  try {
    const data = await fetchNpointData();

    // 统计信息
    const predCount = data.predictions ? data.predictions.length : 0;
    const scoreCount = data.scores ? Object.keys(data.scores).length : 0;
    const predBCount = data.predictions_B ? data.predictions_B.length : 0;

    // 统计A组用户数
    const users = new Set();
    if (data.predictions) {
      data.predictions.forEach(p => {
        if (p.userName) users.add(p.userName);
      });
    }

    // 写入文件
    fs.writeFileSync(finalPath, JSON.stringify(data, null, 2), 'utf8');
    const fileSize = (fs.statSync(finalPath).size / 1024).toFixed(1);

    console.log(`[快照] 备份成功!`);
    console.log(`[快照] 文件大小: ${fileSize} KB`);
    console.log(`[快照] 比赛比分: ${scoreCount} 场`);
    console.log(`[快照] A组预测: ${predCount} 条 (用户: ${users.size} 人)`);
    console.log(`[快照] B组预测: ${predBCount} 条`);

    // 清理旧备份
    cleanupOldBackups();

    // 列出当前所有备份
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('snapshot_') && f.endsWith('.json'))
      .sort()
      .reverse();
    console.log(`[快照] 现有备份: ${backups.length} 个`);
    if (backups.length <= 5) {
      backups.forEach(b => console.log(`  - ${b}`));
    } else {
      backups.slice(0, 3).forEach(b => console.log(`  - ${b}`));
      console.log(`  ... 还有 ${backups.length - 3} 个`);
    }

  } catch (err) {
    console.error(`[快照] 失败: ${err.message}`);
    process.exit(1);
  }
}

main();
