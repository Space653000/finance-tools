/* 大規模掃描：系統性列舉 + 亂數取樣，兩者都用固定種子確保可重現。
   產出 cases.json（供 Python 讀同一批案例）與 js_sweep.json（網頁引擎結果）。 */
const fs=require("fs"),path=require("path"),vm=require("vm");
const src=fs.readFileSync(path.join(__dirname,"..","tools","compound","index.html"),"utf8");
const js=src.split("<script>")[1].split("</script>")[0];
const noop=()=>{},el=()=>({textContent:"",innerHTML:"",style:{setProperty:noop},
  classList:{add:noop,remove:noop,toggle:noop,contains:()=>false},appendChild:noop,setAttribute:noop,offsetHeight:100,value:""});
const sb={console,document:{addEventListener:noop,getElementById:el,querySelector:el,querySelectorAll:()=>[],
  createElementNS:el,body:{classList:{add:noop,remove:noop,toggle:noop,contains:()=>false}},
  documentElement:{classList:{add:noop,toggle:noop},style:{setProperty:noop},lang:""}},
  window:{matchMedia:()=>({matches:false})},navigator:{language:"zh-TW"},addEventListener:noop,
  matchMedia:()=>({matches:false}),getComputedStyle:()=>({getPropertyValue:()=>"#000"}),
  setTimeout,clearTimeout,Math,JSON,Date,parseFloat,Object,Array,String,Number};
sb.globalThis=sb; vm.createContext(sb); process.on("unhandledRejection",noop);
vm.runInContext(js+`;globalThis.__E__={DEF,DEBT_TYPES,layerPmt,pmtAfterGrace,stepLayer,rates,runDet,runMC,boundary,divTaxRate};`,sb);
const E=sb.__E__;

/* 固定種子亂數，Python 端不需重現此序列（案例已寫成檔） */
let seed=20260801;
const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
const pick=a=>a[Math.floor(rnd()*a.length)];
const round=(v,s)=>Math.round(v/s)*s;

const DKEYS=["pledge","margin","mortgage","heloc","credit","car"];
const MKEYS=["annuity","principal","interest","grace"];
const mkDebt=(type,amount,rate,years,method,grace,invest)=>{
  const T=E.DEBT_TYPES[type];
  return {type,amount,rate,years,method,grace,invest,
    call:T.call||0,sell:T.sell||0,fee:0};
};

const cases=[];

/* ---- A. 系統性列舉：模式 × 借款類型 × 還款方式 × 寬限 × 是否投入 ---- */
for(const mode of ["lump","dca","mix"])
 for(const type of DKEYS)
  for(const method of MKEYS)
   for(const grace of [0,3])
    for(const invest of [true,false]){
      if(method!=="grace"&&grace>0) continue;
      for(const [init,monthly,years,ret] of [[3000000,12000,20,6.5],[500000,30000,10,4],[10000000,0,30,8]]){
        const s=E.DEF();
        Object.assign(s,{mode,init,monthly,years,ret,vol:20,infl:2,freq:12,
          divYield:3.2,fee:0.45,divTax:"combined",bracket:12,nhi:true,
          income:120000,cash:600000,stepUp:0,
          debts:[mkDebt(type,2000000,E.DEBT_TYPES[type].rate,
            method==="interest"?1:Math.min(20,years),method,grace,invest)]});
        cases.push(s);
      }
    }

/* ---- B. 多筆借款疊加：2~4 筆隨機組合 ---- */
for(let k=0;k<2200;k++){
  const s=E.DEF();
  const n=2+Math.floor(rnd()*3);
  const debts=[];
  for(let j=0;j<n;j++){
    const type=pick(DKEYS), method=pick(MKEYS);
    debts.push(mkDebt(type,round(200000+rnd()*8000000,100000),
      round(1+rnd()*9,0.05),1+Math.floor(rnd()*30),method,
      method==="grace"?Math.floor(rnd()*5):0,rnd()<0.5));
  }
  Object.assign(s,{mode:pick(["lump","dca","mix"]),
    init:round(rnd()*15000000,50000),monthly:round(rnd()*150000,1000),
    years:1+Math.floor(rnd()*40),ret:round(rnd()*20,0.1),vol:round(rnd()*45,1),
    infl:round(rnd()*8,0.1),freq:pick([1,2,4,12,365]),
    divYield:round(rnd()*10,0.1),fee:round(rnd()*3,0.01),
    divTax:pick(["combined","separate","none"]),bracket:pick([5,12,20,30,40]),
    nhi:rnd()<0.5,income:round(rnd()*400000,5000),cash:round(rnd()*8000000,50000),
    stepUp:round(rnd()*15,0.5),debts});
  cases.push(s);
}

