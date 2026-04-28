
import { startBot } from "./bot.js";
import { startScheduler } from "./scheduler.js";
import { startHealthServer } from "./health.js";

console.log("[RegenHub Bot] Starting...");
startBot();
startScheduler();
startHealthServer();
