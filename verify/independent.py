# -*- coding: utf-8 -*-
"""
獨立實作：不參考 index.html 的 JavaScript，直接依金融數學公式重寫。
兩份實作若一致，代表程式符合規格；若不一致，至少有一邊錯，必須查明。
另有第三方檢查：closed_form（封閉解）與 Excel 內建財務函式。
"""
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
import json, math, os

# ---------- 攤還 ----------
def pmt_annuity(P, annual_rate, years):
    """本息平均攤還月付金。標準年金現值公式，與 Excel PMT 同源。"""
    i = annual_rate / 100 / 12
    n = round(years * 12)
    if i == 0:
        return P / n
    return P * i / (1 - (1 + i) ** (-n))

def pmt_interest_only(P, annual_rate):
    return P * annual_rate / 100 / 12

def pmt_equal_principal_first(P, annual_rate, years):
    """本金平均攤還第一期（本金固定＋當期利息）"""
    n = round(years * 12)
    return P / n + P * annual_rate / 100 / 12

def pmt_after_grace(P, annual_rate, years, grace_years):
    """寬限期屆滿後之月付金：以剩餘期數重新計算年金"""
    i = annual_rate / 100 / 12
    n = round(years * 12); g = round(grace_years * 12)
    m = max(1, n - g)
    if i == 0:
        return P / m
    return P * i / (1 - (1 + i) ** (-m))

def amort_schedule(P, annual_rate, years, months):
    """逐期攤還，回傳 (首期利息, 首期本金, 首期後餘額, 第 months 期後餘額)"""
    i = annual_rate / 100 / 12
    n = round(years * 12)
    pmt = pmt_annuity(P, annual_rate, years)
    bal = P; first = None
    for m in range(months):
        interest = bal * i
        principal = pmt - interest
        if m == n - 1:
            principal = bal
        principal = max(0.0, min(bal, principal))
        bal -= principal
        if m == 0:
            first = (interest, principal, bal)
    return first[0], first[1], first[2], bal

# ---------- 報酬 ----------
def effective_annual(nominal_pct, freq):
    """名目年利率換算為年有效報酬率"""
    return (1 + nominal_pct / 100 / freq) ** freq - 1

def monthly_price_rate(nominal_pct, freq, div_yield_pct=0.0):
    """扣除配息後的月價差報酬率"""
    ae = effective_annual(nominal_pct, freq)
    price_annual = ae - div_yield_pct / 100
    return (1 + max(0.01, 1 + price_annual) - 1) ** (1 / 12) - 1

def div_tax_rate(mode, bracket_pct=0):
    """股利有效稅率。合併計稅可按 8.5% 計算可抵減稅額。"""
    if mode == "none":
        return 0.0
    if mode == "separate":
        return 0.28
    return max(0.0, bracket_pct / 100 - 0.085)

def simulate(mode, init, monthly, ret_pct, years, freq,
             div_yield=0.0, fee_pct=0.0, tax_mode="none", bracket=0, nhi=False):
    """逐月模擬。順序：成長 → 扣內扣費用 → 配息與課稅 → 投入"""
    months = round(years * 12)
    ae = effective_annual(ret_pct, freq)
    price_annual = ae - div_yield / 100
    price_m = max(0.01, 1 + price_annual) ** (1 / 12) - 1
    fee_m = max(0.01, 1 - fee_pct / 100) ** (1 / 12)
    div_m = div_yield / 100 / 12
    tr = div_tax_rate(tax_mode, bracket)

    assets = init if mode != "dca" else 0.0
    own = assets
    fee_paid = tax_paid = nhi_paid = 0.0
    for m in range(months):
        b0 = assets
        assets *= (1 + price_m)
        fee = assets * (1 - fee_m); fee_paid += fee; assets -= fee
        div = b0 * div_m
        tax = div * tr; tax_paid += tax
        nh = div * 0.0211 if (nhi and div * 12 >= 20000) else 0.0
        nhi_paid += nh
        assets += div - tax - nh
        if mode != "lump":
            assets += monthly; own += monthly
    return dict(assets=assets, own=own, fee=fee_paid, tax=tax_paid, nhi=nhi_paid)

# ---------- 擔保 ----------
def margin(collateral_value, secured_debt, call_pct, sell_pct, cash, monthly_pay):
    ratio = collateral_value / secured_debt * 100
    to_call = (1 - (call_pct / 100) * secured_debt / collateral_value) * 100
    to_sell = (1 - (sell_pct / 100) * secured_debt / collateral_value) * 100
    months = cash / monthly_pay if monthly_pay > 0 else float("inf")
    return dict(ratio=ratio, to_call=to_call, to_sell=to_sell, months=months)

# ---------- 封閉解（第三方獨立驗算） ----------
def closed_form_lump(P, rate_pct, years, freq):
    """單筆終值封閉解：FV = P(1+r_eff)^n"""
    return P * (1 + effective_annual(rate_pct, freq)) ** years

def closed_form_dca(PMT, rate_pct, years, freq):
    """期末年金終值封閉解：FV = PMT·((1+i)^n − 1)/i"""
    i = (1 + effective_annual(rate_pct, freq)) ** (1 / 12) - 1
    n = round(years * 12)
    return PMT * ((1 + i) ** n - 1) / i

