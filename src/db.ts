import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { RULES_VERSION } from "./atmosphere";

export interface QueryRecord {
  id: number;
  requestHash: string;
  type: string;
  inputJson: string;
  unit: string;
  rulesVersion: string;
  ok: number;
  resultJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  report: string;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  private static readonly SELECT =
    `SELECT id, request_hash AS requestHash, type, input_json AS inputJson, unit,
       rules_version AS rulesVersion, ok, result_json AS resultJson,
       error_code AS errorCode, error_message AS errorMessage, report,
       created_at AS createdAt FROM queries`;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "atmosphere.sqlite"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_hash TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        input_json TEXT NOT NULL,
        unit TEXT NOT NULL,
        rules_version TEXT NOT NULL,
        ok INTEGER NOT NULL,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        report TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  static hash(type: string, input: unknown): string {
    return createHash("sha256")
      .update(`${RULES_VERSION}|${type}|${JSON.stringify(input)}`)
      .digest("hex");
  }

  /** 幂等记录：同一请求重复提交返回已有记录。 */
  record(
    type: string,
    input: unknown,
    unit: string,
    outcome:
      | { ok: true; result: unknown; report: string }
      | { ok: false; code: string; message: string; report: string },
  ): { record: QueryRecord; deduplicated: boolean } {
    const hash = Store.hash(type, input);
    const existing = this.db
      .prepare(`${Store.SELECT} WHERE request_hash = ?`)
      .get(hash) as unknown as QueryRecord | undefined;
    if (existing) return { record: existing, deduplicated: true };
    this.db
      .prepare(
        `INSERT INTO queries (request_hash, type, input_json, unit, rules_version, ok,
           result_json, error_code, error_message, report, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hash,
        type,
        JSON.stringify(input),
        unit,
        RULES_VERSION,
        outcome.ok ? 1 : 0,
        outcome.ok ? JSON.stringify(outcome.result) : null,
        outcome.ok ? null : outcome.code,
        outcome.ok ? null : outcome.message,
        outcome.report,
        new Date().toISOString(),
      );
    const record = this.db
      .prepare(`${Store.SELECT} WHERE request_hash = ?`)
      .get(hash) as unknown as QueryRecord;
    return { record, deduplicated: false };
  }

  list(limit = 100): QueryRecord[] {
    return this.db
      .prepare(`${Store.SELECT} ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as QueryRecord[];
  }

  get(id: number): QueryRecord | undefined {
    return this.db.prepare(`${Store.SELECT} WHERE id = ?`).get(id) as
      | unknown
      | QueryRecord
      | undefined as QueryRecord | undefined;
  }

  close(): void {
    this.db.close();
  }
}

export function defaultDataDir(): string {
  return process.env.ATM_DATA_DIR ?? path.join(process.cwd(), "data");
}
