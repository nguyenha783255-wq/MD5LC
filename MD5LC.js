'use strict';

const express = require('express');
const cors = require('cors');

// API gốc được lấy nguyên từ demotonghopttoan2.html.
const SOURCE_API = process.env.SOURCE_API ||
  'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=3959701241b686f12e01bfe9c3a319b8';
const PORT = Number(process.env.PORT || 3000);
const ADMIN = '@DENIUS09';
const POLL_MS = Math.max(2000, Number(process.env.POLL_MS || 5000));
const MAX_HISTORY = 300;

/* ---------- STATISTICAL HELPERS (từ binh.js StatisticalEngine) ---------- */
const Stat = {
  mean: a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0,
  variance: a => { if(a.length<2) return 0; const m=Stat.mean(a); return a.reduce((s,v)=>s+(v-m)**2,0)/a.length; },
  std: a => Math.sqrt(Stat.variance(a)),
  skewness: a => { const n=a.length; if(n<3) return 0; const m=Stat.mean(a), s=Stat.std(a); if(s===0) return 0;
    return a.reduce((sum,v)=>sum+((v-m)/s)**3,0)*n/((n-1)*(n-2)); },
  kurtosis: a => { const n=a.length; if(n<4) return 0; const m=Stat.mean(a), s=Stat.std(a); if(s===0) return 0;
    return a.reduce((sum,v)=>sum+((v-m)/s)**4,0)*(n*(n+1))/((n-1)*(n-2)*(n-3)) - 3*(n-1)**2/((n-2)*(n-3)); }
};

/* ============================================================================
 * PART 1: THUẬT TOÁN mrtinh.js + predictionAlgorithms.js
 * ==========================================================================*/
