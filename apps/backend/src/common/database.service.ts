import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private db: Database;
  private dbPath: string;
  private saveTimeout: NodeJS.Timeout | null = null;

  async onModuleInit() {
    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.dbPath = process.env.DATABASE_FILE
      ? path.resolve(process.cwd(), process.env.DATABASE_FILE)
      : path.join(dataDir, 'mcq_assistant.db');

    const SQL: SqlJsStatic = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
      this.logger.log(`Loaded existing SQLite database from ${this.dbPath}`);
    } else {
      this.db = new SQL.Database();
      this.logger.log(`Created new SQLite database at ${this.dbPath}`);
      this.persist();
    }

    this.initSchema();
  }

  onModuleDestroy() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.persistSync();
    if (this.db) {
      this.db.close();
      this.db = null as any;
    }
  }

  private initSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS configs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        tab_id INTEGER,
        page_url TEXT NOT NULL,
        page_title TEXT,
        status TEXT NOT NULL,
        total_detected INTEGER DEFAULT 0,
        processed_count INTEGER DEFAULT 0,
        needs_review_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        current_question_index INTEGER DEFAULT 0,
        current_question_fingerprint TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        question_number INTEGER,
        question_text TEXT NOT NULL,
        options_json TEXT NOT NULL,
        extraction_strategy TEXT,
        extraction_confidence REAL,
        status TEXT NOT NULL,
        ai_answer_json TEXT,
        user_confirmed_selection TEXT,
        element_selector TEXT,
        detected_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS cache (
        fingerprint TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS topic_knowledge (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        question_fingerprint TEXT,
        question_text TEXT NOT NULL,
        correct_option_id TEXT,
        correct_option_text TEXT NOT NULL,
        was_incorrect_first BOOLEAN DEFAULT 0,
        wrong_option_text TEXT,
        explanation TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS custom_knowledge (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        content TEXT NOT NULL,
        is_active BOOLEAN DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id);
      CREATE INDEX IF NOT EXISTS idx_questions_fingerprint ON questions(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_topic_knowledge_topic ON topic_knowledge(topic);
      CREATE INDEX IF NOT EXISTS idx_custom_knowledge_topic ON custom_knowledge(topic);
    `);
    this.persist();
  }

  public persist() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.persistSync();
    }, 100);
  }

  public persistSync() {
    try {
      if (!this.db) return;
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (err: any) {
      if (err && (err.message?.includes('Database closed') || !this.db)) {
        return;
      }
      this.logger.error('Failed to persist SQLite database', err);
    }
  }

  public run(sql: string, params: any[] = []): void {
    this.db.run(sql, params);
    this.persist();
  }

  public query<T = any>(sql: string, params: any[] = []): T[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as T);
    }
    stmt.free();
    return results;
  }

  public queryOne<T = any>(sql: string, params: any[] = []): T | null {
    const results = this.query<T>(sql, params);
    return results.length > 0 ? results[0] : null;
  }
}
