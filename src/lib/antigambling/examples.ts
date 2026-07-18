// 內建範例資料 —— 原封搬自 anti-gambling-trader-tw core/examples/
// （MIT 授權；賭博型與具優勢型對照，讓使用者不上傳檔案也能看效果）

export interface ExampleFile {
  key: string;
  label: string;
  description: string;
  fileName: string;
  format: 'csv' | 'json';
  content: string;
}

const TW_STOCK_GAMBLING_CSV = `代號,方向,進場時間,出場時間,進場價,出場價,股數,策略
2330,做多,2025-01-03,2025-01-03,1000,1010,1000,當沖追高
2454,做多,2025-01-06,2025-01-06,1200,1180,1000,當沖追高
3008,做多,2025-01-07,2025-01-07,2500,2530,500,當沖追高
2330,做多,2025-01-08,2025-01-08,1015,1005,1000,當沖追高
2603,做多,2025-01-09,2025-01-09,180,178,5000,聽明牌
2609,做多,2025-01-10,2025-01-10,90,95,10000,聽明牌
2317,做多,2025-01-13,2025-01-13,210,208,3000,當沖追高
2412,做多,2025-01-14,2025-01-14,125,124,5000,當沖追高
2882,做多,2025-01-15,2025-01-15,68,69,10000,聽明牌
2891,做多,2025-01-16,2025-01-16,28,27,20000,聽明牌
2330,做多,2025-01-17,2025-01-17,1020,1000,1000,當沖追高
3034,做多,2025-01-20,2025-01-20,640,650,1000,當沖追高
2308,做多,2025-01-21,2025-01-21,480,475,1000,聽明牌
3037,做多,2025-01-22,2025-01-22,95,93,5000,當沖追高
6505,做多,2025-01-23,2025-01-23,82,83,10000,聽明牌
2603,做多,2025-02-03,2025-02-03,185,180,5000,聽明牌
2609,做多,2025-02-04,2025-02-04,98,92,10000,聽明牌
2615,做多,2025-02-05,2025-02-05,120,115,3000,當沖追高
2330,做多,2025-02-06,2025-02-06,1030,1025,1000,當沖追高
2454,做多,2025-02-07,2025-02-07,1250,1230,500,當沖追高
3008,做多,2025-02-10,2025-02-10,2600,2580,300,當沖追高
2317,做多,2025-02-11,2025-02-11,215,212,3000,聽明牌
2882,做多,2025-02-12,2025-02-12,70,68,10000,聽明牌
2891,做多,2025-02-13,2025-02-13,29,30,20000,聽明牌
2412,做多,2025-02-14,2025-02-14,127,125,5000,當沖追高
2308,做多,2025-02-17,2025-02-17,490,485,1000,聽明牌
3034,做多,2025-02-18,2025-02-18,655,648,1000,當沖追高
2603,做多,2025-02-19,2025-02-19,182,179,5000,聽明牌
2609,做多,2025-02-20,2025-02-20,94,90,10000,聽明牌
2615,做多,2025-02-21,2025-02-21,118,112,3000,當沖追高
3037,做多,2025-02-24,2025-02-24,96,94,5000,當沖追高
6505,做多,2025-02-25,2025-02-25,84,82,10000,聽明牌
2330,做多,2025-02-26,2025-02-26,1040,1020,1000,當沖追高
2454,做多,2025-02-27,2025-02-27,1260,1300,500,當沖追高
2317,做多,2025-03-03,2025-03-03,218,214,3000,聽明牌
`;

