'use strict';

/**
 * Polling-based waiting helpers for tasks and works.
 */

function sleepUnref(ms) {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        if (typeof t.unref === 'function') t.unref();
    });
}

function ensureConnector(client) {
    client._ensureConnector();
}

async function peekExitCode(client, taskId) {
    const v = await client.redisConnector.peekExitCode(taskId);
    if (v == null) return null;
    const n = Number.parseInt(String(v), 10);
    return Number.isFinite(n) ? n : null;
}

/**
 * Wait for a single task completion.
 * Returns { state: 'DONE'|'TIMEOUT', taskId, code? }
 */
async function waitForTask(client, taskId, opts = {}) {
    await client.ready();

    const timeoutSec = Number.isFinite(opts.timeoutSec) ? opts.timeoutSec : 0;

    // Fast path: code already persisted in <taskId> set
    const fast = await peekExitCode(client, taskId);
    if (Number.isFinite(fast)) {
        return { state: 'DONE', taskId, code: fast };
    }

    ensureConnector(client);

    // Register waiter in the connector loop
    const p = client.redisConnector.waitForTask(taskId).then((tuple) => {
        const codeStr = Array.isArray(tuple) ? tuple[1] : tuple;
        const codeNum = codeStr == null ? null : Number.parseInt(String(codeStr), 10);
        return { state: 'DONE', taskId, code: codeNum };
    });

    if (!timeoutSec || timeoutSec <= 0) {
        return p;
    }

    // Race with timeout; cancel resolver on timeout
    const timeoutP = (async () => {
        await sleepUnref(timeoutSec * 1000);
        client.redisConnector.cancelWait(taskId);
        return { state: 'TIMEOUT', taskId };
    })();

    const res = await Promise.race([p, timeoutP]);

    // Last-chance peek to avoid false TIMEOUT
    if (res.state === 'TIMEOUT') {
        const late = await peekExitCode(client, taskId);
        if (Number.isFinite(late)) {
            return { state: 'DONE', taskId, code: late };
        }
    }

    return res;
}

/**
 * Wait for many taskIds; optional failFast (stop at first non-zero code).
 * Returns { state, done: [{taskId, code}], pending: string[] }
 */
async function waitForMany(client, taskIds, opts = {}) {
    await client.ready();

    const timeoutSec = Number.isFinite(opts.timeoutSec) ? opts.timeoutSec : 0;
    const failFast   = !!opts.failFast;

    const pending = new Set(taskIds);
    const done    = [];

    // Pipeline fast-peek for all pending
    if (pending.size > 0) {
        const multi = client.rcl.multi();
        for (const id of pending) multi.sRandMember(id);
        const replies = await multi.exec();

        let i = 0;
        for (const id of Array.from(pending)) {
            const v = replies?.[i++];
            if (v == null) continue;
            const code = Number.parseInt(String(v), 10);
            if (Number.isFinite(code)) {
                done.push({ taskId: id, code });
                pending.delete(id);
            }
        }
    }

    if (pending.size === 0) {
        return { state: 'DONE', done, pending: [] };
    }

    ensureConnector(client);

  return await new Promise((resolve) => {
    let timer = null;
    if (timeoutSec > 0) {
      timer = setTimeout(() => {
        resolve({ state: 'TIMEOUT', done, pending: [...pending] });
      }, timeoutSec * 1000);
    }

    if (pending.size === 0) {
      if (timer) clearTimeout(timer);
      return resolve({ state: 'DONE', done, pending: [] });
    }

    for (const id of pending) {
      waitForTask(client, id).then((r) => {
        if (!pending.has(id)) return;
        pending.delete(id);

        if (r.state === 'DONE') {
          done.push({ taskId: id, code: r.code });

          if (failFast && typeof r.code === 'number' && r.code !== 0) {

            for (const restId of pending) client.redisConnector.cancelWait(restId);
            if (timer) clearTimeout(timer);
            return resolve({ state: 'FAILED', done, pending: [...pending] });
          }
        }

        if (pending.size === 0) {
          if (timer) clearTimeout(timer);
          return resolve({ state: 'DONE', done, pending: [] });
        }
      });
    }
  });
}

/**
 * Watch a whole work by workId (snapshot of tasks present at call time).
 * Returns { state: 'DONE'|'TIMEOUT'|'IDLE', total, results }
 */
async function watchWork(client, workId, opts = {}) {
    await client.ready();

    const pollMs    = Number.isFinite(opts.pollMs) ? opts.pollMs : 1000;
    const timeoutMs = (Number.isFinite(opts.timeoutSec) ? opts.timeoutSec : 0) * 1000;
    const idleMs    = (Number.isFinite(opts.idleSec) ? opts.idleSec : 0) * 1000;
    const onEvent   = typeof opts.onEvent === 'function' ? opts.onEvent : null;

    const keySet   = `work:${workId}:tasks`;
    const expected = Number.isFinite(opts.expected) && opts.expected > 0
        ? opts.expected
        : await client.rcl.sCard(keySet);

    let taskIds = await client.rcl.sMembers(keySet);
    if (expected && taskIds.length > expected) {
        taskIds = taskIds.slice(0, expected);
    }

    // Fast-peek all tasks
    const multi = client.rcl.multi();
    for (const id of taskIds) multi.sRandMember(id);
    const replies = await multi.exec();

    const results = [];
    const waiting = [];
    for (let i = 0; i < taskIds.length; i++) {
        const id = taskIds[i];
        const v  = replies?.[i];
        if (v == null) { waiting.push(id); continue; }
        const code = Number.parseInt(String(v), 10);
        if (Number.isFinite(code)) {
            results.push({ taskId: id, code });
            if (onEvent) onEvent({ type: 'task:done', taskId: id, code });
        } else {
            waiting.push(id);
        }
    }
    if (onEvent) onEvent({ type: 'progress', done: results.length, total: expected });

    if (results.length >= expected) {
        return { state: 'DONE', total: expected, results };
    }

    ensureConnector(client);

    const start   = Date.now();
    let   lastNew = Date.now();

    const perTask = new Map();
    for (const id of waiting) {
        perTask.set(id, waitForTask(client, id));
    }

    while (results.length < expected) {
        if (timeoutMs > 0 && (Date.now() - start) >= timeoutMs) {
            return { state: 'TIMEOUT', total: expected, results };
        }

        for (const [id, p] of perTask) {
            if (!p) continue;
            const r = await Promise.race([p, sleepUnref(0)]);
            if (r && r.state === 'DONE') {
                results.push({ taskId: id, code: r.code });
                perTask.set(id, null);
                lastNew = Date.now();
                if (onEvent) onEvent({ type: 'task:done', taskId: id, code: r.code });
            }
        }

        if (onEvent) onEvent({ type: 'progress', done: results.length, total: expected });
        if (results.length >= expected) break;

        if (idleMs > 0 && (Date.now() - lastNew) >= idleMs) {
            return { state: 'IDLE', total: expected, results };
        }

        await sleepUnref(pollMs);
    }

    return { state: 'DONE', total: expected, results };
}

module.exports = {
    waitForTask,
    waitForMany,
    watchWork
};