const Mrtinh = {
  detectStreakAndBreak(history){
    if(!history || !history.length) return {streak:0, currentResult:null, breakProb:0};
    let streak = 1;
    const cur = history[history.length-1].result;
    for(let i=history.length-2;i>=0;i--){
      if(history[i].result === cur) streak++; else break;
    }
    const last15 = history.slice(-15).map(h=>h.result);
    if(!last15.length) return {streak, currentResult:cur, breakProb:0};
    const switches = last15.slice(1).reduce((c,curr,idx)=>c+(curr!==last15[idx]?1:0),0);
    const taiCount = last15.filter(r=>r==='Tài').length;
    const xiuCount = last15.filter(r=>r==='Xỉu').length;
    const imbalance = Math.abs(taiCount-xiuCount)/last15.length;
    let bp = 0;
    if(streak>=6) bp = Math.min(0.8 + switches/15 + imbalance*0.3, 0.95);
    else if(streak>=4) bp = Math.min(0.5 + switches/12 + imbalance*0.25, 0.9);
    else if(streak>=2 && switches>=5) bp = 0.45;
    else if(streak===1 && switches>=6) bp = 0.3;
    return {streak, currentResult:cur, breakProb:bp};
  },

  smartBridgeBreak(history){
    if(!history || history.length<5) return {prediction:0, breakProb:0, reason:'Không đủ dữ liệu'};
    const {streak, currentResult, breakProb} = Mrtinh.detectStreakAndBreak(history);
    const last20 = history.slice(-20).map(h=>h.result);
    const lastScores = history.slice(-20).map(h=>h.totalScore||0);
    let bp = breakProb;
    let reason = '';
    const avgScore = Stat.mean(lastScores);
    const scoreDev = lastScores.reduce((s,v)=>s+Math.abs(v-avgScore),0)/(lastScores.length||1);
    const last5 = last20.slice(-5);
    const patternCounts = {};
    for(let i=0;i<=last20.length-2;i++){
      const p = last20.slice(i,i+2).join(',');
      patternCounts[p] = (patternCounts[p]||0)+1;
    }
    const mostCommon = Object.entries(patternCounts).sort((a,b)=>b[1]-a[1])[0];
    const isStablePattern = mostCommon && mostCommon[1] >= 3;

    if(streak>=3 && scoreDev<2.0 && !isStablePattern){
      bp = Math.max(bp-0.25, 0.1);
      reason = `[Theo Cầu] Chuỗi ${streak} ${currentResult} ổn định`;
    } else if(streak>=6){
      bp = Math.min(bp+0.3, 0.95);
      reason = `[Bẻ Cầu] Chuỗi ${streak} ${currentResult} quá dài`;
    } else if(streak>=3 && scoreDev>3.5){
      bp = Math.min(bp+0.25, 0.9);
      reason = `[Bẻ Cầu] Biến động điểm lớn (${scoreDev.toFixed(1)})`;
    } else if(isStablePattern && last5.every(r=>r===currentResult)){
      bp = Math.min(bp+0.2, 0.85);
      reason = `[Bẻ Cầu] Mẫu lặp ${mostCommon[0]}`;
    } else {
      bp = Math.max(bp-0.2, 0.1);
      reason = `[Theo Cầu] Không phát hiện mẫu bẻ`;
    }
    const prediction = bp>0.5 ? (currentResult==='Tài'?2:1) : (currentResult==='Tài'?1:2);
    return {prediction, breakProb:bp, reason};
  },

  trendAndProb(history){
    if(!history || history.length<3) return 0;
    const {streak, currentResult, breakProb} = Mrtinh.detectStreakAndBreak(history);
    if(streak>=3){
      if(breakProb>0.6) return currentResult==='Tài'?2:1;
      return currentResult==='Tài'?1:2;
    }
    const last15 = history.slice(-15).map(h=>h.result);
    if(!last15.length) return 0;
    const weights = last15.map((_,i)=>Math.pow(1.3,i));
    const tw = weights.reduce((s,w,i)=>s+(last15[i]==='Tài'?w:0),0);
    const xw = weights.reduce((s,w,i)=>s+(last15[i]==='Xỉu'?w:0),0);
    const total = tw+xw;
    const last10 = last15.slice(-10);
    const patterns = [];
    for(let i=0;i<=last10.length-4;i++) patterns.push(last10.slice(i,i+4).join(','));
    const pc = patterns.reduce((a,p)=>{a[p]=(a[p]||0)+1;return a;},{});
    const mc = Object.entries(pc).sort((a,b)=>b[1]-a[1])[0];
    if(mc && mc[1]>=3){
      const pattern = mc[0].split(',');
      return pattern[pattern.length-1] !== last10[last10.length-1] ? 1 : 2;
    } else if(total>0 && Math.abs(tw-xw)/total >= 0.25){
      return tw>xw ? 1 : 2;
    }
    return last15[last15.length-1]==='Xỉu' ? 1 : 2;
  },

  shortPattern(history){
    if(!history || history.length<3) return 0;
    const {streak, currentResult, breakProb} = Mrtinh.detectStreakAndBreak(history);
    if(streak>=2){
      if(breakProb>0.6) return currentResult==='Tài'?2:1;
      return currentResult==='Tài'?1:2;
    }
    const last8 = history.slice(-8).map(h=>h.result);
    if(!last8.length) return 0;
    const patterns = [];
    for(let i=0;i<=last8.length-2;i++) patterns.push(last8.slice(i,i+2).join(','));
    const pc = patterns.reduce((a,p)=>{a[p]=(a[p]||0)+1;return a;},{});
    const mc = Object.entries(pc).sort((a,b)=>b[1]-a[1])[0];
    if(mc && mc[1]>=2){
      const pattern = mc[0].split(',');
      return pattern[pattern.length-1] !== last8[last8.length-1] ? 1 : 2;
    }
    return last8[last8.length-1]==='Xỉu' ? 1 : 2;
  },

  meanDeviation(history){
    if(!history || history.length<3) return 0;
    const {streak, currentResult, breakProb} = Mrtinh.detectStreakAndBreak(history);
    if(streak>=2){
      if(breakProb>0.6) return currentResult==='Tài'?2:1;
      return currentResult==='Tài'?1:2;
    }
    const last12 = history.slice(-12).map(h=>h.result);
    if(!last12.length) return 0;
    const tc = last12.filter(r=>r==='Tài').length;
    const xc = last12.length - tc;
    const dev = Math.abs(tc-xc)/last12.length;
    if(dev<0.2) return last12[last12.length-1]==='Xỉu' ? 1 : 2;
    return xc>tc ? 1 : 2;
  },

  recentSwitch(history){
    if(!history || history.length<3) return 0;
    const {streak, currentResult, breakProb} = Mrtinh.detectStreakAndBreak(history);
    if(streak>=2){
      if(breakProb>0.6) return currentResult==='Tài'?2:1;
      return currentResult==='Tài'?1:2;
    }
    const last10 = history.slice(-10).map(h=>h.result);
    if(!last10.length) return 0;
    const sw = last10.slice(1).reduce((c,curr,idx)=>c+(curr!==last10[idx]?1:0),0);
    return last10[last10.length-1]==='Xỉu' ? 1 : 2;
  },

  isBadPattern(history){
    const last15 = history.slice(-15).map(h=>h.result);
    if(!last15.length) return false;
    const sw = last15.slice(1).reduce((c,curr,idx)=>c+(curr!==last15[idx]?1:0),0);
    const {streak} = Mrtinh.detectStreakAndBreak(history);
    return sw>=6 || streak>=7;
  },

  aiHtddLogic(history){
    if(!history || history.length<3){
      return {prediction: Math.random()<0.5?'Tài':'Xỉu', reason:'[AI] Dữ liệu ngắn', source:'AI HTDD'};
    }
    const recentHistory = history.slice(-5).map(h=>h.result);
    const recentScores = history.slice(-5).map(h=>h.totalScore||0);
    const tc = recentHistory.filter(r=>r==='Tài').length;
    const xc = recentHistory.filter(r=>r==='Xỉu').length;
    const {streak, currentResult} = Mrtinh.detectStreakAndBreak(history);

    if(streak>=2 && streak<=4){
      return {prediction: currentResult, reason:`[Theo Cầu] Chuỗi ${streak} ${currentResult}`, source:'AI HTDD'};
    }
    if(history.length>=3){
      const last3 = history.slice(-3).map(h=>h.result).join(',');
      if(last3==='Tài,Xỉu,Tài') return {prediction:'Xỉu', reason:'[Bẻ Cầu] Mẫu 1T1X', source:'AI HTDD'};
      if(last3==='Xỉu,Tài,Xỉu') return {prediction:'Tài', reason:'[Bẻ Cầu] Mẫu 1X1T', source:'AI HTDD'};
    }
    if(history.length>=4){
      const last4 = history.slice(-4).map(h=>h.result).join(',');
      if(last4==='Tài,Tài,Xỉu,Xỉu') return {prediction:'Tài', reason:'[Theo Cầu] Mẫu 2T2X', source:'AI HTDD'};
      if(last4==='Xỉu,Xỉu,Tài,Tài') return {prediction:'Xỉu', reason:'[Theo Cầu] Mẫu 2X2T', source:'AI HTDD'};
    }
    if(history.length>=7){
      const last7 = history.slice(-7).map(h=>h.result);
      if(last7.every(r=>r==='Xỉu')) return {prediction:'Tài', reason:'[Bẻ Cầu] Chuỗi 7 Xỉu', source:'AI HTDD'};
      if(last7.every(r=>r==='Tài')) return {prediction:'Xỉu', reason:'[Bẻ Cầu] Chuỗi 7 Tài', source:'AI HTDD'};
    }
    const avg = Stat.mean(recentScores);
    if(avg>11) return {prediction:'Tài', reason:`[AI] Điểm TB cao (${avg.toFixed(1)})`, source:'AI HTDD'};
    if(avg<7) return {prediction:'Xỉu', reason:`[AI] Điểm TB thấp (${avg.toFixed(1)})`, source:'AI HTDD'};
    if(tc>xc+1) return {prediction:'Xỉu', reason:`[Bẻ Cầu] Tài chiếm đa số (${tc}/5)`, source:'AI HTDD'};
    if(xc>tc+1) return {prediction:'Tài', reason:`[Bẻ Cầu] Xỉu chiếm đa số (${xc}/5)`, source:'AI HTDD'};
    const overallTai = history.filter(h=>h.result==='Tài').length;
    const overallXiu = history.filter(h=>h.result==='Xỉu').length;
    if(overallTai>overallXiu) return {prediction:'Xỉu', reason:'[Bẻ Cầu] Tổng thể Tài nhiều hơn', source:'AI HTDD'};
    return {prediction:'Tài', reason:'[Theo Cầu] Tổng thể Xỉu ≥ Tài', source:'AI HTDD'};
  }
};

