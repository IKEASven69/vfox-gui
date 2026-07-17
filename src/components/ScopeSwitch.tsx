import type { VersionScope } from "../constants";

/** Segmented control for global vs project version scope.
 *  Clicking "项目" when already selected re-opens the directory picker. */
export default function ScopeSwitch({
  value,
  onChange,
  projectPath,
  onPickProject,
}: {
  value: VersionScope;
  onChange: (s: VersionScope) => void;
  projectPath: string | null;
  onPickProject: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div
        className="flex rounded-[6px] p-0.5 text-[11px] font-medium"
        style={{ background: "var(--card)", boxShadow: "var(--shadow-sm)" }}
      >
        {(["global", "project"] as VersionScope[]).map((scope) => {
          const active = value === scope;
          return (
            <button
              key={scope}
              onClick={() => {
                if (scope === "project" && value === "project" && projectPath) {
                  onPickProject();
                } else if (scope !== value) {
                  onChange(scope);
                }
              }}
              className="px-2.5 py-0.5 rounded-[4px] transition-colors"
              style={{
                background: active ? "var(--accent-soft)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-tertiary)",
              }}
            >
              {scope === "global" ? "全局" : "项目"}
            </button>
          );
        })}
      </div>
      {value === "project" && projectPath && (
        <span
          className="text-[10px] truncate max-w-[140px]"
          style={{ color: "var(--text-tertiary)" }}
          title={projectPath}
        >
          {projectPath.split(/[/\\]/).slice(-2).join("/")}
        </span>
      )}
    </div>
  );
}
