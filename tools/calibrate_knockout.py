#!/usr/bin/env python3
"""
淘汰赛时间校准脚本
从 worldcup26.ir API 获取淘汰赛时间，根据体育场时区计算北京时间，
与 match_data.js 中的 bjDate 对比，输出差异报告。
用法：python calibrate_knockout.py [--fix]
"""

import json
import re
import sys
import subprocess
import argparse
from datetime import datetime, timedelta

# === 体育场时区映射（UTC偏移量，负值）===
# 来源：daily-planner.js STADIUM_TZ
STADIUM_TZ = {
    1: -6,   # Mexico City (永久UTC-6)
    2: -6,   # Guadalajara (永久UTC-6)
    3: -6,   # Monterrey (永久UTC-6)
    4: -5,   # Dallas (CDT)
    5: -5,   # Houston (CDT)
    6: -5,   # Kansas City (CDT)
    7: -4,   # Atlanta (EDT)
    8: -4,   # Miami (EDT)
    9: -4,   # Boston (EDT)
    10: -4,  # Philadelphia (EDT)
    11: -4,  # New York (EDT)
    12: -4,  # Toronto (EDT)
    13: -7,  # Vancouver (PDT)
    14: -7,  # Seattle (PDT)
    15: -7,  # San Francisco (PDT)
    16: -7,  # Los Angeles (PDT)
}

# API type -> phase 映射
TYPE_TO_PHASE = {
    'r32': '32强',
    'r16': '16强',
    'qf': '四分之一决赛',
    'sf': '半决赛',
    'third': '季军赛',
    'final': '决赛',
}

