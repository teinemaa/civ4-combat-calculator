// Web Worker for running combat simulations off the main thread

import { simulateStackCombat } from './simulation.js';

let currentTaskId = null;

self.onmessage = function(e) {
  const { taskId, attackerStack, defenderStack, context, numRuns } = e.data;
  currentTaskId = taskId;

  const results = simulateStackCombat(attackerStack, defenderStack, context, numRuns);

  // Only post if this task wasn't superseded
  if (currentTaskId === taskId) {
    self.postMessage({ taskId, results });
  }
};
