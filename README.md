# WPOK Client Library (Node.js)

A minimal client library for a **serverless scientific‑computing** platform built on **Kubernetes worker pools**.
It lets you **submit single or batch tasks**, **wait/watch for completion**, and (optionally) plan batches against **S3/MinIO** sources. Under the hood the platform uses **Redis** for task metadata and **RabbitMQ (AMQP)** for dispatching task IDs to worker pools (KEDA handles autoscaling).

> The library is intentionally small and opinionated: the **client** only pushes task messages to Redis and publishes task IDs to AMQP; **workers** do the actual compute and S3 I/O.

---

## Key features

* **Task submission**

  * `createSingle()` — submit one task from a manifest
  * `createBatch()` — submit many tasks (auto‑planned from S3, if configured)
  * Adds each `taskId` into `work:<workId>:tasks` for later monitoring
* **Batch planning for S3/MinIO**

  * `planBatch()` expands `spec.io.inputs` (prefix + include/exclude) into concrete plan items
  * Supports grouping by **object** (1 task per object, optionally packed by `maxPerTask`) or by **prefix** (1 task per subfolder at a given depth)
* **Waiting & watching**

  * `waitForTask()`, `waitForMany()` — poll‑driven completion helpers
  * `watchWork()` — observe a whole work until done / timeout / idle
* **Minimal surface area**

  * One **TaskClient** per “work” (logical batch), holding Redis and AMQP connections
  * Clear separation of concerns: planning, submission, watching, S3 helpers

---

## Requirements

* **Node.js 18+**
* **Redis** (network‑reachable by the client)
* **RabbitMQ** (the target AMQP queue must already exist — queues are declared by the Operator)
* **S3/MinIO** (only if you plan/submit using `spec.io` against object storage)

> For development you can port‑forward Redis/RabbitMQ/MinIO from a local Minikube cluster.

---

## Install

This package is not published to npm yet. Use a git dependency or a local folder:

```jsonc
// package.json
"dependencies": {
  "@wpok/client-lib": "github:dawidkurdyla/wpok-client-lib#main"
}
```

…or from a local path while iterating:

```bash
npm i ../wpok-client-lib
```

---

## Quick start

**CommonJS (CJS)**

```js
const {
  TaskClient, createSingle, createBatch, planBatch,
  waitForTask, waitForMany, watchWork,
  validateManifest, assertValidManifest
} = require('@wpok/client-lib');

const client = new TaskClient(
  'demo-work-001',
  'redis://127.0.0.1:6379',
  'amqp://user:pass@127.0.0.1:5672'
);
```

**ESM**

```js
import {
  TaskClient, createSingle, createBatch, planBatch,
  waitForTask, waitForMany, watchWork,
  validateManifest, assertValidManifest
} from '@wpok/client-lib';

const client = new TaskClient(
  'demo-work-001',
  'redis://127.0.0.1:6379',
  'amqp://user:pass@127.0.0.1:5672'
);
```

**Single‑task manifest (YAML → JSON)** — workers do S3 I/O:

```js
const manifest = {
  apiVersion: 'v1',
  kind: 'Task',
  metadata: { name: 'img-proc-batch' },
  spec: {
    taskType: 'test.imgproc.s',        // AMQP queue
    name: 'python-image-op',
    executable: 'python3',
    args: [
      '/usr/local/bin/dumb_compute.py',
      '--in_dir', '__INPUT_DIR__',
      '--out_dir', '__OUTPUT_DIR__',
      '--op', 'grayscale', '--size', '512'
    ],
    work_dir: '/work_dir',
    input_dir: '/work_dir',
    output_dir: '/work_dir',
    io: {
      inputs: [
        { type: 's3', url: 's3://datasets/demo/', recursive: true,
          include: ['**/*.jpg','**/*.png'] }
      ],
      output: { type: 's3', url: 's3://results/demo/', overwrite: false,
        layout: '{stem}.jpg' }
    }
  }
};

// (optional) validate early
assertValidManifest(manifest);

// 1) Submit one task
const taskId = await createSingle(client, manifest);

// (optional) wait for the result
const r1 = await waitForTask(client, taskId, { timeoutSec: 600 });
console.log(r1);

// 2) Batch: auto‑plan from S3 and submit many
const { workId, tasks } = await createBatch(client, manifest, { ratePerSec: 0 });
console.log(workId, tasks.length);

// 3) Watch a whole work
const summary = await watchWork(client, 'demo-work-001', { timeoutSec: 1800 });
console.log(summary);

// 4) Clean up so the process can exit
await client.close();
```

