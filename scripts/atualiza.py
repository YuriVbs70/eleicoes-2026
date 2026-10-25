#!/usr/bin/env python3
"""Baixa resultados oficiais do TSE (2026) e grava data/snapshot.json.
Uso: python3 scripts/atualiza.py [--check]
--check: testa em segundos se o TSE responde e o formato bate.
"""
import json, sys, urllib.request, concurrent.futures as cf, datetime, os

BASE = "https://resultados.tse.jus.br/oficial/ele2026"
PRES1, PRES2, GOV1, GOV2 = "6257", "6258", "6259", "6260"
UFS = "ac al am ap ba ce df es go ma mg ms mt pa pb pe pi pr rj rn ro rr rs sc se sp to".split()
GOV_UFS = ["ac", "am", "df", "es", "rn", "to"]  # 2o turno governador (ele-c.json, eleicao 6260)

def url(ele, uf, cargo):
    return f"{BASE}/{ele}/dados/{uf}/{uf}-c{int(cargo):04d}-e{int(ele):06d}-u.json"

def get(u):
    req = urllib.request.Request(u, headers={"User-Agent": "painel-eleicoes/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def num(x):
    try: return float(str(x).replace(",", "."))
    except Exception: return 0.0

def parse(d):
    s, e, v = d.get("s", {}), d.get("e", {}), d.get("v", {})
    cands = []
    for a in d["carg"][0].get("agr", []):
        for p in a.get("par", []):
            for c in p.get("cand", []):
                cands.append({"n": c["n"], "nm": c.get("nmu") or c.get("nm"), "sg": p.get("sg"),
                              "sq": c.get("sqcand"), "v": int(c.get("vap") or 0), "p": num(c.get("pvapn")),
                              "st": c.get("st", "")})
    cands.sort(key=lambda c: -c["v"])
    return {"pst": num(s.get("pstn")), "st": int(s.get("st") or 0), "ts": int(s.get("ts") or 0),
            "te": int(e.get("te") or 0), "comp": int(e.get("c") or 0), "pc": num(e.get("pcn")),
            "vv": int(v.get("vv") or 0), "vb": int(v.get("vb") or 0), "vn": int(v.get("tvn") or 0),
            "dg": d.get("dg"), "hg": d.get("hg"), "tf": d.get("tf"), "cands": cands}

def fetch_all(jobs):
    out = {}
    with cf.ThreadPoolExecutor(12) as ex:
        futs = {ex.submit(get, url(*j)): j for j in jobs}
        for f in cf.as_completed(futs):
            j = futs[f]
            try: out[j] = parse(f.result())
            except Exception as err: out[j] = {"erro": str(err)}
    return out

def main():
    if "--check" in sys.argv:
        d = parse(get(url(PRES1, "br", 1)))
        ok = d["vv"] > 0 and len(d["cands"]) >= 2
        print("OK" if ok else "FALHOU", d["cands"][0]["nm"], d["cands"][0]["p"])
        sys.exit(0 if ok else 1)
    jobs = [(PRES1, u, 1) for u in ["br"] + UFS + ["zz"]] + [(PRES2, u, 1) for u in ["br"] + UFS + ["zz"]]
    jobs += [(GOV1, u, 3) for u in GOV_UFS] + [(GOV2, u, 3) for u in GOV_UFS]
    r = fetch_all(jobs)
    snap = {"gerado": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "fonte": BASE, "pres": {"r1": {}, "r2": {}}, "gov": {"r1": {}, "r2": {}}}
    for (ele, uf, cargo), d in r.items():
        grp = "pres" if cargo == 1 else "gov"
        rnd = "r1" if ele in (PRES1, GOV1) else "r2"
        snap[grp][rnd][uf] = d
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "snapshot.json")
    old = None
    if os.path.exists(out):
        try: old = json.load(open(out))
        except Exception: pass
    if old and {k: v for k, v in old.items() if k != "gerado"} == {k: v for k, v in snap.items() if k != "gerado"}:
        print("sem mudanca"); return
    json.dump(snap, open(out, "w"), ensure_ascii=False, separators=(",", ":"))
    erros = sum(1 for d in r.values() if "erro" in d)
    print("gravado", out, "arquivos:", len(r), "erros:", erros)

if __name__ == "__main__":
    main()
