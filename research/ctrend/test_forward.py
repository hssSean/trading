"""Unit tests for ctrend_forward pure helpers (pytest; no network)."""
import pandas as pd

import ctrend_forward as Fw

T = pd.Timestamp


def test_mondays_first_run():
    got = Fw.mondays_to_process(None, "2026-10-26", T("2026-11-13 03:00"))
    assert got == [T("2026-10-26"), T("2026-11-02"), T("2026-11-09")]


def test_mondays_next_week():
    assert Fw.mondays_to_process("2026-11-09", "2026-10-26", T("2026-11-16 00:30")) == [T("2026-11-16")]


def test_mondays_rerun_same_day():
    assert Fw.mondays_to_process("2026-11-16", "2026-10-26", T("2026-11-16 05:00")) == []


def test_mondays_catch_up():
    got = Fw.mondays_to_process("2026-11-02", "2026-10-26", T("2026-11-24 12:00"))
    assert got == [T("2026-11-09"), T("2026-11-16"), T("2026-11-23")]


def test_summarize():
    assert Fw.summarize([]) == (0, 0.0, None)
    n, mean, t = Fw.summarize([{"net": 0.01}, {"net": 0.03}])
    assert n == 2 and abs(mean - 0.02) < 1e-12 and t is None
    n, mean, t = Fw.summarize([{"net": 0.01}, {"net": 0.02}, {"net": 0.03}])
    assert n == 3 and abs(mean - 0.02) < 1e-12 and abs(t - 0.02 / (0.01 / 3 ** 0.5)) < 1e-9


def test_week_net_uses_stored_turnover():
    wgt = pd.Series({"a": 0.5, "b": 0.5, "c": -1.0})
    r = pd.Series({"a": 0.10, "b": 0.00, "c": 0.05})
    f = pd.Series({"a": 0.001, "c": 0.002})
    gross, net, fund = Fw.week_result(wgt, r, f, turnover=1.5)
    assert abs(gross - (0.05 - 0.05)) < 1e-12
    assert abs(fund - (0.0005 - 0.002)) < 1e-12
    assert abs(net - (gross - 0.0007 * 1.5 - fund)) < 1e-12


def test_week_returns_delisted_uses_last_close():
    idx = pd.date_range("2026-11-02", "2026-11-09", freq="D")
    O = pd.DataFrame({"a": [10.0] * 8, "b": [20.0] * 5 + [float("nan")] * 3}, index=idx)
    O.loc[idx[-1], "a"] = 11.0
    Cl = pd.DataFrame({"a": [10.0] * 8, "b": [20.0, 21, 22, 23, 18] + [float("nan")] * 3}, index=idx)
    ret, miss = Fw.week_returns({"o": O, "c": Cl}, ["a", "b", "zz"], idx[0], idx[-1])
    assert abs(ret["a"] - 0.1) < 1e-12 and abs(ret["b"] - (18 / 20 - 1)) < 1e-12
    assert ret["zz"] == 0.0 and miss == ["zz"]
