# WPOK Client Library (Node.js)

A minimal client library for a **serverless scientific computing** platform built on **Kubernetes worker-pools**.
It lets you **submit single or batch tasks**, **watch for completion**, and (optionally) plan batches against **S3/MinIO** sources. Under the hood the platform uses **Redis** for task metadata and **RabbitMQ (AMQP)** for dispatching task IDs to worker pools (scaled by KEDA).

> The library is intentionally small and opinionated: the **client** only pushes task messages to Redis and publishes task IDs to AMQP; **workers** do the actual compute and S3 I/O.

---

## Key features

- **Task submission**
  - `createSingle()` — submit one task from a manifest
  - `createBatch()` — submit many tasks (typically from an S3 listing plan)
  - Adds each `taskId` into `work:<workId>:tasks` for later monitoring
- **Batch planning for S3/MinIO**
  - `planBatch()` expands `spec.io.inputs` (prefix + include/exclude) into concrete items
- **Waiting & watching**
  - `waitForTask()`, `waitForMany()` — poll-driven completion helpers
  - `watchWork()` — observe a whole work until done/timeout/idle
- **Small surface area**
  - One **TaskClient** per “work” (logical batch), holding Redis and AMQP connections
  - Clear separation of responsibilities: batching, submission, watching, S3 helpers

---

## Requirements

- **Node.js 18+**
- **Redis** (network reachable by the client)
- **RabbitMQ** (the target AMQP queue must already exist — queues are declared by the Operator)
- **S3/MinIO** (only if you plan/submit using `spec.io` against object storage)

> For development you can port-forward Redis/RabbitMQ/MinIO from a local Minikube cluster.

---

## Install

This package is not published to npm yet. Use a git dependency or a local folder:

```bash
# Git dependency (package.json)
"dependencies": {
  "@wpok/client-lib": "github:dawidkurdyla/wpok-client-lib#main"
}

# …or from a local path while iterating
npm i ../wpok-client-lib
```

---

## Quick start

```js
const { TaskClient, createSingle, planBatch, createBatch, waitForTask, watchWork } = require('@wpok/client-lib');

// 1) Connect to Redis/AMQP for a logical work (batch) id:
const client = new TaskClient(
  'demo-work-001',
  'redis://127.0.0.1:6379',
  'amqp://user:pass@127.0.0.1:5672'
);

// 2) Single-task manifest (YAML → JSON) – workers do S3 I/O
const manifest = {
  apiVersion: 'v1',
  kind: 'Task',
  metadata: {
    name: 'img-proc-batch',
  }
  spec: {
    taskType: 'test.imgproc.s',
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
        { type: 's3', url: 's3://datasets/demo/', recursive: true, include: ['**/*.jpg','**/*.png'] }
      ],
      output: { type: 's3', url: 's3://results/demo/', overwrite: false, layout: '{stem}.jpg' }
    }
  }
};

// 3a) Submit just one task
const taskId = await createSingle(client, manifest);

// (optionally) wait for result
const res = await waitForTask(client, taskId, { timeoutSec: 600 });
console.log(res);

// 3b) Or create a batch for all matching S3 objects
const plan = await planBatch(manifest);                 // expands io.inputs → items (one per object)
const ids  = await createBatch(client, manifest, plan); // returns array of taskIds

// Optionally watch whole work
const summary = await watchWork(client, 'demo-work-001', { timeoutSec: 1800 });
console.log(summary);

// 4) Clean up (very important so your process can exit)
await client.close();
```

> The worker image (installed alongside actual compute program) reads task messages from Redis, pulls inputs from S3 into `__INPUT_DIR__`, runs your program, and uploads outputs from `__OUTPUT_DIR__` to the configured S3 prefix.

---

## Environment variables

These are only needed if you are **planning batches or listing S3** from the client. Workers use the same variables for I/O when they run the task.

| Variable                   | Purpose                                       | Example                 |
|----------------------------|-----------------------------------------------|-------------------------|
| `AWS_ACCESS_KEY_ID`        | S3/MinIO access key                           | `admin`                 |
| `AWS_SECRET_ACCESS_KEY`    | S3/MinIO secret                               | `admin123456`           |
| `AWS_DEFAULT_REGION`       | Region for AWS SDK                            | `us-east-1`             |
| `WPOK_S3_ENDPOINT`         | Custom S3 endpoint (MinIO, etc.)              | `http://127.0.0.1:9000` |
| `WPOK_S3_FORCE_PATH_STYLE` | Force path-style URLs (MinIO compatibility)   | `1`                     |
| `WPOK_S3_CONCURRENCY`      | Optional: max concurrent transfers             | `6`                     |
| `WPOK_S3_RETRIES`          | Optional: transfer retries                     | `3`                     |

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
        url: s3://datasets/demo/     # prefix (ends with '/'), or an exact key without trailing '/'
        recursive: true
        include: ["**/*.jpg","**/*.png"]
    output:
      type: s3
      url: s3://results/demo/        # prefix (should end with '/')
      overwrite: false
      layout: "{stem}.jpg"
```

### Placeholders & args
- `__INPUT_DIR__`, `__OUTPUT_DIR__` — expanded by the executor to container paths
- `{stem}` in `layout` — base name of the single input object without extension (used by uploader)

---

## API reference (TL;DR)

```ts
new TaskClient(workId: string, redisURL: string, rabbitURL: string);
await client.ready?();           // optional if provided by the client
await client.close();            // always close to let Node exit
```

**Submission & batching**
```ts
createSingle(client, manifest): Promise<string>;                 // → taskId
planBatch(manifest, overrides?): Promise<{ items: Array<...> }>; // expands S3 inputs
createBatch(client, manifest, planOrItems): Promise<string[]>;   // → taskIds[]
```

**Waiting**
```ts
waitForTask(client, taskId, { timeoutSec? }): Promise<{ state, taskId, code? }>;
waitForMany(client, taskIds, { timeoutSec?, failFast? }): Promise<{ state, done[], pending[] }>;
watchWork(client, workId, { timeoutSec?, idleSec?, onEvent? }): Promise<{ state, total, results[] }>;
```

**Utilities**
```ts
generateWorkId(): string;
generateTaskId(workId?: string): string;
parseS3Url("s3://bucket/prefix/or/key"): { bucket, key, prefix };
```

---


## Roadmap

- Additional storage adapters (GCS/Azure)
- Richer output layouts and pre-flight collision checks

---

## License

See `package.json`.

