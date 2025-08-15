'use strict';

const path = require('node:path');
const { makeS3ClientFromEnv, parseS3Url, listObjects, listPrefixesAtDepth } = require('../storage/s3');
const { expandInputPlaceholders } = require('../args/templating');

/**
 * AsyncGenerator of task plans based on spec.io.*
 * Supports:
 *  - batch.enabled=false  → single (leaves args unchanged, localInputs empty)
 *  - grouping: 'object'   → 1 task = 1 object (or packs up to maxPerTask)
 *  - grouping: 'prefix'   → 1 task = 1 subfolder at the given depth
 */
async function* planBatch(spec) {
    const io = spec.io || {};
    const inputs = Array.isArray(io.inputs) ? io.inputs : [];
    const batch = io.batch || { enabled: false };
    const grouping = batch.grouping || 'object';
    const prefixDepth = Number.isFinite(batch.prefixDepth) ? batch.prefixDepth : 1;
    const maxPerTask = Number.isFinite(batch.maxPerTask) && batch.maxPerTask > 0 ? batch.maxPerTask : 1;

    // SINGLE
    if (!batch.enabled) {
        // On the executor side: preRun will download by prefix/key; on the program side __INPUT_DIR__ will be used
        yield {
            inputs,
            localInputs: [],
            args: spec.args || [],
            source: { single: true }
        };
        return;
    }

    if (inputs.length === 0) {
        throw new Error(`spec.io.batch.enabled=true, ale spec.io.inputs jest puste`);
    }

    // Assume the first input as the base (MVP — we’ll extend later if needed).
    const base = inputs[0];
    const client = makeS3ClientFromEnv();

    // Normalize to { bucket, prefix } (prefix) or { bucket, key } (single object)
    const parsed = base.url ? parseS3Url(base.url) : { bucket: base.bucket, key: base.key || '', prefix: base.prefix || '' };

    if (grouping === 'prefix') {
        const prefixes = await listPrefixesAtDepth({
            s3: client,
            bucket: parsed.bucket,
            basePrefix: parsed.prefix || '',
            depth: prefixDepth
        });

        for (const p of prefixes) {
            yield {
                inputs: [{
                    bucket: parsed.bucket,
                    prefix: p,
                    recursive: true,
                    include: base.include || [],
                    exclude: base.exclude || []
                }],
                localInputs: [],
                args: spec.args || [],
                source: { prefix: p }
            };
        }
        return;
    }

    // grouping === 'object' (with batching)
    const gen = listObjects({
        s3: client,
        bucket: parsed.bucket,
        prefix: parsed.prefix || parsed.key || '',
        recursive: base.recursive !== false,
        include: base.include || [],
        exclude: base.exclude || [],
        maxFiles: base.maxFiles
    });

    let pack = [];
    for await (const item of gen) {
        if (item.commonPrefixes) {
            // ignore CommonPrefixes in object mode (they only appear when recursive=false)
            continue;
        }
        const bn = path.basename(item.key);
        pack.push({ remote: { bucket: item.bucket, key: item.key }, basename: bn });

        if (pack.length >= maxPerTask) {
            yield packToPlan(pack, spec, base);
            pack = [];
        }
    }
    if (pack.length > 0) {
        yield packToPlan(pack, spec, base);
    }
}

function packToPlan(pack, spec, base) {
    const localInputs = pack.map(p => ({ name: p.basename, workflow_input: true }));
    const basenames = pack.map(p => p.basename);
    const args = expandInputPlaceholders(spec.args || [], basenames);
    return {
        inputs: pack.map(p => ({ bucket: p.remote.bucket, key: p.remote.key })),
        localInputs,
        args,
        source: { keys: pack.map(p => p.remote.key) },
        include: base.include || [],
        exclude: base.exclude || []
    };
}

module.exports = { planBatch };
