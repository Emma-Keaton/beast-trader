Here is an end-to-end guide on building, deploying, and integrating the **Kronos Predictor Sidecar** on **Modal** with your **TypeScript trading app**.

---

### System Architecture

```
┌────────────────────────────────────────────────────────┐
│             TypeScript Trading Bot (Node/Bun)          │
│                                                        │
│  ┌──────────────────┐       ┌───────────────────────┐  │
│  │ Exchange Stream  │ ───►  │ Candle Buffer (400)   │  │
│  │ (Binance/Bybit)  │       └──────────┬────────────┘  │
│  └──────────────────┘                  │               │
│                               Bar-Close Event          │
│                                        ▼               │
│                             ┌───────────────────────┐  │
│                             │     KronosClient      │  │
│                             └──────────┬────────────┘  │
└────────────────────────────────────────┼───────────────┘
                                         │ HTTPS / POST (JSON)
                                         ▼
┌────────────────────────────────────────────────────────┐
│           Serverless GPU Sidecar (Modal.com)           │
│                                                        │
│  ┌──────────────────┐       ┌───────────────────────┐  │
│  │ FastAPI Endpoint │ ───►  │ Feature Preprocessing │  │
│  └──────────────────┘       │ (Time features, Norm) │  │
│                             └──────────┬────────────┘  │
│                                        │               │
│                                        ▼               │
│                             ┌───────────────────────┐  │
│                             │ Kronos Model (PyTorch)│  │
│                             │ (Nvidia T4 GPU)       │  │
│                             └───────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

---

## Part 1: The Modal Sidecar (Python)

### 1. File Structure
Organize your Python sidecar directory next to the Kronos `model/` folder:

```text
kronos-sidecar/
├── model/                  # Copied directly from shiyu-coder-kronos/model
│   ├── __init__.py
│   ├── kronos.py
│   └── module.py
├── kronos_modal.py         # Modal deployment script
└── requirements.txt        # Local testing requirements
```

### 2. Sidecar Implementation (`kronos_modal.py`)

Create `kronos_modal.py`:

```python
import modal
from typing import List, Dict, Any
import pandas as pd
import numpy as np

# 1. Define Container Image
kronos_image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install(
        "torch>=2.1.0",
        "huggingface_hub==0.33.1",
        "transformers",
        "einops==0.8.1",
        "pandas==2.2.2",
        "numpy>=1.26.0",
        "fastapi[standard]"
    )
    # Bundle the local 'model' directory into Python's path
    .add_local_python_source("model")
)

app = modal.App("kronos-sidecar", image=kronos_image)

@app.cls(
    gpu="T4",                 # Cost-efficient GPU, well suited for Kronos inference
    scaledown_window=300,     # Keep container warm for 5 minutes after each invocation
    timeout=120
)
class KronosPredictorService:
    @modal.enter()
    def initialize(self):
        """Loads weights once during container startup."""
        import torch
        from model import Kronos, KronosTokenizer, KronosPredictor

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading Kronos on {self.device}...")

        # Initialize Tokenizer and Model from Hugging Face
        self.tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
        self.model = Kronos.from_pretrained("NeoQuasar/Kronos-small")
        
        # Instantiate Predictor
        self.predictor = KronosPredictor(
            self.model,
            self.tokenizer,
            device=self.device,
            max_context=512
        )
        print("Kronos loaded and ready for inference.")

    @modal.fastapi_endpoint(method="POST")
    def predict(self, req: Dict[str, Any]):
        candles = req.get("candles", [])
        pred_len = int(req.get("pred_len", 15))
        temperature = float(req.get("temperature", 1.0))
        top_p = float(req.get("top_p", 0.9))

        if len(candles) < 400:
            return {"error": f"Requires at least 400 candles. Received {len(candles)}."}

        # 1. Build DataFrame
        df = pd.DataFrame(candles)
        df["timestamps"] = pd.to_datetime(df["timestamp"])
        df = df.sort_values("timestamps").reset_index(drop=True)

        # 2. Fill missing volume or amount
        if "volume" not in df.columns:
            df["volume"] = 0.0
        if "amount" not in df.columns or df["amount"].isna().all():
            df["amount"] = df["close"] * df["volume"]

        # 3. Construct Future Timestamps based on frequency
        time_diff = df["timestamps"].iloc[-1] - df["timestamps"].iloc[-2]
        future_timestamps = pd.date_range(
            start=df["timestamps"].iloc[-1] + time_diff,
            periods=pred_len,
            freq=time_diff
        )

        # 4. Truncate context to model's limit (up to 512)
        lookback = min(len(df), 512)
        x_df = df.iloc[-lookback:][["open", "high", "low", "close", "volume", "amount"]]
        x_ts = df.iloc[-lookback:]["timestamps"]

        # 5. Execute Inference
        pred_df = self.predictor.predict(
            df=x_df,
            x_timestamp=x_ts,
            y_timestamp=pd.Series(future_timestamps),
            pred_len=pred_len,
            T=temperature,
            top_p=top_p,
            sample_count=1,
            verbose=False
        )

        # 6. Compute Directional Signals
        current_close = float(df["close"].iloc[-1])
        predicted_close = float(pred_df["close"].iloc[-1])
        predicted_high = float(pred_df["high"].max())
        predicted_low = float(pred_df["low"].min())
        
        delta_pct = ((predicted_close - current_close) / current_close) * 100.0

        return {
            "current_close": current_close,
            "predicted_close": predicted_close,
            "predicted_high": predicted_high,
            "predicted_low": predicted_low,
            "delta_percent": delta_pct,
            "forecast": pred_df.reset_index().to_dict(orient="records")
        }
