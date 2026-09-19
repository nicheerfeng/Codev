export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "externalSandbox"; networkAccess: "enabled" | "restricted" }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export const SANDBOX_LABELS: Record<SandboxMode, string> = {
  "read-only": "只读",
  "workspace-write": "工作区写入",
  "danger-full-access": "完全访问",
};

/** 将原生策略映射到用户可选择的三个沙箱等级。 */
export function sandboxMode(policy: SandboxPolicy | null): SandboxMode | null {
  if (policy?.type === "readOnly") return "read-only";
  if (policy?.type === "workspaceWrite") return "workspace-write";
  if (policy?.type === "dangerFullAccess") return "danger-full-access";
  return null;
}

/** 生成 turn/start 原生策略，同级别保留服务端确认的网络和可写目录设置。 */
export function sandboxPolicy(
  mode: SandboxMode,
  cwd: string,
  effective: SandboxPolicy | null,
): SandboxPolicy {
  if (sandboxMode(effective) === mode && effective) return effective;
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
