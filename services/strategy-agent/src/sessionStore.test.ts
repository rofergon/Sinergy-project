import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StrategyAgentSessionStore } from "./services/sessionStore.js";

test("session store persists session state across instances", () => {
  const root = mkdtempSync(join(tmpdir(), "sinergy-agent-session-"));
  const dbFile = join(root, "agent.sqlite");

  const firstStore = new StrategyAgentSessionStore({ dbFile });
  const session = firstStore.getOrCreate({
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111"
  });

  firstStore.addTurn(session, {
    role: "user",
    mode: "run",
    text: "Create a mean reversion strategy"
  });
  firstStore.applyArtifacts(session, {
    strategyId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222"
  });

  const secondStore = new StrategyAgentSessionStore({ dbFile });
  const restored = secondStore.getOrCreate({
    sessionId: session.sessionId,
    ownerAddress: session.ownerAddress
  });
  const snapshot = secondStore.snapshot(restored);

  assert.equal(snapshot.sessionId, session.sessionId);
  assert.equal(snapshot.strategyId, "11111111-1111-4111-8111-111111111111");
  assert.equal(snapshot.runId, "22222222-2222-4222-8222-222222222222");
  assert.equal(snapshot.turnCount, 1);
  assert.equal(snapshot.recentTurns[0]?.text, "Create a mean reversion strategy");
});
