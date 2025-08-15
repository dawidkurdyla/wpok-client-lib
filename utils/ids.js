'use strict';

const crypto = require('node:crypto');

function generateWorkId(provided) {
    if (provided && typeof provided === 'string') return provided;
    const ts = Date.now();
    const rnd = crypto.randomBytes(3).toString('hex');
    return `batch-${ts}-${rnd}`;
}

function generateTaskId(workId) {
    const ts = Date.now();
    const rnd = crypto.randomBytes(4).toString('hex');
    return `work:${workId}:task:${ts}-${rnd}`;
}

module.exports = { generateWorkId, generateTaskId };
