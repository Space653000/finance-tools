# -*- coding: utf-8 -*-
"""獨立 Python 引擎（含借款層），逐案與網頁引擎比對。
   依 references/formulas.md 的規格重新實作，不參考 index.html 的 JavaScript。"""
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
import json, math, os, sys
D = os.path.dirname(os.path.abspath(__file__))

DEBT_META = {  # 僅需知道哪些類型計入擔保
 "pledge":dict(collateral=True), "margin":dict(collateral=True),
 "mortgage":dict(collateral=False), "heloc":dict(collateral=False),
 "credit":dict(collateral=False), "car":dict(collateral=False)}

# ---------- 借款 ----------
def layer_pmt(d):
    """月付金。寬限期內僅計利息；其餘依還款方式。"""
    i = d["rate"]/100/12
    n = max(1, round(d["years"]*12))
    m = d["method"]
    if m == "interest":
        return d["amount"]*i
    if m == "grace":
        if (d.get("grace") or 0) > 0:
            return d["amount"]*i
        return d["amount"]/n if i == 0 else d["amount"]*i/(1-(1+i)**-n)
    if m == "principal":
        return d["amount"]/n + d["amount"]*i
    return d["amount"]/n if i == 0 else d["amount"]*i/(1-(1+i)**-n)

def pmt_after_grace(d):
    if d["method"] != "grace":
        return layer_pmt(d)
    i = d["rate"]/100/12
    n = max(1, round(d["years"]*12)); g = round((d.get("grace") or 0)*12)
    m = max(1, n-g)
    return d["amount"]/m if i == 0 else d["amount"]*i/(1-(1+i)**-m)

def step_layer(d, bal, m):
    """單期攤還。回傳 (利息, 本金, 期末餘額)"""
    i = d["rate"]/100/12
    n = max(1, round(d["years"]*12))
    g = round((d.get("grace") or 0)*12) if d["method"] == "grace" else 0
    if bal <= 0:
        return 0.0, 0.0, 0.0
    interest = bal*i
    if d["method"] == "interest" or (d["method"] == "grace" and m < g):
        principal = bal if m >= n-1 else 0.0
    elif d["method"] == "principal":
        principal = min(bal, d["amount"]/n)
    else:
        mm = max(1, n-g) if d["method"] == "grace" else n
        p = d["amount"]/mm if i == 0 else d["amount"]*i/(1-(1+i)**-mm)
        principal = max(0.0, min(bal, p-interest))
    if m >= n-1:
        principal = bal
    return interest, principal, bal-principal

# ---------- 稅與報酬 ----------
def div_tax_rate(s):
    if s["divTax"] == "none": return 0.0
    if s["divTax"] == "separate": return 0.28
    return max(0.0, s["bracket"]/100 - 0.085)

def rates(s):
    ae = (1 + s["ret"]/100/s["freq"])**s["freq"] - 1
    dv = s["divYield"]/100
    price_m = max(0.01, 1 + ae - dv)**(1/12) - 1
    fee_m   = max(0.01, 1 - s["fee"]/100)**(1/12)
    return price_m, fee_m, dv/12