/* ============================================================================
 * PART 2: THUẬT TOÁN sun.js (Markov + Pattern + Bayes + Hidden State)
 * ==========================================================================*/
const SunAlgo = {
  markovChain(seq, order){
    if(seq.length <= order) return null;
    const current = seq.slice(-order).join('');
    let tv = 0, xv = 0;
    for(let i=0;i<=seq.length-order-1;i++){
      const w = seq.slice(i,i+order).join('');
      if(w===current){
        const nxt = seq[i+order];
        if(nxt==='Tài') tv++;
        else if(nxt==='Xỉu') xv++;
      }
    }
    const tot = tv+xv;
    if(tot===0) return null;
    return {predict: tv>xv?'Tài':'Xỉu', confidence: Math.max(tv,xv)/tot};
  },

  patternMatching(seq){
    let longestLen = 0;
    let predict = null;
    let confidence = 0;
    const maxLen = Math.floor(seq.length/2);
    for(let len=maxLen; len>=3; len--){
      const target = seq.slice(-len).join('');
      const searchArea = seq.slice(0, seq.length-1).join('');
      const lastIdx = searchArea.lastIndexOf(target);
      if(lastIdx !== -1){
        const before = searchArea.substring(0, lastIdx);
        const matchArr = before.match(/Tài|Xỉu/g);
        const actualIdx = (matchArr ? matchArr.length : 0) + len;
        if(seq[actualIdx]){
          predict = seq[actualIdx];
          longestLen = len;
          confidence = Math.min(1, 0.8 + len*0.05);
          break;
        }
      }
    }
    if(!predict) return null;
    return {predict, confidence, longestLen};
  },

  bayesianPredict(seq){
    const recent3 = seq.slice(-3);
    let cT = 0, cX = 0;
    seq.forEach(k => k==='Tài' ? cT++ : cX++);
    if(!cT || !cX) return null;
    const pT = cT/seq.length;
    const pX = cX/seq.length;
    let cRGT = 0.1, cRGX = 0.1;
    for(let i=3; i<seq.length; i++){
      const match = seq[i-3]===recent3[0] && seq[i-2]===recent3[1] && seq[i-1]===recent3[2];
      if(match){
        if(seq[i]==='Tài') cRGT++; else cRGX++;
      }
    }
    const lT = cRGT/cT, lX = cRGX/cX;
    const uT = pT*lT, uX = pX*lX;
    if(uT===0 && uX===0) return null;
    return {predict: uT>uX?'Tài':'Xỉu', confidence: Math.max(uT,uX)/(uT+uX)};
  },

  hiddenStateAnalysis(seq){
    const recent10 = seq.slice(-10);
    let flips = 0;
    for(let i=1; i<recent10.length; i++){
      if(recent10[i] !== recent10[i-1]) flips++;
    }
    const last = seq[seq.length-1];
    if(flips>=6){
      return {predict: last==='Tài'?'Xỉu':'Tài', confidence: flips/10, type:'Choppy'};
    } else if(flips<=3){
      return {predict: last, confidence: (10-flips)/10, type:'Trending'};
    }
    return null;
  }
};

