// 「止損／止盈觸發了，但真的把部位平乾淨了嗎？」——條件單觸發後的對帳純函數。
//
// 為什麼需要這個檔：2026-09-06 UNIUSDT 的移動止損（STOP_MARKET +
// closePosition=true）連續四次平錯數量都沒人發現——82→平41、31→平10、
// 21→平20，最後一次部位只剩 1 張卻平了 40 張，把多單翻成 -39 的空單，裸奔
// 十小時。前三次「沒平乾淨」在任何既有工具上都看不出來：`npm run status`
// 只看當下有沒有保護單，`npm run audit-exits` 對的是損益不是數量。
//
// ── 為什麼要從「現在」往回推，不從視窗起點往前加 ──────────────────────
// 直覺做法是「抓 N 天內的成交，從 0 開始累加」重建每一刻的部位。這個做法
// 2026-09-06 第一版就踩到了：SOL 跟 BTC 被誤報成翻倉，實際上只是 N 天前
// 就已經有部位，視窗起點的基準不是 0。誤報比漏報更貴——這個專案一個月內
// 抓到七個量測錯誤，每一個在被抓到前都長得像結論。
//
// 正確做法：拿交易所**現在**的真實部位當錨點往回推。
//   觸發前部位 = 現在的部位 − Σ(觸發時間之後的所有成交，帶正負號)
// 這個式子跟視窗起點的基準無關，只要「觸發時間之後」的成交沒有缺漏就精確。
// 呼叫端因此有義務把成交抓完整（分頁抓到底），寧可多抓也不要截斷——截斷會
// 讓這個式子從「精確」變成「靜悄悄地錯」。

export type CloseFillVerdict = 'clean' | 'partial' | 'flipped';

export interface AuditFill {
  time: number;
  side: 'BUY' | 'SELL';
  qty: number;
}

export interface AuditTriggeredAlgo {
  clientAlgoId: string;
  orderType: string;     // STOP_MARKET / TAKE_PROFIT_MARKET / …
  side: 'BUY' | 'SELL';
  triggerTime: number;
  actualQty: number;     // 交易所實際成交的數量（不是我們掛單時寫的 quantity）
  closePosition: boolean;
}

export interface AuditRow extends AuditTriggeredAlgo {
  positionBefore: number;  // 帶正負號
  positionAfter: number;   // 帶正負號
  closedQty: number;       // 帶正負號（SELL 為負）
  verdict: CloseFillVerdict;
}

export interface AuditInput {
  currentPosition: number;   // 交易所此刻的真實部位，帶正負號（positionRisk.positionAmt）
  fills: AuditFill[];        // 這個 symbol 的成交紀錄，**必須涵蓋最早那筆觸發之後的全部**
  triggered: AuditTriggeredAlgo[];
}

// 浮點數容差：幣安的數量是字串轉來的，0.1+0.2 那類誤差會讓「剛好平乾淨」
// 看起來像剩 4.4e-16。用相對容差，避免對 19105 張 DOGE 跟 0.0124 顆 BTC
// 套同一個絕對值。
function isFlat(qty: number, scale: number): boolean {
  return Math.abs(qty) <= Math.max(1e-8, Math.abs(scale) * 1e-6);
}

export function auditCloseFills(input: AuditInput): AuditRow[] {
  const signed = (f: AuditFill) => (f.side === 'BUY' ? f.qty : -f.qty);

  return input.triggered
    .slice()
    .sort((a, b) => a.triggerTime - b.triggerTime)
    .map((algo) => {
      // 觸發時間「之後（含當下）」的成交——條件單自己那筆成交的時間戳跟
      // triggerTime 相同，用 >= 才會把它算進「之後」，positionBefore 才是
      // 真正的觸發前部位。
      const after = input.fills
        .filter(f => f.time >= algo.triggerTime)
        .reduce((sum, f) => sum + signed(f), 0);

      const positionBefore = input.currentPosition - after;
      const closedQty = algo.side === 'BUY' ? algo.actualQty : -algo.actualQty;
      const positionAfter = positionBefore + closedQty;

      let verdict: CloseFillVerdict;
      if (isFlat(positionAfter, positionBefore)) {
        verdict = 'clean';
      } else if (!isFlat(positionBefore, positionBefore)
                 && Math.sign(positionAfter) !== Math.sign(positionBefore)) {
        // 平完之後方向反了 = 平過頭，開出了一個反向部位。這是最嚴重的那種，
        // 因為新開的那個部位沒有任何保護單。
        verdict = 'flipped';
      } else {
        verdict = 'partial';
      }

      return { ...algo, positionBefore, positionAfter, closedQty, verdict };
    });
}