```

### 3. Deploy to Modal

Run from your terminal:
```bash
modal setup       # One-time login
modal deploy kronos_modal.py
```

Save the generated URL:
```text
✓ Created web endpoint: https://<workspace>--kronos-sidecar-kronospredictorservice-predict.modal.run
```

---

## Part 2: TypeScript Trading Bot Integration

### 1. Bot Project Structure

```text
trading-bot/
├── src/
│   ├── types.ts              # Data contracts and schemas
│   ├── CandleBuffer.ts       # 400-candle rolling buffer
│   ├── KronosClient.ts       # Modal HTTP connector
│   └── index.ts              # Trading loop / Strategy entry point
├── package.json
└── tsconfig.json
```

Install dependencies:
```bash
npm install axios dotenv
npm install -D typescript @types/node
```

### 2. Type Definitions (`src/types.ts`)

```typescript
export interface Candle {
  timestamp: string | number | Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount?: number;
}

export interface PredictionPoint {
  index: string; // Timestamp from prediction
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

export interface KronosResponse {
  current_close: number;
  predicted_close: number;
  predicted_high: number;
  predicted_low: number;
  delta_percent: number;
  forecast: PredictionPoint[];
  error?: string;
}

export interface PredictionConfig {
  predLen?: number;
  temperature?: number;
  topP?: number;
}
```

### 3. Rolling Candle Buffer (`src/CandleBuffer.ts`)

Kronos requires contiguous historical context (typically 400–512 candles). This class keeps the sliding window sorted and populated:

```typescript
import { Candle } from "./types";

export class CandleBuffer {
  private buffer: Candle[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = 450) {
    this.maxSize = maxSize;
  }

  /**
   * Appends or updates the latest candle.
   */
  public addCandle(candle: Candle): void {
    // Standardize timestamp
    const normalized: Candle = {
      ...candle,
      timestamp: new Date(candle.timestamp).toISOString(),
      amount: candle.amount ?? (candle.volume * candle.close)
    };

    // If latest timestamp already exists, replace it (bar update)
    const lastIndex = this.buffer.length - 1;
    if (lastIndex >= 0 && this.buffer[lastIndex].timestamp === normalized.timestamp) {
      this.buffer[lastIndex] = normalized;
      return;
    }

    this.buffer.push(normalized);

    // Evict oldest candles to maintain fixed lookback
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  public isReady(): boolean {
    return this.buffer.length >= 400;
  }

  public getCandles(): Candle[] {
    return [...this.buffer];
  }

  public get size(): number {
    return this.buffer.length;
  }
}
```

### 4. Modal Client Service (`src/KronosClient.ts`)

```typescript
import axios, { AxiosInstance } from "axios";
import { Candle, KronosResponse, PredictionConfig } from "./types";

export class KronosClient {
  private readonly client: AxiosInstance;
  private readonly endpointUrl: string;

  constructor(endpointUrl: string) {
    this.endpointUrl = endpointUrl;
    this.client = axios.create({
      timeout: 45000, // 45s: accommodates cold-start spinup on Modal
      headers: { "Content-Type": "application/json" }
    });
  }

