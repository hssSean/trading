"""CTREND core (Fieberg, Liedtke, Poddig, Walker & Zaremba, JFQA 2025) -- shared by the research backtest
(C:\\trading_stratage\\ctrend.py) and the forward ledger (ctrend_forward.py). One copy of the algorithm.

Weekly (Monday 00:00 UTC). Weight = trailing 30d dollar volume. 28 indicators -> cross-sectional ranks in
[-0.5, 0.5] -> weighted univariate CS regressions, coefficients averaged over the previous M weeks -> per-indicator
forecasts -> pooled elastic net (l1_ratio 0.5, lambda by AICc) over the previous M weeks, keep theta > 0 ->
CTREND = mean of the kept forecasts. Quintiles, weighted long-short.
"""
import numpy as np
import pandas as pd
from sklearn.linear_model import enet_path

M_DEFAULT = 52
COST = 0.0007
NAMES = (["rsi", "stochK", "stochD", "stochRSI", "cci"]
         + [f"sma{n}" for n in (3, 5, 10, 20, 50, 100, 200)] + ["macd", "macd_sig"]
         + [f"volsma{n}" for n in (3, 5, 10, 20, 50, 100, 200)] + ["volmacd", "volmacd_sig", "chaikin"]
         + ["boll_low", "boll_mid", "boll_high", "boll_width"])


def ema(x, n):
    return x.ewm(span=n, adjust=False, min_periods=n).mean()


def indicators(c, h, l, v):
    """Daily panels (index = day, columns = symbols) -> dict name -> DataFrame."""
    ind = {}
    d = c.diff()
    up, dn = d.clip(lower=0).rolling(14).mean(), (-d.clip(upper=0)).rolling(14).mean()
    rsi = 100 - 100 / (1 + up / dn)
    ind["rsi"] = rsi
    hh, ll = h.rolling(14).max(), l.rolling(14).min()
    k = 100 * (c - ll) / (hh - ll)
    ind["stochK"], ind["stochD"] = k, k.rolling(3).mean()
    ind["stochRSI"] = (rsi - rsi.rolling(14).min()) / (rsi.rolling(14).max() - rsi.rolling(14).min())
    tp = (h + l + c) / 3
    mad = tp.rolling(20).apply(lambda x: np.abs(x - x.mean()).mean(), raw=True)
    ind["cci"] = (tp - tp.rolling(20).mean()) / (0.015 * mad)
    for n in (3, 5, 10, 20, 50, 100, 200):
        ind[f"sma{n}"] = c.rolling(n).mean() / c
    macd = (ema(c, 26) - ema(c, 12)) / ema(c, 12)
    ind["macd"], ind["macd_sig"] = macd, macd - ema(macd, 9)
    for n in (3, 5, 10, 20, 50, 100, 200):
        ind[f"volsma{n}"] = v.rolling(n).mean() / v
    vm = (ema(v, 26) - ema(v, 12)) / ema(v, 12)
    ind["volmacd"], ind["volmacd_sig"] = vm, vm - ema(vm, 9)
    mfv = ((c - l) - (h - c)) / (h - l) * v
    ind["chaikin"] = mfv.rolling(20).sum() / v.rolling(20).sum()
    mid, sd = c.rolling(20).mean(), c.rolling(20).std()
    ind["boll_low"], ind["boll_mid"], ind["boll_high"] = (mid - 2 * sd) / c, mid / c, (mid + 2 * sd) / c
    ind["boll_width"] = 4 * sd / mid
    return {j: ind[j] for j in NAMES}


def rank_unit(Z):
    return Z.rank().sub(1).div(len(Z) - 1).sub(0.5)


def wls(y, x, w):
    """Weighted univariate regression y = a + b x."""
    W = w / w.sum()
    xm, ym = (W * x).sum(), (W * y).sum()
    vx = (W * (x - xm) ** 2).sum()
    b = (W * (x - xm) * (y - ym)).sum() / vx if vx > 0 else 0.0
    return ym - b * xm, b


def enet_select(X, y, w):
    """Boolean mask of forecasts with positive elastic-net weight (lambda by AICc); None if nothing fits."""
    sw = np.sqrt(w / w.mean())
    Xc = (X - np.average(X, axis=0, weights=w)) * sw[:, None]
    yc = (y - np.average(y, weights=w)) * sw
    _, coefs, _ = enet_path(Xc, yc, l1_ratio=0.5, n_alphas=60)
    n = len(y)
    best, keep = np.inf, None
    for a_i in range(coefs.shape[1]):
        beta = coefs[:, a_i]
        rss = ((yc - Xc @ beta) ** 2).sum()
        kk = int((beta != 0).sum())
        if n - kk - 1 <= 0:
            continue
        aicc = n * np.log(rss / n) + 2 * kk + 2 * kk * (kk + 1) / (n - kk - 1)
        if aicc < best:
            best, keep = aicc, beta > 0
    return keep


