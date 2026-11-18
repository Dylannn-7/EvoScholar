import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
// node:sqlite ships with Node >= 22.13; no native addon to compile.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
export type Db = import('node:sqlite').DatabaseSync

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     category TEXT NOT NULL,
     kind TEXT NOT NULL,           -- model | search | fetch | ocr
     provider TEXT NOT NULL,
     model TEXT,
     session_id TEXT,
     genome_id TEXT,
     input_tokens INTEGER DEFAULT 0,
     cache_read_tokens INTEGER DEFAULT 0,
     output_tokens INTEGER DEFAULT 0,
     units INTEGER DEFAULT 0,
     peak INTEGER DEFAULT 0,
     cost_usd REAL NOT NULL,
     cost_cny REAL NOT NULL
   );
   CREATE INDEX IF NOT EXISTS ledger_ts ON ledger(ts);
   CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     genome_id TEXT NOT NULL,
     title TEXT,
     stage TEXT,
     category TEXT NOT NULL DEFAULT 'usage'
   );
   CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     ts TEXT NOT NULL,
     genome_id TEXT NOT NULL,
     run_id TEXT,
     type TEXT NOT NULL,
     payload TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS events_session ON events(session_id);
   CREATE TABLE IF NOT EXISTS turns (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     genome_id TEXT NOT NULL,
     ts_start TEXT NOT NULL,
     ts_end TEXT,
     outcome TEXT,
     steps INTEGER DEFAULT 0,
     tool_calls INTEGER DEFAULT 0,
     tool_errors INTEGER DEFAULT 0,
     input_tokens INTEGER DEFAULT 0,
     output_tokens INTEGER DEFAULT 0,
     cost_cny REAL DEFAULT 0,
     prompt TEXT,
     answer TEXT
   );
   CREATE TABLE IF NOT EXISTS feedback (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     turn_id INTEGER,
     ts TEXT NOT NULL,
     kind TEXT NOT NULL,           -- thumb | rating | comment | accept | rerun | edit | verifier
     value REAL,
     note TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS evolution_runs (
     id TEXT PRIMARY KEY,
     ts_start TEXT NOT NULL,
     ts_end TEXT,
     base_genome TEXT NOT NULL,
     status TEXT NOT NULL,          -- running | done | failed | budget
     cost_cny REAL DEFAULT 0,
     note TEXT,
     report_path TEXT
   );
   CREATE TABLE IF NOT EXISTS eval_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     evolution_run TEXT,
     genome_id TEXT NOT NULL,
     genome_hash TEXT NOT NULL,
     case_id TEXT NOT NULL,
     split TEXT NOT NULL,
     pass INTEGER NOT NULL,
     failures TEXT NOT NULL,
     manual_review TEXT,
     steps INTEGER DEFAULT 0,
     tool_calls INTEGER DEFAULT 0,
     tool_errors INTEGER DEFAULT 0,
     cost_cny REAL DEFAULT 0,
     duration_ms INTEGER DEFAULT 0,
     session_id TEXT,
     run_dir TEXT,
     error TEXT,
     ts TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS eval_runs_key ON eval_runs(genome_hash, case_id);
   CREATE TABLE IF NOT EXISTS candidates (
     genome_id TEXT PRIMARY KEY,
     evolution_run TEXT NOT NULL,
     parent TEXT NOT NULL,
     target TEXT NOT NULL,
     diagnosis TEXT,
     change TEXT,
     dev_pass INTEGER, dev_total INTEGER, base_dev_pass INTEGER,
     acc_pass INTEGER, acc_total INTEGER, base_acc_pass INTEGER,
     cost_cny REAL DEFAULT 0,
     status TEXT NOT NULL,          -- evaluating | pending | approved | rejected | discarded
     reason TEXT,
     ts TEXT NOT NULL
   );`,
  `ALTER TABLE ledger ADD COLUMN round_id TEXT;
   ALTER TABLE ledger ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX ledger_round ON ledger(round_id);
   CREATE TABLE budget_reservations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     category TEXT NOT NULL,
     kind TEXT NOT NULL,
     round_id TEXT,
     cost_cny REAL NOT NULL
   );`,
  `ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE eval_runs ADD COLUMN task_hash TEXT;
   CREATE INDEX eval_runs_cache_key ON eval_runs(genome_hash, case_id, task_hash)
     WHERE error IS NULL AND task_hash IS NOT NULL;`,
  `ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`,
  // v2: projects (local folders), per-session model / effort / permission, library index.
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     path TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL,
     archived INTEGER NOT NULL DEFAULT 0
   );
   ALTER TABLE sessions ADD COLUMN project_id TEXT;
   ALTER TABLE sessions ADD COLUMN cwd TEXT;
   ALTER TABLE sessions ADD COLUMN model TEXT;
   ALTER TABLE sessions ADD COLUMN effort TEXT;
   ALTER TABLE sessions ADD COLUMN permission TEXT;
   CREATE TABLE library (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id TEXT,
     session_id TEXT,
     root TEXT NOT NULL,            -- absolute folder the path is relative to (session cwd)
     path TEXT NOT NULL,
     kind TEXT NOT NULL,            -- output | upload
     size INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     deliverable INTEGER NOT NULL DEFAULT 0,
     UNIQUE(root, path)
   );
   CREATE INDEX library_session ON library(session_id);
   CREATE INDEX library_project ON library(project_id);
   CREATE INDEX ledger_session ON ledger(session_id);`,
  // v2 P3: in-loop evolution — memory (lessons / preferences), attribution, overlays, turn scores, log.
  `CREATE TABLE memory (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,            -- lesson | preference
     scope TEXT NOT NULL,           -- global | project | stage
     project_id TEXT,
     stage TEXT,
     trigger TEXT NOT NULL,
     content TEXT NOT NULL,
     source TEXT NOT NULL,          -- model | user | choice | edit | host
     evidence TEXT,                 -- session id(s)
     status TEXT NOT NULL,          -- trial | active | retired
     trust TEXT NOT NULL DEFAULT 'trusted', -- trusted | untrusted
     pinned INTEGER NOT NULL DEFAULT 0,
     uses INTEGER NOT NULL DEFAULT 0,
     wins REAL NOT NULL DEFAULT 0,
     losses REAL NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     last_used_at TEXT
   );
   CREATE TABLE memory_uses (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     memory_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     turn_id INTEGER,
     adopted INTEGER NOT NULL DEFAULT 0,
     score REAL,
     ts TEXT NOT NULL
   );
   CREATE INDEX memory_uses_turn ON memory_uses(session_id, turn_id);
   CREATE TABLE overlays (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     op TEXT NOT NULL,
     target TEXT,
     value TEXT NOT NULL,
     reason TEXT,
     status TEXT NOT NULL,          -- trial | kept | reverted | promoted
     turn_id INTEGER,
     before_score REAL,
     after_score REAL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE turn_scores (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     turn_id INTEGER,
     score REAL NOT NULL,
     confidence REAL NOT NULL,
     signals TEXT NOT NULL,
     ts TEXT NOT NULL
   );
   CREATE TABLE evolve_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT,
     project_id TEXT,
     turn_id INTEGER,
     kind TEXT NOT NULL,            -- recall | reflect | adjust | selfcheck | learned | preference | observe | credit | revert
     refs TEXT,
     text TEXT NOT NULL,
     data TEXT,
     ts TEXT NOT NULL
   );
   CREATE INDEX evolve_log_session ON evolve_log(session_id);`
]

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(join(dataDir, 'evoscholar.sqlite'))
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  // WAL needs shared memory; network/FUSE mounts reject it. TRUNCATE also avoids deleting files.
  try {
    db.exec('PRAGMA journal_mode = WAL')
  } catch {
    db.exec('PRAGMA journal_mode = TRUNCATE')
  }
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)')
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare('SELECT v FROM schema_version').get() as { v: number } | undefined
    let v = row?.v ?? 0
    if (!row) db.prepare('INSERT INTO schema_version (v) VALUES (0)').run()
    for (; v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v])
      db.prepare('UPDATE schema_version SET v = ?').run(v + 1)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    db.close()
    throw error
  }
  return db
}
