import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StrategyToolName } from "@sinergy/shared";
import type {
  AgentArtifacts,
  AgentSessionListItem,
  AgentSessionSnapshot,
  AgentSessionTurn,
  AgentStrategySummary,
  AgentToolTraceEntry
} from "../types.js";

type StrategyAgentSession = {
  sessionId: string;
  ownerAddress: string;
  marketId?: string;
  strategyId?: string;
  strategy?: AgentStrategySummary;
  runId?: string;
  summary?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

const MAX_RECENT_TURNS = 12;
const MAX_SESSIONS = 200;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function parseOptionalJson(value: unknown) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return JSON.parse(value) as Record<string, unknown>;
}

export class StrategyAgentSessionStore {
  private readonly db: DatabaseSync;

  constructor(private readonly options: { dbFile: string }) {
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new DatabaseSync(options.dbFile);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.ensureSchema();
  }

  getOrCreate(input: { sessionId?: string; ownerAddress: string; marketId?: string; strategyId?: string }) {
    this.prune();

    if (input.sessionId) {
      const existing = this.readSession(input.sessionId);
      if (existing) {
        if (existing.ownerAddress.toLowerCase() !== input.ownerAddress.toLowerCase()) {
          throw new Error("Session owner mismatch.");
        }
        const nextStrategyId = input.strategyId ?? existing.strategyId;
        const updated: StrategyAgentSession = {
          ...existing,
          marketId: input.marketId ?? existing.marketId,
          strategyId: nextStrategyId,
          strategy: nextStrategyId === existing.strategyId ? existing.strategy : undefined,
          updatedAt: new Date().toISOString()
        };
        this.writeSession(updated);
        return updated;
      }
    }

    const now = new Date().toISOString();
    const session: StrategyAgentSession = {
      sessionId: input.sessionId ?? crypto.randomUUID(),
      ownerAddress: input.ownerAddress,
      marketId: input.marketId,
      strategyId: input.strategyId,
      createdAt: now,
      updatedAt: now
    };

    this.writeSession(session);
    return session;
  }

  addTurn(
    session: StrategyAgentSession,
    turn: Omit<AgentSessionTurn, "id" | "createdAt">
  ) {
    const nextTurn: AgentSessionTurn = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...turn
    };

    this.db
      .prepare(
        `
          INSERT INTO agent_session_turns (
            turn_id,
            session_id,
            role,
            mode,
            text,
            used_tools_json,
            warnings_json,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        nextTurn.id,
        session.sessionId,
        nextTurn.role,
        nextTurn.mode,
        nextTurn.text,
        nextTurn.usedTools ? JSON.stringify(nextTurn.usedTools) : null,
        nextTurn.warnings ? JSON.stringify(nextTurn.warnings) : null,
        nextTurn.createdAt
      );

    session.updatedAt = nextTurn.createdAt;
    this.touchSession(session);
    return nextTurn;
  }

  appendTrace(session: StrategyAgentSession, trace: AgentToolTraceEntry[]) {
    if (trace.length === 0) return;

    const insert = this.db.prepare(
      `
        INSERT INTO agent_session_tool_trace (
          trace_id,
          session_id,
          step,
          tool,
          input_json,
          output_json,
          error_json,
          started_at,
          completed_at,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );

    const now = new Date().toISOString();
    for (const entry of trace) {
      insert.run(
        crypto.randomUUID(),
        session.sessionId,
        entry.step,
        entry.tool,
        JSON.stringify(entry.input),
        entry.output ? JSON.stringify(entry.output) : null,
        entry.error ? JSON.stringify(entry.error) : null,
        entry.startedAt,
        entry.completedAt ?? null,
        now
      );
    }
    session.updatedAt = now;
    this.touchSession(session);
  }

  applyArtifacts(session: StrategyAgentSession, artifacts: AgentArtifacts) {
    session.strategyId = artifacts.strategyId ?? session.strategyId;
    session.strategy = artifacts.strategy ?? session.strategy;
    session.marketId = artifacts.strategy?.marketId ?? session.marketId;
    session.runId = artifacts.runId ?? session.runId;
    session.summary = artifacts.summary ?? session.summary;
    session.validation = artifacts.validation ?? session.validation;
    session.updatedAt = new Date().toISOString();
    this.writeSession(session);
  }