/* ---- C. 純參數掃描（無借款），覆蓋所有數值邊界 ---- */
for(let k=0;k<8200;k++){
  const s=E.DEF();
  Object.assign(s,{mode:pick(["lump","dca","mix"]),
    init:round(rnd()*20000000,50000),monthly:round(rnd()*300000,1000),
    years:1+Math.floor(rnd()*40),ret:round(rnd()*20,0.1),vol:round(rnd()*45,1),
    infl:round(rnd()*8,0.1),freq:pick([1,2,4,12,365]),
    divYield:round(rnd()*10,0.1),fee:round(rnd()*3,0.01),
    divTax:pick(["combined","separate","none"]),bracket:pick([5,12,20,30,40]),
    nhi:rnd()<0.5,income:round(rnd()*500000,5000),cash:round(rnd()*10000000,50000),
    stepUp:round(rnd()*15,0.5),debts:[]});
  cases.push(s);
}

/* ---- D. 極端與邊界值 ---- */
const edge=[];
for(const init of [0,1,20000000]) for(const monthly of [0,1,300000])
 for(const years of [1,40]) for(const ret of [0,20]) for(const freq of [1,365])
  for(const vol of [0,45]){
    const s=E.DEF();
    Object.assign(s,{mode:"mix",init,monthly,years,ret,vol,infl:0,freq,
      divYield:0,fee:0,divTax:"none",bracket:5,nhi:false,
      income:0,cash:0,stepUp:0,debts:[]});
    edge.push(s);
  }
cases.push(...edge);

/* ---- E. 额外还款专项（仅攤還型借款）---- */
const extraCases=[];
const amMethods=["annuity","principal","grace"];
for(let k=0;k<800;k++){
  const s=E.DEF();
  const method=pick(amMethods);
  const years=5+Math.floor(rnd()*30);
  const n=Math.floor(rnd()*6); // 0~5 次额外还款
  const extra=[];
  for(let j=0;j<n;j++){
    extra.push({month:Math.floor(rnd()*years*12),amount:round(50000+rnd()*2000000,10000)});
  }
  const d=mkDebt("mortgage",round(1000000+rnd()*9000000,100000),
    round(1+rnd()*5,0.05),years,method,method==="grace"?Math.floor(rnd()*4):0,rnd()<0.5);
  d.extra=extra;
  Object.assign(s,{mode:pick(["lump","dca","mix"]),
    init:round(rnd()*10000000,50000),monthly:round(rnd()*100000,1000),
    years:1+Math.floor(rnd()*40),ret:round(rnd()*15,0.1),vol:round(rnd()*40,1),
    infl:round(rnd()*6,0.1),freq:pick([1,12]),divYield:round(rnd()*8,0.1),
    fee:round(rnd()*2,0.01),divTax:pick(["combined","separate","none"]),
    bracket:pick([5,12,20,30,40]),nhi:rnd()<0.5,income:round(rnd()*300000,5000),
    cash:round(rnd()*5000000,50000),stepUp:0,debts:[d]});
  extraCases.push(s);
}
cases.push(...extraCases);

/* ---- 執行 ---- */
const out=[];
for(let i=0;i<cases.length;i++){
  const s=cases[i];
  const d=E.runDet(s), b=E.boundary(s,d);
  out.push({i,
    assets:d.assets, debtEnd:d.debtEnd, net:d.net, ownIn:d.ownIn,
    intP:d.intP, prinP:d.prinP, feeP:d.feeP, taxP:d.taxP, nhiP:d.nhiP,
    firstPay:d.firstPay, borrowed:d.borrowed,
    pathLen:d.path.length, pathLast:d.path[d.path.length-1].assets,
    ratio:b?b.ratio:null, toCall:b?b.toCall:null, toSell:b?b.toSell:null,
    pmts:s.debts.map(x=>E.layerPmt(x)),
    pmtsAfterGrace:s.debts.map(x=>E.pmtAfterGrace(x))});
}
fs.writeFileSync(path.join(__dirname,"cases.json"),JSON.stringify(cases));
fs.writeFileSync(path.join(__dirname,"js_sweep.json"),JSON.stringify(out));
console.log(`✓ 產生 ${cases.length.toLocaleString()} 組案例並由網頁引擎完成計算`);
console.log(`  A 系統列舉 ${3*6*4*3-0} 類 × 3 組參數  B 多筆疊加 2,200  C 純參數 8,200  D 邊界 ${edge.length}`);
