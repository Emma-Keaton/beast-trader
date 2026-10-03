import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { requireDevice } from "./auth.js";
import { publicRouter, deviceRouter } from "./routes/index.js";
import { startPoller } from "./services/poller.js";
import { warmRegistry } from "./ml/strategies.js";
import { startIntradayCollector } from "./ml/intraday.js";

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: true }));
app.use(express.json({ limit: "256kb" }));

app.use("/api", publicRouter);
app.use("/api", requireDevice, deviceRouter);

app.use((err, _req, res, _next) => {
  console.error("[error]", err?.message || err);
  const status = Number(err?.status) || 500;
  res.status(status).json({
    error: status === 500 ? "Something went wrong on our side. Please try again." : err?.message || "Request failed",
  });
});

// Load the durable model registry before serving traffic. A cold process would
// otherwise answer the first predictions from an empty registry and quietly
// score every challenger as absent, which looks like "no improvement yet"
// rather than the transient state it is. A failure here must not stop the
// server: the prediction path falls back to the rules tier on its own.
warmRegistry()
  .then((m) => {
    console.log(
      `[registry] champion=${m.champion ? "loaded" : "none"} challengers=${m.challengers.length}`,
    );
  })
  .catch((err) => console.warn("[registry] warm failed:", err.message));

startPoller();

// Collect intraday history for the venue actually traded. Large-cap daily bars
// cannot answer questions about long-tail short-timeframe moves, and this is the
// only way to get data on the right venue. Off by default so a local run does not
// spend the rate limit unasked; set COLLECT_INTRADAY=true in the environment.
if (process.env.COLLECT_INTRADAY === "true") {
  const interval = process.env.COLLECT_INTERVAL || "15m";
  startIntradayCollector({ interval, bars: Number(process.env.COLLECT_BARS || 2000) });
  console.log(`[collect] intraday ${interval} collector started`);
}

app.listen(config.port, () => {
  console.log(`[beast-trader] backend :${config.port} | mode=${config.tradingMode} | poll=${config.pollIntervalMs}ms`);
});

export default app;