  snapshot(session: StrategyAgentSession): AgentSessionSnapshot {
    const turnCountRow = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM agent_session_turns
          WHERE session_id = ?
        `
      )
      .get(session.sessionId) as { count: number };

    const recentTurns = this.db
      .prepare(
        `
          SELECT turn_id, role, mode, text, used_tools_json, warnings_json, created_at
          FROM agent_session_turns
          WHERE session_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `
      )
      .all(session.sessionId, MAX_RECENT_TURNS) as Array<{
      turn_id: string;
      role: "user" | "assistant";
      mode: "run" | "plan";
      text: string;
      used_tools_json: string | null;
      warnings_json: string | null;
      created_at: string;
    }>;

    return {
      sessionId: session.sessionId,
      ownerAddress: session.ownerAddress,
      marketId: session.marketId,
      strategyId: session.strategyId,
      strategy: session.strategy,
      runId: session.runId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      turnCount: turnCountRow.count,
      recentTurns: recentTurns
        .reverse()
        .map((turn) => ({
          id: turn.turn_id,
          role: turn.role,
          mode: turn.mode,
          text: turn.text,
          createdAt: turn.created_at,
          usedTools: turn.used_tools_json
            ? (JSON.parse(turn.used_tools_json) as StrategyToolName[])
            : undefined,
          warnings: turn.warnings_json ? (JSON.parse(turn.warnings_json) as string[]) : undefined
        }))
    };
  }

  getSession(sessionId: string, ownerAddress: string) {
    const session = this.readSession(sessionId);
    if (!session) return null;
    if (session.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
      throw new Error("Session owner mismatch.");
    }
    return this.snapshot(session);
  }

  listSessions(input: { ownerAddress: string; marketId?: string; limit?: number }): AgentSessionListItem[] {
    this.prune();

    const rows = (
      input.marketId
        ? this.db
            .prepare(
              `
                SELECT session_id
                FROM agent_sessions
                WHERE owner_address = ? AND market_id = ?
                ORDER BY updated_at DESC
                LIMIT ?
              `
            )
            .all(input.ownerAddress, input.marketId, input.limit ?? 20)
        : this.db
            .prepare(
              `
                SELECT session_id
                FROM agent_sessions
                WHERE owner_address = ?
                ORDER BY updated_at DESC
                LIMIT ?
              `
            )
            .all(input.ownerAddress, input.limit ?? 20)
    ) as Array<{ session_id: string }>;

    return rows.flatMap((row) => {
      const session = this.readSession(row.session_id);
      if (!session) return [];
      const snapshot = this.snapshot(session);
      const lastUserMessage = this.readLastTurnMessage(session.sessionId, "user");
      const lastAssistantMessage = this.readLastTurnMessage(session.sessionId, "assistant");

      return [
        {
          ...snapshot,
          lastUserMessage,
          lastAssistantMessage
        }
      ];
    });
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        owner_address TEXT NOT NULL,
        market_id TEXT,
        strategy_id TEXT,
        strategy_name TEXT,
        strategy_status TEXT,
        strategy_timeframe TEXT,
        strategy_updated_at TEXT,
        run_id TEXT,
        summary_json TEXT,
        validation_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner_updated
      ON agent_sessions(owner_address, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_session_turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        mode TEXT NOT NULL,
        text TEXT NOT NULL,
        used_tools_json TEXT,
        warnings_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_agent_session_turns_session_created
      ON agent_session_turns(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS agent_session_tool_trace (
        trace_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        tool TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_agent_session_tool_trace_session_created
      ON agent_session_tool_trace(session_id, created_at DESC);
    `);