const US_STOCK_EDGE_CSV = `symbol,side,entry_time,exit_time,entry_price,exit_price,quantity,fees,strategy
AAPL,long,2024-01-05,2024-02-20,182,195,100,2.0,季線突破
MSFT,long,2024-01-08,2024-03-01,370,395,50,1.5,季線突破
NVDA,long,2024-01-10,2024-02-15,540,610,30,1.5,季線突破
GOOGL,long,2024-01-12,2024-02-05,140,138,100,2.0,季線突破
AMZN,long,2024-01-15,2024-03-10,153,168,80,2.0,季線突破
META,long,2024-01-18,2024-02-28,390,470,40,1.5,季線突破
AAPL,long,2024-02-22,2024-04-05,196,189,100,2.0,季線突破
MSFT,long,2024-03-04,2024-04-20,398,415,50,1.5,季線突破
NVDA,long,2024-02-19,2024-04-01,615,880,30,2.0,季線突破
TSLA,long,2024-02-01,2024-02-20,188,200,100,2.0,均線多頭
AMD,long,2024-02-05,2024-03-15,170,185,100,1.5,均線多頭
GOOGL,long,2024-02-08,2024-03-25,139,152,100,2.0,季線突破
AMZN,long,2024-03-12,2024-04-30,169,178,80,2.0,季線突破
META,long,2024-03-01,2024-04-15,472,500,40,1.5,季線突破
AAPL,long,2024-04-08,2024-05-30,190,192,100,2.0,均線多頭
MSFT,long,2024-04-22,2024-06-10,416,448,50,1.5,季線突破
NVDA,long,2024-04-03,2024-05-25,885,1100,20,2.0,季線突破
TSLA,long,2024-02-25,2024-03-20,202,175,100,2.0,均線多頭
AMD,long,2024-03-18,2024-04-10,186,178,100,1.5,均線多頭
GOOGL,long,2024-03-28,2024-05-15,153,175,100,2.0,季線突破
AMZN,long,2024-05-02,2024-06-20,179,190,80,2.0,季線突破
META,long,2024-04-18,2024-06-05,502,495,40,1.5,季線突破
AAPL,long,2024-06-01,2024-07-20,193,225,100,2.0,季線突破
MSFT,long,2024-06-12,2024-07-30,450,438,50,1.5,均線多頭
NVDA,long,2024-05-28,2024-07-10,1105,1280,20,2.0,季線突破
TSLA,long,2024-04-15,2024-05-30,176,178,100,2.0,均線多頭
AMD,long,2024-04-12,2024-06-01,179,168,100,1.5,均線多頭
GOOGL,long,2024-05-18,2024-07-05,176,185,100,2.0,季線突破
AMZN,long,2024-06-22,2024-08-10,191,178,80,2.0,均線多頭
META,long,2024-06-08,2024-07-25,496,540,40,1.5,季線突破
AAPL,long,2024-07-22,2024-09-10,226,221,100,2.0,均線多頭
MSFT,long,2024-08-01,2024-09-20,440,432,50,1.5,均線多頭
NVDA,long,2024-07-12,2024-08-30,1285,1240,20,2.0,均線多頭
GOOGL,long,2024-07-08,2024-08-28,186,205,100,2.0,季線突破
AMZN,long,2024-08-12,2024-10-01,179,195,80,2.0,季線突破
META,long,2024-07-28,2024-09-15,542,580,40,1.5,季線突破
AAPL,long,2024-09-12,2024-11-01,222,235,100,2.0,季線突破
MSFT,long,2024-09-22,2024-11-10,433,455,50,1.5,季線突破
NVDA,long,2024-09-01,2024-10-20,1245,1420,20,2.0,季線突破
AMZN,long,2024-10-03,2024-11-25,196,210,80,2.0,季線突破
META,long,2024-09-18,2024-11-05,581,615,40,1.5,季線突破
GOOGL,long,2024-09-01,2024-10-15,205,198,100,2.0,均線多頭
`;

