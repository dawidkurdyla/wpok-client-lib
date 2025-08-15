// amqpConnector.js
// -----------------------------------------------------------------------------
// Lightweight AMQP helper that keeps **one connection** per process and **one channel per queue**.
//

'use strict';

const amqplib = require('amqplib');
const { once } = require('node:events');

class AmqpConnector {
    /**
     * @param {string} url   AMQP URI, e.g. amqp://user:pass@host:5672
     * @param {object} [opts] amqplib connect options (e.g., { heartbeat: 60 })
     */
    constructor(url, opts = {}) {
        this.url = url;
        this.opts = {
            heartbeat: 60,
            clientProperties: { connection_name: 'wpok-client' },
            ...opts
        };

        this.conn = null;
        this.connPromise = null;

        /** @type {Map<string, import('amqplib').Channel>} */
        this.channels = new Map();
        /** @type {Map<string, Promise<void>>} */
        this.channelPromises = new Map();
    }

    /* --------------------------------------------------------------------- */
    /* Internal helpers                                                      */
    /* --------------------------------------------------------------------- */

    /** Lazily establish exactly ONE connection. */
    async _getConnection() {
        if (this.conn) return this.conn;

        if (!this.connPromise) {
            console.log('[AMQP] Opening connection…');
            console.log(this.url);

            this.connPromise = (async () => {
                const conn = await amqplib.connect(this.url, this.opts);
                console.log('[AMQP] Connection established');

                // Keep caches consistent upon connection issues.
                const onConnError = (err) => {
                    console.error('[AMQP] Connection error:', err?.message || err);
                    this._teardownConnection();
                };
                const onConnClose = () => {
                    console.warn('[AMQP] Connection closed');
                    this._teardownConnection();
                };
                const onBlocked = (reason) => {
                    console.warn('[AMQP] Connection blocked:', reason);
                };
                const onUnblocked = () => {
                    console.log('[AMQP] Connection unblocked');
                };

                conn.on('error', onConnError);
                conn.on('close', onConnClose);
                conn.on('blocked', onBlocked);
                conn.on('unblocked', onUnblocked);

                this.conn = conn;
                return conn;
            })();
        }

        return this.connPromise;
    }

    /**
     * Cleanup local references when connection dies.
     * Channels will be closed by the broker; we just clear caches.
     */
    _teardownConnection() {
        this.conn = null;
        this.connPromise = null;

        for (const [q, ch] of this.channels.entries()) {
            try { ch.removeAllListeners(); } catch {}
        }
        this.channels.clear();
        this.channelPromises.clear();
    }

    /**
     * Ensure a channel exists for a given queue.
     * Does **not** declare the queue.
     */
    async _initialize(queueName) {
        if (this.channels.has(queueName)) return;

        if (!this.channelPromises.has(queueName)) {
            const promise = (async () => {
                const conn = await this._getConnection();
                const ch = await conn.createChannel();

                // Report and cleanup on channel lifecycle events
                const cleanup = () => {
                    try { ch.removeAllListeners(); } catch {}
                    this.channels.delete(queueName);
                    this.channelPromises.delete(queueName);
                    console.warn(`[AMQP] Channel closed for '${queueName}'`);
                };
                ch.on('error', (err) => {
                    console.error(`[AMQP] Channel error for '${queueName}':`, err?.message || err);
                    cleanup();
                });
                ch.on('close', cleanup);

                this.channels.set(queueName, ch);
                console.log(`[AMQP] Channel ready for '${queueName}'`);
            })();

            this.channelPromises.set(queueName, promise);
        }

        await this.channelPromises.get(queueName);
    }

    /* --------------------------------------------------------------------- */
    /* Public API                                                             */
    /* --------------------------------------------------------------------- */

    /**
     * Passive queue check (does not declare).
     * @param   {string} queueName
     * @returns {Promise<boolean>} true = exists, false = missing
     */
    async checkQueue(queueName) {
        await this._initialize(queueName);
        const ch = this.channels.get(queueName);

        try {
            await ch.checkQueue(queueName);
            console.log(`[AMQP] checkQueue OK for '${queueName}'`);
            return true;
        } catch (err) {
            if (err && (err.code === 404 || err.replyCode === 404)) {
                console.error(`[AMQP] Queue '${queueName}' does not exist (404)`);
                return false;
            }
            console.error(`[AMQP] checkQueue error for '${queueName}':`, err?.message || err);
            throw err;
        }
    }

    /**
     * Same as `checkQueue`, but throws ENOQUEUE if queue is missing.
     * @param {string} queueName
     */
    async checkQueueOrThrow(queueName) {
        const ok = await this.checkQueue(queueName);
        if (!ok) {
            throw new Error(`ENOQUEUE:${queueName}`);
        }
    }

    /**
     * Publish a payload to the given queue (fire-and-forget).
     * Does NOT wait for backpressure; for mass publish use publishBurst().
     *
     * @param {string|Buffer} payload
     * @param {string} queueName
     * @param {object} [options] amqplib sendToQueue options (e.g., { persistent: true })
     */
    async publish(payload, queueName, options = undefined) {
        await this._initialize(queueName);
        const ch = this.channels.get(queueName);

        const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
        ch.sendToQueue(queueName, buf, options);
        console.log(`[AMQP] Sent '${String(payload)}' → ${queueName}`);
    }

    /**
     * Publish respecting channel backpressure (burst-friendly).
     * If sendToQueue returns false, waits for 'drain' before continuing.
     *
     * @param {string} queueName
     * @param {string|Buffer} payload
     * @param {object} [options] amqplib sendToQueue options (e.g., { persistent: true })
     */
    async publishBurst(queueName, payload, options = undefined) {
        await this._initialize(queueName);
        const ch = this.channels.get(queueName);

        const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
        const ok = ch.sendToQueue(queueName, buf, options);

        if (!ok) {
            console.warn(`[AMQP] Write buffer full for '${queueName}', waiting for 'drain'…`);
            await once(ch, 'drain');
            console.log(`[AMQP] 'drain' received for '${queueName}', resuming publish`);
        } else {
            console.log(`[AMQP] Sent '${String(payload)}' → ${queueName} (burst)`);
        }
    }

    /**
     * Close all AMQP resources held by this connector.
     * Safe to call multiple times; subsequent publishes will reconnect lazily.
     */
    async close() {
        // Close channels first
        for (const [q, ch] of this.channels.entries()) {
            try {
                await ch.close();
                console.log(`[AMQP] Channel closed for '${q}'`);
            } catch (e) {
                console.warn(`[AMQP] Channel close error for '${q}':`, e?.message || e);
            }
        }
        this.channels.clear();
        this.channelPromises.clear();

        // Then close the connection
        if (this.conn) {
            try {
                await this.conn.close();
                console.log('[AMQP] Connection closed');
            } catch (e) {
                console.warn('[AMQP] Connection close error:', e?.message || e);
            }
            try { this.conn.connection?.stream?.destroy(); } catch {}
            this.conn = null;
            this.connPromise = null;
        }
    }
}

module.exports = AmqpConnector;
