import express from "express";
import type { ParkId } from "@disney-wait-planner/shared";

const app = express();
const PORT = 4000;

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
  });
});

// Example usage of shared type
const defaultPark: ParkId = "DL";
console.log(`Default park: ${defaultPark}`);

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
