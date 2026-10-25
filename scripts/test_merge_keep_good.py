#!/usr/bin/env python3
"""Testes locais do merge, sem rede ou escrita de dados."""
from copy import deepcopy
import atualiza
from atualiza import merge_keep_good
from unittest.mock import patch
from pathlib import Path


def snapshot(value, gerado="novo"):
    return {"gerado": gerado, "pres": {"r2": {"sp": value}}}


good = {"st": 1234, "ts": 5678, "cands": [{"n": "22", "v": 100}]}
error = {"erro": "timeout"}
new = snapshot(error)
old = snapshot(good, "anterior")
original_new, original_old = deepcopy(new), deepcopy(old)
merged, kept = merge_keep_good(new, old)
assert merged["pres"]["r2"]["sp"] == dict(good, stale=True, erro_ultimo="timeout")
assert kept == 1
assert new == original_new and old == original_old
assert merged["gerado"] == "novo"

for missing in (None, {}, snapshot(error)):
    merged, kept = merge_keep_good(new, missing)
    assert merged == new
    assert kept == 0

fresh = snapshot(dict(good, st=2345))
merged, kept = merge_keep_good(fresh, old)
assert merged == fresh
assert kept == 0
assert merged["gerado"] == "novo"

legacy = deepcopy(old)
legacy["gov"] = {"r2": {"ac": good}}
merged, kept = merge_keep_good(new, legacy)
assert "gov" not in merged
assert merged["pres"]["r2"]["sp"]["st"] == good["st"]
assert kept == 1
assert legacy["gov"]["r2"]["ac"] == good

# Exercise the writer contract without network access or changing local files.
captured_jobs, written = [], {}
def fake_fetch(jobs):
    captured_jobs.extend(jobs)
    return {job: deepcopy(good) for job in jobs}

with patch.object(atualiza.sys, "argv", ["atualiza.py"]), \
     patch.object(atualiza, "fetch_all", side_effect=fake_fetch), \
     patch.object(atualiza.os.path, "exists", return_value=False), \
     patch.object(atualiza, "read_series", return_value=[]), \
     patch.object(atualiza, "write_json_atomic", side_effect=lambda path, value: written.update({Path(path).name: value})):
    atualiza.main()
assert len(captured_jobs) == 58
assert {job[0] for job in captured_jobs} == {"6257", "6258"}
assert all(job[2] == 1 for job in captured_jobs)
assert set(written["snapshot.json"]) == {"gerado", "fonte", "pres"}
for rnd in ("r1", "r2"):
    assert len(written["snapshot.json"]["pres"][rnd]) == 29

print("OK merge_keep_good e snapshot somente presidencial")