# ================= 產生結果 =================
R = {}
R["lump_1M_6pct_10y_annual"]  = simulate("lump",1_000_000,0,6,10,1)["assets"]
R["lump_1M_6pct_10y_monthly"] = simulate("lump",1_000_000,0,6,10,12)["assets"]
R["lump_5M_8pct_20y_annual"]  = simulate("lump",5_000_000,0,8,20,1)["assets"]
_d = simulate("dca",0,10_000,6,10,12)
R["dca_10k_6pct_10y"] = _d["assets"]; R["dca_10k_own"] = _d["own"]
R["dca_30k_5pct_30y"] = simulate("dca",0,30_000,5,30,12)["assets"]
R["mix_1M_10k_6pct_10y"] = simulate("mix",1_000_000,10_000,6,10,12)["assets"]

R["pmt_mortgage_5M_2p35_30y"] = pmt_annuity(5_000_000,2.35,30)
R["pmt_credit_1M_5p5_7y"]     = pmt_annuity(1_000_000,5.5,7)
R["pmt_interest_2M_3p2"]      = pmt_interest_only(2_000_000,3.2)
R["pmt_principal_1M_5_5y"]    = pmt_equal_principal_first(1_000_000,5,5)
R["pmt_after_grace"]          = pmt_after_grace(5_000_000,2.35,30,3)
R["edge_zero_rate_pmt"]       = pmt_annuity(1_200_000,0,10)

i1,p1,b1,b12 = amort_schedule(5_000_000,2.35,30,12)
R["amort_m1_interest"]=i1; R["amort_m1_principal"]=p1
R["amort_m1_balance"]=b1;  R["amort_balance_after_12m"]=b12

mg = margin(5_000_000,2_000_000,140,130,600_000,pmt_interest_only(2_000_000,3.2))
R["margin_ratio"]=mg["ratio"]; R["margin_to_call"]=mg["to_call"]
R["margin_to_sell"]=mg["to_sell"]; R["margin_months"]=mg["months"]

R["tax_combined_12pct"]=div_tax_rate("combined",12)
R["tax_combined_40pct"]=div_tax_rate("combined",40)
R["tax_separate"]=div_tax_rate("separate"); R["tax_none"]=div_tax_rate("none")

for f in (1,2,4,12,365):
    R[f"eff_rate_freq_{f}"] = max(0.01,1+effective_annual(6,f))**(1/12)-1

_f = simulate("lump",1_000_000,0,7,20,12,div_yield=3.2,fee_pct=0.45,
              tax_mode="combined",bracket=12,nhi=True)
R["full_assets"]=_f["assets"]; R["full_fee"]=_f["fee"]
R["full_tax"]=_f["tax"];       R["full_nhi"]=_f["nhi"]

R["ref_500w_2p8_20y_normal"] = pmt_annuity(5_000_000,2.8,20)
R["ref_500w_2p8_20y_grace"]  = pmt_interest_only(5_000_000,2.8)
R["ref_500w_2p8_20y_after"]  = pmt_after_grace(5_000_000,2.8,20,3)

R["edge_zero_init"]   = simulate("lump",0,0,6.5,1,12)["assets"]
R["edge_zero_return"] = simulate("lump",1_000_000,0,0,10,12)["assets"]

CF = {
 "lump_1M_6pct_10y_annual":  closed_form_lump(1_000_000,6,10,1),
 "lump_1M_6pct_10y_monthly": closed_form_lump(1_000_000,6,10,12),
 "lump_5M_8pct_20y_annual":  closed_form_lump(5_000_000,8,20,1),
 "dca_10k_6pct_10y":         closed_form_dca(10_000,6,10,12),
 "dca_30k_5pct_30y":         closed_form_dca(30_000,5,30,12),
 "amort_m1_interest":        5_000_000*0.0235/12,
 "margin_ratio":             5_000_000/2_000_000*100,
 "margin_to_call":           (1-1.40*2_000_000/5_000_000)*100,
 "margin_to_sell":           (1-1.30*2_000_000/5_000_000)*100,
 "margin_months":            600_000/(2_000_000*0.032/12),
 "tax_combined_12pct":       0.12-0.085,
 "edge_zero_rate_pmt":       1_200_000/120,
 "pmt_interest_2M_3p2":      2_000_000*0.032/12,
 "pmt_principal_1M_5_5y":    1_000_000/60 + 1_000_000*0.05/12,
 # 第三方 App「房貸小幫手」實際顯示值（四捨五入至整數）
 "ref_500w_2p8_20y_normal":  27232.0,
 "ref_500w_2p8_20y_grace":   11666.67,
 "ref_500w_2p8_20y_after":   30832.0,
}

with open(os.path.join(os.path.dirname(__file__),"py_results.json"),"w",encoding="utf-8") as f:
    json.dump({"cases":R,"closed_form":CF}, f, indent=2, ensure_ascii=False)
print(f"✓ 獨立實作完成 {len(R)} 筆，封閉解 {len(CF)} 筆 → py_results.json")
