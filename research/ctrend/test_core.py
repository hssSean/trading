"""Unit tests for ctrend_core (pytest)."""
import numpy as np
import pandas as pd

import ctrend_core as C


def test_rank_unit_range():
    Z = pd.DataFrame({"a": [5.0, 1.0, 3.0, 2.0], "b": [0.1, 0.4, 0.2, 0.3]})
    R = C.rank_unit(Z)
    assert R.min().min() == -0.5 and R.max().max() == 0.5
    assert np.allclose(R["a"].to_numpy(), [0.5, -0.5, 1 / 6, -1 / 6], atol=1e-12)


def test_wls_recovers_line():
    x = np.array([0.0, 1.0, 2.0, 3.0])
    a, b = C.wls(1 + 2 * x, x, np.array([1.0, 2.0, 3.0, 4.0]))
    assert abs(a - 1) < 1e-12 and abs(b - 2) < 1e-12


def test_enet_keeps_only_positive():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(400, 3))
    y = 0.8 * X[:, 0] - 0.8 * X[:, 1] + 0.1 * rng.normal(size=400)
    keep = C.enet_select(X, y, np.ones(400))
    assert keep[0] and not keep[1]


def test_leg_weights_sum_and_disjoint():
    score = pd.Series(np.arange(20, dtype=float), index=[f"s{i}" for i in range(20)])
    w = pd.Series(np.arange(1, 21, dtype=float), index=score.index)
    wgt = C.leg_weights(score, w, None)
    assert abs(wgt[wgt > 0].sum() - 1) < 1e-12 and abs(wgt[wgt < 0].sum() + 1) < 1e-12
    assert set(wgt[wgt > 0].index).isdisjoint(wgt[wgt < 0].index)
    assert set(wgt[wgt > 0].index) == {f"s{i}" for i in range(16, 20)}


def test_settle_costs():
    wgt = pd.Series({"a": 1.0, "b": -1.0})
    prev = pd.Series({"a": 0.5, "c": -1.0})
    r = pd.Series({"a": 0.10, "b": -0.05})
    f = pd.Series({"a": 0.001, "b": 0.002})
    gross, net, turn = C.settle(wgt, prev, r, f, cost=0.0007)
    assert abs(gross - 0.15) < 1e-12
    assert abs(turn - (0.5 + 1.0 + 1.0)) < 1e-12
    assert abs(net - (0.15 - 0.0007 * 2.5 - (0.001 - 0.002))) < 1e-12