def fetch_api_games():
    """从 worldcup26.ir 获取比赛数据"""
    print("📡 正在从 worldcup26.ir 获取比赛数据...")
    cmd = [
        'curl', '-s',
        'https://worldcup26.ir/get/games',
        '--tlsv1.2'
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        print(f"❌ API 请求失败: {result.stderr}")
        sys.exit(1)
    try:
        data = json.loads(result.stdout)
        games = data.get('games', [])
        if isinstance(games, dict):
            games = list(games.values())
        print(f"✅ 获取到 {len(games)} 场比赛")
        return games
    except json.JSONDecodeError as e:
        print(f"❌ API 返回数据解析失败: {e}")
        print(f"Raw response: {result.stdout[:500]}")
        sys.exit(1)

def api_to_beijing_time(local_date_str, stadium_id):
    """
    将 API 当地时间转换为北京时间
    local_date_str 格式: "MM/DD/YYYY HH:MM"
    stadium_id: 数字，对应 STADIUM_TZ
    返回: "YYYY-MM-DD HH:MM" 或 None
    """
    tz_offset = STADIUM_TZ.get(stadium_id)
    if tz_offset is None:
        return None
    
    match = re.match(r'(\d{2})/(\d{2})/(\d{4})\s+(\d{2}):(\d{2})', local_date_str)
    if not match:
        return None
    
    mm, dd, yyyy, hh, mi = match.groups()
    # 构造当地时间（用 UTC 时间来表示当地时间）
    # 当地时间是 UTC+tz_offset，所以 UTC = 当地时间 - tz_offset
    # 这里用 datetime 来表示当地时间，然后转 UTC，再转北京时间
    local_dt = datetime(int(yyyy), int(mm), int(dd), int(hh), int(mi))
    # UTC 时间 = 当地时间 - tz_offset 小时
    utc_dt = local_dt - timedelta(hours=tz_offset)
    # 北京时间 = UTC + 8 小时
    bj_dt = utc_dt + timedelta(hours=8)
    
    return bj_dt.strftime('%Y-%m-%d %H:%M')

def read_match_data(js_path):
    """读取 match_data.js，返回匹配列表"""
    with open(js_path, 'r', encoding='utf8') as f:
        content = f.read()
    
    # 用正则提取所有比赛对象
    matches = []
    # 简化：找每个 { ... } 块
    pattern = re.compile(r'\{\s*[\s\S]*?"id"\s*:\s*"(\d+)"[\s\S]*?\}', re.DOTALL)
    
    # 更精确的方法：逐字符解析
    i = 0
    while i < len(content):
        # 找 "id"
        idx = content.find('"id"', i)
        if idx == -1:
            break
        # 找到这个对象的开始 {
        brace_start = content.rfind('{', 0, idx)
        if brace_start == -1:
            i = idx + 1
            continue
        # 找到匹配的 }
        brace_count = 1
        pos = brace_start + 1
        while brace_count > 0 and pos < len(content):
            if content[pos] == '{':
                brace_count += 1
            elif content[pos] == '}':
                brace_count -= 1
            pos += 1
        obj_str = content[brace_start:pos]
        
        # 提取字段
        m_id = re.search(r'"id"\s*:\s*"(\d+)"', obj_str)
        m_bjDate = re.search(r'"bjDate"\s*:\s*"([^"]+)"', obj_str)
        m_stadiumId = re.search(r'"stadiumId"\s*:\s*"(\d+)"', obj_str)
        m_phase = re.search(r'"phase"\s*:\s*"([^"]+)"', obj_str)
        m_homeCn = re.search(r'"homeCn"\s*:\s*"([^"]+)"', obj_str)
        m_awayCn = re.search(r'"awayCn"\s*:\s*"([^"]+)"', obj_str)
        
        if m_id:
            match = {
                'id': m_id.group(1),
                'bjDate': m_bjDate.group(1) if m_bjDate else None,
                'stadiumId': m_stadiumId.group(1) if m_stadiumId else None,
                'phase': m_phase.group(1) if m_phase else None,
                'homeCn': m_homeCn.group(1) if m_homeCn else '',
                'awayCn': m_awayCn.group(1) if m_awayCn else '',
            }
            matches.append(match)
        
        i = pos
    
    print(f"📖 从 match_data.js 读取到 {len(matches)} 场比赛")
    return matches

def write_match_data(js_path, matches):
    """将更新后的比赛数据写回 match_data.js"""
    with open(js_path, 'r', encoding='utf8') as f:
        content = f.read()
    
    # 对于每个比赛，更新 bjDate 和 phase
    for match in matches:
        mid = match['id']
        new_bjDate = match.get('new_bjDate')
        new_phase = match.get('new_phase')
        
        if not new_bjDate and not new_phase:
            continue
        
        # 找到这个比赛对象
        idx = content.find(f'"id":"{mid}"')
        if idx == -1:
            idx = content.find(f'"id": "{mid}"')
        if idx == -1:
            continue
        
        brace_start = content.rfind('{', 0, idx)
        brace_count = 1
        pos = brace_start + 1
        while brace_count > 0 and pos < len(content):
            if content[pos] == '{':
                brace_count += 1
            elif content[pos] == '}':
                brace_count -= 1
            pos += 1
        obj_str = content[brace_start:pos]
        
        new_obj_str = obj_str
        if new_bjDate:
            new_obj_str = re.sub(
                r'("bjDate"\s*:\s*")[^"]*"',
                r'\1' + new_bjDate + r'\1',
                new_obj_str
            )
            # 更简单：直接替换
            new_obj_str = new_obj_str.replace(
                '"bjDate":"' + match['bjDate'] + '"',
                '"bjDate":"' + new_bjDate + '"'
            ) if match['bjDate'] else new_obj_str
        
        if new_phase:
            new_obj_str = new_obj_str.replace(
                '"phase":"' + match['phase'] + '"',
                '"phase":"' + new_phase + '"'
            ) if match['phase'] else new_obj_str
        
        content = content[:brace_start] + new_obj_str + content[pos:]
    
    with open(js_path, 'w', encoding='utf8') as f:
        f.write(content)
    
    print(f"✅ 已更新 {js_path}")

def main():
    parser = argparse.ArgumentParser(description='淘汰赛时间校准脚本')
    parser.add_argument('--fix', action='store_true', help='自动修复 match_data.js（需手动确认）')
    args = parser.parse_args()
    
    # 1. 获取 API 数据
    api_games = fetch_api_games()
    
    # 2. 筛选淘汰赛
    knockout_types = {'r32', 'r16', 'qf', 'sf', 'third', 'final'}
    knockout_games = [g for g in api_games if g.get('type') in knockout_types]
    print(f"🏆 淘汰赛场数: {len(knockout_games)}")
    print()
    
    # 3. 读取 match_data.js
    js_path = 'match_data.js'
    local_matches = read_match_data(js_path)
    
    # 4. 构建 API 数据映射（按 id）
    api_map = {}
    for g in knockout_games:
        gid = str(g.get('id', ''))
        if not gid:
            continue
        # 去掉前缀 M（如果有）
        gid = gid.lstrip('M')
        bj_date = api_to_beijing_time(g.get('local_date', ''), int(g.get('stadium_id', 0)))
        api_map[gid] = {
            'api_local_date': g.get('local_date'),
            'api_stadium_id': g.get('stadium_id'),
            'api_type': g.get('type'),
            'bj_date': bj_date,
            'phase': TYPE_TO_PHASE.get(g.get('type'), ''),
        }
    
    # 5. 对比
    print("=" * 80)
    print("对比结果:")
    print("=" * 80)
    
    diffs = []
    for m in local_matches:
        mid = m['id']
        if int(mid) < 73:
            continue  # 跳过小组赛
        
        api_info = api_map.get(mid)
        if not api_info:
            print(f"⚠️  M{mid}: 在 API 中未找到")
            continue
        
        bj_api = api_info['bj_date']
        bj_local = m['bjDate']
        
        # 比较（只比较到分钟）
        match_fuzzy = False
        if bj_api and bj_local:
            # 规范化：去掉秒数
            bj_api_fmt = bj_api[:16]
            bj_local_fmt = bj_local[:16]
            match_fuzzy = bj_api_fmt == bj_local_fmt
        
        phase_match = (m['phase'] == api_info['phase']) if (m['phase'] and api_info['phase']) else True
        
        if not match_fuzzy or not phase_match:
            diff = {
                'id': mid,
                'homeCn': m['homeCn'],
                'awayCn': m['awayCn'],
                'bj_local': bj_local,
                'bj_api': bj_api,
                'phase_local': m['phase'],
                'phase_api': api_info['phase'],
                'match_fuzzy': match_fuzzy,
                'phase_match': phase_match,
            }
            diffs.append(diff)
            
            print(f"❌ M{mid}: {m['homeCn']} vs {m['awayCn']}")
            if not match_fuzzy:
                print(f"   时间差异: match_data={bj_local}, API计算={bj_api}")
            if not phase_match:
                print(f"   阶段差异: match_data={m['phase']}, API={api_info['phase']}")
            print()
        else:
            print(f"✅ M{mid}: {m['homeCn']} vs {m['awayCn']} ({bj_local}) ✓")
    
    print()
    print("=" * 80)
    print(f"总结: {len(diffs)} 场需要更新，{len(local_matches) - len(diffs)} 场正确")
    print("=" * 80)
    
    # 6. 如果需要修复
    if diffs and args.fix:
        print()
        print("🔧 开始修复 match_data.js...")
        # 更新 local_matches
        for m in local_matches:
            mid = m['id']
            diff = next((d for d in diffs if d['id'] == mid), None)
            if diff:
                m['new_bjDate'] = diff['bj_api']
                m['new_phase'] = diff['phase_api']
            else:
                m['new_bjDate'] = None
                m['new_phase'] = None
        
        write_match_data(js_path, local_matches)
        
        # 同时更新 deploy/ 和 deploy2/
        import shutil
        for subdir in ['deploy', 'deploy2']:
            target = os.path.join(subdir, 'match_data.js')
            shutil.copy2(js_path, target)
            print(f"✅ 已同步到 {target}")
    
    elif diffs and not args.fix:
        print()
        print("💡 运行 'python calibrate_knockout.py --fix' 来自动修复")

if __name__ == '__main__':
    main()