    this.ensureColumn("agent_sessions", "strategy_name", "TEXT");
    this.ensureColumn("agent_sessions", "strategy_status", "TEXT");
    this.ensureColumn("agent_sessions", "strategy_timeframe", "TEXT");
    this.ensureColumn("agent_sessions", "strategy_updated_at", "TEXT");
  }

  private readSession(sessionId: string) {
    const row = this.db
      .prepare(
        `
          SELECT
            session_id,
            owner_address,
            market_id,
            strategy_id,
            strategy_name,
            strategy_status,
            strategy_timeframe,
            strategy_updated_at,
            run_id,
            summary_json,
            validation_json,
            created_at,
            updated_at
          FROM agent_sessions
          WHERE session_id = ?
        `
      )
      .get(sessionId) as
      | {
          session_id: string;
          owner_address: string;
          market_id: string | null;
          strategy_id: string | null;
          strategy_name: string | null;
          strategy_status: string | null;
          strategy_timeframe: string | null;
          strategy_updated_at: string | null;
          run_id: string | null;
          summary_json: string | null;
          validation_json: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      sessionId: row.session_id,
      ownerAddress: row.owner_address,
      marketId: row.market_id ?? undefined,
      strategyId: row.strategy_id ?? undefined,
      strategy:
        row.strategy_id
          ? {
              id: row.strategy_id,
              name: row.strategy_name ?? undefined,
              marketId: row.market_id ?? undefined,
              status: row.strategy_status as AgentStrategySummary["status"],
              timeframe: row.strategy_timeframe as AgentStrategySummary["timeframe"],
              updatedAt: row.strategy_updated_at ?? undefined
            }
          : undefined,
      runId: row.run_id ?? undefined,
      summary: parseOptionalJson(row.summary_json),
      validation: parseOptionalJson(row.validation_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    } satisfies StrategyAgentSession;
  }

  private writeSession(session: StrategyAgentSession) {
    this.db
      .prepare(
        `
          INSERT INTO agent_sessions (
            session_id,
            owner_address,
            market_id,
            strategy_id,
            strategy_name,
            strategy_status,
            strategy_timeframe,
            strategy_updated_at,
            run_id,
            summary_json,
            validation_json,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            owner_address = excluded.owner_address,
            market_id = excluded.market_id,
            strategy_id = excluded.strategy_id,
            strategy_name = excluded.strategy_name,
            strategy_status = excluded.strategy_status,
            strategy_timeframe = excluded.strategy_timeframe,
            strategy_updated_at = excluded.strategy_updated_at,
            run_id = excluded.run_id,
            summary_json = excluded.summary_json,
            validation_json = excluded.validation_json,
            updated_at = excluded.updated_at
        `
      )
      .run(
        session.sessionId,
        session.ownerAddress,
        session.marketId ?? null,
        session.strategyId ?? null,
        session.strategy?.name ?? null,
        session.strategy?.status ?? null,
        session.strategy?.timeframe ?? null,
        session.strategy?.updatedAt ?? null,
        session.runId ?? null,
        session.summary ? JSON.stringify(session.summary) : null,
        session.validation ? JSON.stringify(session.validation) : null,
        session.createdAt,
        session.updatedAt
      );
  }

  private touchSession(session: StrategyAgentSession) {
    this.db
      .prepare(
        `
          UPDATE agent_sessions
          SET
            market_id = ?,
            strategy_id = ?,
            strategy_name = ?,
            strategy_status = ?,
            strategy_timeframe = ?,
            strategy_updated_at = ?,
            run_id = ?,
            updated_at = ?
          WHERE session_id = ?
        `
      )
      .run(
        session.marketId ?? null,
        session.strategyId ?? null,
        session.strategy?.name ?? null,
        session.strategy?.status ?? null,
        session.strategy?.timeframe ?? null,
        session.strategy?.updatedAt ?? null,
        session.runId ?? null,
        session.updatedAt,
        session.sessionId
      );
  }

  private readLastTurnMessage(sessionId: string, role: "user" | "assistant") {
    const row = this.db
      .prepare(
        `
          SELECT text
          FROM agent_session_turns
          WHERE session_id = ? AND role = ?
          ORDER BY created_at DESC
          LIMIT 1
        `
      )
      .get(sessionId, role) as { text: string } | undefined;

    return row?.text;
  }

  private ensureColumn(tableName: string, columnName: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  private prune() {
    const expiresBefore = new Date(Date.now() - SESSION_TTL_MS).toISOString();
    this.db.prepare("DELETE FROM agent_sessions WHERE updated_at < ?").run(expiresBefore);

    const countRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM agent_sessions")
      .get() as { count: number };

    if (countRow.count <= MAX_SESSIONS) {
      return;
    }

    const overflow = countRow.count - MAX_SESSIONS;
    const staleRows = this.db
      .prepare(
        `
          SELECT session_id
          FROM agent_sessions
          ORDER BY updated_at ASC
          LIMIT ?
        `
      )
      .all(overflow) as Array<{ session_id: string }>;

    const remove = this.db.prepare("DELETE FROM agent_sessions WHERE session_id = ?");
    for (const row of staleRows) {
      remove.run(row.session_id);
    }
  }
}
