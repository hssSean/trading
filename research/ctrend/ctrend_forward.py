"""CTREND forward-validation weekly paper ledger (no orders).

Runs every Monday after 00:00 UTC (EC2 systemd timer, deploy/ctrend.timer). For each Monday not yet processed
(from ctrend:meta.lastWeek, start 2026-10-26): settle last week's holdings at this Monday's open, then form this
week's holdings from CTREND scores computed with data up to Sunday's close. Rules are frozen = research ctrend.py;
the algorithm lives in ctrend_core.py (one copy). Design: docs/superpowers/specs/2026-11-13-ctrend-forward-ledger-design.md

Usage:
  python ctrend_forward.py            # write Redis (needs UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)
  python ctrend_forward.py --dry      # read nothing from Redis, write nothing; print what would be written
  python ctrend_forward.py --dry --start 2026-10-12   # dry run from another start week (sanity check vs research)
Env: CTREND_FAPI (default https://fapi.binance.com)
"""
import argparse
import csv
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ctrend_core as C  # noqa: E402

warnings.filterwarnings("ignore")
START = "2026-10-26"
VERSION = 1
FAPI = os.environ.get("CTREND_FAPI", "https://fapi.binance.com")
OUT = Path(__file__).resolve().parent / "out"
DAY = pd.Timedelta(days=1)
WEEK = pd.Timedelta(days=7)


# ---------- pure helpers (tested) ----------

def mondays_to_process(last_week, start, now):
    """Mondays (00:00 UTC) after last_week (or from start) whose open has already happened (<= now)."""
    first = pd.Timestamp(last_week) + WEEK if last_week else pd.Timestamp(start)
    out, m = [], first
    while m <= now:
        out.append(m)
        m += WEEK
    return out


def summarize(records):
    """(n, mean net, t of mean net or None when n < 3 or no dispersion)."""
    x = np.array([r["net"] for r in records], dtype=float)
    n = len(x)
    if n == 0:
        return 0, 0.0, None
    mean = float(x.mean())
    if n < 3:
        return n, mean, None
    sd = float(x.std(ddof=1))
    return n, mean, (mean / (sd / math.sqrt(n)) if sd > 0 else None)


def week_result(wgt, r, f, turnover, cost=C.COST):
    """(gross, net, funding paid) for weights wgt held one week; turnover was fixed when the holdings were formed."""
    gross = float((wgt * r.reindex(wgt.index)).sum())
    fund = float((wgt * f.reindex(wgt.index).fillna(0)).sum())
    return gross, gross - cost * turnover - fund, fund


def week_returns(P, syms, m0, m1):
    """Open(m1)/Open(m0) - 1; a coin without m1's open (delisted) exits at its last close before m1.
    Returns (Series, symbols with no usable price -> return 0)."""
    O, Cl = P["o"], P["c"]
    out, missing = {}, []
    for s in syms:
        o0 = O[s].get(m0, np.nan) if s in O else np.nan
        end = O[s].get(m1, np.nan) if s in O else np.nan
        if not np.isfinite(end) and s in Cl:
            cl = Cl[s][(Cl.index >= m0) & (Cl.index < m1)].dropna()
            end = cl.iloc[-1] if len(cl) else np.nan
        if np.isfinite(o0) and np.isfinite(end) and o0 > 0:
            out[s] = end / o0 - 1
        else:
            out[s], missing = 0.0, missing + [s]
    return pd.Series(out, dtype=float), missing


def turnover(wgt, prev):
    return float(wgt.sub(prev, fill_value=0).abs().sum()) if prev is not None else float(wgt.abs().sum())


def to_pairs(wgt):
    lo = wgt[wgt > 0].sort_values(ascending=False)
    sh = wgt[wgt < 0].sort_values()
    return [[s, round(float(v), 8)] for s, v in lo.items()], [[s, round(float(v), 8)] for s, v in sh.items()]


