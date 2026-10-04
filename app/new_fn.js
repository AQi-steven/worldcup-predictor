function showFinaleReportPreview(state){
  const me = state.me; window.__previewMe = me;
  if (typeof MATCH_DATA === 'undefined') return null;
  const m103 = MATCH_DATA.find(m=>String(m.id)==='103');
  const m104 = MATCH_DATA.find(m=>String(m.id)==='104'); if(!m104) return null;
  const m104settled = state.isFinal || (m104.settledDate && m104.homeScore != null);
  const { stats, dayChampDates } = wcBuildStatsAll();
  const s = stats[me]; if(!s) return null;
  const avgBase = s.baseSettled>0 ? s.baseTotal/s.baseSettled : 0;
  const pr = wcPartRate(me, stats);
  const totalRank = Object.entries(stats).sort((a,b)=>b[1].total-a[1].total).findIndex(([n])=>n===me)+1;
  const totalUsers = Object.keys(stats).length;
  const compRank = Object.entries(stats).map(([n,st])=>{ const ar=st.baseSettled>0?st.baseTotal/st.baseSettled:0; const prr=wcPartRate(n,stats); return [n, ar*(0.5+0.5*prr)]; }).sort((a,b)=>b[1]-a[1]).findIndex(([n])=>n===me)+1;
  const maxPerfect = Math.max(...Object.values(stats).map(st=>st.perfect));
  const validBase = Object.entries(stats).filter(([,st])=>st.baseSettled>=10);
  const maxAvgBase = validBase.length?Math.max(...validBase.map(([,st])=>st.baseTotal/st.baseSettled)):0;
  const kingTitles=[];
  if(s.perfect>=3 && s.perfect===maxPerfect) kingTitles.push('完美王');
  if(s.baseSettled>=10 && validBase.length>0 && avgBase===maxAvgBase) kingTitles.push('神准王');
  if(pr>=1.0 && s.settled>=10) kingTitles.push('全勤王');
  const et = evalUserTitle(me);
  const radarAll = computeStyleRadarAll(); const myRadar = radarAll && radarAll[me];
  const dayChamps = (dayChampDates[me]||[]).slice().sort();
  const perfectSorted = s.perfectList.slice().sort((a,b)=>a.date<b.date?-1:1);
  const perfectListHtml = perfectSorted.length ? perfectSorted.map(p=>`<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px dashed rgba(255,215,0,0.18);"><span>${p.date} · M${p.id}</span><span>${p.home} ${p.hs}-${p.as} ${p.away}</span></div>`).join('') : '<div style="font-size:12px;color:#9fb0d9;">暂无完美命中</div>';
  const cb = wcSeasonComeback(); const seasonCb = cb && cb.best; const myCb = cb && cb.me;
  const mode = state.mode || (state.isFinal ? 'end' : 'final');
  const isSemi = (mode==='semi');
  const isEnd = (mode==='end');
  let comebackHtml='';
  if(isEnd){
    if(myCb){
      comebackHtml=`<div style="color:#ffd700;font-weight:700;">🏅 你就是本季逆袭达人！</div><div style="font-size:12px;color:#cdd6f4;margin-top:4px;">${myCb.date} 第${myCb.from} → 第${myCb.to}（单日反超 +${myCb.rise} 位）</div>`;
    } else if(seasonCb){
      comebackHtml=`<div style="font-size:12px;color:#9fb0d9;">你本季最佳单日反超：</div><div style="font-size:12px;color:#cdd6f4;margin-top:4px;">${seasonCb.date} 第${seasonCb.from} → 第${seasonCb.to}（ +${seasonCb.rise} 位）</div>`;
    } else {
      comebackHtml='<div style="font-size:12px;color:#9fb0d9;">本季暂无显著逆袭（无人单日反超≥2位）</div>';
    }
  }
  const comebackText = myCb ? (`你（${myCb.date} +${myCb.rise}位）`) : (seasonCb ? `${seasonCb.name}（${seasonCb.date} +${seasonCb.rise}位）` : '本季暂无');
  let bgGrad, borderCol, accentCol, subTxtCol;
  if(isSemi){ bgGrad='linear-gradient(160deg,#0e2e2a,#1c4a44)'; borderCol='rgba(126,232,200,0.45)'; accentCol='#7ee8c8'; subTxtCol='#bfe9dd'; }
  else { bgGrad='linear-gradient(160deg,#0d1b3e,#1a2a5e)'; borderCol='rgba(255,215,0,0.4)'; accentCol='#ffd700'; subTxtCol='#cdd6f4'; }
  const multMap = {'semi':['季军赛',6,18,24,30],'final':['决赛',7,21,28,35]};
  const multRow = multMap[mode];
  const isFinal = m104settled;
  const titleTxt = isEnd ? '🏆 封笔战报 · 本届最后一眼' : (isSemi ? '🟢 收官预告 · 季军赛即将开打' : '🏆 收官倒计时 · 决赛最后一战');
  const subTxt = isEnd ? '四年一度的竞猜，在此刻为你封笔。' : (isSemi ? '半决赛与季军赛之间，先看看你的征战厚度。' : '这是本届最后一次预测机会——写下你的最终判断。');
  let finaleResult='';
  if(isFinal){
    const m103sc=m103?scoreOf(m103):null; const m104sc=scoreOf(m104);
    finaleResult=`<div style="margin:14px 0;padding:12px;border:1px solid rgba(255,215,0,0.3);border-radius:10px;font-size:13px;">
      <div style="color:#ffd700;font-weight:700;margin-bottom:6px;">🥉 季军赛 M103</div>
      <div>${m103?((m103.homeCn||m103.home)+' '+(m103sc?m103sc.h:'-')+' : '+(m103sc?m103sc.a:'-')+' '+(m103.awayCn||m103.away)):'-'}</div>
      <div style="color:#ffd700;font-weight:700;margin:8px 0 6px;">🏆 决赛 M104</div>
      <div>${(m104.homeCn||m104.home)} ${m104sc.h} : ${m104sc.a} ${(m104.awayCn||m104.away)}</div>
    </div>`;
  }
  const perfectSection = isEnd
    ? `<div style="margin:14px 0;"><div style="font-size:13px;color:${accentCol};font-weight:700;margin-bottom:6px;">⚽ 完美命中 ${s.perfect} 场（逐场）</div>${perfectListHtml}</div>`
    : `<div style="margin:14px 0;font-size:13px;">⚽ 完美命中 <b style="color:${accentCol};">${s.perfect}</b> 场（决赛后揭晓逐场）</div>`;
  let radarText=''; if(myRadar) radarText=myRadar.topLabel+'（'+myRadar.topScore+'%）';
  let headerHtml;
  if(isEnd){
    headerHtml = `
      <div style="text-align:center;margin:6px 0 14px;">
        <div style="font-size:13px;color:${subTxtCol};">${me} · 「${et.main}」${et.sub?' '+et.sub:''}</div>
        <div style="font-size:34px;font-weight:900;color:${accentCol};line-height:1.1;margin-top:6px;">${s.total.toFixed(1)}</div>
        <div style="font-size:13px;color:${subTxtCol};margin-top:2px;">总积分 · 全组第 <b style="color:${accentCol};">${totalRank}</b>/${totalUsers} 名</div>
        <div style="font-size:12px;color:${subTxtCol};margin-top:2px;">综合准度第 ${compRank} 名${kingTitles.length?' · '+kingTitles.join(' / '):''}</div>
      </div>`;
  } else {
    headerHtml = `
      <div style="text-align:center;margin:6px 0 14px;">
        <div style="font-size:22px;font-weight:800;">${me}</div>
        <div style="font-size:13px;color:${accentCol};margin-top:4px;">「${et.main}」 ${et.sub}</div>
        ${kingTitles.length?`<div style="margin-top:8px;">${kingTitles.map(t=>`<span style="display:inline-block;margin:2px;padding:3px 10px;background:${accentCol};color:#1a2a5e;border-radius:20px;font-size:12px;font-weight:700;">${t}</span>`).join('')}</div>`:''}
      </div>`;
  }
  const uid = 'f' + (window.__fuid = (window.__fuid||0)+1);
  const overlay=document.createElement('div'); overlay.id='finale-report-'+uid;
  overlay.style.cssText='margin:0 auto 8px;max-width:420px;width:100%;';
  const box=document.createElement('div');
  box.style.cssText=`margin:0 auto;max-width:420px;width:100%;background:${bgGrad};border:1px solid ${borderCol};border-radius:18px;padding:22px;color:#fff;box-shadow:0 10px 40px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;`;
  box.innerHTML=`
    <div style="text-align:center;">
      <div style="font-size:20px;font-weight:800;color:${accentCol};letter-spacing:1px;">${titleTxt}</div>
      <div style="font-size:13px;color:${subTxtCol};margin-top:6px;">${subTxt}</div>
    </div>
    ${headerHtml}
    <div style="display:flex;justify-content:space-around;text-align:center;margin:14px 0;">
      <div><div style="font-size:20px;font-weight:800;color:${accentCol};">${s.firstDate||'-'}</div><div style="font-size:11px;color:#9fb0d9;">首猜日</div></div>
      <div><div style="font-size:20px;font-weight:800;color:${accentCol};">${s.days.size}</div><div style="font-size:11px;color:#9fb0d9;">征战天数</div></div>
      <div><div style="font-size:20px;font-weight:800;color:${accentCol};">${s.count}</div><div style="font-size:11px;color:#9fb0d9;">预测场次</div></div>
      <div><div style="font-size:20px;font-weight:800;color:${accentCol};">${s.xCount}</div><div style="font-size:11px;color:#9fb0d9;">X题参与</div></div>
    </div>
    ${perfectSection}
    <div style="display:flex;justify-content:space-around;text-align:center;margin:14px 0;">
      <div><div style="font-size:20px;font-weight:800;color:${accentCol};">${dayChamps.length}</div><div style="font-size:11px;color:#9fb0d9;">单日封王</div></div>
      <div><div style="font-size:20px;font-weight:800;color:${accentCol};">${s.total.toFixed(1)}</div><div style="font-size:11px;color:#9fb0d9;">总积分${isEnd?'':'·第'+totalRank+'/'+totalUsers}</div></div>
      <div><div style="font-size:20px;font-weight:800;color:${accentCol};">${compRank}</div><div style="font-size:11px;color:#9fb0d9;">综合准度名次</div></div>
    </div>
    ${dayChamps.length?`<div style="font-size:12px;color:${subTxtCol};margin-bottom:8px;">封王日：${dayChamps.join('、')}</div>`:''}
    ${isEnd?`<div style="margin:14px 0;padding:12px;border:1px solid ${borderCol};border-radius:10px;font-size:13px;background:rgba(255,215,0,0.06);"><div style="color:${accentCol};font-weight:700;margin-bottom:6px;">🚀 逆袭达人 · 本季最大单日反超</div>${comebackHtml}</div>`:''}
    <div style="font-size:12px;color:${subTxtCol};margin-bottom:10px;">🎯 预测风格：${radarText||'—'}</div>
    ${finaleResult}
    ${multRow?`<div style="margin-top:10px;font-size:12px;color:#9fb0d9;">📊 阶段倍率（积分 = 基础分 × 倍率）</div>
    <table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:6px;text-align:center;color:#cdd6f4;">
      <tr style="background:rgba(255,215,0,0.1);"><th style="padding:4px;border:1px solid ${borderCol};">阶段</th><th style="padding:4px;border:1px solid ${borderCol};">倍率</th><th style="padding:4px;border:1px solid ${borderCol};">参与</th><th style="padding:4px;border:1px solid ${borderCol};">净胜球</th><th style="padding:4px;border:1px solid ${borderCol};">完美</th></tr>
      <tr><td style="padding:4px 6px;border:1px solid ${borderCol};">${multRow[0]}</td><td style="padding:4px 6px;border:1px solid ${borderCol};color:${accentCol};font-weight:700;">×${multRow[1]}</td><td style="padding:4px 6px;border:1px solid ${borderCol};">${multRow[2]}</td><td style="padding:4px 6px;border:1px solid ${borderCol};">${multRow[3]}</td><td style="padding:4px 6px;border:1px solid ${borderCol};">${multRow[4]}</td></tr>
    </table>`:''}
    ${isEnd?`<div style="display:flex;gap:10px;margin-top:18px;">
      <button id="finale-share-${uid}" style="flex:1;background:linear-gradient(90deg,#ffd700,#ffb300);color:#1a2a5e;border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:700;cursor:pointer;">📸 生成战报长图</button>
      <button id="finale-close-${uid}" style="flex:1;background:rgba(255,255,255,0.12);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:10px;padding:11px;font-size:14px;cursor:pointer;">收下这份记忆</button>
    </div>`:''}
  `;
  overlay.appendChild(box);
  if(isEnd){
    overlay.querySelector('#finale-close-'+uid).addEventListener('click', ()=>{ overlay.remove(); });
    overlay.querySelector('#finale-share-'+uid).addEventListener('click', ()=>wcGenerateFinaleImage({ me, et, kingTitles, s, totalRank, totalUsers, compRank, dayChamps, avgBase, pr, perfectCount:s.perfect, isFinal, radarText, comeback: comebackText }));
  }
  return overlay;
}