/* ============================================================================
 * PART 3: THUẬT TOÁN ai.py (Markov/Pattern/Bayes/HMM/LSTM)
 * ==========================================================================*/
const PyAlgo = {
  markovPy(seq, order=3){
    if(seq.length <= order) return null;
    const trans = {};
    for(let i=0; i<=seq.length-order-1; i++){
      const st = seq.slice(i,i+order).join('|');
      const nxt = seq[i+order];
      if(!trans[st]) trans[st] = {Tài:0, Xỉu:0};
      trans[st][nxt]++;
    }
    const ctx = seq.slice(-order).join('|');
    if(!trans[ctx]) return null;
    const {Tài:t, Xỉu:x} = trans[ctx];
    const tot = t+x;
    return {predict: t>x?'Tài':'Xỉu', confidence: Math.max(t,x)/tot};
  },

  patternPy(seq, maxLen=5){
    const len = Math.min(maxLen, seq.length);
    for(let l=len; l>=1; l--){
      const pat = seq.slice(-l);
      const matches = [];
      for(let i=0; i<=seq.length-l-1; i++){
        let ok = true;
        for(let j=0;j<l;j++) if(seq[i+j]!==pat[j]){ok=false;break;}
        if(ok) matches.push(seq[i+l]);
      }
      if(matches.length){
        const counts = {Tài:0, Xỉu:0};
        matches.forEach(m=>counts[m]++);
        const tot = matches.length;
        return {predict: counts.Tài>counts.Xỉu?'Tài':'Xỉu', confidence: Math.max(counts.Tài,counts.Xỉu)/tot};
      }
    }
    return null;
  },

  bayesPy(seq){
    const c0 = seq.filter(v=>v==='Xỉu').length + 1;
    const c1 = seq.filter(v=>v==='Tài').length + 1;
    const p1 = c1/(c0+c1);
    return {predict: p1>0.5?'Tài':'Xỉu', confidence: Math.max(p1, 1-p1)};
  },

  hmmPy(seq){
    if(seq.length < 5) return null;
    const recent = seq.slice(-8);
    let flips = 0;
    for(let i=1;i<recent.length;i++) if(recent[i]!==recent[i-1]) flips++;
    const isTrending = flips <= 3;
    let tranTrendT=0, tranTrendX=0, tranChopT=0, tranChopX=0;
    for(let i=8; i<seq.length; i++){
      const win = seq.slice(i-8, i);
      let f = 0;
      for(let j=1;j<win.length;j++) if(win[j]!==win[j-1]) f++;
      const trend = f <= 3;
      if(trend){
        if(seq[i]==='Tài') tranTrendT++; else tranTrendX++;
      } else {
        if(seq[i]==='Tài') tranChopT++; else tranChopX++;
      }
    }
    const predict = isTrending ? (tranTrendT>tranTrendX?'Tài':'Xỉu') : (tranChopT>tranChopX?'Tài':'Xỉu');
    const conf = isTrending 
      ? Math.max(tranTrendT, tranTrendX)/(tranTrendT+tranTrendX||1)
      : Math.max(tranChopT, tranChopX)/(tranChopT+tranChopX||1);
    return {predict, confidence: Math.max(0.5, conf)};
  },

  lstmPy(seq, lookback=5){
    if(seq.length < lookback+5) return null;
    const X = [], y = [];
    for(let i=lookback; i<seq.length; i++){
      X.push(seq.slice(i-lookback, i).map(v=>v==='Tài'?1:0));
      y.push(seq[i]==='Tài'?1:0);
    }
    if(X.length<5) return null;
    const w = new Array(lookback).fill(0);
    let b = 0;
    const lr = 0.15;
    for(let ep=0; ep<120; ep++){
      for(let i=0; i<X.length; i++){
        let z = b;
        for(let j=0; j<lookback; j++) z += w[j]*X[i][j];
        const p = 1/(1+Math.exp(-z));
        const err = y[i] - p;
        for(let j=0; j<lookback; j++) w[j] += lr*err*X[i][j];
        b += lr*err;
      }
    }
    const last = seq.slice(-lookback).map(v=>v==='Tài'?1:0);
    let z = b;
    for(let j=0;j<lookback;j++) z += w[j]*last[j];
    const p = 1/(1+Math.exp(-z));
    return {predict: p>0.5?'Tài':'Xỉu', confidence: Math.max(p, 1-p)};
  }
};

/* ============================================================================
 * PART 4: THUẬT TOÁN binh.js (Statistical + Mini + Main + Advanced)
 * ==========================================================================*/
