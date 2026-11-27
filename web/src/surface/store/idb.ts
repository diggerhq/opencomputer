import type { Files, Principal, Storage } from '@opencomputer/sdk/computer'

// The client's storage over IndexedDB: one object store of JSON values, in a
// database named by principal (spec 26.3). Reopens once when Safari drops the
// connection.

export function idbStorage(p: Principal): Storage & { drop(): Promise<void> } {
  const name = `oc-surface:${p.org}:${p.subject}`
  let db: Promise<IDBDatabase> | null = null
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onsuccess = () => {
        req.result.onclose = () => (db = null)
        resolve(req.result)
      }
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    }))
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> => {
    const attempt = async () => {
      const tx = (await open()).transaction('kv', mode)
      return new Promise<T>((resolve, reject) => {
        const req = fn(tx.objectStore('kv'))
        tx.oncomplete = () => resolve((req ? req.result : undefined) as T)
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
      })
    }
    try {
      return await attempt()
    } catch {
      db = null
      return attempt()
    }
  }
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    put: (key, value) => run('readwrite', (s) => void s.put(value, key)),
    delete: (key) => run('readwrite', (s) => void s.delete(key)),
    async list(prefix) {
      const range = IDBKeyRange.bound(prefix, prefix + '￿')
      const tx = (await open()).transaction('kv', 'readonly')
      const s = tx.objectStore('kv')
      const [keys, values] = await Promise.all([
        new Promise<IDBValidKey[]>((res, rej) => {
          const r = s.getAllKeys(range)
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(r.error ?? new Error('IndexedDB read failed'))
        }),
        new Promise<unknown[]>((res, rej) => {
          const r = s.getAll(range)
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(r.error ?? new Error('IndexedDB read failed'))
        }),
      ])
      // Every key is a string: put() is only ever given one.
      return keys.map((k, i) => [k as string, values[i]] as [string, unknown])
    },
    batch: (ops) =>
      run('readwrite', (s) => {
        for (const op of ops) {
          if ('put' in op) s.put(op.value, op.put)
          else s.delete(op.delete)
        }
      }),
    async drop() {
      ;(await open()).close()
      db = null
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name)
        req.onsuccess = req.onerror = req.onblocked = () => resolve()
      })
    },
  }
}

// Pending attachments' bytes (work 126), beside the JSON store: Blobs in
// their own database, so the kv store's schema is untouched and a Safari that
// cannot keep a Blob (K2) fails here alone; the client then holds the Blob in
// memory for the page's life.
export function idbFiles(p: Principal): Files & { drop(): Promise<void> } {
  const name = `oc-surface-files:${p.org}:${p.subject}`
  let db: Promise<IDBDatabase> | null = null
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('files')
      req.onsuccess = () => {
        req.result.onclose = () => (db = null)
        resolve(req.result)
      }
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    }))
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> => {
    const tx = (await open()).transaction('files', mode)
    return new Promise<T>((resolve, reject) => {
      const req = fn(tx.objectStore('files'))
      tx.oncomplete = () => resolve((req ? req.result : undefined) as T)
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    })
  }
  return {
    get: (id) => run<Blob | undefined>('readonly', (s) => s.get(id) as IDBRequest<Blob | undefined>),
    put: (id, blob) => run('readwrite', (s) => void s.put(blob, id)),
    delete: (id) => run('readwrite', (s) => void s.delete(id)),
    async drop() {
      ;(await open()).close()
      db = null
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name)
        req.onsuccess = req.onerror = req.onblocked = () => resolve()
      })
    },
  }
}
