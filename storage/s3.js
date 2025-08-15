'use strict';

const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const minimatch = require('minimatch');

function bool(value, def = false) {
    if (value === undefined || value === null) return def;
    if (typeof value === 'boolean') return value;
    const s = String(value).toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
}

function makeS3ClientFromEnv() {
    const endpoint = process.env.WPOK_S3_ENDPOINT || undefined;
    const forcePathStyle = bool(process.env.WPOK_S3_FORCE_PATH_STYLE, false);
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    return new S3Client({ region, endpoint, forcePathStyle });
}

function parseS3Url(url) {
    if (!url || typeof url !== 'string' || !url.startsWith('s3://')) {
        throw new Error(`Invalid S3 URL: ${url}`);
    }
    const without = url.slice('s3://'.length);
    const slash = without.indexOf('/');
    if (slash < 0) return { bucket: without, key: '', prefix: '' };
    const bucket = without.slice(0, slash);
    const rest = without.slice(slash + 1);
    const isPrefix = url.endsWith('/');
    return { bucket, key: isPrefix ? '' : rest, prefix: isPrefix ? rest : '' };
}

/**
 * Async generator that lists objects under a given prefix (with filters).
 */
async function* listObjects({ s3, bucket, prefix = '', recursive = true, include = [], exclude = [], maxFiles }) {
    s3 = s3 || makeS3ClientFromEnv();
    let ContinuationToken = undefined;
    let yielded = 0;

    do {
        const cmd = new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken,
            Delimiter: recursive ? undefined : '/'
        });
        const resp = await s3.send(cmd);

        for (const obj of (resp.Contents || [])) {
            const key = obj.Key;
            if (!key) continue;

            if (Array.isArray(include) && include.length > 0) {
                const ok = include.some(gl => minimatch(key, gl));
                if (!ok) continue;
            }
            if (Array.isArray(exclude) && exclude.length > 0) {
                const bad = exclude.some(gl => minimatch(key, gl));
                if (bad) continue;
            }

            yield { bucket, key, size: obj.Size ?? null, etag: obj.ETag ?? null };
            yielded += 1;
            if (maxFiles && yielded >= maxFiles) return;
        }

        // Return CommonPrefixes (for prefix grouping) only in non-recursive mode
        if (!recursive && Array.isArray(resp.CommonPrefixes)) {
            yield { commonPrefixes: resp.CommonPrefixes.map(p => p.Prefix).filter(Boolean) };
        }

        ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (ContinuationToken);
}

/**
 * Find prefixes at a given "depth" relative to the base prefix.
 * depth=1 => direct subfolders (uses ListObjectsV2 with Delimiter:'/').
 */
async function listPrefixesAtDepth({ s3, bucket, basePrefix = '', depth = 1 }) {
    s3 = s3 || makeS3ClientFromEnv();
    if (depth <= 0) return [basePrefix];

    let levelPrefixes = [basePrefix]; // start from the base prefix
    for (let d = 0; d < depth; d += 1) {
        const next = [];
        for (const pref of levelPrefixes) {
            // fetch CommonPrefixes at this level
            let ContinuationToken = undefined;
            do {
                const cmd = new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: pref,
                    Delimiter: '/'
                });
                const resp = await s3.send(cmd);
                const cps = (resp.CommonPrefixes || []).map(p => p.Prefix).filter(Boolean);
                if (cps.length > 0) next.push(...cps);
                ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
            } while (ContinuationToken);
        }
        levelPrefixes = next.length ? next : levelPrefixes; // if nothing deeper, keep the last known level
    }
    return levelPrefixes;
}

module.exports = {
    makeS3ClientFromEnv,
    parseS3Url,
    listObjects,
    listPrefixesAtDepth
};
