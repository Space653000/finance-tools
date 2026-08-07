/**
 * Stephen AI Finance ｜ ETF 工具　計算引擎（正式程式，index.html 與 harness.js 共用）
 * 純函式、無副作用、瀏覽器與 Node 皆可載入。
 * 本檔為「上線的那份程式」，驗證(harness.js)直接載入此檔測試。
 *
 * 時間模型：每一期給一個 price（還原權息價）與 day（距起始日的天數）。
 * 投資動作發生在每一期的 price。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // Node
  if (typeof window !== "undefined") window.ETFEngine = api;                 // Browser
})(this, function () {
  "use strict";

  // ---- 基礎統計 ----
  function mean(a){ let s=0; for(const x of a) s+=x; return s/a.length; }
  function sampleStd(a){ // 樣本標準差 (n-1)
    if(a.length<2) return 0;
    const m=mean(a); let s=0; for(const x of a) s+=(x-m)*(x-m);
    return Math.sqrt(s/(a.length-1));
  }

  // ---- 期報酬序列（時間加權，標的本身） ----
  function periodReturns(prices){
    const r=[];
    for(let i=1;i<prices.length;i++) r.push(prices[i]/prices[i-1]-1);
    return r;
  }

  // ---- 年化波動度 ----
  function annualizedVol(prices, periodsPerYear){
    return sampleStd(periodReturns(prices)) * Math.sqrt(periodsPerYear);
  }

  // ---- 標的價格 CAGR（時間加權） ----
  function priceCAGR(prices, days){
    const years=(days[days.length-1]-days[0])/365;
    if(years<=0) return 0;
    return Math.pow(prices[prices.length-1]/prices[0], 1/years)-1;
  }

  // ---- 最大回撤（用價格/淨值序列） ----
  function maxDrawdown(prices){
    let peak=prices[0], mdd=0;
    for(const p of prices){
      if(p>peak) peak=p;
      const dd=p/peak-1;
      if(dd<mdd) mdd=dd;
    }
    return mdd; // 負值
  }

  // ---- 夏普值 ----
  function sharpe(cagr, vol, rf){
    if(vol===0) return 0;
    return (cagr-rf)/vol;
  }

  // ---- XIRR（money-weighted，二分法保證收斂與可重現） ----
  function npv(rate, cfs){ // cfs: [{day, amt}]
    let s=0;
    for(const c of cfs) s += c.amt / Math.pow(1+rate, c.day/365);
    return s;
  }
  function xirr(cfs){
    // 需一負一正才有根
    let lo=-0.9999, hi=100.0;
    let flo=npv(lo,cfs), fhi=npv(hi,cfs);
    if(flo*fhi>0) return NaN;
    for(let i=0;i<200;i++){
      const mid=(lo+hi)/2, fm=npv(mid,cfs);
      if(Math.abs(fm)<1e-12){ return mid; }
      if(flo*fm<0){ hi=mid; fhi=fm; } else { lo=mid; flo=fm; }
    }
    return (lo+hi)/2;
  }

  // ---- 加碼倍率（依訊號 z 值查表） ----
  // table: [{max, m}] 由小到大；z<=max 取對應 m；預設見規格書 §1.3
  const DEFAULT_ADD_TABLE = [
    {max:-2, m:3.0},{max:-1, m:2.0},{max:0, m:1.5},
    {max:1, m:1.0},{max:2, m:0.5},{max:Infinity, m:0.0}
  ];
  function multiplierForZ(z, table){
    const t=table||DEFAULT_ADD_TABLE;
    for(const row of t){ if(z<=row.max) return row.m; }
    return 0;
  }

  // ---- 核心：一次投入序列 → 指標 ----
  // contributions[i] = 第 i 期投入金額；prices[i] 該期價；days[i] 該期天數
  function runContributions(prices, days, contributions){
    let shares=0, cost=0;
    const cfs=[];
    for(let i=0;i<prices.length;i++){
      const c=contributions[i]||0;
      if(c>0){
        shares += c/prices[i];
        cost   += c;
        cfs.push({day:days[i], amt:-c});
      }
    }
    const value = shares*prices[prices.length-1];
    cfs.push({day:days[days.length-1], amt:value});
    const avgCost = shares>0 ? cost/shares : 0;
    const totalReturn = cost>0 ? value/cost-1 : 0;
    return { shares, cost, value, avgCost, totalReturn, xirr: xirr(cfs) };
  }

  // ---- 三種投入法 ----
  function dca(prices, days, amountPerPeriod){
    const c = prices.map(()=>amountPerPeriod);
    return runContributions(prices, days, c);
  }
  function lumpSum(prices, days, principal){
    const c = prices.map((_,i)=> i===0 ? principal : 0);
    return runContributions(prices, days, c);
  }
  // 指標驅動智能加碼：baseAmount × multiplier(z_i)
  function smartAdd(prices, days, baseAmount, zscores, table){
    const c = prices.map((_,i)=> baseAmount * multiplierForZ(zscores[i], table));
    const out = runContributions(prices, days, c);
    out.contributions = c;
    return out;
  }

  // ---- 樂活五線譜 z 值序列（給智能加碼用） ----
  // 對每一期，取「往回 window 期」做價格對時間的線性回歸，
  // 算現價相對趨勢線的標準差倍數 z=(P-趨勢線)/殘差SD。歷史不足(min 12)回 0(中性)。
  function regressionZScores(prices, window, minN){
    const W = window || 42;   // 3.5 年（月頻）
    const MIN = minN || 12;
    const z = [];
    for(let i=0;i<prices.length;i++){
      const start = Math.max(0, i-W+1);
      const seg = prices.slice(start, i+1);
      const n = seg.length;
      if(n < MIN){ z.push(0); continue; }
      // x = 0..n-1
      let sx=0, sy=0, sxx=0, sxy=0;
      for(let k=0;k<n;k++){ sx+=k; sy+=seg[k]; sxx+=k*k; sxy+=k*seg[k]; }
      const denom = n*sxx - sx*sx;
      const slope = denom===0 ? 0 : (n*sxy - sx*sy)/denom;
      const intercept = (sy - slope*sx)/n;
      // 殘差樣本標準差
      let ss=0;
      for(let k=0;k<n;k++){ const e=seg[k]-(intercept+slope*k); ss+=e*e; }
      const sd = n>1 ? Math.sqrt(ss/(n-1)) : 0;
      const predNow = intercept + slope*(n-1);
      z.push(sd===0 ? 0 : (seg[n-1]-predNow)/sd);
    }
    return z;
  }

  // ======== 稅費匯後真實淨報酬引擎（護城河） ========
  // 說明：用「未還原價 rawPrices + 每期每股配息 divPerShare」計算，才能把
  //       資本利得（價差）與股利分開，並對股利正確課稅。
  //       內扣費用：歷史未還原價已含（NAV 每日扣除），故歷史模式不重複扣；
  //       僅在「假設報酬率」的前瞻模式才另扣（本函式的 expenseRate 預設 0，供前瞻用）。
  //
  // 股利稅（單筆事件近似，跨年彙總為簡化，需擁有者階段4驗算）：
  //  - 境內 domestic：應稅股利 = 配息 × c54ratio（54C 佔比）；
  //      合併：max(0, 應稅×邊際稅率 − min(應稅×8.5%, 8萬))；分離：應稅×28%；取低。
  //      二代健保：應稅 ≥ 2萬 → ×2.11%。
  //  - 境外 foreign_us：配息×30%；foreign_ie（愛爾蘭）：配息×15%。
  function dividendTax(gross, o){
    o = o||{};
    const market = o.market || "domestic";
    if(market === "foreign_us") return gross * 0.30;
    if(market === "foreign_ie") return gross * 0.15;
    // domestic
    const c54 = (o.c54ratio==null?1:o.c54ratio);
    const taxable = gross * c54;
    const mr = (o.marginalRate==null?0.05:o.marginalRate);
    const combined = Math.max(0, taxable*mr - Math.min(taxable*0.085, 80000));
    const separate = taxable*0.28;
    let tax = Math.min(combined, separate);
    if(o.nhiEnabled && taxable >= 20000) tax += taxable*0.0211;
    return tax;
  }

  // 主計算：回傳稅前 vs 稅後、資本利得 vs 股利拆解
  function netReturnRun(rawPrices, days, divPerShare, contributions, o){
    o = o||{};
    const fee = (o.feeRate==null?0:o.feeRate);      // 手續費率（買進）
    const exp = (o.expenseRate==null?0:o.expenseRate); // 前瞻模式才用（每期）
    const reinvest = o.reinvest!==false;             // 股利再投入（預設true）
    const n = rawPrices.length;
    // 兩條路徑：稅後(net) 與 稅前(gross) 平行跑，凸顯稅費差距
    let shN=0, shG=0, cost=0, cashN=0, cashG=0, taxTotal=0, divGrossTotal=0;
    let contribShares=0; // 純由「投入本金」買到的股數（估資本利得基礎）
    for(let i=0;i<n;i++){
      const c = contributions[i]||0;
      if(c>0){
        const net = c*(1-fee);
        const add = net/rawPrices[i];
        shN += add; shG += add; contribShares += add; cost += c;
      }
      const dps = (divPerShare&&divPerShare[i])||0;
      if(dps>0){
        const grossN = shN*dps, grossG = shG*dps;
        divGrossTotal += grossG;
        const tax = dividendTax(grossN, o);
        taxTotal += tax;
        const netDiv = grossN - tax;
        if(reinvest){ shN += netDiv/rawPrices[i]; shG += grossG/rawPrices[i]; }
        else { cashN += netDiv; cashG += grossG; }
      }
      if(exp>0){ shN *= (1-exp); shG *= (1-exp); } // 前瞻模式的費用侵蝕
    }
    const P = rawPrices[n-1];
    const valueNet = shN*P + cashN;
    const valueGross = shG*P + cashG;
    // 匯率：全部台幣化（美元標的用 fxStart/fxEnd 情境；預設 1）
    const fx = (o.fxEnd==null?1:o.fxEnd);
    const valueNetTWD = valueNet*fx, valueGrossTWD = valueGross*fx, costTWD = cost*(o.fxAvg==null?fx:o.fxAvg);
    // 拆解（近似）：資本利得 = 投入本金買到的股數×期末價 − 成本；股利部分 = 其餘
    const capitalGain = contribShares*P - cost;
    return {
      valueNet: valueNetTWD, valueGross: valueGrossTWD, cost: costTWD,
      totalReturnNet: costTWD>0 ? valueNetTWD/costTWD-1 : 0,
      totalReturnGross: costTWD>0 ? valueGrossTWD/costTWD-1 : 0,
      taxTotal: taxTotal*fx, divGross: divGrossTotal*fx,
      taxDrag: (valueGrossTWD-valueNetTWD),           // 稅費匯吃掉多少
      capitalGain: capitalGain*fx,
      sharesNet: shN, sharesGross: shG,
    };
  }

  // ======== 蒙地卡羅（存活率／分布，非點估計） ========
  // 固定種子可重現。回傳終值分位與達標成功率。
  function mulberry32(a){
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function percentile(sortedArr, p){
    if(!sortedArr.length) return 0;
    const idx = Math.min(sortedArr.length-1, Math.max(0, Math.round((p/100)*(sortedArr.length-1))));
    return sortedArr[idx];
  }
  // o: {monthlyMean, monthlyVol, months, contrib(每月), lump0, N, seed, target}
  function monteCarlo(o){
    const mm = o.monthlyMean, mv = o.monthlyVol, months = o.months|0;
    const contrib = o.contrib||0, lump0 = o.lump0||0, N = o.N||10000, target = o.target||0;
    const rng = mulberry32((o.seed==null?12345:o.seed)>>>0);
    const finals = new Array(N); let success = 0, sum = 0;
    for(let k=0;k<N;k++){
      let v = lump0;
      for(let m=0;m<months;m++){
        // Box-Muller
        let u1 = rng(); if(u1 < 1e-12) u1 = 1e-12; const u2 = rng();
        const z = Math.sqrt(-2*Math.log(u1)) * Math.cos(2*Math.PI*u2);
        const r = mm + mv*z;
        v = v*(1+r) + contrib;
      }
      finals[k] = v; sum += v; if(v >= target) success++;
    }
    finals.sort((a,b)=>a-b);
    return {
      p5:percentile(finals,5), p25:percentile(finals,25), p50:percentile(finals,50),
      p75:percentile(finals,75), p95:percentile(finals,95),
      mean:sum/N, successRate:success/N, N
    };
  }

  // ======== 投資組合：權重統計與最佳配置掃描 ========
  // assetRets: 各資產「對齊後的月報酬序列」陣列；weights: 權重(和=1)
  function portfolioStats(assetRets, weights, rf){
    const A = assetRets.length, n = assetRets[0].length;
    const port = new Array(n).fill(0);
    for(let a=0;a<A;a++){ const w=weights[a]; const r=assetRets[a]; for(let i=0;i<n;i++) port[i]+=w*r[i]; }
    let cum=1; for(const r of port) cum*=(1+r);
    const annRet = n>0 ? Math.pow(cum, 12/n)-1 : 0;
    const vol = sampleStd(port)*Math.sqrt(12);
    const sharpe = vol===0 ? 0 : (annRet-(rf==null?0.015:rf))/vol;
    return { annRet, vol, sharpe };
  }
  // 單純形權重掃描（step 預設 5%）→ 各風險屬性最佳配置
  function portfolioSweep(assetRets, rf, stepPct){
    const A = assetRets.length, step=(stepPct||5)/100, steps=Math.round(1/step);
    const results=[];
    const w=new Array(A).fill(0);
    (function rec(idx, remaining){
      if(idx===A-1){ w[idx]=remaining*step; results.push({w:w.slice(), ...portfolioStats(assetRets,w,rf)}); return; }
      for(let k=0;k<=remaining;k++){ w[idx]=k*step; rec(idx+1, remaining-k); }
    })(0, steps);
    const arr=a=>results.map(r=>r[a]);
    const rMin=Math.min(...arr("annRet")),rMax=Math.max(...arr("annRet"));
    const vMin=Math.min(...arr("vol")),vMax=Math.max(...arr("vol"));
    const sMin=Math.min(...arr("sharpe")),sMax=Math.max(...arr("sharpe"));
    const nrm=(x,mn,mx)=>mx>mn?(x-mn)/(mx-mn):0.5;
    for(const r of results) r.score=nrm(r.annRet,rMin,rMax)*0.4+nrm(r.sharpe,sMin,sMax)*0.4+(1-nrm(r.vol,vMin,vMax))*0.2;
    const top=(a,desc)=>results.reduce((b,r)=>((desc?r[a]>b[a]:r[a]<b[a])?r:b));
    return {
      count:results.length,
      aggressive: top("annRet",true),   // 積極：報酬最高
      conservative: top("vol",false),   // 保守：波動最低
      balanced: top("sharpe",true),     // 穩健：夏普最高
      optimal: top("score",true),       // 完美：綜合分數最高
      retRange:[rMin,rMax], volRange:[vMin,vMax], shpRange:[sMin,sMax]
    };
  }

  // 蒙地卡羅「逐年分位」：用於未來預估扇形圖（悲觀p5/中位p50/樂觀p95 每年一點）
  function monteCarloBands(o){
    const mm=o.monthlyMean, mv=o.monthlyVol, months=o.months|0, contrib=o.contrib||0, lump0=o.lump0||0, N=o.N||2000;
    const years=Math.max(1, Math.ceil(months/12));
    const rng=mulberry32((o.seed==null?12345:o.seed)>>>0);
    const snaps=[]; for(let y=0;y<=years;y++) snaps.push(new Array(N));
    for(let k=0;k<N;k++){
      let v=lump0, mth=0; snaps[0][k]=v;
      for(let y=1;y<=years;y++){
        const mEnd=Math.min(months, y*12);
        for(; mth<mEnd; mth++){
          let u1=rng(); if(u1<1e-12) u1=1e-12; const u2=rng();
          const z=Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);
          v=v*(1+mm+mv*z)+contrib;
        }
        snaps[y][k]=v;
      }
    }
    const p5=[],p50=[],p95=[];
    for(let y=0;y<=years;y++){ const s=snaps[y].slice().sort((a,b)=>a-b); p5.push(percentile(s,5)); p50.push(percentile(s,50)); p95.push(percentile(s,95)); }
    return {years, p5, p50, p95};
  }

  // ---- 綜合指標（含風險） ----
  function metrics(prices, days, periodsPerYear, rf){
    const cagr = priceCAGR(prices, days);
    const vol  = annualizedVol(prices, periodsPerYear);
    return {
      priceCAGR: cagr,
      vol,
      mdd: maxDrawdown(prices),
      sharpe: sharpe(cagr, vol, rf==null?0.015:rf),
    };
  }

  return {
    mean, sampleStd, periodReturns, annualizedVol, priceCAGR, maxDrawdown,
    sharpe, npv, xirr, multiplierForZ, runContributions, regressionZScores,
    dca, lumpSum, smartAdd, metrics, DEFAULT_ADD_TABLE,
    dividendTax, netReturnRun, monteCarlo, monteCarloBands, mulberry32,
    portfolioStats, portfolioSweep,
  };
});