def from_pairs(long, short):
    return pd.Series({s: float(v) for s, v in list(long) + list(short)}, dtype=float)


# ---------- I/O ----------

def http_json(url, tries=6):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ctrend-forward/1"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 418, 403) and k < tries - 1:
                # 403 = Binance WAF (e.g. fundingRate's 500/5min/IP limit): back off and retry
                wait = int(e.headers.get("Retry-After") or (120 if e.code == 403 else 60))
                print(f"  rate limited ({e.code}), sleep {wait}s", flush=True)
                time.sleep(wait)
                continue
            if e.code >= 500 and k < tries - 1:
                time.sleep(5 * (k + 1))
                continue
            body = e.read().decode("utf-8", "replace")[:200]
            raise RuntimeError(f"Binance {url.split('?')[0]} HTTP {e.code}: {body}") from None
        except (urllib.error.URLError, TimeoutError):
            if k == tries - 1:
                raise
            time.sleep(5 * (k + 1))
    raise RuntimeError(f"giving up on {url}")


def fetch_universe():
    """Same condition as src/api/binance.ts isCryptoPerp; any status (delisted coins stay in the training windows)."""
    info = http_json(f"{FAPI}/fapi/v1/exchangeInfo")
    return sorted(s["symbol"] for s in info["symbols"]
                  if s.get("contractType") == "PERPETUAL" and s.get("quoteAsset") == "USDT"
                  and s.get("underlyingType") in (None, "COIN", "PREMARKET")
                  and s.get("status") != "PENDING_TRADING")


def fetch_daily(sym):
    rows = http_json(f"{FAPI}/fapi/v1/klines?symbol={urllib.parse.quote(sym)}&interval=1d&limit=1000")
    time.sleep(0.25)
    if not rows:
        return None
    a = np.array([[float(x) for x in (r[0], r[1], r[2], r[3], r[4], r[7])] for r in rows])
    idx = pd.to_datetime(a[:, 0].astype("int64"), unit="ms")
    return pd.DataFrame({"o": a[:, 1], "h": a[:, 2], "l": a[:, 3], "c": a[:, 4], "qv": a[:, 5]}, index=idx)


_FUNDING = {}


