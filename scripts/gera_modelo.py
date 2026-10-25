#!/usr/bin/env python3
"""Gera parâmetros reproduzíveis a partir exclusivamente do histórico de 2022."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
from pathlib import Path
from typing import Any

UFS = (
    "ac", "al", "am", "ap", "ba", "ce", "df", "es", "go", "ma", "mg",
    "ms", "mt", "pa", "pb", "pe", "pi", "pr", "rj", "rn", "ro", "rr",
    "rs", "sc", "se", "sp", "to", "zz",
)
YEAR = "2022"


def build_model(history: dict[str, Any], history_bytes: bytes) -> dict[str, Any]:
    years = history.get("anos")
    if not isinstance(years, dict) or set(years) != {YEAR}:
        raise ValueError("historico.json deve conter somente anos.2022")
    election = years[YEAR]
    finalists = election.get("finalistas")
    if not isinstance(finalists, dict):
        raise ValueError("finalistas ausentes em 2022")
    pt_ids = [str(cid) for cid, candidate in finalists.items()
              if isinstance(candidate, dict) and candidate.get("sg") == "PT"]
    if len(pt_ids) != 1:
        raise ValueError("esperado exatamente um finalista PT em 2022")
    pt_id = pt_ids[0]
    other_ids = [str(cid) for cid in finalists if str(cid) != pt_id]
    if len(other_ids) != 1:
        raise ValueError("esperados exatamente dois finalistas em 2022")
    other_id = other_ids[0]
    r1, r2 = election.get("r1"), election.get("r2")
    if not isinstance(r1, dict) or not isinstance(r2, dict) or set(r1) != set(UFS) or set(r2) != set(UFS):
        raise ValueError("r1 e r2 devem conter exatamente 27 UFs e ZZ")

    rows: dict[str, dict[str, Any]] = {}
    total_pt1 = total_other1 = total_pt2 = total_other2 = 0
    for uf in UFS:
        try:
            first, second = r1[uf], r2[uf]
            pt1, other1 = int(first[pt_id]), int(first[other_id])
            pt2, other2 = int(second[pt_id]), int(second[other_id])
            vv1 = sum(int(v) for v in first.values())
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"votos ausentes ou inválidos em 2022/{uf}") from exc
        if min(pt1, other1, pt2, other2) < 0 or pt1 + other1 <= 0 or pt2 + other2 <= 0 or vv1 <= 0:
            raise ValueError(f"denominador inválido em 2022/{uf}")
        bilateral = pt1 / (pt1 + other1)
        share_pt_r2 = pt2 / (pt2 + other2)
        rows[uf] = {
            "votos_pt_r1": pt1,
            "votos_opositor_r1": other1,
            "vv_r1": vv1,
            "share_pt_bilateral_r1": bilateral,
            "share_pt_r2": share_pt_r2,
            "d_uf": share_pt_r2 - bilateral,
        }
        total_pt1 += pt1
        total_other1 += other1
        total_pt2 += pt2
        total_other2 += other2

    d_nac = total_pt2 / (total_pt2 + total_other2) - total_pt1 / (total_pt1 + total_other1)
    residuals = {uf: rows[uf]["d_uf"] - d_nac for uf in UFS}
    sd_uf = statistics.stdev(residuals.values())
    for uf in UFS:
        rows[uf]["residuo_uf"] = residuals[uf]
        rows[uf]["sd_uf"] = sd_uf

    model = {
        "unidade": "fração de 0 a 1",
        "anos": [YEAR],
        "n": 1,
        "abrangencias": rows,
        "nacional": {"d_nac": d_nac, "sd_nac": abs(d_nac)},
        "metadados": {
            "formulas": {
                "d_uf": "share PT do 2º turno de 2022 menos share PT bilateral do 1º turno de 2022, por UF/ZZ",
                "d_nac": "mesma diferença após somar votos PT e do outro finalista nas 27 UFs + ZZ",
                "residuo_uf": "d_uf menos d_nac",
                "sd_uf": "desvio-padrão amostral (n−1) dos 28 resíduos entre UFs/ZZ; mesmo parâmetro para cada abrangência",
                "sd_nac": "valor absoluto de d_nac de 2022",
            },
            "premissas": [
                "Há somente uma eleição histórica; não é possível estimar desvio entre eleições.",
                "sd_nac usa |d_nac| de 2022 como tamanho típico do choque nacional.",
                "Choque nacional pré-apuração centrado em zero; nenhum ajuste adicional é aplicado.",
                "A base de 2026 é o 1º turno por UF; a incerteza é calibrada pela mudança do 1º para o 2º turno de 2022 por UF.",
                "Não há dados históricos de ordem de apuração.",
            ],
            "finalistas_2022": {
                "pt": {"n": pt_id, **finalists[pt_id]},
                "opositor": {"n": other_id, **finalists[other_id]},
            },
            "fonte_tse": str(history.get("fonte", "")).replace("<ano>", YEAR),
            "sha256_historico": hashlib.sha256(history_bytes).hexdigest(),
        },
    }
    validate_model(model)
    return model


def validate_model(model: dict[str, Any]) -> None:
    if model.get("anos") != [YEAR] or model.get("n") != 1:
        raise ValueError("modelo deve citar somente 2022")
    entries = model.get("abrangencias")
    if not isinstance(entries, dict) or set(entries) != set(UFS):
        raise ValueError("modelo deve conter exatamente 27 UFs e ZZ")
    nums = [model.get("nacional", {}).get("d_nac"), model.get("nacional", {}).get("sd_nac")]
    nums += [v for entry in entries.values() for v in entry.values()]
    if any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in nums):
        raise ValueError("modelo contém valores não finitos")
    expected_residuals = [entries[uf]["d_uf"] - model["nacional"]["d_nac"] for uf in UFS]
    expected_sd = statistics.stdev(expected_residuals)
    if any(not math.isclose(entries[uf]["residuo_uf"], expected_residuals[i], rel_tol=1e-12, abs_tol=1e-12)
           or not math.isclose(entries[uf]["sd_uf"], expected_sd, rel_tol=1e-12, abs_tol=1e-12)
           for i, uf in enumerate(UFS)):
        raise ValueError("resíduos ou sd_uf inconsistentes")
    if not math.isclose(model["nacional"]["sd_nac"], abs(model["nacional"]["d_nac"]), rel_tol=1e-12, abs_tol=1e-12):
        raise ValueError("sd_nac inconsistente")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validar sem escrever")
    parser.add_argument("--data-dir", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    data_dir = args.data_dir or Path(__file__).resolve().parents[1] / "data"
    try:
        raw = (data_dir / "historico.json").read_bytes()
        model = build_model(json.loads(raw), raw)
        encoded = (json.dumps(model, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()
        target = data_dir / "modelo.json"
        if args.check:
            actual = json.loads(target.read_text(encoding="utf-8"))
            validate_model(actual)
            if actual != model:
                raise ValueError("modelo.json diverge do recálculo em memória")
            print("modelo.json válido; recálculo 2022 reproduzido sem escrita")
        else:
            target.write_bytes(encoded)
            print(f"gerado {target}")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"erro: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