const BinhAlgo = {
  miniAI(history){
    if(history.length<2){
      return {prediction: 0, confidence: 0, risk: 'high'};
    }
    const last = history[history.length-1];
    const prev = history[history.length-2];
    const dir = last.result !== prev.result ? 'flip' : 'same';
    const prediction = dir === 'flip' ? (last.result === 'Tài' ? 'Xỉu' : 'Tài') : last.result;
    const scoreChange = Math.abs((last.totalScore||0) - (prev.totalScore||0));
    const confidence = Math.min(0.85, 0.4 + scoreChange*0.03);
    return {prediction, confidence, risk: scoreChange>8?'high':scoreChange>4?'medium':'low'};
  },

  statisticalEngine(history){
    const points = history.map(h => h.totalScore || 0);
    const stats = {
      mean: Stat.mean(points),
      variance: Stat.variance(points),
      std: Stat.std(points),
      skewness: Stat.skewness(points),
      kurtosis: Stat.kurtosis(points)
    };
    const recent = history.slice(-10);
    const taiCount = recent.filter(h=>h.result==='Tài').length;
    let prediction = 'Tài';
    if(stats.mean > 11) prediction = 'Xỉu';
    else if(stats.mean < 8) prediction = 'Tài';
    else {
      if(taiCount > 6) prediction = 'Xỉu';
      else if(taiCount < 4) prediction = 'Tài';
      else prediction = history[history.length-1].result === 'Tài' ? 'Xỉu' : 'Tài';
    }
    const confidence = Math.min(0.9, 0.5 + Math.abs(stats.mean - 10.5) * 0.05 + Math.abs(stats.skewness) * 0.1);
    return {prediction, confidence, stats};
  },

  mainAI(history){
    const stat = BinhAlgo.statisticalEngine(history);
    const trend = Mrtinh.trendAndProb(history);
    const bridge = Mrtinh.smartBridgeBreak(history);
    const votes = {Tài:0, Xỉu:0};
    votes[stat.prediction] += 0.4 * stat.confidence;
    if(trend === 1) votes.Tài += 0.3; else if(trend === 2) votes.Xỉu += 0.3;
    if(bridge.prediction === 1) votes.Tài += 0.3 * bridge.breakProb; else if(bridge.prediction === 2) votes.Xỉu += 0.3 * bridge.breakProb;
    const prediction = votes.Tài >= votes.Xỉu ? 'Tài' : 'Xỉu';
    const confidence = Math.max(votes.Tài, votes.Xỉu) / (votes.Tài + votes.Xỉu + 0.001);
    return {prediction, confidence, votes};
  },

  advancedAI(history){
    if(history.length < 10) return {prediction: null, confidence: 0};
    const points = history.map(h=>h.totalScore||0);
    const recent = points.slice(-6);
    const avgRecent = Stat.mean(recent);
    const lastPoint = recent[recent.length-1];
    const deviation = lastPoint - avgRecent;
    let prediction;
    if(lastPoint > 14) prediction = 'Xỉu';
    else if(lastPoint < 6) prediction = 'Tài';
    else if(deviation > 3) prediction = 'Xỉu';
    else if(deviation < -3) prediction = 'Tài';
    else prediction = history[history.length-1].result === 'Tài' ? 'Xỉu' : 'Tài';
    const confidence = Math.min(0.85, 0.45 + Math.abs(deviation)*0.06);
    return {prediction, confidence};
  }
};

/* ============================================================================
 * PART 5: THUẬT TOÁN vip.js (Smart Trading signals adapted)
 * ==========================================================================*/
const VipAlgo = {
  analyze(history){
    if(history.length < 10) return {prediction: null, confidence: 0};
    const points = history.map(h=>h.totalScore||0);
    const closes = points;
    const sma5 = Stat.mean(closes.slice(-5));
    const sma10 = Stat.mean(closes.slice(-10));
    const momentum = closes.slice(-3).reduce((s,v)=>s+v,0)/3 - closes.slice(-6,-3).reduce((s,v)=>s+v,0)/3;
    let signals = [];
    if(sma5 > sma10 && momentum > 0) signals.push({type:'LONG_TREND', strength:0.8});
    if(sma5 < sma10 && momentum < 0) signals.push({type:'SHORT_TREND', strength:0.8});
    const gains = [], losses = [];
    for(let i=1; i<Math.min(15, closes.length); i++){
      const d = closes[closes.length-i] - closes[closes.length-i-1];
      if(d>0) gains.push(d); else losses.push(-d);
    }
    const avgG = Stat.mean(gains)||0;
    const avgL = Stat.mean(losses)||0;
    const rs = avgG / (avgL || 0.001);
    const rsi = 100 - 100/(1+rs);
    if(rsi < 30) signals.push({type:'LONG_REVERSAL', strength:0.7});
    if(rsi > 70) signals.push({type:'SHORT_REVERSAL', strength:0.7});
    const last = closes[closes.length-1];
    const prev = closes[closes.length-2];
    const change = Math.abs(last - prev);
    if(change < 3 && Math.abs(rsi-50) < 20){
      signals.push({type: last>sma5?'SHORT_BRIDGE':'LONG_BRIDGE', strength:0.6});
    }
    if(!signals.length) return {prediction: null, confidence: 0};
    signals.sort((a,b)=>b.strength - a.strength);
    const best = signals[0];
    let prediction;
    if(best.type.includes('LONG')) prediction = 'Tài';
    else prediction = 'Xỉu';
    return {prediction, confidence: best.strength, signal: best.type};
  }
};

