/**
 * Stephen AI Finance ｜ 房貸試算工具　計算引擎（正式程式，index.html 與 harness.js 共用）
 * 純函式、無副作用、瀏覽器與 Node 皆可載入。此檔為「上線的那份程式」，
 * 驗證(harness.js)直接載入此檔測試；改計算核心必同步升級 verify/。
 *
 * 時間模型：以「月」為期。第 t 期(t=1..N)期初餘額 B[t-1]，利息 I=B*i，還本 R，
 * 月付 M=I+R，期末餘額 B[t]=B[t-1]-R，B[0]=P。利率可分段(segments)。
 * 對應規格：docs/房貸開發計劃書_階段1_公式與規格.md
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // Node
  if (typeof window !== "undefined") window.MortgageEngine = api;            // Browser
})(this, function () {
  "use strict";

  const round2 = x => Math.round(x * 100) / 100;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---- 月利率序列：把「利率結構」展開成每一期(1..N)的月利率 ----
  // rateSpec:
  //   { type:"single", rate: 2.1 }
  //   { type:"segments", segments:[{months:24, rate:1.775},{months:336, rate:2.1}] }  // 各段長度(月)
  //   { type:"index", base:1.6, spread:0.5 }  // = single(base+spread)，供壓力測試/蒙地卡羅覆寫
  // 回傳長度 N 的「年利率(%)」陣列。
  function expandRates(rateSpec, N) {
    const out = new Array(N);
    if (!rateSpec) { out.fill(2.1); return out; }
    if (rateSpec.type === "single" || rateSpec.type === "index") {
      const r = rateSpec.type === "index"
        ? (rateSpec.base || 0) + (rateSpec.spread || 0)
        : (rateSpec.rate || 0);
      out.fill(r); return out;
    }
    if (rateSpec.type === "segments") {
      let t = 0;
      for (const seg of (rateSpec.segments || [])) {
        const len = Math.max(0, Math.round(seg.months || 0));
        for (let k = 0; k < len && t < N; k++) out[t++] = seg.rate || 0;
      }
      // 未填滿：延用最後一段利率
      const last = rateSpec.segments && rateSpec.segments.length
        ? rateSpec.segments[rateSpec.segments.length - 1].rate : 0;
      while (t < N) out[t++] = last;
      return out;
    }
    out.fill(2.1); return out;
  }

  // ---- 本息平均：給定餘額 bal、月利率 i、剩餘期數 n → 月付金 ----
  function annuityPayment(bal, i, n) {
    if (n <= 0) return bal;
    if (i === 0) return bal / n;
    return bal * i / (1 - Math.pow(1 + i, -n));
  }

  // ======== 核心攤還表 ========
  // o: {
  //   principal, months, rateSpec,
  //   method: "equal_payment"|"equal_principal"|"interest_only"|"grace",
  //   graceMonths: 0,                       // method==="grace" 時的寬限期(月)
  //   graceMethod: "equal_payment"|"equal_principal", // 寬限後採哪種攤還(預設本息)
  //   extraMonthly: 0,                       // 每月額外還本
  //   extraLump: [{month, amount}],          // 部分提前還本(第 month 期期末額外還)
  //   prepayMode: "shorten"|"lower"          // 額外還本後：縮短年限 or 降低月付(預設 shorten)
  // }
  function amortize(o) {
    const P = o.principal, N = Math.max(1, Math.round(o.months));
    const method = o.method || "equal_payment";
    const rates = expandRates(o.rateSpec, N);
    const g = method === "grace" ? Math.max(0, Math.round(o.graceMonths || 0)) : 0;
    const graceMethod = o.graceMethod || "equal_payment";
    const extraMonthly = o.extraMonthly || 0;
    const prepayMode = o.prepayMode || "shorten";
    const lumps = {};
    (o.extraLump || []).forEach(l => { lumps[Math.round(l.month)] = (lumps[Math.round(l.month)] || 0) + l.amount; });

    const rows = [];
    let bal = P, totalInt = 0, totalPrin = 0, totalPay = 0;
    // 針對「本息平均 / 降低月付」需要動態重算月付；用 curPmt 快取，於利率變動或提前還本(lower)時重算。
    let curPmt = null, curRateKey = null;

    for (let t = 1; t <= N; t++) {
      if (bal <= 1e-6) break;
      const i = rates[t - 1] / 1200;
      const remain = N - t + 1;                     // 含本期的剩餘期數
      const inGrace = method === "grace" && t <= g;
      const effMethod = inGrace ? "interest_only"
        : (method === "grace" ? graceMethod : method);

      const interest = bal * i;
      let principal = 0, pmt = 0;

      if (effMethod === "interest_only") {
        principal = 0; pmt = interest;
      } else if (effMethod === "equal_principal") {
        // 固定還本 = 原始本金 / 原始總還本期數
        const payMonths = method === "grace" ? (N - g) : N;
        const base = P / payMonths;
        principal = Math.min(bal, base);
        pmt = principal + interest;
      } else { // equal_payment
        // 需要重算月付的時機：進入還本首期、利率改變、或上一期做過 lower 提前還款
        const rateKey = rates[t - 1] + "@" + remain;
        if (curPmt === null || curRateKey === null || rates[t - 1] !== curRateKey) {
          const payN = method === "grace" ? (N - g - (t - 1 - g)) : remain;
          curPmt = annuityPayment(bal, i, Math.max(1, payN));
          curRateKey = rates[t - 1];
        }
        pmt = curPmt;
        principal = Math.min(bal, pmt - interest);
        if (principal < 0) principal = 0;
      }

      // 每月額外還本
      let extra = 0;
      if (extraMonthly > 0 && !inGrace) extra = Math.min(bal - principal, extraMonthly);
      // 部分提前還本(期末)
      let lump = 0;
      if (lumps[t]) lump = Math.min(bal - principal - extra, lumps[t]);
      const extraAll = Math.max(0, extra) + Math.max(0, lump);

      // 末期清尾差
      if (t === N && effMethod !== "interest_only") { principal = bal - extraAll; if (principal < 0) principal = 0; }
      if (effMethod === "interest_only" && t === N) { principal = bal - extraAll; }

      let payPrin = principal + extraAll;
      if (payPrin > bal) payPrin = bal;
      const newBal = bal - payPrin;

      totalInt += interest; totalPrin += payPrin; totalPay += interest + payPrin;
      rows.push({ m: t, rate: rates[t - 1], interest, principal: payPrin, payment: interest + payPrin, balance: newBal, extra: extraAll });
      bal = newBal;

      // 提前還本後「降低月付」：強制下期重算
      if (extraAll > 0 && prepayMode === "lower") { curPmt = null; curRateKey = null; }
      // 「縮短年限」：月付不變(curPmt 保留)，餘額更快歸零
    }

    const payoffMonth = rows.length ? rows[rows.length - 1].m : 0;
    const firstPmt = rows.length ? rows[0].payment : 0;
    // 寬限後首期月付(跳增用)
    let afterGracePmt = firstPmt;
    if (method === "grace" && rows[g]) afterGracePmt = rows[g].payment;
    return {
      rows, totalInterest: totalInt, totalPrincipal: totalPrin, totalPayment: totalPay,
      months: N, payoffMonth, firstPayment: firstPmt,
      graceJump: method === "grace" ? (afterGracePmt - firstPmt) : 0,
      afterGracePayment: afterGracePmt,
    };
  }

  // 便捷：只要月付金(第一期，未含額外還款)
  function monthlyPayment(o) {
    const r = amortize(Object.assign({}, o, { extraMonthly: 0, extraLump: [] }));
    return r.firstPayment;
  }

  // ======== XIRR / APR（與 ETF 引擎同法，二分法可重現） ========
  function npv(rate, cfs) { let s = 0; for (const c of cfs) s += c.amt / Math.pow(1 + rate, c.day / 365); return s; }
  function xirr(cfs) {
    let lo = -0.9999, hi = 10.0, flo = npv(lo, cfs), fhi = npv(hi, cfs);
    if (flo * fhi > 0) return NaN;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2, fm = npv(mid, cfs);
      if (Math.abs(fm) < 1e-9) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  // ======== 全成本 & 實質 APR（護城河） ========
  // o: amortize 參數 + { openFee, mgmtFeeMonthly, insuranceAnnual, prepayPenalty }
  //   撥款日拿到 (P - openFee)；每期付 (月付 + 帳管費)；期末付清餘額(通常已為0)。
  //   火險/地震險：每年一次(第1,13,25...期)加計。提前清償違約金：於 payoffMonth 加計。
  function costAndAPR(o) {
    const amo = amortize(o);
    const openFee = o.openFee || 0;
    const mgmt = o.mgmtFeeMonthly || 0;
    const insAnnual = o.insuranceAnnual || 0;
    const penalty = o.prepayPenalty || 0;
    const cfs = [{ day: 0, amt: (o.principal - openFee) }];
    let insTotal = 0, mgmtTotal = 0;
    for (const row of amo.rows) {
      let out = row.payment + mgmt;
      if ((row.m - 1) % 12 === 0) { out += insAnnual; insTotal += insAnnual; }
      mgmtTotal += mgmt;
      cfs.push({ day: row.m * 30.4375, amt: -out });
    }
    if (penalty > 0 && amo.rows.length) cfs[cfs.length - 1].amt -= penalty;
    const apr = xirr(cfs);
    const totalCost = amo.totalInterest + openFee + mgmtTotal + insTotal + penalty;
    return {
      ...amo, openFee, mgmtTotal, insuranceTotal: insTotal, prepayPenalty: penalty,
      totalInterest: amo.totalInterest, totalCost,
      apr: isNaN(apr) ? null : apr * 100, nominalRate: firstRate(o.rateSpec),
      // 瀑布圖用拆解
      waterfall: {
        principal: o.principal, interest: amo.totalInterest,
        openFee, mgmt: mgmtTotal, insurance: insTotal, penalty,
      },
    };
  }
  function firstRate(spec) {
    if (!spec) return 0;
    if (spec.type === "single") return spec.rate || 0;
    if (spec.type === "index") return (spec.base || 0) + (spec.spread || 0);
    if (spec.type === "segments" && spec.segments && spec.segments.length) return spec.segments[0].rate || 0;
    return 0;
  }

  // ======== 提前還款比較 ========
  // 違約金為「階段式」：綁約期內依所處年段收不同費率，之後為 0（台灣銀行實務）。
  // stages: [{months, rate%}]，依序累計；如 [{12,1.0},{12,0.75},{12,0.5}] = 第1年1%、第2年0.75%、第3年0.5%、之後0。
  function stageRateAt(month, stages) {
    if (!stages || !stages.length) return 0;
    let acc = 0;
    for (const s of stages) { acc += (s.months || 0); if (month <= acc) return (s.rate || 0) / 100; }
    return 0; // 綁約期後不收
  }
  // base: 原方案 amortize 參數。plan: { extraMonthly, extraLump, prepayMode, penaltyStages }
  //   違約金 = Σ 各期「額外還本額 × 該期所處階段費率」（僅對綁約期內的自願提前還本計收）。
  //   相容舊參數 penaltyRate(小數，如 0.0075)：視為全期單一費率。
  function prepaymentCompare(base, plan) {
    const orig = amortize(base);
    const modded = amortize(Object.assign({}, base, {
      extraMonthly: plan.extraMonthly || 0,
      extraLump: plan.extraLump || [],
      prepayMode: plan.prepayMode || "shorten",
    }));
    const interestSaved = orig.totalInterest - modded.totalInterest;
    const monthsSaved = orig.payoffMonth - modded.payoffMonth;
    const stages = plan.penaltyStages ||
      (plan.penaltyRate != null ? [{ months: 1e9, rate: plan.penaltyRate * 100 }] : []);
    let penalty = 0, extraPaid = 0;
    for (const r of modded.rows) { if (r.extra > 0) { penalty += r.extra * stageRateAt(r.m, stages); extraPaid += r.extra; } }
    return {
      origInterest: orig.totalInterest, newInterest: modded.totalInterest,
      interestSaved, monthsSaved, yearsSaved: monthsSaved / 12,
      extraPaid, penalty, netSaved: interestSaved - penalty, worthwhile: (interestSaved - penalty) > 0,
    };
  }

  // 雙週還款：把月付減半、每兩週付 → 一年 26 次。近似為「月付 × 13/12」的月頻等效。
  function biweeklyCompare(base) {
    const orig = amortize(base);
    const M = orig.firstPayment;
    const extraMonthly = M / 12; // 一年多付一個月月付 → 平均每月多付 M/12
    const modded = amortize(Object.assign({}, base, { extraMonthly, prepayMode: "shorten" }));
    return {
      origInterest: orig.totalInterest, newInterest: modded.totalInterest,
      interestSaved: orig.totalInterest - modded.totalInterest,
      monthsSaved: orig.payoffMonth - modded.payoffMonth,
      yearsSaved: (orig.payoffMonth - modded.payoffMonth) / 12,
    };
  }

  // ======== 轉貸 / 再融資 ========
  // cur: {balance, rate, remainMonths}  new_: {rate, months, openFee, dischargeFee, setupFee, penalty}
  function refinance(cur, new_) {
    const oldPmt = annuityPayment(cur.balance, cur.rate / 1200, cur.remainMonths);
    const newPmt = annuityPayment(cur.balance, new_.rate / 1200, new_.months);
    const oldTotal = oldPmt * cur.remainMonths;
    const oneOff = (new_.openFee || 0) + (new_.dischargeFee || 0) + (new_.setupFee || 0) + (new_.penalty || 0);
    const newTotal = newPmt * new_.months + oneOff;
    const monthlySave = oldPmt - newPmt;
    const breakEven = monthlySave > 0 ? Math.ceil(oneOff / monthlySave) : null;
    return {
      oldPmt, newPmt, monthlySave, oneOff,
      oldTotal, newTotal, netSave: oldTotal - newTotal, breakEven,
      worthwhile: (oldTotal - newTotal) > 0,
    };
  }

  // ======== 買房 vs 租房 ========
  // o: { price, downPayment, loan(amortize參數), years, homeGrowth, rentMonthly, rentGrowth,
  //      investReturn, ownTaxAnnual, maintainAnnual, sellCostRate }
  function rentVsBuy(o) {
    const months = Math.round(o.years * 12);
    const amo = amortize(o.loan);
    // 買方：期初自備款；每月 月付+自住稅/12+維護/12；期末房屋淨值
    let buyOutflow = o.downPayment;
    const rows = [];
    let investBalRent = o.downPayment; // 租方把自備款投入市場
    const rInv = Math.pow(1 + (o.investReturn || 0) / 100, 1 / 12) - 1;
    let rent = o.rentMonthly;
    let totalRent = 0, totalBuyMonthly = 0;
    for (let m = 1; m <= months; m++) {
      const row = amo.rows[m - 1];
      const pmt = row ? row.payment : 0;
      const ownMonthly = pmt + (o.ownTaxAnnual || 0) / 12 + (o.maintainAnnual || 0) / 12;
      totalBuyMonthly += ownMonthly;
      // 租方：付房租；買租價差投入市場
      const diff = ownMonthly - rent;
      investBalRent = investBalRent * (1 + rInv) + Math.max(0, diff);
      totalRent += rent;
      if (m % 12 === 0) rent = rent * (1 + (o.rentGrowth || 0) / 100);
      rows.push({ m, ownMonthly, rent, investRent: investBalRent, balance: row ? row.balance : 0 });
    }
    const homeValue = o.price * Math.pow(1 + (o.homeGrowth || 0) / 100, o.years);
    const remainLoan = amo.rows[months - 1] ? amo.rows[months - 1].balance : 0;
    const sellCost = homeValue * (o.sellCostRate || 0) / 100;
    const buyNetWorth = homeValue - remainLoan - sellCost;
    const rentNetWorth = investBalRent;
    return {
      rows, buyNetWorth, rentNetWorth, homeValue, remainLoan, sellCost,
      totalRent, totalBuyMonthly, downPayment: o.downPayment,
      buyBetter: buyNetWorth > rentNetWorth, gap: buyNetWorth - rentNetWorth,
    };
  }

  // ======== 賣房落袋 / 房地合一稅 2.0 ========
  // o: { salePrice, acquireCost, deductible, landValueIncrease, holdYears,
  //      selfUse(bool), repurchase(bool), remainLoan }
  function capitalGainsTax(o) {
    const gain = Math.max(0, o.salePrice - o.acquireCost - (o.deductible || 0) - (o.landValueIncrease || 0));
    let rate;
    const y = o.holdYears;
    if (y <= 2) rate = 0.45; else if (y <= 5) rate = 0.35; else if (y <= 10) rate = 0.20; else rate = 0.15;
    let taxable = gain, tax;
    if (o.selfUse && y >= 6) { // 自住 6 年：400萬免稅、超額 10%
      taxable = Math.max(0, gain - 4000000);
      tax = taxable * 0.10;
    } else {
      tax = taxable * rate;
    }
    if (o.repurchase) tax = 0; // 重購退稅(簡化：全額退，實務按比例/條件)
    const netProceeds = o.salePrice - (o.remainLoan || 0) - tax - (o.deductible || 0);
    return { gain, rate: (o.selfUse && y >= 6) ? 0.10 : rate, tax, taxable, netProceeds };
  }

  // ======== 升息壓力測試 ========
  // base: amortize 參數(單一/多段皆可)；bumps: [0,1,2,3] 百分點
  function stressTest(base, bumps, income) {
    const out = [];
    for (const b of (bumps || [0, 1, 2, 3])) {
      const spec = bumpRate(base.rateSpec, b);
      const amo = amortize(Object.assign({}, base, { rateSpec: spec }));
      const peak = amo.rows.reduce((mx, r) => Math.max(mx, r.payment), 0);
      out.push({
        bump: b, firstPayment: amo.firstPayment, afterGracePayment: amo.afterGracePayment,
        peakPayment: peak, totalInterest: amo.totalInterest,
        payToIncome: income ? peak / income : null,
        over40: income ? (peak / income > 0.4) : null,
      });
    }
    return out;
  }
  function bumpRate(spec, b) {
    if (!spec) return { type: "single", rate: 2.1 + b };
    if (spec.type === "single") return { type: "single", rate: (spec.rate || 0) + b };
    if (spec.type === "index") return { type: "index", base: (spec.base || 0) + b, spread: spec.spread || 0 };
    if (spec.type === "segments") return { type: "segments", segments: spec.segments.map(s => ({ months: s.months, rate: (s.rate || 0) + b })) };
    return spec;
  }

  // ======== 指數型利率蒙地卡羅（Ornstein-Uhlenbeck 離散） ========
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = clamp(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
    return sorted[idx];
  }
  // o: { principal, months, method, graceMonths, r0, rMean, rVol, kappa, spread, N, seed, income }
  //   利率年變動：dr = kappa*(rMean - r)*dt + rVol*sqrt(dt)*Z ，dt=1/12。月付隨利率逐年重算(本息)。
  function monteCarloRates(o) {
    const N = o.N || 10000, months = Math.max(1, Math.round(o.months));
    const rng = mulberry32((o.seed == null ? 20260806 : o.seed) >>> 0);
    const dt = 1 / 12, sq = Math.sqrt(dt);
    const kappa = o.kappa == null ? 0.5 : o.kappa;
    const spread = o.spread || 0;
    const totalInts = new Array(N), peaks = new Array(N);
    let over40 = 0;
    for (let k = 0; k < N; k++) {
      let r = o.r0, bal = o.principal, totalInt = 0, peak = 0;
      let curPmt = null;
      for (let m = 1; m <= months; m++) {
        if (bal <= 1e-6) break;
        // 年初更新利率(每 12 期一跳，期間固定)
        if ((m - 1) % 12 === 0) {
          if (m > 1) r = Math.max(0, r + kappa * (o.rMean - r) * 1 + o.rVol * 1 * gauss(rng)); // 年步進
          const i = (r + spread) / 1200;
          curPmt = annuityPayment(bal, i, months - m + 1);
        }
        const i = (r + spread) / 1200;
        const interest = bal * i;
        let prin = Math.min(bal, curPmt - interest); if (prin < 0) prin = 0;
        if (m === months) prin = bal;
        const pay = interest + prin;
        totalInt += interest; peak = Math.max(peak, pay);
        bal -= prin;
      }
      totalInts[k] = totalInt; peaks[k] = peak;
      if (o.income && peak / o.income > 0.4) over40++;
    }
    totalInts.sort((a, b) => a - b); peaks.sort((a, b) => a - b);
    return {
      N,
      interest: { p10: percentile(totalInts, 10), p50: percentile(totalInts, 50), p90: percentile(totalInts, 90) },
      peakPayment: { p10: percentile(peaks, 10), p50: percentile(peaks, 50), p90: percentile(peaks, 90) },
      probOver40: o.income ? over40 / N : null,
    };
  }

  // ======== 法規檢查（提醒層） ========
  // 央行成數上限(第七波+2026-03鬆綁，數字待擁有者核對)
  const LTV_CAP = { first: 100, second: 60, third: 30, luxury: 30 }; // %
  function regulationCheck(o) {
    // o: { price, loan, propertyOrder:"first"|"second"|"third"|"luxury", monthlyPayment, income,
    //      qingan:{enable, hasOwnHome, age, everUsed, loanAmount, years, graceYears} }
    const ltv = o.price > 0 ? o.loan / o.price * 100 : 0;
    const cap = LTV_CAP[o.propertyOrder || "first"] || 100;
    const checks = [];
    checks.push({ key: "ltv", label: "貸款成數", value: ltv, limit: cap, pass: ltv <= cap + 1e-6 });
    if (o.income) {
      const ratio = o.monthlyPayment / o.income * 100;
      checks.push({ key: "payToIncome", label: "月付/收入", value: ratio, limit: 40, pass: ratio <= 40 });
    }
    if (o.qingan && o.qingan.enable) {
      const q = o.qingan;
      checks.push({ key: "q_ownHome", label: "無自有住宅", value: q.hasOwnHome ? "有" : "無", limit: "無", pass: !q.hasOwnHome });
      checks.push({ key: "q_used", label: "一生一次", value: q.everUsed ? "已用" : "未用", limit: "未用", pass: !q.everUsed });
      checks.push({ key: "q_amount", label: "額度上限", value: q.loanAmount, limit: 15000000, pass: q.loanAmount <= 15000000 });
      checks.push({ key: "q_years", label: "年限上限", value: q.years, limit: 40, pass: q.years <= 40 });
      checks.push({ key: "q_grace", label: "寬限上限", value: q.graceYears, limit: 5, pass: q.graceYears <= 5 });
    }
    return { ltv, cap, checks, allPass: checks.every(c => c.pass) };
  }

  return {
    // 基礎
    round2, clamp, expandRates, annuityPayment, firstRate,
    // 攤還
    amortize, monthlyPayment,
    // APR / 成本
    npv, xirr, costAndAPR,
    // 情境
    prepaymentCompare, stageRateAt, biweeklyCompare, refinance, rentVsBuy, capitalGainsTax,
    stressTest, bumpRate, monteCarloRates, mulberry32,
    // 法規
    regulationCheck, LTV_CAP,
  };
});
