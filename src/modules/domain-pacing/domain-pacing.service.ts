import { Injectable } from "@nestjs/common";

// Sends per cycle on one lane - with CYCLE_TOTAL_MS, fixes the rate at 3/min.
const CYCLE_COUNT = 3;

// Every CYCLE_COUNT delays on a lane add up to exactly this.
const CYCLE_TOTAL_MS = 60000;

// No two sends on a lane closer than this, whatever the random split.
const MIN_DELAY_MS = 10000;

// Shared across every queue consumer that sends email, so the same real
// domain gets paced against ONE lane regardless of which queue (initial vs
// follow-up) a message arrived on - a private Map per consumer would let an
// initial email and a follow-up for the same domain fire within the same
// pacing window of each other.
@Injectable()
export class DomainPacingService {
  private readonly lanes = new Map<string, Promise<void>>();

  // Per-lane queue of not-yet-used delays from the current cycle. Refilled
  // with a fresh randomized cycle once drained.
  private readonly delayQueues = new Map<string, number[]>();

  schedule(laneKey: string, task: () => Promise<void>): Promise<void> {
    const previousInLane = this.lanes.get(laneKey) ?? Promise.resolve();
    const thisTurn = previousInLane.catch(() => undefined).then(task);
    this.lanes.set(
      laneKey,
      thisTurn.catch(() => undefined),
    );
    return thisTurn;
  }

  // Randomized per-send delay, but every CYCLE_COUNT calls for a given lane
  // still sum to exactly CYCLE_TOTAL_MS - so the send *rate* stays fixed
  // (3/min) even though no individual wait is a fixed 20s.
  nextDelayMs(laneKey: string): number {
    let queue = this.delayQueues.get(laneKey);
    if (!queue || queue.length === 0) {
      queue = this.generateCycle();
      this.delayQueues.set(laneKey, queue);
    }
    return queue.shift() as number;
  }

  private generateCycle(): number[] {
    const slack = CYCLE_TOTAL_MS - MIN_DELAY_MS * CYCLE_COUNT;

    const weights = Array.from({ length: CYCLE_COUNT }, () => Math.random());
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

    const delays = weights.map((weight) =>
      Math.round(MIN_DELAY_MS + (weight / weightSum) * slack),
    );

    // Rounding can leave the sum a few ms off CYCLE_TOTAL_MS - park the
    // remainder on the last slot so the cycle still sums exactly.
    const roundedSum = delays.reduce((sum, delay) => sum + delay, 0);
    delays[delays.length - 1] += CYCLE_TOTAL_MS - roundedSum;

    for (let i = delays.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [delays[i], delays[j]] = [delays[j], delays[i]];
    }

    return delays;
  }
}