/* ============================================================================
 * PART 6: BAYESIAN SUN VOTING ENGINE (ttoan sun.js)
 * ==========================================================================*/
const SunEngine = {
  predict(history, modelPredictions){
    if(!history || history.length < 5) return {prediction: 'Tài', confidence: 0.5, votes: []};
    const seq = history.map(h => h.result);
    let scoreTai = 0, scoreXiu = 0;
    const votes = [];

    const addVote = (name, predict, weight, conf) => {
      if(!predict) return;
      const s = weight * conf;
      if(predict === 'Tài') scoreTai += s; else scoreXiu += s;
      votes.push({name, predict, weight, confidence: conf, score: s});
    };

    for(let i=2; i<=5; i++){
      const mk = SunAlgo.markovChain(seq, i);
      if(mk) addVote(`Markov Bậc ${i}`, mk.predict, i*1.5, mk.confidence);
    }
    const pm = SunAlgo.patternMatching(seq);
    if(pm) addVote(`Pattern (L=${pm.longestLen})`, pm.predict, 4.0, pm.confidence);
    const bp = SunAlgo.bayesianPredict(seq);
    if(bp) addVote('Naive Bayes', bp.predict, 2.0, bp.confidence);
    const hs = SunAlgo.hiddenStateAnalysis(seq);
    if(hs) addVote(`HiddenState (${hs.type})`, hs.predict, 2.5, hs.confidence);

    const prediction = scoreTai > scoreXiu ? 'Tài' : 'Xỉu';
    const confidence = Math.max(scoreTai, scoreXiu) / (scoreTai + scoreXiu + 0.001);
    return {prediction, confidence, votes: votes.map(v => ({...v, engine:'Sun'})), scoreTai, scoreXiu};
  }
};

/* ============================================================================
 * PART 7: PYTHON ENSEMBLE ENGINE (ttoan ai.py)
 * ==========================================================================*/
const PyEngine = {
  predict(history){
    if(!history || history.length < 10) return {prediction: null, confidence: 0, votes: []};
    const seq = history.map(h => h.result);
    const weights = {'Markov': 1.0, 'Pattern': 1.0, 'Bayes': 0.5, 'HMM': 1.2, 'LSTM': 1.5};
    const votes = {Tài:0, Xỉu:0};
    const details = [];

    const addV = (name, res) => {
      if(!res) return;
      const w = weights[name];
      votes[res.predict] += w * res.confidence;
      details.push({name: name+' (Py)', predict: res.predict, confidence: res.confidence, weight: w, engine:'Py'});
    };

    addV('Markov', PyAlgo.markovPy(seq, 3));
    addV('Pattern', PyAlgo.patternPy(seq, 4));
    addV('Bayes', PyAlgo.bayesPy(seq));
    addV('HMM', PyAlgo.hmmPy(seq));
    addV('LSTM', PyAlgo.lstmPy(seq, 5));

    const prediction = votes.Tài > votes.Xỉu ? 'Tài' : 'Xỉu';
    const confidence = Math.max(votes.Tài, votes.Xỉu) / (votes.Tài + votes.Xiu + 0.001);
    return {prediction, confidence, votes: details};
  }
};

/* ============================================================================
 * MAIN ENGINE — TỔNG HỢP TẤT CẢ THUẬT TOÁN + ĐẢO NGƯỢC KẾT QUẢ
 * ==========================================================================*/
