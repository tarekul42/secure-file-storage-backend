export type CheckStatus = "ok" | "error";

export interface HealthCheckResult {
  database: CheckStatus;
  storage: CheckStatus;
}

export interface ReadinessResult {
  status: "ok" | "degraded";
  checks: HealthCheckResult;
}
