import type { StepDef } from "./types";

// Return true if the dependsOn graph has a cycle (mirror of engine.has_cycle).
export function hasCycle(steps: Pick<StepDef, "stepKey" | "dependsOn">[]): boolean {
  const graph = new Map<string, string[]>();
  for (const s of steps) graph.set(s.stepKey, s.dependsOn ?? []);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const k of graph.keys()) color.set(k, WHITE);

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    for (const dep of graph.get(node) ?? []) {
      if (!color.has(dep)) continue;
      if (color.get(dep) === GRAY) return true;
      if (color.get(dep) === WHITE && dfs(dep)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  for (const n of graph.keys()) {
    if (color.get(n) === WHITE && dfs(n)) return true;
  }
  return false;
}