const Engine = {
  // Hàm đảo ngược kết quả
  reverse(pred){
    if(pred === 'Tài') return 'Xỉu';
    if(pred === 'Xỉu') return 'Tài';
    return pred;
  },

  predict(history, modelPredictions){
    if(!history || history.length < 5){
      const r = Math.random() < 0.5 ? 'Tài' : 'Xỉu';
      const reversed = Engine.reverse(r);
      return {
        prediction: reversed,
        originalPrediction: r,
        confidence: 0.5,
        votes: [{name:'Random (không đủ dữ liệu)', predict:r, confidence:0.5, engine:'System'}],
        reason: 'Không đủ dữ liệu để phân tích (đã đảo kết quả)',
        reversed: true
      };
    }

    const allVotes = [];
    const seq = history.map(h=>h.result);

    // ---- mrtinh.js ----
    const trend = Mrtinh.trendAndProb(history);
    const short = Mrtinh.shortPattern(history);
    const mean = Mrtinh.meanDeviation(history);
    const sw = Mrtinh.recentSwitch(history);
    const bridge = Mrtinh.smartBridgeBreak(history);
    const aiHt = Mrtinh.aiHtddLogic(history);

    allVotes.push({name:'Trend & Prob (mrtinh)', predict: trend===1?'Tài':trend===2?'Xỉu':null, weight:0.9, confidence:0.7, engine:'mrtinh'});
    allVotes.push({name:'Short Pattern (mrtinh)', predict: short===1?'Tài':short===2?'Xỉu':null, weight:0.85, confidence:0.7, engine:'mrtinh'});
    allVotes.push({name:'Mean Deviation (mrtinh)', predict: mean===1?'Tài':mean===2?'Xỉu':null, weight:0.75, confidence:0.65, engine:'mrtinh'});
    allVotes.push({name:'Recent Switch (mrtinh)', predict: sw===1?'Tài':sw===2?'Xỉu':null, weight:0.7, confidence:0.6, engine:'mrtinh'});
    allVotes.push({name:'Smart Bridge (mrtinh)', predict: bridge.prediction===1?'Tài':bridge.prediction===2?'Xỉu':null, weight:1.2, confidence:bridge.breakProb, engine:'mrtinh'});
    allVotes.push({name:'AI HTDD (mrtinh)', predict: aiHt.prediction, weight:1.0, confidence:0.75, engine:'mrtinh'});

    // ---- sun.js ----
    const sunRes = SunEngine.predict(history, modelPredictions);
    allVotes.push(...sunRes.votes);

    // ---- ai.py ----
    const pyRes = PyEngine.predict(history);
    if(pyRes.votes) allVotes.push(...pyRes.votes);

    // ---- binh.js ----
    const mini = BinhAlgo.miniAI(history);
    allVotes.push({name:'Mini AI (binh)', predict: mini.prediction, weight:0.7, confidence: mini.confidence, engine:'binh'});

    const statE = BinhAlgo.statisticalEngine(history);
    allVotes.push({name:'Statistical Engine (binh)', predict: statE.prediction, weight:0.9, confidence: statE.confidence, engine:'binh'});

    const mainAI = BinhAlgo.mainAI(history);
    allVotes.push({name:'Main AI (binh)', predict: mainAI.prediction, weight:1.1, confidence: mainAI.confidence, engine:'binh'});

    const advAI = BinhAlgo.advancedAI(history);
    if(advAI.prediction) allVotes.push({name:'Advanced AI (binh)', predict: advAI.prediction, weight:1.0, confidence: advAI.confidence, engine:'binh'});

    // ---- vip.js ----
    const vipRes = VipAlgo.analyze(history);
    if(vipRes.prediction) allVotes.push({name:'Smart Trading (vip)', predict: vipRes.prediction, weight:1.1, confidence: vipRes.confidence, engine:'vip'});

    // ---- TỔNG HỢP (TRƯỚC KHI ĐẢO) ----
    let taiScore = 0, xiuScore = 0;
    allVotes.forEach(v => {
      if(!v.predict) return;
      const s = (v.weight || 1) * (v.confidence || 0.5);
      if(v.predict === 'Tài') taiScore += s;
      else if(v.predict === 'Xỉu') xiuScore += s;
    });

    if(Mrtinh.isBadPattern(history)){
      taiScore *= 0.9;
      xiuScore *= 0.9;
    }

    const last10 = history.slice(-10).map(h=>h.result);
    const tc10 = last10.filter(r=>r==='Tài').length;
    if(tc10 >= 7) xiuScore += 0.15;
    else if(tc10 <= 3) taiScore += 0.15;

    if(bridge.breakProb > 0.6){
      if(bridge.prediction === 1) taiScore += 0.25;
      else xiuScore += 0.25;
    }

    // Kết quả gốc (trước khi đảo)
    const originalPrediction = taiScore >= xiuScore ? 'Tài' : 'Xỉu';
    const total = taiScore + xiuScore + 0.001;
    const originalConfidence = Math.max(taiScore, xiuScore) / total;

    // ========================================================
    // 🔄 ĐẢO NGƯỢC KẾT QUẢ DỰ ĐOÁN
    // ========================================================
    const prediction = Engine.reverse(originalPrediction);
    const confidence = originalConfidence; // Giữ nguyên độ tin cậy

    // Đảo ngược luôn votes để hiển thị đồng bộ
    const normVotes = allVotes.map(v => ({
      name: v.name,
      predict: v.predict,
      confidence: v.confidence,
      weight: v.weight,
      engine: v.engine,
      score: v.predict ? (v.weight||1)*(v.confidence||0.5) : 0
    }));

    // Lý do
    const reasons = [];
    reasons.push(`🔄 <b>REVERSED</b>: gốc ${originalPrediction} → đảo ${prediction}`);
    reasons.push(`📊 Điểm gốc: TÀI ${taiScore.toFixed(2)} | XỈU ${xiuScore.toFixed(2)}`);
    if(bridge.reason) reasons.push(`🌉 ${bridge.reason}`);
    if(aiHt.reason) reasons.push(`🤖 ${aiHt.reason}`);
    if(mini.prediction) reasons.push(`⚡ Mini AI: ${mini.prediction} (${(mini.confidence*100).toFixed(0)}%)`);
    reasons.push(`📈 Statistical: mean=${statE.stats.mean.toFixed(1)}, skew=${statE.stats.skewness.toFixed(2)}`);

    return {
      prediction,
      originalPrediction,
      confidence,
      votes: normVotes,
      reason: reasons.join(' • '),
      taiScore,
      xiuScore,
      reversed: true
    };
  }
};

