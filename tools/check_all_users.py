import json
import os
from datetime import datetime, timedelta

def safe_str(s):
    """安全转字符串，避免Windows终端乱码"""
    return str(s)

print('=' * 80)
print('全面检查：所有用户是否有预测丢失')
print('=' * 80)
print()

# 1. 读取昨天备份
yesterday = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')
backup_path = f'backups/snapshot_{yesterday}.json'

if not os.path.exists(backup_path):
    print(f'[WARN] 未找到昨天备份：{backup_path}')
    # 找最近的备份
    if os.path.exists('backups'):
        backups = sorted([f for f in os.listdir('backups') if f.startswith('snapshot_') and f.endswith('.json')])
        if backups:
            backup_path = f'backups/{backups[-1]}'
            print(f'使用最近备份：{backup_path}')
        else:
            print('[ERROR] 没有备份，无法对比！')
            exit(1)
    else:
        print('[ERROR] backups目录不存在！')
        exit(1)

print(f'[1/4] 读取昨天备份：{backup_path}')
with open(backup_path, 'r', encoding='utf8') as f:
    d_old = json.load(f)
print(f'  A组预测数：{len(d_old.get("predictions", []))}')
print(f'  B组预测数：{len(d_old.get("predictions_B", []))}')
print()

# 2. 读取最新数据（从npoint.io下载，确保是最新的）
print('[2/4] 从 npoint.io 下载最新数据...')
import urllib.request
try:
    req = urllib.request.Request('https://api.npoint.io/REPLACE_WITH_NPOINT_ID')
    with urllib.request.urlopen(req, timeout=30) as resp:
        d_new = json.loads(resp.read().decode('utf8'))
    print('  [OK] 下载成功')
    print(f'  A组预测数：{len(d_new.get("predictions", []))}')
    print(f'  B组预测数：{len(d_new.get("predictions_B", []))}')
except Exception as e:
    print(f'  [ERROR] 下载失败：{e}')
    print('  使用本地 npoint_latest.json')
    with open('npoint_latest.json', 'r', encoding='utf8') as f:
        d_new = json.load(f)
print()

# 3. 检查A组所有用户
print('=' * 80)
print('[3/4] 检查 A组 所有用户...')
print('=' * 80)
print()

preds_old = d_old.get('predictions', [])
preds_new = d_new.get('predictions', [])

# 获取所有用户名（从昨天备份，最完整）
all_users = {}
for p in preds_old:
    name = p.get('userName', '?')
    all_users[name] = all_users.get(name, 0) + 1

# 也检查今天数据中是否有新用户
for p in preds_new:
    name = p.get('userName', '?')
    if name not in all_users:
        all_users[name] = 0

print(f'A组总用户数：{len(all_users)}')
print()

# 检查每个用户
problems = []
for user in sorted(all_users.keys()):
    old_preds = [p for p in preds_old if p.get('userName') == user]
    new_preds = [p for p in preds_new if p.get('userName') == user]
    
    old_dict = {str(p.get('matchId')): p for p in old_preds}
    new_dict = {str(p.get('matchId')): p for p in new_preds}
    
    old_mids = set(old_dict.keys())
    new_mids = set(new_dict.keys())
    
    removed = old_mids - new_mids  # 丢失的比赛
    added = new_mids - old_mids      # 新增的比赛
    
    if removed:
        # 计算丢失的积分
        lost_pts = sum(old_dict[mid].get('points') or 0 for mid in removed)
        problems.append({
            'user': user,
            'group': 'A',
            'lost_count': len(removed),
            'lost_mids': sorted(removed, key=lambda x: int(x)),
            'lost_pts': lost_pts,
            'old_total': sum(p.get('points') or 0 for p in old_preds),
            'new_total': sum(p.get('points') or 0 for p in new_preds)
        })

if problems:
    print(f'[WARN] 发现 {len(problems)} 个用户有预测丢失：')
    print()
    total_lost_all = 0
    for p in problems:
        print(f'  {p["user"]}（A组）：')
        print(f'    丢失 {p["lost_count"]} 场比赛：{p["lost_mids"]}')
        print(f'    丢失积分：{p["lost_pts"]} 分')
        print(f'    昨天总分：{p["old_total"]} → 今天总分：{p["new_total"]}')
        print()
        total_lost_all += p['lost_pts']
    print(f'总共丢失积分：{total_lost_all} 分')
else:
    print('[OK] A组所有用户预测完整，无丢失')

print()

# 4. 检查B组所有用户
print('=' * 80)
print('[4/4] 检查 B组 所有用户...')
print('=' * 80)
print()

preds_b_old = d_old.get('predictions_B', [])
preds_b_new = d_new.get('predictions_B', [])

# 获取所有用户名
all_users_b = {}
for p in preds_b_old:
    name = p.get('userName', '?')
    all_users_b[name] = all_users_b.get(name, 0) + 1
for p in preds_b_new:
    name = p.get('userName', '?')
    if name not in all_users_b:
        all_users_b[name] = 0

print(f'B组总用户数：{len(all_users_b)}')
print()

# 检查每个用户
problems_b = []
for user in sorted(all_users_b.keys()):
    old_preds = [p for p in preds_b_old if p.get('userName') == user]
    new_preds = [p for p in preds_b_new if p.get('userName') == user]
    
    old_dict = {str(p.get('matchId')): p for p in old_preds}
    new_dict = {str(p.get('matchId')): p for p in new_preds}
    
    old_mids = set(old_dict.keys())
    new_mids = set(new_dict.keys())
    
    removed = old_mids - new_mids
    added = new_mids - old_mids
    
    if removed:
        lost_pts = sum(old_dict[mid].get('points') or 0 for mid in removed)
        problems_b.append({
            'user': user,
            'group': 'B',
            'lost_count': len(removed),
            'lost_mids': sorted(removed, key=lambda x: int(x)),
            'lost_pts': lost_pts,
            'old_total': sum(p.get('points') or 0 for p in old_preds),
            'new_total': sum(p.get('points') or 0 for p in new_preds)
        })

if problems_b:
    print(f'[WARN] 发现 {len(problems_b)} 个用户有预测丢失：')
    print()
    total_lost_all_b = 0
    for p in problems_b:
        print(f'  {p["user"]}（B组）：')
        print(f'    丢失 {p["lost_count"]} 场比赛：{p["lost_mids"]}')
        print(f'    丢失积分：{p["lost_pts"]} 分')
        print(f'    昨天总分：{p["old_total"]} → 今天总分：{p["new_total"]}')
        print()
        total_lost_all_b += p['lost_pts']
    print(f'总共丢失积分：{total_lost_all_b} 分')
else:
    print('[OK] B组所有用户预测完整，无丢失')

print()
print('=' * 80)
print('汇总')
print('=' * 80)
print()

if not problems and not problems_b:
    print('[OK] 所有用户预测完整，无需修复')
else:
    print(f'A组有问题用户：{len(problems)}')
    print(f'B组有问题用户：{len(problems_b)}')
    print()
    print('需要修复吗？')
    print('请运行：python restore_all_lost.py')
    print('（会自动从昨天备份恢复丢失的预测）')

# 保存问题报告
report = {
    'check_time': datetime.now().isoformat(),
    'backup_used': backup_path,
    'problems_A': problems,
    'problems_B': problems_b
}

with open('data_loss_report.json', 'w', encoding='utf8') as f:
    json.dump(report, f, ensure_ascii=False, indent=2)

print()
print('[OK] 问题报告已保存到 data_loss_report.json')
print()
print('完成！')
