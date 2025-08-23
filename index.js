'use strict';

/**
 * Public facade for the WPOK client library.
 * - Minimal TaskClient that exposes Redis + AMQP connectors + RedisConnector (lazy-run).
 * - High-level submit API: createSingle/createBatch/planBatch.
 * - Watch API: waitForTask, waitForMany, watchWork.
 * - S3 helpers re-export (parseS3Url).
 */

const redis = require('redis');
const EventEmitter = require('events');

const AmqpConnector = require('./connectors/amqpConnector');
const RedisConnector = require('./connectors/redisConnector');

const { createSingle, createBatch } = require('./submit/submit');
const { planBatch } = require('./batching/expand');
const { waitForTask, waitForMany, watchWork } = require('./watch/wait');
const { parseS3Url } = require('./storage/s3');
const { generateWorkId, generateTaskId, extractWorkId } = require('./utils/ids');
const { validateManifest, assertValidManifest } = require('./schema/validate');

class TaskClient extends EventEmitter {
    /**
     * @param {string} workId
     * @param {string} redisURL
     * @param {string} rabbitURL
     */
    constructor(workId = null, redisURL = 'redis://127.0.0.1:6379', rabbitURL = 'amqp://user:pass@127.0.0.1:5672') {
        super();

        this.workId = workId || generateWorkId();

        this.rcl = redis.createClient({ url: redisURL });
        this.rcl.on('error', (err) => console.error('[redis] client error:', err));

        this._ready = (async () => {
            try {
                await this.rcl.connect();
            } catch (err) {
                console.error('[redis] connect failed:', err);
            }
        })();

        this.amqp = new AmqpConnector(rabbitURL);
        this.redisConnector = new RedisConnector(this.rcl, this.workId, 1000);
        this._connectorRunning = false;
    }

    async ready() {
        await this._ready;
    }

    _ensureConnector() {
        if (!this._connectorRunning) {
            void this.redisConnector.run();
            this._connectorRunning = true;
        }
    }

    /**
     * Gracefully close resources.
     */
    async close() {
        await this.redisConnector.stop();
        await this.amqp.close();
        await this.rcl.quit();
    }
}

// ===== Public API (CJS exports) =====
module.exports = {
    TaskClient,

    // Submit / batching
    createSingle,
    createBatch,
    planBatch,

    // Watch
    waitForTask,
    waitForMany,
    watchWork,

    parseS3Url,
    generateWorkId,
    generateTaskId,
    extractWorkId,

    validateManifest,
    assertValidManifest
};