def build_weeks(P, ind, F, mondays, require_next):
    """P: dict o/h/l/c/qv daily DataFrames; F: daily funding sums. mondays: sorted Mondays (the last one may be the
    current week, whose next open is unknown -> r = NaN).
    require_next=True reproduces the research backtest (coins must have next Monday's open).
    require_next=False (forward): a coin without next Monday's open is settled at its last close before it."""
    O, Cl = P["o"], P["c"]
    age = Cl.notna().cumsum()
    vol30 = P["qv"].rolling(30, min_periods=20).mean()
    weeks = []
    for k, m0 in enumerate(mondays):
        m1 = mondays[k + 1] if k + 1 < len(mondays) else m0 + pd.Timedelta(days=7)
        ref = m0 - pd.Timedelta(days=1)
        if ref not in Cl.index or m0 not in O.index:
            continue
        ok = (age.loc[ref] >= 200) & (vol30.loc[ref] >= 1e6) & O.loc[m0].notna()
        has_next = m1 in O.index
        if require_next:
            if not has_next:
                continue
            ok &= O.loc[m1].notna()
        u = ok[ok].index
        if len(u) < 30:
            continue
        Z = pd.DataFrame({j: ind[j].loc[ref, u] for j in NAMES}).replace([np.inf, -np.inf], np.nan).dropna()
        if len(Z) < 30:
            continue
        Zr = rank_unit(Z)
        syms = Zr.index
        if has_next:
            end = O.loc[m1, syms]
            if not require_next:
                last_close = Cl.loc[(Cl.index >= m0) & (Cl.index < m1), syms].ffill().iloc[-1] \
                    if ((Cl.index >= m0) & (Cl.index < m1)).any() else pd.Series(np.nan, syms)
                end = end.fillna(last_close)
            ret = end / O.loc[m0, syms] - 1
        else:
            ret = pd.Series(np.nan, syms)
        fund = F.loc[(F.index >= m0) & (F.index < m1), syms].sum()
        weeks.append(dict(m0=m0, Z=Zr, r=ret, f=fund, w=vol30.loc[ref, syms]))
    return weeks


def fit_scores(weeks, M=M_DEFAULT):
    """[(m0, CTREND score Series, number of kept forecasts)] for weeks[2M:], each using only earlier weeks."""
    T = len(weeks)
    coef = np.full((T, len(NAMES), 2), np.nan)
    for t, wk in enumerate(weeks):
        y = wk["r"].to_numpy()
        m = np.isfinite(y)
        if m.sum() < 3:
            continue
        w = wk["w"].to_numpy()[m]
        for k, j in enumerate(NAMES):
            coef[t, k] = wls(y[m], wk["Z"][j].to_numpy()[m], w)
    fc = [None] * T
    for t in range(M, T):
        a = np.nanmean(coef[t - M:t], axis=0)
        Z = weeks[t]["Z"]
        fc[t] = pd.DataFrame({j: a[k, 0] + a[k, 1] * Z[j] for k, j in enumerate(NAMES)})
    out = []
    for t in range(2 * M, T):
        Xs, ys, ws = [], [], []
        for s in range(t - M, t):
            f, wk = fc[s], weeks[s]
            Xs.append(f.to_numpy())
            ys.append(wk["r"].reindex(f.index).to_numpy())
            ws.append(wk["w"].reindex(f.index).to_numpy())
        X, y, w = np.vstack(Xs), np.concatenate(ys), np.concatenate(ws)
        good = np.isfinite(y) & np.isfinite(w) & np.isfinite(X).all(axis=1)
        keep = enet_select(X[good], y[good], w[good])
        sel = [j for j, kk in zip(NAMES, keep) if kk] if keep is not None and keep.any() else list(NAMES)
        out.append((weeks[t]["m0"], fc[t][sel].mean(axis=1), len(sel)))
    return out


def leg_weights(score, w, top):
    """Long top quintile (+), short bottom quintile (-), each leg weighted by w and summing to 1 in abs."""
    sc = score
    if top:
        sc = sc[w.reindex(sc.index).sort_values(ascending=False).index[:top]]
    q = pd.qcut(sc.rank(method="first"), 5, labels=False)
    wv = w.reindex(sc.index)

    def leg(qq):
        nm = q[q == qq].index
        return wv[nm] / wv[nm].sum()

    return pd.concat([leg(4), -leg(0)]).groupby(level=0).sum()


def settle(wgt, prev, r, f, cost=COST):
    """(gross, net, turnover) for holding wgt over a week with returns r and funding sums f."""
    gross = float((wgt * r.reindex(wgt.index)).sum())
    turn = float(wgt.sub(prev, fill_value=0).abs().sum()) if prev is not None else float(wgt.abs().sum())
    net = gross - cost * turn - float((wgt * f.reindex(wgt.index).fillna(0)).sum())
    return gross, net, turn
