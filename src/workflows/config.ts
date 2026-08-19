/**
 * Task-type configuration (SPEC 10.3).
 *
 * Escalation thresholds and method sequences are externalised as data in D1,
 * not hardcoded per task, so they are tunable without touching Workflow
 * structure and without a redeploy. This is spec'd as externalised from the
 * outset even though there is a small number of task types at launch.
 */

export type TaskMethod = "api" | "browser" | "voice" | "email";

export type TaskTypeConfig = {
  taskType: string;
  /** Ordered cheapest/fastest to most expensive/slowest (SPEC 10.1 item 1). */
  methods: TaskMethod[];
  maxAttempts: number;
  attemptTimeout: number;
  notifyOnSwitch: boolean;
};

const FALLBACK: TaskTypeConfig = {
  taskType: "generic",
  methods: ["api", "browser"],
  maxAttempts: 2,
  attemptTimeout: 90,
  notifyOnSwitch: true,
};

export async function getTaskTypeConfig(
  env: Env,
  taskType: string
): Promise<TaskTypeConfig> {
  const row = await env.DB.prepare(
    `SELECT task_type, methods, max_attempts, attempt_timeout, notify_on_switch
       FROM task_type_config WHERE task_type = ?`
  )
    .bind(taskType)
    .first<{
      task_type: string;
      methods: string;
      max_attempts: number;
      attempt_timeout: number;
      notify_on_switch: number;
    }>();

  if (!row) return { ...FALLBACK, taskType };

  let methods: TaskMethod[];
  try {
    const parsed = JSON.parse(row.methods) as unknown;
    methods = Array.isArray(parsed) && parsed.length ? (parsed as TaskMethod[]) : FALLBACK.methods;
  } catch {
    console.warn(`task_type_config.methods for "${taskType}" is not valid JSON, using fallback`);
    methods = FALLBACK.methods;
  }

  return {
    taskType: row.task_type,
    methods,
    maxAttempts: row.max_attempts,
    attemptTimeout: row.attempt_timeout,
    notifyOnSwitch: row.notify_on_switch === 1,
  };
}

/** How a method is described to the user when we switch to it. */
export const METHOD_DESCRIPTIONS: Record<TaskMethod, string> = {
  api: "a direct lookup",
  browser: "opening it in a browser and doing it by hand",
  voice: "calling them",
  email: "emailing them",
};
