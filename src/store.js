const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { STORE_VERSION, sanitizeStore, applyCommand, dateInTimeZone } = require('./domain');

const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_RECORDS = 20_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createTodoStore(filePath, options = {}) {
  const now = options.now || (() => new Date());
  const timeZone = options.timeZone;
  const forceTimeZone = Boolean(options.forceTimeZone && timeZone);
  let writeQueue = Promise.resolve();
  let currentStore = null;

  function nowDate() {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  }

  async function readRaw(target) {
    const stats = await fs.stat(target);
    if (stats.size > MAX_STORE_BYTES) {
      const error = new Error(`Daymark data exceeds the ${MAX_STORE_BYTES} byte safety limit`);
      error.code = 'DAYMARK_STORE_TOO_LARGE';
      throw error;
    }
    const content = await fs.readFile(target, 'utf8');
    return JSON.parse(content);
  }

  function migrateTimeZone(raw) {
    // Every version from 2 up is event-sourced and can be re-attributed.
    const eventSourced = Number(raw?.version) >= 2;
    if (!forceTimeZone || !eventSourced || raw?.meta?.timeZone === timeZone) {
      return { value: raw, migrated: false };
    }
    const events = (Array.isArray(raw?.events) ? raw.events : []).map((event) => {
      const occurredAt = new Date(event?.occurredAt);
      if (Number.isNaN(occurredAt.getTime())) return event;
      return {
        ...event,
        reportingDate: dateInTimeZone(occurredAt, timeZone),
        timeZone,
      };
    });
    return {
      migrated: true,
      value: {
        ...raw,
        meta: { ...(raw?.meta || {}), timeZone },
        events,
        // Daily archives are derived from events. Rebuild them under the new
        // timezone so old local-day boundaries cannot leak into review data.
        dailyArchives: [],
      },
    };
  }

  function sanitize(raw) {
    const migrated = migrateTimeZone(raw).value;
    return sanitizeStore(migrated, { now: nowDate(), timeZone });
  }

  async function preserveVersion(raw, version) {
    if (Number(raw?.version ?? 1) !== version) return;
    const backupPath = `${filePath}.v${version}-backup.json`;
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(backupPath, `${JSON.stringify(raw, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  async function write(store) {
    const safe = sanitize(store);
    const serialized = `${JSON.stringify(safe, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
      throw new Error(`Daymark data exceeds the ${MAX_STORE_BYTES} byte safety limit`);
    }
    const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    const backup = `${filePath}.bak`;
    const directory = path.dirname(filePath);

    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    } finally {
      await handle?.close();
    }

    try {
      try {
        await fs.copyFile(filePath, backup);
        await fs.chmod(backup, 0o600);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      await fs.rename(temporary, filePath);
      await fs.chmod(filePath, 0o600);
      try {
        const directoryHandle = await fs.open(directory, 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch (error) {
        if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
      }
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    currentStore = safe;
    return clone(safe);
  }

  async function loadCandidate(target, { persistMigration = false } = {}) {
    const raw = await readRaw(target);
    const rawVersion = Number(raw?.version ?? 1);
    // Refusing a newer file is what stops an older Daymark from silently
    // rewriting data whose fields it does not know about.
    if (rawVersion > STORE_VERSION) throw new Error(`Unsupported store version: ${raw.version}`);
    if (persistMigration && rawVersion < STORE_VERSION) await preserveVersion(raw, rawVersion);
    const timeZoneMigration = migrateTimeZone(raw);
    const safe = sanitize(timeZoneMigration.value);
    if (persistMigration && (rawVersion < STORE_VERSION || timeZoneMigration.migrated)) return write(safe);
    currentStore = safe;
    return clone(safe);
  }

  async function load() {
    if (currentStore) return clone(currentStore);
    try {
      return await loadCandidate(filePath, { persistMigration: true });
    } catch (error) {
      if (String(error.message).includes('Unsupported store version')) throw error;
      if (error.code === 'DAYMARK_STORE_TOO_LARGE') throw error;
      if (error.code === 'ENOENT') {
        currentStore = sanitize({ version: 1, tasks: [] });
        return clone(currentStore);
      }

      const corruptPath = `${filePath}.corrupt-${nowDate().getTime()}.json`;
      try {
        await fs.rename(filePath, corruptPath);
      } catch (renameError) {
        if (renameError.code !== 'ENOENT') console.error('Unable to preserve corrupt Daymark data:', renameError);
      }

      try {
        const recovered = await loadCandidate(`${filePath}.bak`, { persistMigration: false });
        await write(recovered);
        return clone(currentStore);
      } catch (backupError) {
        if (String(backupError.message).includes('Unsupported store version')) throw backupError;
        if (backupError.code !== 'ENOENT') console.error('Unable to read Daymark backup:', backupError);
        currentStore = sanitize({ version: 1, tasks: [] });
        return clone(currentStore);
      }
    }
  }

  function enqueue(operation) {
    const result = writeQueue.catch(() => {}).then(operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function execute(command) {
    return enqueue(async () => {
      const store = await load();
      const next = applyCommand(store, command, { now: nowDate(), timeZone });
      if (JSON.stringify(next) === JSON.stringify(store)) return clone(store);
      return write(next);
    });
  }

  function persistArchives(dailyArchives) {
    return enqueue(async () => {
      const store = await load();
      if (!Array.isArray(dailyArchives)) throw new TypeError('dailyArchives must be an array');
      if (dailyArchives.length > MAX_ARCHIVE_RECORDS) throw new RangeError('Too many daily archive records');
      if (Buffer.byteLength(JSON.stringify(dailyArchives), 'utf8') > MAX_ARCHIVE_BYTES) {
        throw new RangeError('Daily archive data is too large');
      }
      const next = sanitize({ ...store, dailyArchives });
      return write(next);
    });
  }

  // Kept for internal migration tests and recovery tools. Renderer code never
  // receives this capability; normal product mutations must go through execute.
  function save(payload) {
    return enqueue(() => write(payload));
  }

  async function getSnapshot() {
    return load();
  }

  return { load, execute, persistArchives, save, getSnapshot, filePath };
}

module.exports = { createTodoStore };
