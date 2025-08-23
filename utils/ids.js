'use strict';

const crypto = require('node:crypto');

function generateWorkId(provided) {
    if (provided && typeof provided === 'string') return provided;
    const ts = Date.now();
    const rnd = crypto.randomBytes(3).toString('hex');
    return `${ts}-${rnd}`;
}

function generateTaskId(workId) {
    const ts = Date.now();
    const rnd = crypto.randomBytes(4).toString('hex');
    return `wf:${workId}:task:${ts}-${rnd}`;
}

function extractWorkId(taskId) {
    const m = /^wf:([^:]+):task:/.exec(taskId);
    return m ? m[1] : null
  }

module.exports = { generateWorkId, generateTaskId, extractWorkId };