# ---------- 主模擬 ----------
def run_det(s):
    months = round(s["years"]*12)
    price_m, fee_m, div_m = rates(s)
    use_i = s["mode"] != "dca"; use_m = s["mode"] != "lump"
    borrowed = sum(d["amount"] for d in s["debts"] if d["invest"])
    a = (s["init"] if use_i else 0) + borrowed
    bals = [d["amount"] for d in s["debts"]]
    own = s["init"] if use_i else 0
    int_p = prin_p = fee_p = tax_p = nhi_p = 0.0
    tr = div_tax_rate(s)
    path_len = 1
    for m in range(months):
        b0 = a
        a *= (1 + price_m)
        f = a*(1 - fee_m); fee_p += f; a -= f
        dv = b0*div_m
        tx = dv*tr; tax_p += tx
        nh = dv*0.0211 if (s["nhi"] and dv*12 >= 20000) else 0.0
        nhi_p += nh
        a += dv - tx - nh
        if use_m:
            c = s["monthly"]*(1 + s["stepUp"]/100)**(m//12)
            a += c; own += c
        for k, d in enumerate(s["debts"]):
            it, pr, nb = step_layer(d, bals[k], m)
            bals[k] = nb; int_p += it; prin_p += pr
        if (m+1) % 12 == 0 or m == months-1:
            path_len += 1
    debt_end = sum(bals)
    return dict(assets=a, debtEnd=debt_end, net=a-debt_end, ownIn=own,
                intP=int_p, prinP=prin_p, feeP=fee_p, taxP=tax_p, nhiP=nhi_p,
                firstPay=sum(layer_pmt(d) for d in s["debts"]),
                borrowed=borrowed, pathLen=path_len, pathLast=a)

def boundary(s, det):
    cd = sum(d["amount"] for d in s["debts"] if DEBT_META[d["type"]]["collateral"])
    a0 = (s["init"] if s["mode"] != "dca" else 0) + det["borrowed"]
    if cd <= 0 or a0 <= 0:
        return None
    call = max([d["call"] or 0 for d in s["debts"] if DEBT_META[d["type"]]["collateral"]] or [0]) or 130
    sell = max([d["sell"] or 0 for d in s["debts"] if DEBT_META[d["type"]]["collateral"]] or [0]) or 120
    return dict(ratio=a0/cd*100,
                toCall=(1-(call/100)*cd/a0)*100,
                toSell=(1-(sell/100)*cd/a0)*100)

# ================= 比對 =================
cases = json.load(open(os.path.join(D,"cases.json"), encoding="utf-8"))
jsr   = json.load(open(os.path.join(D,"js_sweep.json"), encoding="utf-8"))
assert len(cases) == len(jsr)

FIELDS = ["assets","debtEnd","net","ownIn","intP","prinP","feeP","taxP","nhiP",
          "firstPay","borrowed","pathLen","pathLast"]
TOL = 1e-9
def rel(a,b):
    if a == b: return 0.0
    m = max(abs(a),abs(b))
    return abs(a-b)/m if m > 1e-12 else abs(a-b)

fails, worst, worst_info = 0, 0.0, None
inv_fail = {"非負資產":0,"淨值恆等":0,"本息合計":0,"路徑長度":0,"投入本金":0,"維持率":0,"寬限跳增":0}

for idx,(s,j) in enumerate(zip(cases,jsr)):
    p = run_det(s); b = boundary(s,p)
    for f in FIELDS:
        r = rel(float(p[f]), float(j[f]))
        if r > worst: worst, worst_info = r, (idx,f,p[f],j[f])
        if r > TOL: fails += 1
    for f,pv in (("ratio",b["ratio"] if b else None),
                 ("toCall",b["toCall"] if b else None),
                 ("toSell",b["toSell"] if b else None)):
        jv = j[f]
        if (pv is None) != (jv is None): fails += 1; continue
        if pv is not None:
            r = rel(pv,jv)
            if r > worst: worst, worst_info = r,(idx,f,pv,jv)
            if r > TOL: fails += 1
    for k,d in enumerate(s["debts"]):
        for fn,jv in (("pmt",j["pmts"][k]),("after",j["pmtsAfterGrace"][k])):
            pv = layer_pmt(d) if fn=="pmt" else pmt_after_grace(d)
            r = rel(pv,jv)
            if r > worst: worst, worst_info = r,(idx,fn,pv,jv)
            if r > TOL: fails += 1

    # ---- 不變量（無論實作為何都必須成立）----
    if p["assets"] < -1e-6: inv_fail["非負資產"] += 1
    if abs(p["net"] - (p["assets"]-p["debtEnd"])) > 1e-6: inv_fail["淨值恆等"] += 1
    tot = sum(d["amount"] for d in s["debts"])
    if p["prinP"] - tot > 1e-3: inv_fail["本息合計"] += 1
    if p["pathLen"] != round(s["years"])+1: inv_fail["路徑長度"] += 1
    exp_own = (s["init"] if s["mode"]!="dca" else 0) + (
        sum(s["monthly"]*(1+s["stepUp"]/100)**(m//12) for m in range(round(s["years"]*12)))
        if s["mode"]!="lump" else 0)
    if rel(p["ownIn"],exp_own) > 1e-9: inv_fail["投入本金"] += 1
    if b and not (b["toCall"] <= b["toSell"] + 1e-9): inv_fail["維持率"] += 1
    for d in s["debts"]:
        if d["method"]=="grace" and (d.get("grace") or 0)>0:
            if pmt_after_grace(d) < layer_pmt(d) - 1e-9: inv_fail["寬限跳增"] += 1

print("="*80)
print(f"  大規模掃描驗證　{len(cases):,} 組案例")
print("="*80)
n_num = len(cases)*len(FIELDS) + sum(len(s["debts"])*2 for s in cases)
print(f"數值比對點數　　　約 {n_num:,} 個")
print(f"不一致（>1e-9）　 {fails} 個")
if worst_info:
    i,f,a,b_ = worst_info
    print(f"最大相對誤差　　　{worst:.3e}　案例#{i} 欄位 {f}")
    print(f"                  Python {a!r}")
    print(f"                  網頁   {b_!r}")
print("-"*80)
print("不變量檢查（與實作無關，數學上必須成立）")
for k,v in inv_fail.items():
    print(f"{'✅' if v==0 else '❌'} {k:<10} 違反 {v} 次")
print("="*80)
bad = fails + sum(inv_fail.values())
print(f"總計不合格：{bad}")
print("="*80)
sys.exit(1 if bad else 0)