  public async getPrediction(
    candles: Candle[],
    config: PredictionConfig = {}
  ): Promise<KronosResponse | null> {
    if (candles.length < 400) {
      console.warn(`[KronosClient] Insufficient candles: ${candles.length}/400`);
      return null;
    }

    const payload = {
      candles: candles.slice(-400),
      pred_len: config.predLen ?? 15,
      temperature: config.temperature ?? 1.0,
      top_p: config.topP ?? 0.9
    };

    try {
      const response = await this.client.post<KronosResponse>(
        this.endpointUrl,
        payload
      );

      if (response.data.error) {
        console.error(`[KronosClient] Sidecar error: ${response.data.error}`);
        return null;
      }

      return response.data;
    } catch (err: any) {
      if (err.code === "ECONNABORTED") {
        console.error("[KronosClient] Timeout exceeded during prediction request");
      } else {
        console.error("[KronosClient] Request failed:", err.response?.data || err.message);
      }
      return null;
    }
  }
}
```

### 5. Bot Integration & Strategy Loop (`src/index.ts`)

```typescript
import { CandleBuffer } from "./CandleBuffer";
import { KronosClient } from "./KronosClient";
import { Candle } from "./types";

const MODAL_URL = process.env.KRONOS_MODAL_URL || "https://<workspace>--kronos-sidecar-kronospredictorservice-predict.modal.run";

const buffer = new CandleBuffer(450);
const kronos = new KronosClient(MODAL_URL);

/**
 * Invoked every time a candle/bar closes.
 */
async function onCandleClose(closedCandle: Candle) {
  buffer.addCandle(closedCandle);

  console.log(`[Market] New candle closed: ${closedCandle.timestamp} | Close: ${closedCandle.close}`);

  if (!buffer.isReady()) {
    console.log(`[Engine] Warming up buffer: ${buffer.size}/400 candles available.`);
    return;
  }

  console.log("[Engine] Triggering Kronos forecasting sidecar...");
  const startTime = Date.now();

  const prediction = await kronos.getPrediction(buffer.getCandles(), {
    predLen: 12,        // Predict next 12 bars
    temperature: 0.8    // Lower temperature for less volatile signals
  });

  const latency = Date.now() - startTime;
  if (!prediction) return;

  console.log(`[Engine] Inference completed in ${latency}ms`);
  console.log(`[Signal] Expected Move: ${prediction.delta_percent.toFixed(2)}%`);
  console.log(`[Signal] Target Price: $${prediction.predicted_close.toFixed(2)}`);

  // Simple Execution Policy
  const ENTRY_THRESHOLD = 1.2; // 1.2% threshold
  if (prediction.delta_percent >= ENTRY_THRESHOLD) {
    executeTrade("LONG", prediction.current_close, prediction.predicted_high);
  } else if (prediction.delta_percent <= -ENTRY_THRESHOLD) {
    executeTrade("SHORT", prediction.current_close, prediction.predicted_low);
  } else {
    console.log("[Engine] Directional delta within neutral zone. Holding.");
  }
}

function executeTrade(direction: "LONG" | "SHORT", currentPrice: number, target: number) {
  console.log(`>>> EXECUTING ${direction} ORDER <<<`);
  console.log(`Entry: ${currentPrice} | Take Profit Target: ${target}`);
  // Place your exchange API order execution call here (e.g., ccxt, binance-connector)
}

// -------------------------------------------------------------
// Quick Test Harness: Simulating 405 candles
// -------------------------------------------------------------
async function runMockSimulation() {
  console.log("Generating 405 sample candles for testing...");
  const baseTime = Date.now() - 405 * 5 * 60 * 1000;
  let price = 65000;

  for (let i = 0; i < 405; i++) {
    const time = new Date(baseTime + i * 5 * 60 * 1000);
    const change = (Math.random() - 0.49) * 50;
    price += change;
    const mockCandle: Candle = {
      timestamp: time.toISOString(),
      open: price - 10,
      high: price + 15,
      low: price - 15,
      close: price,
      volume: 120 + Math.random() * 50
    };

    if (i < 404) {
      buffer.addCandle(mockCandle);
    } else {
      // Simulate real-time candle close
      await onCandleClose(mockCandle);
    }
  }
}

runMockSimulation().catch(console.error);
```

---

## Part 3: Testing and Production Hardening

### 1. Test the Modal Endpoint with `curl`
Before running your trading bot, confirm the deployed endpoint responds correctly:

```bash
curl -X POST https://<workspace>--kronos-sidecar-kronospredictorservice-predict.modal.run \
  -H "Content-Type: application/json" \
  -d '{
    "pred_len": 5,
    "temperature": 1.0,
    "candles": [
      {"timestamp": "2026-01-01T00:00:00Z", "open": 100, "high": 105, "low": 99, "close": 102, "volume": 1000, "amount": 102000}
      /* ... repeat for 400 candles ... */
    ]
  }'
```

### 2. Operational Tuning

| Problem | Cause | Solution |
| :--- | :--- | :--- |
| **High Latency on First Bar** | Container cold start | Set `scaledown_window=360` in `kronos_modal.py` (6 minutes). On 5m intervals, this ensures the GPU never shuts down between bars. |
| **Out-Of-Memory (OOM) Errors** | Model context length | Clamp lookback in Python (`lookback = min(len(df), 512)`). Kronos attention cannot process sequences longer than 512. |
| **NaN Predictions** | Missing Volume/Amount | Always normalize `amount = volume * close` in the TS client if your broker only provides `volume`. |
| **Credit Exhaustion** | Inactive trading hours | If trading equity markets that close overnight, cron a health check to wake the service right before the market open rather than keeping it awake 24/7. |