'use strict';

const Ajv = require('ajv');

let _validator;

/**
 * Build (once) and return AJV instance with our schema compiled.
 * - useDefaults: apply schema defaults directly to the input object
 * - coerceTypes: coerce ints/bools when it’s safe
 * - allErrors: collect all errors for better messages
 */
function getValidator() {
    if (_validator) return _validator;

    const ajv = new Ajv({
        allErrors: true,
        useDefaults: true,
        coerceTypes: true,
        strict: false
    });

    const schema = require('./taskManifest.schema.json');
    const validate = ajv.compile(schema);

    _validator = validate;
    return _validator;
}

/**
 * Validate a manifest. Mutates the object to apply defaults (AJV behavior).
 * @returns {{ valid: boolean, errors: null | Array }}
 */
function validateManifest(manifest) {
    const validate = getValidator();
    const ok = validate(manifest);
    return { valid: !!ok, errors: ok ? null : validate.errors || [] };
}

/**
 * Throws an Error with a readable message if manifest is invalid.
 */
function assertValidManifest(manifest) {
    const { valid, errors } = validateManifest(manifest);
    if (valid) return;

    const msg = (errors || [])
        .map(e => `• ${e.instancePath || '(root)'} ${e.message}`)
        .join('\n');

    const err = new Error(`Manifest validation failed:\n${msg}`);
    err.details = errors;
    throw err;
}

module.exports = {
    validateManifest,
    assertValidManifest
};
