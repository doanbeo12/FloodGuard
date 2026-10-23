const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { checkDatabase } = require("./db-v2");
const { startMqttCollectorV2 } = require("./mqtt-collector-v2");
const { createV2Router } = require("./api-v2");

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json());
app.use("/api/v2", createV2Router());

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "FloodGuard Backend v2",
    api: "/api/v2",
  });
});

app.listen(PORT, async () => {
  console.log("FloodGuard v2 Render API listening on port " + PORT);

  try {
    await checkDatabase();
    console.log("[DB v2] Connected");
  } catch (error) {
    console.error("[DB v2] Connection failed:", error.message);
  }

  const mqttEnabled =
    String(process.env.MQTT_V2_ENABLED ?? "true").toLowerCase() !== "false";

  if (mqttEnabled) startMqttCollectorV2();
  else console.log("[MQTT v2] Collector disabled");
});