> The worker image (installed alongside your compute program) reads task messages from Redis, pulls inputs from S3 into `__INPUT_DIR__`, runs your program, and uploads outputs from `__OUTPUT_DIR__` to the configured S3 prefix.

---

## Environment variables

Needed only if you **plan batches or list S3** from the client. Workers use the same vars during I/O.

| Variable                          | Purpose                                     | Example                 |
| --------------------------------- | ------------------------------------------- | ----------------------- |
| `AWS_ACCESS_KEY_ID`               | S3/MinIO access key                         | `admin`                 |
| `AWS_SECRET_ACCESS_KEY`           | S3/MinIO secret                             | `admin123456`           |
| `AWS_DEFAULT_REGION`/`AWS_REGION` | Region for AWS SDK                          | `us-east-1`             |
| `WPOK_S3_ENDPOINT`                | Custom S3 endpoint (MinIO, etc.)            | `http://127.0.0.1:9000` |
| `WPOK_S3_FORCE_PATH_STYLE`        | Force path‑style URLs (MinIO compatibility) | `1`                     |

> If `WPOK_S3_ENDPOINT` is **unset**, the AWS SDK will try real AWS S3. With MinIO you **must** set both `WPOK_S3_ENDPOINT` and `WPOK_S3_FORCE_PATH_STYLE=1`.

---

## Manifests & schema

Manifests are validated against the JSON Schema in `schema/taskManifest.schema.json`. Minimal shape:

```yaml
apiVersion: v1
kind: Task
metadata:
  name: my-task
  workId: demo-work-001
spec:
  taskType: test.imgproc.s        # AMQP queue name
  executable: python3
  args: ["/usr/local/bin/dumb_compute.py", "--in_dir", "__INPUT_DIR__", "--out_dir", "__OUTPUT_DIR__"]
  work_dir: /work_dir
  input_dir: /work_dir
  output_dir: /work_dir

  # Optional, recommended for S3 workflows
  io:
    inputs:
      - type: s3
        url: s3://datasets/demo/     # prefix (ends with '/') or an exact key without trailing '/'
        recursive: true
        include: ["**/*.jpg","**/*.png"]
    output:
      type: s3
      url: s3://results/demo/        # prefix (should end with '/')
      overwrite: false
      layout: "{stem}.jpg"

    # Optional batch settings (see below)
    batch:
      enabled: false                 # single task by default
      grouping: object               # or: prefix
      prefixDepth: 1                 # used only when grouping=prefix
      maxPerTask: 1                  # pack N objects per task when grouping=object
```

### Placeholders & args

* `__INPUT_DIR__`, `__OUTPUT_DIR__` — expanded by the **executor** to container paths
* `{stem}` in `layout` — base name of the single input object without extension (used by the uploader)
* `{in}` / `{in0}`, `{in1}`, … — in `spec.args` you can reference **input basenames** produced by the planner

---

## Batch planning from S3 — three common patterns

> Planning happens on the **client** (`planBatch`) but submission in `createBatch` auto‑plans for you. Use `planBatch` yourself only if you want to **inspect** what would be submitted.

### 1) **One task per object (file)** *(default)*

Enable batching and keep `grouping: object`. Each matching S3 object becomes a separate plan item → one task.

```yaml
spec:
  io:
    inputs:
      - type: s3
        url: s3://datasets/demo/
        recursive: true
        include: ["**/*.jpg"]
    batch:
      enabled: true
      grouping: object
      maxPerTask: 1
```

