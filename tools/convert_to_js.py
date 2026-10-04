#!/usr/bin/env python3
"""将worldcup26.ir比赛数据转换为内嵌HTML的JavaScript数据格式"""
import json
import re

# 球场时区偏移（夏季）→ 北京时间偏移小时
STADIUM_TZ = {
    '1':13,'2':13,'3':13,'4':13,'5':13,'6':13,
    '7':12,'8':12,'9':12,'10':12,'11':12,'12':12,
    '13':15,'14':15,'15':15,'16':15
}

CN_NAMES = {
    'Mexico':'墨西哥','South Africa':'南非','South Korea':'韩国',
    'Czech Republic':'捷克','Canada':'加拿大',
    'Bosnia and Herzegovina':'波黑','Qatar':'卡塔尔','Switzerland':'瑞士',
    'Brazil':'巴西','Morocco':'摩洛哥','Haiti':'海地','Scotland':'苏格兰',
    'United States':'美国','Paraguay':'巴拉圭','Australia':'澳大利亚',
    'Turkey':'土耳其','Germany':'德国','Curaçao':'库拉索',
    'Ivory Coast':'科特迪瓦','Ecuador':'厄瓜多尔','Netherlands':'荷兰',
    'Japan':'日本','Sweden':'瑞典','Tunisia':'突尼斯',
    'Belgium':'比利时','Egypt':'埃及','Iran':'伊朗',
    'New Zealand':'新西兰','Spain':'西班牙','Cape Verde':'佛得角',
    'Saudi Arabia':'沙特','Uruguay':'乌拉圭','France':'法国',
    'Senegal':'塞内加尔','Norway':'挪威','Iraq':'伊拉克',
    'Argentina':'阿根廷','Algeria':'阿尔及利亚','Austria':'奥地利',
    'Jordan':'约旦','Portugal':'葡萄牙','Uzbekistan':'乌兹别克斯坦',
    'Colombia':'哥伦比亚','Democratic Republic of the Congo':'民主刚果',
    'England':'英格兰','Croatia':'克罗地亚','Ghana':'加纳','Panama':'巴拿马'
}

ROUND_CN = {'group':'小组赛','r32':'32强','r16':'16强','qf':'四分之一决赛','sf':'半决赛','third':'季军赛','final':'决赛'}

# 国旗emoji
FLAG_CODES = {
    'Mexico':'mx','South Africa':'za','South Korea':'kr',
    'Czech Republic':'cz','Canada':'ca',
    'Bosnia and Herzegovina':'ba','Qatar':'qa','Switzerland':'ch',
    'Brazil':'br','Morocco':'ma','Haiti':'ht','Scotland':'gb-sct',
    'United States':'us','Paraguay':'py','Australia':'au',
    'Turkey':'tr','Germany':'de','Curaçao':'cw',
    'Ivory Coast':'ci','Ecuador':'ec','Netherlands':'nl',
    'Japan':'jp','Sweden':'se','Tunisia':'tn',
    'Belgium':'be','Egypt':'eg','Iran':'ir',
    'New Zealand':'nz','Spain':'es','Cape Verde':'cv',
    'Saudi Arabia':'sa','Uruguay':'uy','France':'fr',
    'Senegal':'sn','Norway':'no','Iraq':'iq',
    'Argentina':'ar','Algeria':'dz','Austria':'at',
    'Jordan':'jo','Portugal':'pt','Uzbekistan':'uz',
    'Colombia':'co','Democratic Republic of the Congo':'cd',
    'England':'gb-eng','Croatia':'hr','Ghana':'gh','Panama':'pa'
}

def to_bj_time(local_date, stadium_id):
    parts = re.match(r'(\d{2})/(\d{2})/(\d{4})\s+(\d{2}):(\d{2})', local_date)
    if not parts: return local_date
    mm,dd,yyyy,hh,mi = parts.groups()
    offset = STADIUM_TZ.get(str(stadium_id), 13)
    bj_hour = int(hh) + offset
    bj_day = int(dd); bj_month = int(mm); bj_year = int(yyyy)
    if bj_hour >= 24:
        bj_hour -= 24; bj_day += 1
    dim = [31,28,31,30,31,30,31,31,30,31,30,31]
    if bj_year%4==0 and (bj_year%100!=0 or bj_year%400==0): dim[1]=29
    if bj_day > dim[bj_month-1]: bj_day=1; bj_month+=1
    if bj_month > 12: bj_month=1; bj_year+=1
    return f"{bj_year}-{str(bj_month).zfill(2)}-{str(bj_day).zfill(2)} {str(bj_hour).zfill(2)}:{mi}"

with open('games_raw.json', encoding='utf-8') as f:
    data = json.load(f)

games = data.get('games', [])
matches_js = []
for g in games:
    is_finished = g.get('finished') == 'TRUE'
    bj_date = to_bj_time(g.get('local_date',''), g.get('stadium_id',''))
    home_en = g.get('home_team_name_en','')
    away_en = g.get('away_team_name_en','')
    home_cn = CN_NAMES.get(home_en, home_en)
    away_cn = CN_NAMES.get(away_en, away_en)
    phase = ROUND_CN.get(g.get('type',''), g.get('group',''))
    home_flag = FLAG_CODES.get(home_en, '')
    away_flag = FLAG_CODES.get(away_en, '')
    
    match_obj = {
        'id': g.get('id',''),
        'bjDate': bj_date,
        'home': home_en,
        'away': away_en,
        'homeCn': home_cn,
        'awayCn': away_cn,
        'homeFlag': home_flag,
        'awayFlag': away_flag,
        'homeScore': int(g.get('home_score',0)) if is_finished else None,
        'awayScore': int(g.get('away_score',0)) if is_finished else None,
        'phase': phase or '',
        'status': 'finished' if is_finished else 'upcoming',
        'stadiumId': g.get('stadium_id','')
    }
    matches_js.append(match_obj)

# 输出为JavaScript变量赋值格式
js_code = 'const MATCH_DATA = ' + json.dumps(matches_js, ensure_ascii=False, indent=0) + ';'

with open('match_data.js', 'w', encoding='utf-8') as f:
    f.write(js_code)

print(f"已转换 {len(matches_js)} 场比赛数据为JS格式")
finished = [m for m in matches_js if m['status'] == 'finished']
print(f"已完成: {len(finished)} 场")
for m in finished[:5]:
    print(f"  {m['homeCn']} {m['homeScore']}:{m['awayScore']} {m['awayCn']}")