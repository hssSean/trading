#!/usr/bin/env bash
# 在 EC2 安裝 CTREND 前向週帳本（每週一 01:30 UTC 跑一次，只記帳、不下單、不碰 live-runner）。
# 用法（在專案根目錄）：git pull && bash deploy/install-ctrend.sh
# 可以重跑：已經裝過就是更新 venv 套件與 systemd 設定。
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
ME="$(id -un)"
HOMEDIR="$HOME"
ENVF="$HOMEDIR/ctrend.env"
VENV="$DIR/research/ctrend/.venv"
cd "$DIR"
echo "== 專案 $DIR，使用者 $ME"

echo "== 1/7 檢查 python3"
command -v python3 >/dev/null || { echo "沒有 python3：sudo apt-get install -y python3 python3-venv"; exit 1; }
python3 --version

echo "== 2/7 建 venv（$VENV）"
if [ ! -x "$VENV/bin/python" ]; then
  if ! python3 -m venv "$VENV" 2>/dev/null; then
    echo "   python3-venv 沒裝，嘗試 sudo apt-get install -y python3-venv"
    rm -rf "$VENV"
    sudo apt-get update -qq && sudo apt-get install -y -qq python3-venv
    python3 -m venv "$VENV"
  fi
fi

echo "== 3/7 安裝套件（numpy、pandas、scikit-learn、pytest）"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r research/ctrend/requirements.txt

echo "== 4/7 單元測試"
(cd research/ctrend && "$VENV/bin/python" -m pytest -q)

echo "== 5/7 Redis 金鑰（$ENVF，只放 UPSTASH 兩行，不印值）"
if [ ! -s "$ENVF" ]; then
  SRC=""
  if [ -r "$HOMEDIR/live-runner.env" ] && grep -q '^UPSTASH_REDIS_REST_TOKEN=' "$HOMEDIR/live-runner.env"; then
    SRC="$HOMEDIR/live-runner.env"
    grep -E '^UPSTASH_REDIS_REST_(URL|TOKEN)=' "$SRC" > "$ENVF"
  else
    PID="$(pgrep -u "$ME" -f 'live-runner' | head -1 || true)"
    if [ -n "$PID" ] && [ -r "/proc/$PID/environ" ]; then
      for p in $(pgrep -u "$ME" -f 'live-runner'); do
        if tr '\0' '\n' < "/proc/$p/environ" | grep -q '^UPSTASH_REDIS_REST_TOKEN='; then
          tr '\0' '\n' < "/proc/$p/environ" | grep -E '^UPSTASH_REDIS_REST_(URL|TOKEN)=' > "$ENVF"
          SRC="執行中的 live-runner（pid $p）"
          break
        fi
      done
    fi
  fi
  if [ ! -s "$ENVF" ]; then
    rm -f "$ENVF"
    echo "   找不到 UPSTASH 金鑰（~/live-runner.env 沒有、執行中的 live-runner 也讀不到）。"
    echo "   請手動建立 $ENVF，內容兩行（值跟 live-runner 用的一樣）："
    echo "     UPSTASH_REDIS_REST_URL=https://..."
    echo "     UPSTASH_REDIS_REST_TOKEN=..."
    echo "   然後 chmod 600 $ENVF 再重跑這支。"
    exit 1
  fi
  echo "   從 $SRC 複製了 $(wc -l < "$ENVF") 行"
fi
chmod 600 "$ENVF"
grep -q '^UPSTASH_REDIS_REST_URL=' "$ENVF" && grep -q '^UPSTASH_REDIS_REST_TOKEN=' "$ENVF" \
  || { echo "$ENVF 缺 URL 或 TOKEN"; exit 1; }

echo "== 6/7 安裝 systemd timer（ctrend.service／ctrend.timer）"
for u in ctrend.service ctrend.timer; do
  sed -e "s#__USER__#$ME#g" -e "s#__DIR__#$DIR#g" -e "s#__HOME__#$HOMEDIR#g" "deploy/$u" \
    | sudo tee "/etc/systemd/system/$u" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now ctrend.timer

echo "== 7/7 現在跑一次（寫 Redis；第一次會從 2026-10-26 補算，約 5～10 分鐘）"
sudo systemctl start ctrend.service || true
echo
echo "---------- journalctl -u ctrend（最後 40 行）----------"
sudo journalctl -u ctrend -n 40 --no-pager || true
echo "---------- systemctl list-timers ctrend* ----------"
systemctl list-timers 'ctrend*' --no-pager || true
echo
if systemctl is-failed --quiet ctrend.service; then
  echo "🔴 ctrend.service 失敗了：把上面整段貼回來。"
  exit 1
fi
echo "✅ 安裝完成。把上面整段輸出貼回來確認。"
