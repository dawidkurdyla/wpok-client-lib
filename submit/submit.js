'use strict';

const { generateWorkId, generateTaskId } = require('../utils/ids');
const { planBatch } = require('../batching/expand');
const { buildTaskMsgFromPlan } = require('./buildTaskMsg');

/**
 * Helper: publish with backpressure if available (publishBurst), otherwise regular publish.
 */
async function publishWithDrain(amqp, queueName, payload) {
    if (typeof amqp.publishBurst === 'function') {
        return amqp.publishBurst(queueName, payload);
    }
    // Fallback – your current publish method
    return amqp.publish(payload, queueName);
}

/**
 * Single: we don't list S3 on the client side — the executor will perform preRun based on spec.io.
 */
async function createSingle(client, manifest) {
    const spec = manifest.spec ?? manifest;
    const workId = manifest?.metadata?.workId || generateWorkId('solo');
    const queue = spec.taskType;
    const taskId = generateTaskId(workId);

    const planItem = {
        inputs: Array.isArray(spec.io?.inputs) ? spec.io.inputs : [],
        localInputs: [],
        args: spec.args || [],
        source: { single: true }
    };
    const msg = buildTaskMsgFromPlan(spec, planItem, taskId);

    await client.amqp.checkQueueOrThrow(queue);
    await client.rcl.lPush(`${taskId}_msg`, JSON.stringify(msg));
    await publishWithDrain(client.amqp, queue, taskId);

    return { taskId };
}

/**
 * Batch: grouping object/prefix + optional packing (maxPerTask).
 * Optional: ratePerSec (soft QPS limiter) — by default none, we go "burst + drain".
 */
async function createBatch(client, manifest, { ratePerSec, stopOnError = false } = {}) {
    const spec = manifest.spec ?? manifest;
    const queue = spec.taskType;
    const workId = manifest?.metadata?.workId || generateWorkId();

    await client.amqp.checkQueueOrThrow(queue);

    const results = [];
    let tokens = ratePerSec ? ratePerSec : null;
    let windowStart = Date.now();

    for await (const planItem of planBatch(spec)) {
        const taskId = generateTaskId(workId);
        const msg = buildTaskMsgFromPlan(spec, planItem, taskId);

        await client.rcl.lPush(`${taskId}_msg`, JSON.stringify(msg));

        // Optional simple QPS limiter
        if (ratePerSec) {
            const now = Date.now();
            if (now - windowStart >= 1000) {
                windowStart = now;
                tokens = ratePerSec;
            }
            if (tokens <= 0) {
                const sleep = 1000 - (now - windowStart);
                await new Promise(res => setTimeout(res, sleep));
                windowStart = Date.now();
                tokens = ratePerSec;
            }
            tokens -= 1;
        }

        try {
            await client.amqp.publishBurst(queue, taskId);
            results.push({ taskId, source: planItem.source });
        } catch (err) {
            // rollback Redis message so it doesn't remain "orphaned"
            try { await client.rcl.del(`${taskId}_msg`); } catch (_e) {}
            const rec = { taskId, source: planItem.source, error: err };
            results.push(rec);
            if (stopOnError) throw err;
        }
    }

    return { workId, tasks: results };
}

module.exports = { createSingle, createBatch };
