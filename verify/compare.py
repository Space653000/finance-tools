# -*- coding: utf-8 -*-
"""三方比對：網頁引擎 (JS) × 獨立實作 (Python) × 封閉解 / Excel"""
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
import json, os, sys
D = os.path.dirname(os.path.abspath(__file__))
js = json.load(open(os.path.join(D,"js_results.json"),encoding="utf-8"))["cases"]
pj = json.load(open(os.path.join(D,"py_results.json"),encoding="utf-8"))
py, cf = pj["cases"], pj["closed_form"]

TOL = 1e-6      # 相對誤差容許值（百萬分之一）
rows, fails, warns = [], 0, 0

def rel(a,b):
    if a==b: return 0.0
    d = max(abs(a),abs(b))
    return abs(a-b)/d if d else 0.0

print("="*86)
print("  三方獨立驗證報告　　網頁引擎 × Python 獨立實作 × 封閉解")
print("="*86)
print(f"{'項目':<32}{'網頁引擎':>17}{'Python':>17}{'相對誤差':>12}  判定")
print("-"*86)

for k in sorted(set(js) & set(py)):
    a, b = js[k], py[k]
    if isinstance(a,bool) or isinstance(b,bool): continue
    r = rel(float(a), float(b))
    ok = r <= TOL
    if not ok: fails += 1
    print(f"{k:<32}{a:>17.6f}{b:>17.6f}{r:>12.2e}  {'✅' if ok else '❌ 不一致'}")

print("-"*86)
print("封閉解／手算對照（第三方獨立來源）")
print("-"*86)
for k in sorted(cf):
    if k not in js: continue
    a, c = float(js[k]), float(cf[k])
    r = rel(a,c)
    ok = r <= (2e-5 if k.startswith("ref_") else 1e-9)   # 對照 App 顯示值已四捨五入
    if not ok: fails += 1
    print(f"{k:<32}{a:>17.6f}{c:>17.6f}{r:>12.2e}  {'✅' if ok else '❌ 不一致'}")

print("-"*86)
print("性質檢查（不比數值，檢查行為是否正確）")
print("-"*86)
checks = [
 ("蒙地卡羅可重現（同輸入同結果）", js.get("mc_reproducible") is True),
 ("百分位數排序正確 p10≤p50≤p90",   js.get("mc_ordered") is True),
 ("標準差為 0 時蒙地卡羅收斂至確定性路徑", abs(js.get("mc_zero_vol_matches_det",1))<0.02),
 ("被追繳機率介於 0 與 1 之間",      0 <= (js.get("mc_callprob") or 0) <= 1),
 ("零本金零投入 → 終值為 0",         abs(js.get("edge_zero_init",1))<1e-9),
 ("零報酬率 → 終值等於本金",         abs(js.get("edge_zero_return",0)-1_000_000)<1e-6),
 ("首期利息＋本金＝月付金",
    abs(js["amort_m1_interest"]+js["amort_m1_principal"]-js["pmt_mortgage_5M_2p35_30y"])<1e-6),
 ("複利頻率越高月報酬越高",
    all(js[f"eff_rate_freq_{a}"] < js[f"eff_rate_freq_{b}"] for a,b in [(1,2),(2,4),(4,12),(12,365)])),
]
for name, ok in checks:
    if not ok: fails += 1
    print(f"{'✅' if ok else '❌'} {name}")

print("-"*86)
print("寬限期行為（對照第三方 App「房貸小幫手」）")
print("-"*86)
gn, ga = js["ref_500w_2p8_20y_grace"], js["ref_500w_2p8_20y_after"]
print(f"  500 萬 / 2.8% / 20 年 / 寬限 3 年")
print(f"    寬限期內月付金  本工具 {gn:>10,.2f}   對照 App 11,667")
print(f"    第 37 月起月付金 本工具 {ga:>10,.2f}   對照 App 30,832")
print(f"    跳增           本工具 {ga-gn:>10,.2f}")
ok_grace = ga > gn
if not ok_grace: fails += 1
print(f"{'✅' if ok_grace else '❌'} 期滿後月付金高於寬限期內（寬限期只繳息，期滿以剩餘年期重算）")

print("="*86)
print(f"結論：比對 {len(set(js)&set(py))} 項數值 + {len([k for k in cf if k in js])} 項封閉解 + {len(checks)} 項性質檢查")
print(f"      不一致 {fails} 項　待裁決 {warns} 項")
print("="*86)
sys.exit(1 if fails else 0)