// --- Adapter dữ liệu API gốc ---
async function fetchSource() {
  const response = await fetch(SOURCE_API, {
    headers: { accept: 'application/json', 'user-agent': 'Denius-MD5LC/1.0' },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`API gốc trả HTTP ${response.status}`);
  const data = await response.json();
  if (!data || !Array.isArray(data.list)) {
    throw new Error('Cấu trúc API gốc không có data.list như file HTML mong đợi');
  }
  return data.list.map(s => ({
    id: Number(s.id),
    result: s.resultTruyenThong === 'TAI' ? 'Tài' :
      s.resultTruyenThong === 'XIU' ? 'Xỉu' : null,
    totalScore: Number(s.point) || 0,
    dices: Array.isArray(s.dices) ? s.dices : []
  })).filter(s => Number.isFinite(s.id) && s.result);
}

let cache = { updatedAt: null, sessions: [], error: null };
let predictionLog = new Map();

function analyze(sessions) {
  const history = sessions.slice().sort((a, b) => a.id - b.id)
    .map(s => ({ result: s.result, totalScore: s.totalScore, session: s.id }));
  if (history.length < 5) {
    return { prediction: null, confidence: 0, reason: 'Chưa đủ 5 phiên lịch sử hợp lệ' };
  }
  return Engine.predict(history, {});
}

function makeRows(sessions) {
  const ordered = sessions.slice().sort((a, b) => a.id - b.id);
  const rows = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const actual = ordered[i + 1];
    const saved = predictionLog.get(actual.id);
    if (saved) {
      rows.push({
        Phien: actual.id,
        Du_doan: saved.prediction,
        Do_tin_cay: `${Math.round(saved.confidence * 100)}%`,
        KetQua: saved.prediction === actual.result ? '✅ ĐÚNG' : '❌ SAI',
        ADMIN
      });
    }
  }
  const latest = ordered[ordered.length - 1];
  const pred = analyze(ordered);
  if (latest && pred.prediction) {
    const targetSession = latest.id + 1;
    predictionLog.set(targetSession, {
      prediction: pred.prediction,
      confidence: pred.confidence,
      reason: pred.reason
    });
    rows.push({
      Phien: targetSession,
      Du_doan: pred.prediction,
      Do_tin_cay: `${Math.round(pred.confidence * 100)}%`,
      ADMIN
    });
  }
  while (predictionLog.size > MAX_HISTORY) {
    predictionLog.delete(predictionLog.keys().next().value);
  }
  return rows.sort((a, b) => b.Phien - a.Phien);
}

async function refresh() {
  try {
    cache.sessions = (await fetchSource()).slice(0, MAX_HISTORY);
    cache.updatedAt = new Date().toISOString();
    cache.error = null;
    return true;
  } catch (error) {
    cache.error = error.message;
    return false;
  }
}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '32kb' }));

app.get('/', (_req, res) => res.json({
  name: 'Denius MD5LC API',
  status: cache.error ? 'degraded' : 'ready',
  endpoints: ['/api/predict', '/api/history', '/health'],
  admin: ADMIN,
  note: 'Dự đoán thống kê không đảm bảo kết quả trò chơi ngẫu nhiên.'
}));

app.get('/health', (_req, res) => res.status(cache.error && !cache.sessions.length ? 503 : 200).json({
  ok: !cache.error,
  source: SOURCE_API,
  updatedAt: cache.updatedAt,
  historyCount: cache.sessions.length,
  error: cache.error
}));

app.get('/api/predict', async (_req, res) => {
  if (!cache.sessions.length || Date.now() - Date.parse(cache.updatedAt || 0) > POLL_MS) {
    await refresh();
  }
  if (!cache.sessions.length) {
    return res.status(502).json({ error: 'Không lấy được dữ liệu từ API gốc', detail: cache.error, ADMIN });
  }
  const rows = makeRows(cache.sessions);
  res.set('Cache-Control', 'no-store');
  res.json(rows);
});

app.get('/api/history', async (req, res) => {
  if (!cache.sessions.length || Date.now() - Date.parse(cache.updatedAt || 0) > POLL_MS) await refresh();
  if (!cache.sessions.length) {
    return res.status(502).json({ error: 'Không lấy được lịch sử từ API gốc', detail: cache.error, ADMIN });
  }
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  res.set('Cache-Control', 'no-store');
  res.json(cache.sessions.slice(0, limit).map(s => ({
    Phien: s.id, KetQua: s.result, Diem: s.totalScore, XucXac: s.dices
  })));
});

// Warm cache and refresh periodically; API requests also refresh if stale.
refresh().finally(() => {});
setInterval(refresh, POLL_MS).unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Denius MD5LC API listening on ${PORT}`);
});

module.exports = { app, Engine, fetchSource, analyze };