const CRYPTO_LUCK_JSON = `{
  "source": "binance_export",
  "trades": [
    {"symbol": "BTCUSDT", "side": "long", "entry_time": "2025-01-02", "exit_time": "2025-01-04", "entry_price": 94000, "exit_price": 96000, "quantity": 0.1, "strategy": "追突破"},
    {"symbol": "ETHUSDT", "side": "long", "entry_time": "2025-01-03", "exit_time": "2025-01-05", "entry_price": 3300, "exit_price": 3200, "quantity": 2, "strategy": "追突破"},
    {"symbol": "SOLUSDT", "side": "long", "entry_time": "2025-01-05", "exit_time": "2025-01-06", "entry_price": 210, "exit_price": 235, "quantity": 20, "strategy": "梭哈迷因"},
    {"symbol": "DOGEUSDT", "side": "long", "entry_time": "2025-01-06", "exit_time": "2025-01-07", "entry_price": 0.38, "exit_price": 0.33, "quantity": 30000, "strategy": "梭哈迷因"},
    {"symbol": "BTCUSDT", "side": "long", "entry_time": "2025-01-08", "exit_time": "2025-01-09", "entry_price": 95000, "exit_price": 93000, "quantity": 0.1, "strategy": "追突破"},
    {"symbol": "PEPEUSDT", "side": "long", "entry_time": "2025-01-09", "exit_time": "2025-01-10", "entry_price": 0.000018, "exit_price": 0.000035, "quantity": 500000000, "strategy": "梭哈迷因"},
    {"symbol": "ETHUSDT", "side": "long", "entry_time": "2025-01-11", "exit_time": "2025-01-12", "entry_price": 3250, "exit_price": 3100, "quantity": 2, "strategy": "追突破"},
    {"symbol": "SOLUSDT", "side": "long", "entry_time": "2025-01-12", "exit_time": "2025-01-13", "entry_price": 230, "exit_price": 215, "quantity": 20, "strategy": "追突破"},
    {"symbol": "DOGEUSDT", "side": "long", "entry_time": "2025-01-14", "exit_time": "2025-01-15", "entry_price": 0.34, "exit_price": 0.31, "quantity": 30000, "strategy": "梭哈迷因"},
    {"symbol": "BTCUSDT", "side": "long", "entry_time": "2025-01-16", "exit_time": "2025-01-17", "entry_price": 94500, "exit_price": 92000, "quantity": 0.1, "strategy": "追突破"},
    {"symbol": "WIFUSDT", "side": "long", "entry_time": "2025-01-17", "exit_time": "2025-01-18", "entry_price": 2.1, "exit_price": 1.7, "quantity": 3000, "strategy": "梭哈迷因"},
    {"symbol": "ETHUSDT", "side": "long", "entry_time": "2025-01-19", "exit_time": "2025-01-20", "entry_price": 3150, "exit_price": 3050, "quantity": 2, "strategy": "追突破"},
    {"symbol": "SOLUSDT", "side": "long", "entry_time": "2025-01-21", "exit_time": "2025-01-22", "entry_price": 218, "exit_price": 205, "quantity": 20, "strategy": "追突破"},
    {"symbol": "PEPEUSDT", "side": "long", "entry_time": "2025-01-22", "exit_time": "2025-01-23", "entry_price": 0.000030, "exit_price": 0.000024, "quantity": 500000000, "strategy": "梭哈迷因"},
    {"symbol": "BTCUSDT", "side": "long", "entry_time": "2025-01-24", "exit_time": "2025-01-25", "entry_price": 93000, "exit_price": 91000, "quantity": 0.1, "strategy": "追突破"},
    {"symbol": "DOGEUSDT", "side": "long", "entry_time": "2025-01-26", "exit_time": "2025-01-27", "entry_price": 0.32, "exit_price": 0.29, "quantity": 30000, "strategy": "梭哈迷因"},
    {"symbol": "ETHUSDT", "side": "long", "entry_time": "2025-01-28", "exit_time": "2025-01-29", "entry_price": 3050, "exit_price": 2950, "quantity": 2, "strategy": "追突破"},
    {"symbol": "SOLUSDT", "side": "long", "entry_time": "2025-01-30", "exit_time": "2025-01-31", "entry_price": 200, "exit_price": 190, "quantity": 20, "strategy": "追突破"},
    {"symbol": "WIFUSDT", "side": "long", "entry_time": "2025-02-01", "exit_time": "2025-02-02", "entry_price": 1.6, "exit_price": 1.4, "quantity": 3000, "strategy": "梭哈迷因"},
    {"symbol": "BTCUSDT", "side": "long", "entry_time": "2025-02-03", "exit_time": "2025-02-04", "entry_price": 91000, "exit_price": 89000, "quantity": 0.1, "strategy": "追突破"},
    {"symbol": "PEPEUSDT", "side": "long", "entry_time": "2025-02-05", "exit_time": "2025-02-06", "entry_price": 0.000024, "exit_price": 0.000020, "quantity": 500000000, "strategy": "梭哈迷因"},
    {"symbol": "ETHUSDT", "side": "long", "entry_time": "2025-02-07", "exit_time": "2025-02-08", "entry_price": 2950, "exit_price": 2880, "quantity": 2, "strategy": "追突破"}
  ]
}
`;

export const EXAMPLE_FILES: ExampleFile[] = [
  {
    key: 'tw_gambling',
    label: '台股當沖（賭博型）',
    description: '35 筆全當沖 + 聽明牌 —— 典型的負期望值賭博紀錄',
    fileName: 'tw_stock_gambling.csv',
    format: 'csv',
    content: TW_STOCK_GAMBLING_CSV,
  },
  {
    key: 'us_edge',
    label: '美股波段（具優勢型）',
    description: '42 筆季線突破/均線多頭 —— 通過統計檢定的正期望值範例',
    fileName: 'us_stock_edge.csv',
    format: 'csv',
    content: US_STOCK_EDGE_CSV,
  },
  {
    key: 'crypto_luck',
    label: '加密貨幣（疑似運氣型）',
    description: '22 筆追突破/梭哈迷因 —— 帳面靠少數暴賺撐場的紀錄',
    fileName: 'crypto_luck.json',
    format: 'json',
    content: CRYPTO_LUCK_JSON,
  },
];
