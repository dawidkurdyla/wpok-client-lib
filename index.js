'use strict';

/**
 * Public facade for the WPOK client library.
 * - Minimal TaskClient that exposes Redis + AMQP connectors.
 * - High-level batch API: createSingle/createBatch/planBatch.
 * - S3 helpers re-export (parseS3Url).
 *
 * Implementation details (S3 listing, batching, building task messages)
 * lives in modules: storage/*, batching/*, submit/*, utils/*.
 */

const redis = require('redis');
const EventEmitter = require('events');

const AmqpConnector = require('./amqpConnector');

// High-level batch API
const { createSingle, createBatch } = require('./submit/submit');
const { planBatch } = require('./batching/expand');

// S3 helpers
const { parseS3Url } = require('./storage/s3');

// Public ID helpers
const { generateWorkId, generateTaskId } = require('./utils/ids');

/**
 * TaskClient
 *  - holds connections to Redis and AMQP
 *  - exposes them to high-level functions
 */
class TaskClient extends EventEmitter {
    /**
     * @param {string} workId     Logical batch/group identifier
     * @param {string} redisURL   e.g. redis://127.0.0.1:6379
     * @param {string} rabbitURL  e.g. amqp://user:pass@127.0.0.1:5672
     */
    constructor(workId, redisURL = 'redis://127.0.0.1:6379', rabbitURL = 'amqp://user:pass@127.0.0.1:5672') {
        super();

        if (!workId || typeof workId !== 'string') {
            throw new Error('TaskClient requires a non-empty workId (string).');
        }

        this.workId = workId;

        this.rcl = redis.createClient({ url: redisURL });
        this.rcl.on('error', (err) => console.error('[redis] client error:', err));
        this.amqp = new AmqpConnector(rabbitURL);

        (async () => {
            try {
                await this.rcl.connect();
            } catch (err) {
                console.error('[redis] connect failed:', err);
            }
        })();

    }

    /**
     * Gracefully close resources.
     * Safe to call multiple times.
     */
    async close() {
        try { if (this.amqp && typeof this.amqp.close === 'function') await this.amqp.close(); } catch (_) {}
        try { if (this.rcl  && typeof this.rcl.quit === 'function')  await this.rcl.quit(); }  catch (_) {}
    }
}

// ===== Public API (CJS exports) =====
module.exports = {
    TaskClient,

    // High-level batch API
    createSingle,
    createBatch,
    planBatch,

    // S3 helper (parsing canonical s3:// URL)
    parseS3Url,

    // ID helpers (useful when integrating programmatically)
    generateWorkId,
    generateTaskId
};