### 2) **Pack N objects per task**

Same as above, but increase `maxPerTask`.

```yaml
spec:
  io:
    inputs:
      - type: s3
        url: s3://datasets/demo/
        recursive: true
        include: ["**/*.jpg"]
    batch:
      enabled: true
      grouping: object
      maxPerTask: 8   # e.g., 8 images processed together
```

> When packing, the planner exposes input basenames to your program via `{in}` / `{in0}`, … placeholders in `spec.args`.

### 3) **One task per folder (prefix)**

Group by sub‑prefixes at a given depth and run one task per “folder”.

```yaml
spec:
  io:
    inputs:
      - type: s3
        url: s3://datasets/demo/   # base prefix
        recursive: false            # listing is non‑recursive when grouping by prefix
        include: ["**/*.jpg"]
    batch:
      enabled: true
      grouping: prefix
      prefixDepth: 1   # 1 = direct child folders of the base prefix
```

### 4) **Single task** (no client‑side planning)

Disable `io.batch.enabled`. The worker will handle pulling inputs into `__INPUT_DIR__` and produce outputs to `__OUTPUT_DIR__` in a single run.

```yaml
spec:
  io:
    inputs:
      - type: s3
        url: s3://datasets/demo/
    batch:
      enabled: false
```

---

## API reference (TL;DR)

```ts
new TaskClient(workId?: string, redisURL: string, rabbitURL: string);
await client.close(); // always close so Node can exit
```

**Submission & batching**

```ts
createSingle(client, manifest): Promise<string>;      // → taskId

createBatch(client, manifest, {
  ratePerSec?: number,   // optional QPS limiter (soft)
  stopOnError?: boolean  // throw on first AMQP publish error
}): Promise<{ workId: string, tasks: string[] }>;

planBatch(spec): AsyncIterable<PlanItem>;             // yields items; use for inspection/debug
```

**Waiting**

```ts
waitForTask(client, taskId, { timeoutSec? }):
  Promise<{ state: 'DONE'|'TIMEOUT', taskId: string, code?: number }>;

waitForMany(client, taskIds, { timeoutSec?, failFast? }):
  Promise<{ state: 'DONE'|'TIMEOUT'|'FAILED', done: Array<{taskId, code?}>, pending: string[] }>;

watchWork(client, workId, { timeoutSec?, idleSec?, pollMs?, expected?, onEvent? }):
  Promise<{ state: 'DONE'|'TIMEOUT'|'IDLE', total: number, results: Array<{taskId, code?}> }>;
```

**Utilities**

```ts
parseS3Url("s3://bucket/prefix/or/key"):
  { bucket: string, key: string, prefix: string };

generateWorkId(provided?: string): string;  // if provided, returns it unchanged
generateTaskId(workId: string): string;     // wf:<workId>:task:<ts>-<rnd>
extractWorkId(taskId: string): string | null;

validateManifest(manifest): { valid: boolean, errors: AjvError[]|null };
assertValidManifest(manifest): void; // throws Error with details on failure
```

---

## Design notes

* **AMQP queue existence**: the client expects the target queue to exist (declared by the Operator). It passively checks with `checkQueueOrThrow(queue)` before publishing.
* **Redis keys (convention)**:

  * Each task message is pushed to a list: `<taskId>_msg`.
  * All task IDs for a work are collected in a set: `work:<workId>:tasks`.
  * Workers report completion by writing exit code into a set named **`<taskId>`** and enqueueing the task ID into `wf:<workId>:tasksPendingCompletionHandling` (the client’s connector consumes from there).
* **Back‑pressure**: use `ratePerSec` in `createBatch(...)` for simple throttling when submitting very large plans. For pure fire‑and‑forget, leave it unset.

---

## Roadmap

* Additional storage adapters (GCS/Azure)
* Richer output layouts and pre‑flight collision checks

---

## License

See `package.json`.
