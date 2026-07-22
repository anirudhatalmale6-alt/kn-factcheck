'use strict';
// Consistent online backup of the SQLite database (safe while the app is running).
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const OUT = process.env.KN_BACKUP_DIR || '/var/backups/kn';
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const src = path.join(__dirname, 'data', 'kn.db');
const dest = path.join(OUT, `kn-${stamp}.db`);

const db = new Database(src, { readonly: true });
db.backup(dest)
  .then(() => {
    db.close();
    // prune backups older than 14 days
    const cutoff = Date.now() - 14 * 86400000;
    for (const f of fs.readdirSync(OUT)) {
      if (/^kn-.*\.db$/.test(f)) {
        const p = path.join(OUT, f);
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      }
    }
    console.log(new Date().toISOString(), 'db backup ->', dest);
  })
  .catch((e) => { console.error('backup failed:', e.message); process.exit(1); });
