#!/usr/bin/env python3
"""Baixa resultados oficiais do TSE e atualiza snapshot.json e serie.json.
--check valida os dados locais sem rede e sem escrita.
"""
import json, sys, urllib.request, concurrent.futures as cf, datetime, os, math, tempfile

BASE = "https://resultados.tse.jus.br/oficial/ele2026"
PRES1, PRES2, GOV1, GOV2 = "6257", "6258", "6259", "6260"
UFS = "ac al am ap ba ce df es go ma mg ms mt pa pb pe pi pr rj rn ro rr rs sc se sp to".split()
GOV_UFS = ["ac", "am", "df", "es", "rn", "to"]  # 2o turno governador (ele-c.json, eleicao 6260)
SERIE_MAX = 300
CANDIDATOS_SERIE = ("22", "13")

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

def data_dir():
    if os.environ.get("ELEICOES_DATA_DIR"): return os.path.abspath(os.environ["ELEICOES_DATA_DIR"])
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))

def point_scope(d, require_votes=False):
    """Converte abrangência válida; ausência/erro nunca vira zero inventado."""
    if not isinstance(d, dict) or "erro" in d:
        return None
    try:
        pst = float(d["pst"])
        if not math.isfinite(pst) or pst <= 0:
            return None
        found = {str(c["n"]): c for c in d["cands"] if isinstance(c, dict) and "n" in c}
        result = {}
        for code in CANDIDATOS_SERIE:
            c = found[code]
            v, p = int(c["v"]), float(c["p"])
            if v < 0 or not math.isfinite(p) or p < 0:
                return None
            result[code] = {"v": v, "p": p}
        if require_votes and sum(c["v"] for c in result.values()) <= 0:
            return None
        return pst, result
    except (KeyError, TypeError, ValueError, OverflowError):
        return None

def make_point(snapshot, observed_at=None):
    """Gera o contrato compacto somente quando o Brasil tem resultado real."""
    br_data = snapshot.get("pres", {}).get("r2", {}).get("br")
    br = point_scope(br_data, require_votes=True)
    try:
        if br is None or int(br_data.get("vv", 0)) <= 0:
            return None
        t = observed_at or snapshot["gerado"]
        parsed = datetime.datetime.fromisoformat(t.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            return None
        t = parsed.isoformat(timespec="seconds")
    except (KeyError, TypeError, ValueError, AttributeError):
        return None
    point = {"t": t, "pst": br[0], "br": br[1], "ufs": {}}
    for uf, d in snapshot.get("pres", {}).get("r2", {}).items():
        if uf == "br":
            continue
        scope = point_scope(d)
        if scope:
            point["ufs"][uf] = {"pst": scope[0], "22p": scope[1]["22"]["p"], "13p": scope[1]["13"]["p"]}
    return point

def valid_point(point):
    if not isinstance(point, dict) or not isinstance(point.get("t"), str):
        return False
    try:
        t = datetime.datetime.fromisoformat(point["t"].replace("Z", "+00:00"))
        if t.tzinfo is None or t.utcoffset() is None:
            return False
        pst = float(point["pst"])
        if not math.isfinite(pst) or pst <= 0:
            return False
        br = point["br"]
        for code in CANDIDATOS_SERIE:
            v, p = int(br[code]["v"]), float(br[code]["p"])
            if v < 0 or not math.isfinite(p) or p < 0:
                return False
        if sum(int(br[c]["v"]) for c in CANDIDATOS_SERIE) <= 0:
            return False
        for uf, scope in point["ufs"].items():
            if not isinstance(uf, str) or not isinstance(scope, dict):
                return False
            values = [float(scope[k]) for k in ("pst", "22p", "13p")]
            if not all(math.isfinite(x) for x in values) or values[0] <= 0 or values[1] < 0 or values[2] < 0:
                return False
    except (KeyError, TypeError, ValueError, OverflowError):
        return False
    return True

def append_point(history, point):
    """Retorna série limitada e sinaliza inclusão; entradas históricas são mantidas."""
    if not isinstance(history, list) or any(not valid_point(p) for p in history):
        raise ValueError("histórico de série inválido")
    if point is None or not valid_point(point):
        return history[-SERIE_MAX:], False
    if any(float(old["pst"]) == float(point["pst"]) for old in history):
        return history[-SERIE_MAX:], False
    return (history + [point])[-SERIE_MAX:], True

def read_series(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        history = json.load(f)
    if not isinstance(history, list) or any(not valid_point(p) for p in history):
        raise ValueError("serie.json não corresponde ao contrato")
    return history

def write_json_atomic(path, value):
    fd, tmp = tempfile.mkstemp(prefix=".atualiza-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, separators=(",", ":"))
            f.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

def check_local():
    """Checa contrato e geração de pontos com arquivos locais, sem efeitos colaterais."""
    directory = data_dir()
    with open(os.path.join(directory, "snapshot.json"), encoding="utf-8") as f:
        snapshot = json.load(f)
    history = read_series(os.path.join(directory, "serie.json"))
    candidate = make_point(snapshot)
    simulated, added = append_point(history, candidate)
    if len(simulated) > SERIE_MAX or (added and candidate not in simulated):
        raise ValueError("geração local de série inválida")
    print(f"OK série local: {len(history)} ponto(s); novo ponto: {'sim' if added else 'não'}")

def main():
    if "--check" in sys.argv:
        try:
            check_local()
            return
        except Exception as err:
            print("FALHOU", err)
            sys.exit(1)
    observed_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    jobs = [(PRES1, u, 1) for u in ["br"] + UFS + ["zz"]] + [(PRES2, u, 1) for u in ["br"] + UFS + ["zz"]]
    jobs += [(GOV1, u, 3) for u in GOV_UFS] + [(GOV2, u, 3) for u in GOV_UFS]
    r = fetch_all(jobs)
    snap = {"gerado": observed_at,
            "fonte": BASE, "pres": {"r1": {}, "r2": {}}, "gov": {"r1": {}, "r2": {}}}
    for (ele, uf, cargo), d in r.items():
        grp = "pres" if cargo == 1 else "gov"
        rnd = "r1" if ele in (PRES1, GOV1) else "r2"
        snap[grp][rnd][uf] = d
    out = os.path.join(data_dir(), "snapshot.json")
    old = None
    if os.path.exists(out):
        try: old = json.load(open(out))
        except Exception: pass
    snapshot_changed = not old or {k: v for k, v in old.items() if k != "gerado"} != {k: v for k, v in snap.items() if k != "gerado"}
    if snapshot_changed:
        write_json_atomic(out, snap)
    serie_path = os.path.join(data_dir(), "serie.json")
    try:
        history = read_series(serie_path)
    except Exception as err:
        # Nunca descartar histórico por uma falha no próprio arquivo.
        print("série preservada; não foi possível validar:", err)
        history = None
    serie_changed = False
    if history is not None:
        try:
            updated, added = append_point(history, make_point(snap, observed_at))
            if added or not os.path.exists(serie_path):
                write_json_atomic(serie_path, updated)
                serie_changed = True
        except Exception as err:
            print("série preservada; atualização ignorada:", err)
    erros = sum(1 for d in r.values() if "erro" in d)
    print("snapshot", "gravado" if snapshot_changed else "sem mudança", "série", "atualizada" if serie_changed else "sem mudança", "arquivos:", len(r), "erros:", erros)

if __name__ == "__main__":
    main()
