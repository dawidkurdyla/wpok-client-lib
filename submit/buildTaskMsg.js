'use strict';

function buildTaskMsgFromPlan(spec, plan, taskId) {
    const msg = {
        executable: spec.executable || spec.cmd,
        name:       spec.name,
        args:       Array.isArray(plan.args) ? plan.args : (spec.args || []),
        work_dir:   spec.work_dir,
        input_dir:  spec.input_dir,
        output_dir: spec.output_dir,
        inputs:     Array.isArray(plan.localInputs) ? plan.localInputs : [],
        outputs:    Array.isArray(spec.outputs) ? spec.outputs : [],
        taskId,
        taskType:   spec.taskType,
        io: {
            inputs: plan.inputs || [],
            output: spec.io?.output || undefined,
            batch:  spec.io?.batch || undefined
        }
    };
    return msg;
}

module.exports = { buildTaskMsgFromPlan };
