/* 取出網頁實際執行的引擎函式，不複製、不改寫。
   作法：把 index.html 的 <script> 原封不動放進 Node 的 vm，
   補上最小 DOM 樁，再把引擎函式輸出成 JSON。
   ——測的是「上線的那份程式」，不是它的副本。 */
const fs = require("fs"), path = require("path"), vm = require("vm");

const HTML = path.join(__dirname, "..", "tools", "compound", "index.html");
const src = fs.readFileSync(HTML, "utf8");
const js = src.split("<script>")[1].split("</script>")[0];

const noop = () => {};
const el = () => ({ textContent:"", innerHTML:"", style:{setProperty:noop},
  classList:{add:noop,remove:noop,toggle:noop,contains:()=>false},
  appendChild:noop, setAttribute:noop, offsetHeight:100, value:"" });

const sandbox = {
  console,
  document: { addEventListener:noop, getElementById:el, querySelector:el,
    querySelectorAll:()=>[], createElementNS:el,
    body:{classList:{add:noop,remove:noop,toggle:noop,contains:()=>false}},
    documentElement:{classList:{add:noop,toggle:noop},style:{setProperty:noop},lang:""} },
  window: { matchMedia:()=>({matches:false}) },
  navigator: { language:"zh-TW" },
  addEventListener: noop,
  matchMedia: () => ({ matches: false }),
  getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
  setTimeout, clearTimeout, Math, JSON, Date, parseFloat, Object, Array, String, Number
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
process.on("unhandledRejection", noop);

const EXPORT = `
;globalThis.__E__ = { DEF, DEBT_TYPES, divTaxRate, borrowedIn, colDebt0, openFees,
  bindingLines, layerPmt, pmtAfterGrace, stepLayer, rates, runDet, runMC, boundary, wan };`;

vm.runInContext(js + EXPORT, sandbox, { filename: "index.html:<script>" });
const E = sandbox.__E__;
if (!E) { console.error("無法取出引擎函式"); process.exit(1); }

/* ---------- 測試情境 ---------- */
const base = () => {
  const s = E.DEF();
  s.vol = 0;          // 關掉隨機性，走確定性路徑以便逐位元比對
  s.divYield = 0; s.fee = 0; s.nhi = false; s.divTax = "none";
  s.stepUp = 0; s.debts = [];
  return s;
};
const out = { generated:new Date().toISOString(), cases:{} };

/* 1. 單筆複利 */
{ const s = base(); s.mode="lump"; s.init=1000000; s.ret=6; s.years=10; s.freq=1;
  out.cases.lump_1M_6pct_10y_annual = E.runDet(s).assets; }
{ const s = base(); s.mode="lump"; s.init=1000000; s.ret=6; s.years=10; s.freq=12;
  out.cases.lump_1M_6pct_10y_monthly = E.runDet(s).assets; }
{ const s = base(); s.mode="lump"; s.init=5000000; s.ret=8; s.years=20; s.freq=1;
  out.cases.lump_5M_8pct_20y_annual = E.runDet(s).assets; }

/* 2. 定期定額 */
{ const s = base(); s.mode="dca"; s.monthly=10000; s.ret=6; s.years=10; s.freq=12;
  const r = E.runDet(s); out.cases.dca_10k_6pct_10y = r.assets; out.cases.dca_10k_own = r.ownIn; }
{ const s = base(); s.mode="dca"; s.monthly=30000; s.ret=5; s.years=30; s.freq=12;
  out.cases.dca_30k_5pct_30y = E.runDet(s).assets; }

/* 3. 混合 */
{ const s = base(); s.mode="mix"; s.init=1000000; s.monthly=10000; s.ret=6; s.years=10; s.freq=12;
  out.cases.mix_1M_10k_6pct_10y = E.runDet(s).assets; }

/* 4. 攤還月付金 */
const L = (t,a,r,y,m,g) => ({type:t,amount:a,rate:r,years:y,method:m,grace:g||0,invest:false,call:0,sell:0,fee:0});
out.cases.pmt_mortgage_5M_2p35_30y = E.layerPmt(L("mortgage",5000000,2.35,30,"annuity"));
out.cases.pmt_credit_1M_5p5_7y     = E.layerPmt(L("credit",1000000,5.5,7,"annuity"));
out.cases.pmt_interest_2M_3p2      = E.layerPmt(L("pledge",2000000,3.2,1,"interest"));
out.cases.pmt_principal_1M_5_5y    = E.layerPmt(L("car",1000000,5,5,"principal"));
out.cases.pmt_grace_5M_2p35_30y_g3 = E.layerPmt(L("mortgage",5000000,2.35,30,"grace",3));
out.cases.pmt_after_grace          = E.pmtAfterGrace(L("mortgage",5000000,2.35,30,"grace",3));

/* 5. 攤還表首期拆分 */
{ const d = L("mortgage",5000000,2.35,30,"annuity"); const r = E.stepLayer(d,5000000,0);
  out.cases.amort_m1_interest = r.int; out.cases.amort_m1_principal = r.prin; out.cases.amort_m1_balance = r.bal; }
{ const d = L("mortgage",5000000,2.35,30,"annuity"); let b=5000000;
  for(let m=0;m<12;m++) b = E.stepLayer(d,b,m).bal;
  out.cases.amort_balance_after_12m = b; }

/* 6. 擔保維持率與邊界 */
{ const s = base(); s.mode="lump"; s.init=3000000; s.cash=600000;
  s.debts=[{type:"pledge",amount:2000000,rate:3.2,years:1,method:"interest",grace:0,
    invest:true,call:140,sell:130,fee:0}];
  const det=E.runDet(s), bd=E.boundary(s,det);
  out.cases.margin_ratio = bd.ratio; out.cases.margin_to_call = bd.toCall;
  out.cases.margin_to_sell = bd.toSell; out.cases.margin_months = bd.months; }

/* 7. 稅務 */
out.cases.tax_combined_12pct = E.divTaxRate({divTax:"combined",bracket:12});
out.cases.tax_combined_40pct = E.divTaxRate({divTax:"combined",bracket:40});
out.cases.tax_separate       = E.divTaxRate({divTax:"separate"});
out.cases.tax_none           = E.divTaxRate({divTax:"none"});

/* 8. 複利頻率換算 */
[1,2,4,12,365].forEach(f=>{ const s=base(); s.ret=6; s.freq=f;
  out.cases["eff_rate_freq_"+f] = E.rates(s).priceM; });

/* 9. 費用與稅同時作用 */
{ const s = base(); s.mode="lump"; s.init=1000000; s.ret=7; s.years=20; s.freq=12;
  s.divYield=3.2; s.fee=0.45; s.divTax="combined"; s.bracket=12; s.nhi=true;
  const r=E.runDet(s);
  out.cases.full_assets=r.assets; out.cases.full_fee=r.feeP;
  out.cases.full_tax=r.taxP; out.cases.full_nhi=r.nhiP; }

/* 10. 蒙地卡羅可重現性 */
{ const s=E.DEF(); const a=E.runMC(s,1000), b=E.runMC(s,1000);
  out.cases.mc_reproducible = (a.p50===b.p50 && a.p10===b.p10 && a.p90===b.p90);
  out.cases.mc_p50 = a.p50; out.cases.mc_p10 = a.p10; out.cases.mc_p90 = a.p90;
  out.cases.mc_ordered = (a.p10 <= a.p50 && a.p50 <= a.p90);
  out.cases.mc_callprob = a.callProb; }
{ const s=E.DEF(); s.vol=0; const z=E.runMC(s,200); const d=E.runDet(s);
  out.cases.mc_zero_vol_matches_det = Math.abs(z.p50-(d.assets-d.debtEnd))/Math.abs(d.assets-d.debtEnd); }

/* 11. 真實世界對照（房貸小幫手 App：500 萬 / 2.8% / 20 年）*/
out.cases.ref_500w_2p8_20y_normal   = E.layerPmt(L("mortgage",5000000,2.8,20,"annuity"));
out.cases.ref_500w_2p8_20y_grace    = E.layerPmt(L("mortgage",5000000,2.8,20,"grace",3));
out.cases.ref_500w_2p8_20y_after    = E.pmtAfterGrace(L("mortgage",5000000,2.8,20,"grace",3));

/* 12. 邊界輸入 */
{ const s=base(); s.mode="lump"; s.init=0; s.years=1; out.cases.edge_zero_init = E.runDet(s).assets; }
{ const s=base(); s.mode="lump"; s.init=1000000; s.ret=0; s.years=10;
  out.cases.edge_zero_return = E.runDet(s).assets; }
out.cases.edge_zero_rate_pmt = E.layerPmt(L("mortgage",1200000,0,10,"annuity"));

fs.writeFileSync(path.join(__dirname,"js_results.json"), JSON.stringify(out,null,2));
console.log("✓ 已從網頁擷取引擎並產生 " + Object.keys(out.cases).length + " 筆結果 → js_results.json");
