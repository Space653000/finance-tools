/**
 * Stephen AI Finance ｜ FIRE 退休試算工具　計算引擎（正式程式，index.html 與 harness.js 共用）
 * 純函式、無副作用、瀏覽器與 Node 皆可載入。此檔為「上線的那份程式」，
 * 驗證(verify/harness.js、verify/independent.py)直接對照此檔測試；改計算核心必同步升級 verify/。
 *
 * 設計原則（延續房貸／ETF 引擎）：
 *   1. 累積期以「月」為期（配合每月投入與加薪級距）；提領期以「年」為期（配合各家提領法則的年度規則）。
 *   2. 所有隨機模擬使用固定種子 mulberry32，可 100% 重現。
 *   3. 名目 / 實質雙軌：提領策略以「名目」計算（4%法則、GK 法則的通膨規則都定義在名目），
 *      再以通膨還原出「實質」對照；FI 數字與累積期以「實質報酬」計算，語意最直覺。
 *   4. 台灣三支柱（勞保老年年金、勞退新制、國民年金）為在地護城河，於法定年齡起抵減提領缺口。
 *
 * 對應規格：docs/FIRE開發計劃書_階段1_公式與規格.md
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // Node
  if (typeof window !== "undefined") window.FIREEngine = api;                 // Browser
})(this, function () {
  "use strict";

  /* ==================== 基礎工具 ==================== */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pctToRate = p => (p || 0) / 100;
  // 名目→實質：Fisher 精確式 (1+n)/(1+i)-1
  function realFromNominal(nominal, inflation) {
    return (1 + pctToRate(nominal)) / (1 + pctToRate(inflation)) - 1;
  }
  // 年利率→月利率（幾何一致）
  function annualToMonthly(rAnnual) { return Math.pow(1 + rAnnual, 1 / 12) - 1; }

  // 亂數與統計（與 ETF/房貸引擎同法，保證可重現）
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) { // Box-Muller
    let u1 = rng(); if (u1 < 1e-12) u1 = 1e-12; const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  function mean(a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : 0; }
  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = clamp(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
    return sorted[idx];
  }

  /* ==================== 1. FI 數字（財務自由目標） ==================== */
  // 年支出 ÷ 安全提領率 = 目標資產。 swrPct 4 → 25×；3 → 33.3×；2.5 → 40×。
  function fiNumber(annualExpense, swrPct) {
    const s = pctToRate(swrPct);
    if (s <= 0) return Infinity;
    return annualExpense / s;
  }
  // 依「退休年數」給安全提領率建議：30年→4%、40年→3.5%、45年↑→3.25%、50年↑→3%（社群共識，非保證）
  function suggestSWR(retirementYears) {
    if (retirementYears <= 30) return 4.0;
    if (retirementYears <= 40) return 3.5;
    if (retirementYears <= 45) return 3.25;
    if (retirementYears <= 50) return 3.0;
    return 2.75;
  }

  /* ==================== 2. 累積期投射（每月投入＋加薪級距） ==================== */
  // o: { initial, monthlyContribution, stepUpAnnualPct, realReturnPct, months }
  //   每年（每 12 期）於期初把每月投入乘上 (1+stepUp)。回傳每月餘額序列與年末序列。
  function accumulate(o) {
    const months = Math.max(0, Math.round(o.months || 0));
    const rm = annualToMonthly(pctToRate(o.realReturnPct || 0));
    const step = pctToRate(o.stepUpAnnualPct || 0);
    let bal = o.initial || 0;
    let contrib = o.monthlyContribution || 0;
    let totalContrib = 0;
    const monthly = [bal];
    const yearEnd = [];
    for (let m = 1; m <= months; m++) {
      if (m > 1 && (m - 1) % 12 === 0) contrib *= (1 + step); // 每滿一年調升投入
      bal = bal * (1 + rm) + contrib;
      totalContrib += contrib;
      monthly.push(bal);
      if (m % 12 === 0) yearEnd.push(bal);
    }
    return {
      endValue: bal, totalContribution: totalContrib,
      totalGrowth: bal - (o.initial || 0) - totalContrib,
      monthly, yearEnd, months,
    };
  }

  // 解「幾年達標 FI」：在給定投入與實質報酬下，資產首次 ≥ target 的月數。找不到→null（capMonths 內）。
  // o: accumulate 參數（不含 months）＋ { target, capMonths }
  function monthsToTarget(o) {
    const cap = Math.max(1, Math.round(o.capMonths || 1200)); // 預設上限 100 年
    const rm = annualToMonthly(pctToRate(o.realReturnPct || 0));
    const step = pctToRate(o.stepUpAnnualPct || 0);
    let bal = o.initial || 0, contrib = o.monthlyContribution || 0;
    const target = o.target || 0;
    if (bal >= target) return 0;
    for (let m = 1; m <= cap; m++) {
      if (m > 1 && (m - 1) % 12 === 0) contrib *= (1 + step);
      bal = bal * (1 + rm) + contrib;
      if (bal >= target) return m;
    }
    return null;
  }

  // 儲蓄率→達成 FI 年數（MMM「震撼的簡單數學」：假設從 0 起、實質報酬 r、支出固定）
  // savingsRate 0..1（存下的稅後收入比例）。回傳年數（解析近似，供對照）。
  function yearsFromSavingsRate(savingsRatePct, realReturnPct) {
    const sr = clamp(pctToRate(savingsRatePct), 0.0001, 0.9999);
    const r = pctToRate(realReturnPct);
    // 目標＝25×年支出（4%）；年儲蓄＝sr、年支出＝(1-sr)，目標＝25(1-sr)。
    // 從 0 起，年末投入 sr，複利 r：求 n 使 FV(sr, r, n) ≥ 25(1-sr)
    const target = 25 * (1 - sr);
    if (r <= 0) return target / sr; // 無報酬→線性
    // FV of annuity = sr*((1+r)^n -1)/r ≥ target → 解 n
    const n = Math.log(1 + (target * r) / sr) / Math.log(1 + r);
    return n;
  }

  /* ==================== 3. 五種 FIRE 型態 ==================== */
  // 傳統/胖/瘦：只是年支出不同 → FI 數字不同。
  // Coast FIRE：現在的資產「不再投入」就能在傳統退休年齡長成 FI 數字。
  //   coastTarget(現在需要) = fiAtRetire / (1+r)^yearsToTraditional
  // Barista FIRE：兼職收入分攤部分支出 → 需要資產 = (年支出 − 兼職年收入) ÷ swr
  function coastFire(o) {
    // o: { fiNumberAtRetire, realReturnPct, yearsToTraditional, currentPortfolio }
    const r = pctToRate(o.realReturnPct || 0);
    const y = Math.max(0, o.yearsToTraditional || 0);
    const needNow = o.fiNumberAtRetire / Math.pow(1 + r, y);
    const cur = o.currentPortfolio || 0;
    // 現有資產「放著長大」到傳統退休時的價值
    const projected = cur * Math.pow(1 + r, y);
    return {
      coastNumberNow: needNow,
      alreadyCoasting: cur >= needNow - 1e-6,
      projectedAtRetire: projected,
      surplus: projected - o.fiNumberAtRetire,
    };
  }
  function baristaFire(o) {
    // o: { annualExpense, partTimeAnnualIncome, swrPct }
    const gap = Math.max(0, (o.annualExpense || 0) - (o.partTimeAnnualIncome || 0));
    return {
      portfolioNeeded: fiNumber(gap, o.swrPct),
      coveredByWork: o.partTimeAnnualIncome || 0,
      residualExpense: gap,
    };
  }
  // 一次算出五型態的 FI 數字（給總覽卡）
  function fireVariants(o) {
    // o: { fatExpense, baseExpense, leanExpense, swrPct, coast:{realReturnPct, yearsToTraditional, currentPortfolio} }
    const swr = o.swrPct;
    const traditional = fiNumber(o.baseExpense, swr);
    const lean = fiNumber(o.leanExpense, swr);
    const fat = fiNumber(o.fatExpense, swr);
    const coast = coastFire({
      fiNumberAtRetire: traditional,
      realReturnPct: o.coast.realReturnPct,
      yearsToTraditional: o.coast.yearsToTraditional,
      currentPortfolio: o.coast.currentPortfolio,
    });
    return { traditional, lean, fat, coastNumberNow: coast.coastNumberNow, coast };
  }

  /* ==================== 4. 提領策略（名目，年步） ==================== */
  // 每個策略吃「名目年報酬路徑 rets[]（長度=年數）」＋參數，回傳逐年 {balance, spend, pension} 與是否枯竭。
  // 通用參數 o:
  //   initial, spend0(第一年名目提領), inflationPct,
  //   pension: { annualAmount, startYear(第幾年開始領,1-based), growWithInflation(bool) }
  //   legacyTarget(期末想留下的名目資產，預設0), extraFloorSpend(名目最低生活費地板)
  function _applyPension(o, year, infl) {
    const p = o.pension;
    if (!p || !p.annualAmount || year < (p.startYear || 1e9)) return 0;
    const yrs = year - (p.startYear || year);
    return p.growWithInflation === false ? p.annualAmount
      : p.annualAmount * Math.pow(1 + infl, yrs);
  }
  // 4a. 固定實質提領（4%法則）：第一年 spend0，其後每年隨通膨成長；養老金抵減portfolio提領。
  function withdrawConstant(rets, o) {
    const infl = pctToRate(o.inflationPct || 0);
    let bal = o.initial || 0, spend = o.spend0 || 0;
    const rows = []; let depletedYear = 0, minBal = bal;
    for (let y = 1; y <= rets.length; y++) {
      const pension = _applyPension(o, y, infl);
      const net = Math.max(0, spend - pension);      // 需自資產提領
      bal -= net;                                     // 年初提領
      if (bal < 0 && !depletedYear) { depletedYear = y; bal = 0; }
      bal = bal * (1 + rets[y - 1]);                  // 年中投資成長
      rows.push({ year: y, spend, pension, netWithdraw: net, balance: bal });
      if (bal < minBal) minBal = bal;
      spend *= (1 + infl);                            // 下一年通膨調整
    }
    const end = rows.length ? rows[rows.length - 1].balance : bal;
    return { rows, endBalance: end, depletedYear, minBalance: minBal,
             success: !depletedYear && end >= (o.legacyTarget || 0) };
  }
  // 4b. 固定百分比提領：每年提領當前餘額 × pctPerYear（永不枯竭但支出波動大）
  function withdrawFixedPct(rets, o) {
    const infl = pctToRate(o.inflationPct || 0);
    const wr = pctToRate(o.pctPerYear || 4);
    let bal = o.initial || 0; const rows = []; let minSpend = Infinity, minBal = bal;
    for (let y = 1; y <= rets.length; y++) {
      const gross = bal * wr;
      const pension = _applyPension(o, y, infl);
      const spend = gross + pension;
      bal -= gross;
      bal = bal * (1 + rets[y - 1]);
      rows.push({ year: y, spend, pension, netWithdraw: gross, balance: bal });
      if (spend < minSpend) minSpend = spend; if (bal < minBal) minBal = bal;
    }
    const end = rows.length ? rows[rows.length - 1].balance : bal;
    return { rows, endBalance: end, depletedYear: 0, minBalance: minBal, minSpend,
             success: end >= (o.legacyTarget || 0) };
  }
  // 4c. Guyton-Klinger 護欄（名目）：
  //   初始提領率 wr0；通膨規則(前一年為負報酬則略過通膨調整，且僅在當前WR>初始WR時)；
  //   資本保全 CPR：當前WR>初始WR×1.2 → 支出×0.9；繁榮 PR：當前WR<初始WR×0.8 → 支出×1.1。
  //   （最後 15 年不套用 CPR，符合 GK 原文。）
  function withdrawGuytonKlinger(rets, o) {
    const infl = pctToRate(o.inflationPct || 0);
    const wr0 = pctToRate(o.initialWRPct || 5);
    const guardHigh = 1.2, guardLow = 0.8, adj = 0.10;
    let bal = o.initial || 0;
    let spend = (o.spend0 != null) ? o.spend0 : bal * wr0;
    const N = rets.length; const rows = []; let depletedYear = 0, minBal = bal, minSpend = Infinity;
    for (let y = 1; y <= N; y++) {
      // 提領前先套用當年守則（第 1 年不調整）
      if (y > 1) {
        const prevNeg = rets[y - 2] < 0;
        const curWR = spend / bal;
        // 通膨規則：非負報酬年才給通膨；且若前一年負報酬且WR>wr0，凍結（不補）
        if (!(prevNeg && curWR > wr0)) spend *= (1 + infl);
        // 資本保全（最後15年豁免）
        if (curWR > wr0 * guardHigh && (N - y) > 15) spend *= (1 - adj);
        // 繁榮法則
        else if (curWR < wr0 * guardLow) spend *= (1 + adj);
      }
      const pension = _applyPension(o, y, infl);
      const net = Math.max(0, spend - pension);
      bal -= net;
      if (bal < 0 && !depletedYear) { depletedYear = y; bal = 0; }
      bal = bal * (1 + rets[y - 1]);
      rows.push({ year: y, spend, pension, netWithdraw: net, balance: bal });
      if (bal < minBal) minBal = bal; if (spend < minSpend) minSpend = spend;
    }
    const end = rows.length ? rows[rows.length - 1].balance : bal;
    return { rows, endBalance: end, depletedYear, minBalance: minBal, minSpend,
             success: !depletedYear && end >= (o.legacyTarget || 0) };
  }
  // 4d. VPW 變動百分比提領：提領率隨年齡上升（用剩餘年數的年金因子）。
  //   pct_y = r / (1 - (1+r)^-(remainingYears))，r 用實質報酬預期。永不枯竭。
  function withdrawVPW(rets, o) {
    const infl = pctToRate(o.inflationPct || 0);
    const rExp = pctToRate(o.expectedRealReturnPct != null ? o.expectedRealReturnPct : 3);
    const N = rets.length; let bal = o.initial || 0; const rows = []; let minSpend = Infinity;
    for (let y = 1; y <= N; y++) {
      const remain = N - y + 1;
      const pct = rExp === 0 ? 1 / remain : rExp / (1 - Math.pow(1 + rExp, -remain));
      const gross = Math.min(bal, bal * pct); // 末年因子>1，夾住不使餘額為負
      const pension = _applyPension(o, y, infl);
      const spend = gross + pension;
      bal -= gross; bal = bal * (1 + rets[y - 1]);
      rows.push({ year: y, spend, pension, netWithdraw: gross, balance: bal });
      if (spend < minSpend) minSpend = spend;
    }
    const end = rows.length ? rows[rows.length - 1].balance : bal;
    return { rows, endBalance: end, depletedYear: 0, minSpend,
             success: end >= (o.legacyTarget || 0) };
  }
  // 4e. Vanguard 動態支出（天花板/地板）：目標＝當前餘額×wr；
  //   實際變動限制在 前一年名目 ×(1-floor) ~ ×(1+ceiling)。
  function withdrawDynamic(rets, o) {
    const infl = pctToRate(o.inflationPct || 0);
    const wr = pctToRate(o.targetWRPct || 4);
    const ceil = pctToRate(o.ceilingPct != null ? o.ceilingPct : 5);
    const floor = pctToRate(o.floorPct != null ? o.floorPct : 2.5);
    let bal = o.initial || 0; let prev = (o.spend0 != null) ? o.spend0 : bal * wr;
    const rows = []; let depletedYear = 0, minBal = bal, minSpend = Infinity;
    for (let y = 1; y <= rets.length; y++) {
      let spend;
      if (y === 1) spend = prev;
      else {
        const target = bal * wr;
        const hi = prev * (1 + infl) * (1 + ceil);
        const lo = prev * (1 + infl) * (1 - floor);
        spend = clamp(target, lo, hi);
      }
      const pension = _applyPension(o, y, infl);
      const net = Math.max(0, spend - pension);
      bal -= net;
      if (bal < 0 && !depletedYear) { depletedYear = y; bal = 0; }
      bal = bal * (1 + rets[y - 1]);
      rows.push({ year: y, spend, pension, netWithdraw: net, balance: bal });
      if (bal < minBal) minBal = bal; if (spend < minSpend) minSpend = spend;
      prev = spend;
    }
    const end = rows.length ? rows[rows.length - 1].balance : bal;
    return { rows, endBalance: end, depletedYear, minBalance: minBal, minSpend,
             success: !depletedYear && end >= (o.legacyTarget || 0) };
  }
  const STRATEGIES = {
    constant: withdrawConstant, fixedpct: withdrawFixedPct,
    gk: withdrawGuytonKlinger, vpw: withdrawVPW, dynamic: withdrawDynamic,
  };
  function runStrategy(name, rets, o) {
    return (STRATEGIES[name] || withdrawConstant)(rets, o);
  }

  /* ==================== 4.5 逐年現金流引擎（v2：地板/彈性、階段支出、多段收入） ====================
   * 全程「實質」計算(與三軌報酬一致)。醫療以「實質超額成長」med-gen 表達,故階段仍在實質框架。
   * plan:
   *  retireAge, initialPortfolio,
   *  phases:[{startAge, essentialMonthly, medicalMonthly, discretionaryMonthly}]   // 微笑曲線三階段
   *  oneOffEssential:[{age,amount}], oneOffDiscretionary:[{age,amount}]            // 一次性大額
   *  incomeSegments:[{startAge,endAge,monthlyAmount}]                              // 多段收入(兼職/房租,實質)
   *  oneOffInflows:[{age,amount}]                                                  // 一次性流入(繼承/理賠/賣房)
   *  pensionAnnual, pensionStartAge,                                               // 台灣三支柱(實質)
   *  generalInflationPct, medicalInflationPct,
   *  strategy, strategyParams, glide:{stockStartPct,stockEndPct}, legacyTarget
   * 給定「實質」股/債年報酬陣列(等長=年數)→ 逐年決定地板(必要)與彈性(可選)支出。
   */
  function _phaseAt(phases, age) {
    let p = (phases && phases.length) ? phases[0] : { essentialMonthly: 0, medicalMonthly: 0, discretionaryMonthly: 0 };
    for (const q of (phases || [])) if ((q.startAge || 0) <= age) p = q;
    return { essentialMonthly: p.essentialMonthly || 0, medicalMonthly: p.medicalMonthly || 0, discretionaryMonthly: p.discretionaryMonthly || 0 };
  }
  function _oneOff(list, age) { let s = 0; for (const x of (list || [])) if (Math.round(x.age) === age) s += (x.amount || 0); return s; }
  function _segIncome(segs, age) { let s = 0; for (const g of (segs || [])) if (age >= (g.startAge == null ? -1e9 : g.startAge) && age <= (g.endAge == null ? 1e9 : g.endAge)) s += (g.monthlyAmount || 0) * 12; return s; }
  function glideStock(age, retireAge, planAge, cfg) {
    if (!cfg) return 1;
    const a = pctToRate(cfg.stockStartPct != null ? cfg.stockStartPct : 100);
    const b = pctToRate(cfg.stockEndPct != null ? cfg.stockEndPct : (cfg.stockStartPct != null ? cfg.stockStartPct : 100));
    const span = Math.max(1, planAge - retireAge);
    return clamp(a + (b - a) * clamp((age - retireAge) / span, 0, 1), 0, 1);
  }
  function runRetirementPath(plan, stockRets, bondRets) {
    const gen = pctToRate(plan.generalInflationPct || 0);
    const med = pctToRate(plan.medicalInflationPct != null ? plan.medicalInflationPct : (plan.generalInflationPct || 0));
    const medRealGrowth = (1 + med) / (1 + gen) - 1; // 醫療相對一般的實質超額成長
    const retAge = plan.retireAge || 55, N = Math.min(stockRets.length, bondRets.length);
    const planAge = retAge + N;
    let port = plan.initialPortfolio || 0; const port0 = port;
    const p0 = _phaseAt(plan.phases, retAge);
    const essential0 = p0.essentialMonthly * 12 + p0.medicalMonthly * 12 + _oneOff(plan.oneOffEssential, retAge);
    const disc0 = p0.discretionaryMonthly * 12 + _oneOff(plan.oneOffDiscretionary, retAge);
    const base0 = essential0 + disc0;
    const sp = plan.strategyParams || {}, strat = plan.strategy || "constant";
    const wr0 = pctToRate(sp.initialWRPct != null ? sp.initialWRPct : (base0 > 0 && port0 > 0 ? base0 / port0 * 100 : 4));
    let prevBudget = base0;
    const rows = []; let floorBreachYear = 0, minBal = port, fulfillSum = 0, fulfillYears = 0;
    for (let k = 0; k < N; k++) {
      const age = retAge + k;
      const sW = glideStock(age, retAge, planAge, plan.glide);
      const realRet = sW * stockRets[k] + (1 - sW) * bondRets[k];
      const ph = _phaseAt(plan.phases, age);
      const essential = ph.essentialMonthly * 12 + ph.medicalMonthly * 12 * Math.pow(1 + medRealGrowth, k) + _oneOff(plan.oneOffEssential, age);
      const discTarget = ph.discretionaryMonthly * 12 + _oneOff(plan.oneOffDiscretionary, age);
      const pension = (plan.pensionAnnual && age >= (plan.pensionStartAge == null ? 1e9 : plan.pensionStartAge)) ? plan.pensionAnnual : 0;
      const income = pension + _segIncome(plan.incomeSegments, age) + _oneOff(plan.oneOffInflows, age);
      const essentialGap = Math.max(0, essential - income);
      const surplusIncome = Math.max(0, income - essential);
      // 策略給的「總支出預算」(實質)
      let budget; const remain = N - k;
      if (strat === "fixedpct") budget = port * pctToRate(sp.pctPerYear != null ? sp.pctPerYear : 4);
      else if (strat === "vpw") { const rE = pctToRate(sp.expectedRealReturnPct != null ? sp.expectedRealReturnPct : 3); budget = rE === 0 ? port / remain : port * (rE / (1 - Math.pow(1 + rE, -remain))); }
      else if (strat === "dynamic") { const wr = pctToRate(sp.targetWRPct != null ? sp.targetWRPct : (sp.pctPerYear != null ? sp.pctPerYear : 4)); const ce = pctToRate(sp.ceilingPct != null ? sp.ceilingPct : 5), fl = pctToRate(sp.floorPct != null ? sp.floorPct : 2.5); budget = k === 0 ? base0 : clamp(port * wr, prevBudget * (1 - fl), prevBudget * (1 + ce)); }
      else if (strat === "gk") { let b = k === 0 ? base0 : prevBudget; if (k > 0) { const curWR = port > 0 ? b / port : Infinity; if (curWR > wr0 * 1.2 && (N - k) > 15) b *= 0.9; else if (curWR < wr0 * 0.8) b *= 1.1; } budget = b; }
      else budget = base0; // constant：實質固定總預算
      // 配置：地板(必要)優先且強制;彈性只用剩餘預算與剩餘資產
      const essPay = Math.min(essentialGap, port);
      if (port < essentialGap - 1e-6 && !floorBreachYear) floorBreachYear = k + 1;
      const availForDisc = Math.max(0, port - essPay);
      const discFromIncome = Math.min(discTarget, surplusIncome);
      const remainingDisc = Math.max(0, discTarget - discFromIncome);
      const discFromPort = clamp(budget - essentialGap, 0, Math.min(remainingDisc, availForDisc));
      const totalWithdraw = essPay + discFromPort;
      const actualDisc = discFromIncome + discFromPort;
      port = (port - totalWithdraw) * (1 + realRet);
      if (port < minBal) minBal = port;
      prevBudget = budget;
      if (discTarget > 1e-9) { fulfillSum += clamp(actualDisc / discTarget, 0, 1); fulfillYears++; }
      rows.push({ age, essential, discTarget, income, essentialGap, actualDisc, withdraw: totalWithdraw, balance: port, stockW: sW });
    }
    return {
      rows, months: N, floorBreachYear, floorSuccess: !floorBreachYear,
      endBalance: port, minBalance: minBal, avgFulfillment: fulfillYears ? fulfillSum / fulfillYears : 1,
    };
  }

  /* ==================== 4.6 三軌退休模擬（MC + 歷史序列 + 區塊 bootstrap） ====================
   * 把 runRetirementPath 跑很多條「實質股/債報酬路徑」，統計地板存活率、彈性實現率、枯竭年齡、終值分位。
   * o: { planAge, track:"mc"|"historical"|"bootstrap", N, seed,
   *      stockMeanPct, stockVolPct, bondMeanPct, bondVolPct, corr,   // mc 用(皆實質)
   *      histStock[], histBond[], block }                            // historical/bootstrap 用(實質年報酬)
   */
  function _mcPath(rng, o, years) {
    const sm = pctToRate(o.stockMeanPct || 0), sv = pctToRate(o.stockVolPct || 0);
    const bm = pctToRate(o.bondMeanPct || 0), bv = pctToRate(o.bondVolPct || 0);
    const rho = o.corr || 0, k = Math.sqrt(Math.max(0, 1 - rho * rho));
    const s = new Array(years), b = new Array(years);
    for (let y = 0; y < years; y++) { const z1 = gauss(rng), z2 = rho * z1 + k * gauss(rng); s[y] = sm + sv * z1; b[y] = bm + bv * z2; }
    return [s, b];
  }
  function simulateRetirement(plan, o) {
    const years = Math.max(1, Math.round((o.planAge != null ? o.planAge : 95) - plan.retireAge));
    const track = o.track || "mc", N = o.N || 10000;
    const rng = mulberry32((o.seed == null ? 20260808 : o.seed) >>> 0);
    const survivals = [], fulfills = [], ends = [], breaches = [];
    const solventCount = new Array(years).fill(0);
    const runOne = (s, b) => {
      const r = runRetirementPath(plan, s, b);
      survivals.push(r.floorSuccess ? 1 : 0); fulfills.push(r.avgFulfillment);
      ends.push(Math.max(0, r.endBalance)); if (r.floorBreachYear) breaches.push(r.floorBreachYear);
      const bY = r.floorBreachYear; for (let k = 0; k < years; k++) if (bY === 0 || (k + 1) < bY) solventCount[k]++;
    };
    if (track === "historical") {
      const hs = o.histStock || [], hb = o.histBond || [], n = Math.min(hs.length, hb.length);
      for (let st = 0; st + years <= n; st++) runOne(hs.slice(st, st + years), hb.slice(st, st + years));
    } else if (track === "bootstrap") {
      const hs = o.histStock || [], hb = o.histBond || [], n = Math.min(hs.length, hb.length), bl = Math.max(1, o.block || 5);
      for (let c = 0; c < N; c++) {
        const s = [], b = [];
        while (s.length < years) { const start = Math.floor(rng() * (n - bl + 1)); for (let j = 0; j < bl && s.length < years; j++) { s.push(hs[start + j]); b.push(hb[start + j]); } }
        runOne(s, b);
      }
    } else {
      for (let c = 0; c < N; c++) { const sb = _mcPath(rng, o, years); runOne(sb[0], sb[1]); }
    }
    const M = survivals.length;
    ends.sort((a, b) => a - b); const fs = fulfills.slice().sort((a, b) => a - b); breaches.sort((a, b) => a - b);
    return {
      track, paths: M,
      floorSurvivalRate: M ? survivals.reduce((a, c) => a + c, 0) / M : 0,
      avgFulfillment: M ? fulfills.reduce((a, c) => a + c, 0) / M : 1,
      fulfillment: { p10: percentile(fs, 10), p50: percentile(fs, 50), p90: percentile(fs, 90) },
      terminal: { p5: percentile(ends, 5), p50: percentile(ends, 50), p95: percentile(ends, 95), mean: mean(ends) },
      medianBreachAge: breaches.length ? plan.retireAge + percentile(breaches, 50) : null,
      earliestBreachAge: breaches.length ? plan.retireAge + breaches[0] : null,
      solventByYear: solventCount.map(c => M ? c / M : 0), years,
    };
  }

  /* ==================== 4.7 Rich-Broke-Dead（結合台灣生命表的長壽×破產機率） ====================
   * solventByYear：第 k 年仍有錢(地板未破)的路徑比例(來自 simulateRetirement)。
   * survivalByYear：第 k 年「仍存活」機率(由生命表 lx 推得，長度需 ≥ years)。UI 提供(資料可換官方生命表)。
   * 回傳每年 {age, rich:活著且有錢, broke:活著但破產, dead:已身故}，三者和=1。
   */
  function richBrokeDead(retireAge, solventByYear, survivalByYear) {
    const years = solventByYear.length; const out = [];
    for (let k = 0; k < years; k++) {
      const S = clamp(survivalByYear && survivalByYear[k] != null ? survivalByYear[k] : 1, 0, 1);
      const solv = clamp(solventByYear[k], 0, 1);
      out.push({ age: retireAge + k + 1, rich: S * solv, broke: S * (1 - solv), dead: 1 - S });
    }
    return out;
  }
  // 由年度死亡率 qx(自 retireAge 起) 推「仍存活」機率序列(長度 years)
  function survivalFromQx(qx, retireAge, years) {
    const out = []; let alive = 1;
    for (let k = 0; k < years; k++) { const q = qx[retireAge + k] != null ? qx[retireAge + k] : (qx[qx.length - 1] || 0.5); alive *= (1 - clamp(q, 0, 1)); out.push(alive); }
    return out;
  }

  /* ==================== 5. 蒙地卡羅退休存活率（v0 相容） ==================== */
  // 產生名目年報酬路徑：nominalMean, vol（皆年%）。回傳成功率、終值分位、枯竭年分布。
  // o: { initial, spend0, years, nominalMeanPct, volPct, inflationPct, strategy, strategyParams,
  //      pension, legacyTarget, N, seed }
  function monteCarloRetirement(o) {
    const N = o.N || 10000, years = Math.max(1, Math.round(o.years || 30));
    const mm = pctToRate(o.nominalMeanPct || 0), vol = pctToRate(o.volPct || 0);
    const rng = mulberry32((o.seed == null ? 20260807 : o.seed) >>> 0);
    const finals = new Array(N); const depletes = [];
    let success = 0;
    const base = Object.assign({
      initial: o.initial, spend0: o.spend0, inflationPct: o.inflationPct,
      pension: o.pension, legacyTarget: o.legacyTarget,
    }, o.strategyParams || {});
    for (let k = 0; k < N; k++) {
      const rets = new Array(years);
      for (let y = 0; y < years; y++) rets[y] = mm + vol * gauss(rng);
      const res = runStrategy(o.strategy || "constant", rets, base);
      finals[k] = Math.max(0, res.endBalance);
      if (res.success) success++;
      if (res.depletedYear) depletes.push(res.depletedYear);
    }
    finals.sort((a, b) => a - b);
    depletes.sort((a, b) => a - b);
    return {
      N, successRate: success / N,
      terminal: { p5: percentile(finals, 5), p25: percentile(finals, 25), p50: percentile(finals, 50),
                  p75: percentile(finals, 75), p95: percentile(finals, 95), mean: mean(finals) },
      failRate: 1 - success / N,
      medianDepletionYear: depletes.length ? percentile(depletes, 50) : null,
      earliestDepletionYear: depletes.length ? depletes[0] : null,
    };
  }

  // 累積期蒙地卡羅：幾歲能達 FI 的分布 / 指定年限內達標機率。
  // o: { initial, monthlyContribution, stepUpAnnualPct, nominalMeanPct, volPct, inflationPct,
  //      target(實質), maxYears, N, seed }
  function monteCarloAccumulate(o) {
    const N = o.N || 10000, maxY = Math.max(1, Math.round(o.maxYears || 60));
    const realMean = realFromNominal(o.nominalMeanPct, o.inflationPct);
    const mmM = annualToMonthly(realMean);
    // 波動也轉月（實質波動≈名目波動）
    const volM = pctToRate(o.volPct || 0) / Math.sqrt(12);
    const step = pctToRate(o.stepUpAnnualPct || 0);
    const rng = mulberry32((o.seed == null ? 20260807 : o.seed) >>> 0);
    const target = o.target || 0;
    const hitYears = []; let reached = 0;
    for (let k = 0; k < N; k++) {
      let bal = o.initial || 0, contrib = o.monthlyContribution || 0, hit = 0;
      const months = maxY * 12;
      for (let m = 1; m <= months; m++) {
        if (m > 1 && (m - 1) % 12 === 0) contrib *= (1 + step);
        const r = mmM + volM * gauss(rng);
        bal = bal * (1 + r) + contrib;
        if (!hit && bal >= target) { hit = m; break; }
      }
      if (hit) { reached++; hitYears.push(hit / 12); }
    }
    hitYears.sort((a, b) => a - b);
    return {
      N, reachRate: reached / N,
      years: hitYears.length ? {
        p10: percentile(hitYears, 10), p50: percentile(hitYears, 50), p90: percentile(hitYears, 90),
      } : null,
    };
  }

  /* ==================== 6. 歷史回測（序列風險） ==================== */
  // 吃「名目年報酬序列陣列」histStock[], histBond[]（等長，逐年），以 stockPct 配置合成投資組合，
  // 對每個可用起始年跑一次提領策略，回傳成功率與各起點終值。資料由 index.html 提供（可換官方來源）。
  // o: { initial, spend0, years, stockPct, inflationPct, strategy, strategyParams, pension, legacyTarget }
  function historicalBacktest(histStock, histBond, o) {
    const w = clamp(pctToRate(o.stockPct != null ? o.stockPct : 100), 0, 1);
    const years = Math.max(1, Math.round(o.years || 30));
    const n = Math.min(histStock.length, histBond.length);
    const starts = [];
    const base = Object.assign({
      initial: o.initial, spend0: o.spend0, inflationPct: o.inflationPct,
      pension: o.pension, legacyTarget: o.legacyTarget,
    }, o.strategyParams || {});
    let success = 0, total = 0;
    for (let s = 0; s + years <= n; s++) {
      const rets = new Array(years);
      for (let y = 0; y < years; y++) rets[y] = w * histStock[s + y] + (1 - w) * histBond[s + y];
      const res = runStrategy(o.strategy || "constant", rets, base);
      starts.push({ startIndex: s, endBalance: res.endBalance, success: res.success, depletedYear: res.depletedYear });
      if (res.success) success++; total++;
    }
    const ends = starts.map(x => Math.max(0, x.endBalance)).sort((a, b) => a - b);
    return {
      periods: total, successRate: total ? success / total : 0,
      worstEnd: ends.length ? ends[0] : 0, bestEnd: ends.length ? ends[ends.length - 1] : 0,
      medianEnd: percentile(ends, 50), starts,
    };
  }

  /* ==================== 7. 台灣三支柱（在地護城河） ==================== */
  // 7a. 勞保老年年金（月領）。展開版採 B 式：平均月投保薪資 × 年資 × 1.55%（法定給付率）。
  //   減額（未達法定年齡提前請領，每提前1年減4%，最多提前5年-20%）；展延（每延1年+4%，最多+20%）。
  //   avgInsuredSalary 上限級距（2025 約 45,800），此處吃已代入值，不強制上限。
  function laborInsurancePension(o) {
    // o: { avgInsuredSalary, insuredYears, claimAge, statutoryAge(預設65), earlyReduce(bool), deferIncrease(bool) }
    const base = (o.avgInsuredSalary || 0) * (o.insuredYears || 0) * 0.0155;
    const statutory = o.statutoryAge || 65;
    const claim = o.claimAge != null ? o.claimAge : statutory;
    let factor = 1;
    if (claim < statutory && o.earlyReduce !== false) {
      const early = clamp(statutory - claim, 0, 5);
      factor = 1 - 0.04 * early;
    } else if (claim > statutory && o.deferIncrease !== false) {
      const late = clamp(claim - statutory, 0, 5);
      factor = 1 + 0.04 * late;
    }
    const monthly = Math.max(0, base * factor);
    return { monthly, annual: monthly * 12, factor, formulaBase: base };
  }
  // 7b. 勞退新制個人專戶（月領）：雇主提繳 employerPct(≥6%)＋自願 voluntaryPct(0~6%) × 月薪，
  //   投資年化 investReturnPct 累積至請領年齡，再用預期餘命做年金化月領。
  function laborPensionNew(o) {
    // o: { monthlySalary, employerPct(6), voluntaryPct(0..6), years, investReturnPct, annuityYears(預期餘命，預設24=至85歲) }
    const contribRate = pctToRate((o.employerPct != null ? o.employerPct : 6) + (o.voluntaryPct || 0));
    const monthlyContrib = (o.monthlySalary || 0) * contribRate;
    const rm = annualToMonthly(pctToRate(o.investReturnPct != null ? o.investReturnPct : 3));
    const months = Math.round((o.years || 0) * 12);
    let bal = 0;
    for (let m = 1; m <= months; m++) bal = bal * (1 + rm) + monthlyContrib;
    // 年金化：以請領時預期餘命月數、同報酬率折算月領（等額年金）
    const annMonths = Math.round((o.annuityYears != null ? o.annuityYears : 24) * 12);
    const monthly = annMonths > 0
      ? (rm === 0 ? bal / annMonths : bal * rm / (1 - Math.pow(1 + rm, -annMonths)))
      : 0;
    return { accountBalance: bal, monthly, annual: monthly * 12, monthlyContrib };
  }
  // 7c. 國民年金老年年金（月領，簡化）：月投保金額(2025 約19,761) × 年資 × 1.3%（B式）+ 加計3,772（A式擇優概念，這裡取B式加基本）
  function nationalPension(o) {
    // o: { insuredAmount, insuredYears }
    const amt = o.insuredAmount != null ? o.insuredAmount : 19761;
    const monthly = amt * (o.insuredYears || 0) * 0.013;
    return { monthly: Math.max(0, monthly), annual: Math.max(0, monthly) * 12 };
  }
  // 7d. 合併台灣退休年金（法定年齡起，名目月領總額）→ 供提領策略的 pension.annualAmount 使用
  function taiwanPensionStack(o) {
    // o: { labor:{...}, laborNew:{...}, national:{...}|null }
    const li = o.labor ? laborInsurancePension(o.labor) : { monthly: 0 };
    const lp = o.laborNew ? laborPensionNew(o.laborNew) : { monthly: 0 };
    const np = o.national ? nationalPension(o.national) : { monthly: 0 };
    const monthly = li.monthly + lp.monthly + np.monthly;
    return { monthly, annual: monthly * 12, labor: li, laborNew: lp, national: np };
  }

  /* ==================== 8. 缺口分析（把未來年金折成「現在少存多少」） ==================== */
  // 未來從 startYear 起、每年領 pensionAnnual（隨通膨），折現到退休當下的現值，
  // 等於「因為有年金，FI 目標可以少準備」的金額。
  function pensionGapOffset(o) {
    // o: { pensionAnnual, yearsToPensionFromRetire, pensionYears, realDiscountPct, inflationPct }
    const rReal = pctToRate(o.realDiscountPct != null ? o.realDiscountPct : 3);
    const yStart = Math.max(0, o.yearsToPensionFromRetire || 0);
    const dur = Math.max(0, Math.round(o.pensionYears != null ? o.pensionYears : 20));
    let pv = 0;
    for (let k = 0; k < dur; k++) {
      const t = yStart + k;              // 退休後第 t 年領到（實質等額，因年金隨通膨）
      pv += (o.pensionAnnual || 0) / Math.pow(1 + rReal, t + 1);
    }
    return { presentValue: pv };
  }

  /* ==================== 9. 提領期稅費拖累（台灣，選用） ==================== */
  // 台灣個人證券交易所得不課稅；賣出課證交稅 0.3%；配息另有股利稅（沿用 ETF 引擎口徑）。
  // 這裡給「每年提領的有效拖累率」近似：僅對『被視為股利的部分』課稅。預設 0（多數人賣股提領≈免稅）。
  function withdrawalTaxDrag(annualWithdraw, o) {
    o = o || {};
    const divPortion = clamp(o.dividendPortion || 0, 0, 1); // 提領中屬股利現金流的比例
    const gross = annualWithdraw * divPortion;
    const c54 = (o.c54ratio == null ? 1 : o.c54ratio);
    const taxable = gross * c54;
    const mr = (o.marginalRate == null ? 0.05 : o.marginalRate);
    const combined = Math.max(0, taxable * mr - Math.min(taxable * 0.085, 80000));
    const separate = taxable * 0.28;
    let tax = Math.min(combined, separate);
    if (o.nhiEnabled && taxable >= 20000) tax += taxable * 0.0211;
    const stt = (annualWithdraw * (1 - divPortion)) * (o.sttRate == null ? 0.003 : o.sttRate); // 賣股證交稅
    return { tax: tax + stt, effectiveRate: annualWithdraw > 0 ? (tax + stt) / annualWithdraw : 0 };
  }

  /* ==================== 10.5 槓桿投資寬限期（比照 tools/compound 的寬限期算法） ==================== */
  // 累積期可選擇質押/融資借錢投資：寬限期內只繳息，期滿後改本息，月付金會「跳增」。
  // o:{ loanAmount, ratePct, years, graceYears, method }  method:"grace"|"annuity"|"interest"
  //   grace   ：寬限期內只繳息(P·i)，期滿後對剩餘期數本息平均攤還（會跳增）。
  //   annuity ：無寬限，全期本息平均（graceMonthly=afterGraceMonthly）。
  //   interest：全期只繳息，到期一次還本(氣球)。
  function _annuityPmt(bal, rate, n) {
    if (n <= 0) return bal;
    if (rate === 0) return bal / n;
    return bal * rate / (1 - Math.pow(1 + rate, -n));
  }
  function leverageLoan(o) {
    const P = o.loanAmount || 0, i = (o.ratePct || 0) / 1200, N = Math.max(1, Math.round((o.years || 0) * 12));
    const method = o.method || "grace";
    const g = (method === "grace") ? Math.max(0, Math.min(N - 1, Math.round((o.graceYears || 0) * 12))) : 0;
    const post = (method === "interest") ? 0 : _annuityPmt(P, i, Math.max(1, N - g));
    const pay = new Array(N), bals = new Array(N);
    let bal = P, totalInt = 0, firstPmt = 0, afterPmt = 0;
    for (let m = 1; m <= N; m++) {
      const interest = bal * i; let pmt, prin;
      if (method === "interest") { prin = (m === N) ? bal : 0; pmt = interest + prin; }
      else if (method === "grace" && m <= g) { prin = 0; pmt = interest; }
      else { pmt = post; prin = Math.min(bal, pmt - interest); if (prin < 0) prin = 0; }
      if (m === 1) firstPmt = pmt;
      if (m === g + 1) afterPmt = pmt;
      totalInt += interest; bal = Math.max(0, bal - prin); pay[m - 1] = pmt; bals[m - 1] = bal;
    }
    if (method !== "grace" || g === 0) afterPmt = firstPmt;
    return {
      graceMonthly: firstPmt, afterGraceMonthly: afterPmt, jump: Math.max(0, afterPmt - firstPmt),
      monthlyPay: pay, balance: bals, totalInterest: totalInt, months: N, graceMonths: g, loanAmount: P,
    };
  }
  // 槓桿後淨值累積：借款投入市場（initial+=P），每月照常投入；淨值 = 投資市值 − 借款餘額。
  // 回傳每年末淨值序列與「首次達標(≥target)」月數。
  function accumulateLeveraged(o) {
    const months = Math.max(0, Math.round(o.months || 0));
    const rm = annualToMonthly(pctToRate(o.realReturnPct || 0));
    const step = pctToRate(o.stepUpAnnualPct || 0);
    const lev = o.loan ? leverageLoan(o.loan) : null;
    let bal = (o.initial || 0) + (lev ? lev.loanAmount : 0);
    let contrib = o.monthlyContribution || 0;
    const yearEnd = []; let hitMonth = null;
    for (let m = 1; m <= months; m++) {
      if (m > 1 && (m - 1) % 12 === 0) contrib *= (1 + step);
      bal = bal * (1 + rm) + contrib;
      const loanBal = lev ? (m <= lev.months ? lev.balance[m - 1] : 0) : 0;
      const net = bal - loanBal;
      if (hitMonth === null && o.target != null && net >= o.target) hitMonth = m;
      if (m % 12 === 0) yearEnd.push(net);
    }
    return { yearEnd, hitMonth, lev };
  }

  return {
    // 基礎
    clamp, pctToRate, realFromNominal, annualToMonthly, mulberry32, gauss, mean, percentile,
    // 槓桿寬限期
    leverageLoan, accumulateLeveraged,
    // FI 與累積
    fiNumber, suggestSWR, accumulate, monthsToTarget, yearsFromSavingsRate,
    // FIRE 型態
    coastFire, baristaFire, fireVariants,
    // 提領策略
    withdrawConstant, withdrawFixedPct, withdrawGuytonKlinger, withdrawVPW, withdrawDynamic,
    runStrategy, STRATEGIES,
    // 逐年現金流(v2：地板/彈性、階段支出、多段收入) + 三軌模擬 + Rich-Broke-Dead
    runRetirementPath, glideStock, simulateRetirement, richBrokeDead, survivalFromQx,
    // 模擬
    monteCarloRetirement, monteCarloAccumulate, historicalBacktest,
    // 台灣三支柱
    laborInsurancePension, laborPensionNew, nationalPension, taiwanPensionStack,
    pensionGapOffset, withdrawalTaxDrag,
  };
});
