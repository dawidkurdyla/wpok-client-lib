'use strict';

/**
 * Replace {in}/{in0..} placeholders in the args array with base names of input files.
 * - {in} works ONLY when there is exactly one input (otherwise it remains unchanged).
 * - {in0}, {in1}, ... are substituted according to the index if it exists.
 */
function expandInputPlaceholders(args, basenames) {
    if (!Array.isArray(args)) return args;
    const one = basenames && basenames.length === 1 ? basenames[0] : null;

    return args.map(a => {
        if (typeof a !== 'string') return a;

        if (a === '{in}') {
            return one !== null ? one : a;
        }

        const m = a.match(/^\{in(\d+)\}$/);
        if (m) {
            const idx = Number(m[1]);
            if (Number.isFinite(idx) && basenames && idx < basenames.length) {
                return basenames[idx];
            }
            return a;
        }

        return a;
    });
}

module.exports = { expandInputPlaceholders };
