
/**
 * Class for exchanging task data and status between 
 * clients and remote executors using Redis.
 */
class RedisConnector {
    /**
     * Constructor.
     * @param {RedisClient} redisClient redis client
     * @param {string} workId work ID (work = all tasks to be computed)
     * @param {number} checkInterval loop interval in ms.
     */
    constructor(redisClient, workId, checkInterval = 3000) {
        this.taskPromiseResolves = {};
        this.rcl = redisClient;
        this.running = false;
        this.completedNotificationQueueKey = "wf:" + workId + ":tasksPendingCompletionHandling";
        this.checkInterval = checkInterval;
        this._sleepHandle = null;
    }

    _sleep(ms) {
        return new Promise((resolve) => {
            this._sleepHandle = setTimeout(resolve, ms);
            if (this._sleepHandle.unref) this._sleepHandle.unref(); 
        });
    }
    
    /**
     * Gives promise, that will be resolved on remote
     * task completion.
     * @param {*} taskId task ID
     */
    async waitForTask(taskId) {
        if (this.taskPromiseResolves[taskId] !== undefined) {
            console.error("[RedisConnector] Task", taskId, "is already observed");
            return;
        }
        console.log("[RedisConnector] Waiting for task", taskId);
        let promise = new Promise((resolve, reject) => {
            this.taskPromiseResolves[taskId] = resolve;
            console.log(this.taskPromiseResolves);
        });

        return promise;
    }

    /**
     * Notify about task completion.
     * @param {string} taskId task ID
     * @param {number} code exit code
     */
    async notifyTaskCompletion(taskId, code) {
        console.log("[RedisConnector] Adding result", code, "of task", taskId);
        try {
            await this.rcl.sAdd(taskId, code);
        } catch (error) {
            console.error(error);
            console.trace("Error trace");
        }
        console.log("[RedisConnector] Marking task", taskId, "as completed");
        return this.rcl.sAdd(this.completedNotificationQueueKey, taskId);
    }

    /**
     * Runs connector, that fetches notifications about task 
     * completions, then makes relevant waiting promises resolved.
     */
    async run() {
        this.running = true;
        while (this.running) {

            let taskId = null;
            try {
                taskId = await this.rcl.sRandMember(this.completedNotificationQueueKey);
            } catch (error) {
                console.error("[RedisConnector] Unable to fetch new completed tasks", error);
            }

            if (!this.running) break;
            
            if (taskId == null) {
                await this._sleep(this.checkInterval);
                continue;
            }

            console.log("[RedisConnector] Got completed task:", taskId);

            let taskResult = null;
            try {
                /* Wrap results into array to preserve compatibility with blpop format. */
                taskResult = [null, await this.rcl.sRandMember(taskId)];
            } catch (error) {
                console.error("[RedisConnector] Unable to get result of task", taskId);
                continue;
            }

            if (this.taskPromiseResolves[taskId] === undefined) {
                console.error("[RedisConnector] Observer for task", taskId, "not found");
                await this.rcl.sRem(this.completedNotificationQueueKey, taskId);
                continue;
            }
            let promiseResolve = this.taskPromiseResolves[taskId];
            console.log("Promises count:", Object.keys(this.taskPromiseResolves).length);
            delete this.taskPromiseResolves[taskId];

            try {
                await this.rcl.sRem(this.completedNotificationQueueKey, taskId);
            } catch (error) {
                console.error("[RedisConnector] Unable to delete task from completed queue", error);
            }

            console.log("[RedisConnector] Resolving promise for task", taskId, "| result =", taskResult);
            promiseResolve(taskResult);
        }

        return;
    }

    /**
     * Peek task exit code (non-consuming). Returns string or null.
     */
    async peekExitCode(taskId) {
        try {
            return await this.rcl.sRandMember(taskId);
        } catch (e) {
            console.error("[RedisConnector] peekExitCode error for", taskId, e);
            return null;
        }
    }

    /**
     * Cancel waiting for a given taskId (used on timeout to avoid leaking resolver).
     */
    cancelWait(taskId) {
        if (this.taskPromiseResolves[taskId] !== undefined) {
            delete this.taskPromiseResolves[taskId];
            return true;
        }
        return false;
    }

    /**
     * Stops connector.
     */
    async stop() {
        console.log("[RedisConnector] Requesting stop");
        this.running = false;
        if (this._sleepHandle) {
            clearTimeout(this._sleepHandle);
            this._sleepHandle = null;
        }
        return;
    }
}

module.exports = RedisConnector