def fetch_funding(sym, start, end, since):
    """Sum of funding rates with fundingTime in [start, end). One request per symbol per run (cached from `since`):
    /fapi/v1/fundingRate has its own limit of 500 requests / 5 min / IP, above which Binance's WAF answers 403."""
    if sym not in _FUNDING:
        s0, got = int(since.value // 10 ** 6), []
        while True:  # 1000 rows ≈ 41 days for coins with hourly funding: page through long catch-ups
            rows = http_json(f"{FAPI}/fapi/v1/fundingRate?symbol={urllib.parse.quote(sym)}&startTime={s0}&limit=1000")
            time.sleep(0.7)
            got += [(int(r["fundingTime"]), float(r["fundingRate"])) for r in rows]
            if len(rows) < 1000:
                break
            s0 = got[-1][0] + 1
        _FUNDING[sym] = got
    s_ms, e_ms = int(start.value // 10 ** 6), int(end.value // 10 ** 6)
    return float(sum(fr for t, fr in _FUNDING[sym] if s_ms <= t < e_ms))


class Upstash:
    def __init__(self):
        self.url = os.environ["UPSTASH_REDIS_REST_URL"].rstrip("/")
        self.token = os.environ["UPSTASH_REDIS_REST_TOKEN"]

    def cmd(self, *args):
        req = urllib.request.Request(self.url, data=json.dumps([str(a) for a in args]).encode("utf-8"),
                                     headers={"Authorization": f"Bearer {self.token}",
                                              "Content-Type": "application/json",
                                              # urllib 預設的 Python-urllib/x.y 會被 Upstash 前面的 Cloudflare 擋成 403
                                              "User-Agent": "ctrend-forward/1"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                out = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:200]
            raise RuntimeError(f"Upstash {args[0]} HTTP {e.code}: {body}") from None
        if "error" in out:
            raise RuntimeError(f"Upstash {args[0]}: {out['error']}")
        return out["result"]


# ---------- main ----------

def load_panels(now):
    syms = fetch_universe()
    print(f"universe {len(syms)} symbols; fetching daily klines", flush=True)
    frames, skipped = {}, 0
    for i, s in enumerate(syms):
        try:
            d = fetch_daily(s)
        except Exception as e:  # one coin failing must not stop the ledger
            print(f"  skip {s}: {e}", flush=True)
            skipped += 1
            continue
        if d is not None and len(d):
            frames[s] = d
        if (i + 1) % 100 == 0:
            print(f"  {i + 1}/{len(syms)}", flush=True)
    P = {k: pd.DataFrame({s: d[k] for s, d in frames.items()}).sort_index() for k in ("o", "h", "l", "c", "qv")}
    # today's bar is still open: keep its open (this Monday's entry price), blank the rest
    today = now.floor("D")
    if today in P["o"].index:
        for k in ("h", "l", "c", "qv"):
            P[k].loc[today] = np.nan
    return P, skipped


def run(dry, start=START):
    now = pd.Timestamp.now(tz="UTC").tz_localize(None)
    r = None if dry else Upstash()
    meta = json.loads(r.cmd("GET", "ctrend:meta") or "null") if r else None
    open_ = json.loads(r.cmd("GET", "ctrend:open") or "null") if r else None
    old = r.cmd("HGETALL", "ctrend:weeks") if r else []
    records = {old[i]: json.loads(old[i + 1]) for i in range(0, len(old), 2)}
    todo = mondays_to_process(meta["lastWeek"] if meta else None, start, now)
    print(f"now {now:%Y-%m-%d %H:%M} UTC; last week {meta['lastWeek'] if meta else None}; "
          f"to process {[m.strftime('%Y-%m-%d') for m in todo]}", flush=True)

    new_records, new_open = {}, None
    if todo:
        P, skipped = load_panels(now)
        ind = C.indicators(P["c"], P["h"], P["l"], P["qv"])
        F = pd.DataFrame(0.0, index=P["o"].index, columns=P["o"].columns)  # funding settled separately below
        mondays = [d for d in P["o"].index if d.dayofweek == 0]
        weeks = C.build_weeks(P, ind, F, mondays, require_next=False)
        by = {wk["m0"]: wk for wk in weeks}
        scores = {m0: (sc, nsel) for m0, sc, nsel in C.fit_scores(weeks)}
        print(f"usable weeks {len(weeks)}, scored weeks {len(scores)}", flush=True)

        # holdings currently open (from Redis), as {"all": (wgt, turnover), "top100": (...)}
        held, held_wk = None, None
        if open_:
            held_wk = pd.Timestamp(open_["wk"])
            held = {"all": (from_pairs(open_["long"], open_["short"]), open_["turnover"]),
                    "top100": (from_pairs(open_["top100"]["long"], open_["top100"]["short"]),
                               open_["top100"]["turnover"]),
                    "info": {"nUniverse": open_["nUniverse"], "kept": open_["kept"]}}
        for m in todo:
            if held is not None:
                if held_wk + WEEK != m:
                    raise RuntimeError(f"open holdings are for {held_wk.date()}, expected {(m - WEEK).date()}")
                syms = sorted(set(held["all"][0].index) | set(held["top100"][0].index))
                ret, no_price = week_returns(P, syms, held_wk, m)
                if no_price:
                    print(f"  WARNING week {held_wk.date()}: no price for {no_price}, counted as 0", flush=True)
                f = pd.Series({s: fetch_funding(s, held_wk, m, since=todo[0] - WEEK) for s in syms}, dtype=float)
                res = {}
                for lab in ("all", "top100"):
                    wgt, turn = held[lab]
                    res[lab] = week_result(wgt, ret, f, turn) + (turn,)
                g, n, fu, turn = res["all"]
                key = held_wk.strftime("%Y-%m-%d")
                new_records[key] = dict(
                    wk=key, gross=g, net=n, fund=fu, turnover=turn,
                    nLong=int((held["all"][0] > 0).sum()), nShort=int((held["all"][0] < 0).sum()),
                    nUniverse=held["info"]["nUniverse"], kept=held["info"]["kept"], skipped=skipped,
                    noPrice=len(no_price),
                    top100=dict(gross=res["top100"][0], net=res["top100"][1]))
                print(f"settled {key}: gross {g * 100:+.2f}% net {n * 100:+.2f}% (top100 net "
                      f"{res['top100'][1] * 100:+.2f}%), turnover {turn:.2f}", flush=True)
            if m not in scores:
                raise RuntimeError(f"no CTREND score for {m.date()} (history too short or data missing)")
            sc, nsel = scores[m]
            wk = by[m]
            nxt = {}
            for lab, top in (("all", None), ("top100", 100)):
                wgt = C.leg_weights(sc, wk["w"], top)
                prev = held[lab][0] if held is not None else None
                nxt[lab] = (wgt, turnover(wgt, prev))
            nxt["info"] = {"nUniverse": int(len(sc)), "kept": int(nsel)}
            held, held_wk = nxt, m
            lo, sh = to_pairs(nxt["all"][0])
            lo100, sh100 = to_pairs(nxt["top100"][0])
            new_open = dict(wk=m.strftime("%Y-%m-%d"), long=lo, short=sh, turnover=nxt["all"][1],
                            nUniverse=int(len(sc)), kept=int(nsel),
                            top100=dict(long=lo100, short=sh100, turnover=nxt["top100"][1]))
            print(f"formed {new_open['wk']}: universe {len(sc)}, kept {nsel}, long {len(lo)} "
                  f"{[s for s, _ in lo[:5]]}, short {len(sh)} {[s for s, _ in sh[:5]]}", flush=True)

    records.update(new_records)
    allrec = [records[k] for k in sorted(records)]
    n, mean, t = summarize(allrec)
    last_week = new_open["wk"] if new_open else (meta["lastWeek"] if meta else None)
    new_meta = dict(lastRun=int(now.value // 10 ** 6), lastWeek=last_week, weeks=n, meanNet=mean, tNet=t,
                    startWeek=start, version=VERSION)
    print(f"summary: {n} weeks, mean net {mean * 100:+.3f}%/wk, t {t if t is None else round(t, 2)}", flush=True)

    OUT.mkdir(exist_ok=True)
    if allrec:
        with open(OUT / ("weeks_dry.csv" if dry else "weeks.csv"), "w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["wk", "gross", "net", "fund", "turnover", "nLong", "nShort", "nUniverse", "kept",
                        "top100_gross", "top100_net"])
            for x in allrec:
                w.writerow([x["wk"], x["gross"], x["net"], x["fund"], x["turnover"], x["nLong"], x["nShort"],
                            x["nUniverse"], x["kept"], x["top100"]["gross"], x["top100"]["net"]])
    if dry:
        print("[dry] would write ctrend:weeks", list(new_records), "ctrend:open", new_open and new_open["wk"],
              "ctrend:meta", json.dumps(new_meta))
        return
    if new_records:
        args = []
        for k, v in new_records.items():
            args += [k, json.dumps(v)]
        r.cmd("HSET", "ctrend:weeks", *args)
    if new_open:
        r.cmd("SET", "ctrend:open", json.dumps(new_open))
    r.cmd("SET", "ctrend:meta", json.dumps(new_meta))  # last: a failed run leaves lastWeek unchanged
    print("written to Redis", flush=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--start", default=START)
    a = ap.parse_args()
    if a.start != START and not a.dry:
        sys.exit("--start is only for --dry sanity checks")
    run(a.dry, a.start)
