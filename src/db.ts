// SQLite 持久化（Node 内置 node:sqlite，无原生依赖）。
// 保存查询原值、单位、规则版本、未舍入结果与报告；重复请求幂等。
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface StoredQuery {
  id: number;
  requestHash: string;
  kind: string;
  input: string;
  unit: string;
  rulesVersion: string;
  result: string;
  report: string;
  createdAt: string;
}

export class AtmoDb {
  private db: DatabaseSync;
  readonly filePath: string;

  constructor(dataDir?: string) {
    const dir = dataDir ?? path.join(process.cwd(), "data");
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, "atmosphere.db");
    this.db = new DatabaseSync(this.filePath);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS queries (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "request_hash TEXT NOT NULL UNIQUE, " +
        "kind TEXT NOT NULL, " +
        "input TEXT NOT NULL, " +
        "unit TEXT NOT NULL, " +
        "rules_version TEXT NOT NULL, " +
        "result TEXT NOT NULL, " +
        "report TEXT NOT NULL, " +
        "created_at TEXT NOT NULL" +
        ")",
    );
  }

  static hashRequest(kind: string, input: unknown): string {
    const canonical = JSON.stringify({ kind, input });
    return createHash("sha256").update(canonical).digest("hex");
  }

  record(
    kind: string,
    input: unknown,
    unit: string,
    rulesVersion: string,
    result: unknown,
    report: unknown,
  ): StoredQuery {
    const hash = AtmoDb.hashRequest(kind, input);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO queries " +
          "(request_hash, kind, input, unit, rules_version, result, report, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        hash,
        kind,
        JSON.stringify(input),
        unit,
        rulesVersion,
        JSON.stringify(result),
        JSON.stringify(report),
        new Date().toISOString(),
      );
    const row = this.db
      .prepare("SELECT * FROM queries WHERE request_hash = ?")
      .get(hash) as Record<string, unknown>;
    return {
      id: row.id as number,
      requestHash: row.request_hash as string,
      kind: row.kind as string,
      input: row.input as string,
      unit: row.unit as string,
      rulesVersion: row.rules_version as string,
      result: row.result as string,
      report: row.report as string,
      createdAt: row.created_at as string,
    };
  }

  history(limit = 50): StoredQuery[] {
    const rows = this.db
      .prepare("SELECT * FROM queries ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as number,
      requestHash: row.request_hash as string,
      kind: row.kind as string,
      input: row.input as string,
      unit: row.unit as string,
      rulesVersion: row.rules_version as string,
      result: row.result as string,
      report: row.report as string,
      createdAt: row.created_at as string,
    }));
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM queries").get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
