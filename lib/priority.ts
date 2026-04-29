export function computePriorityScore(project: {
  member_count: number;
  at_risk_file_count: number;
  last_file_activity: Date | null;
  max_members: number;
  max_at_risk: number;
}): number {
  const daysSinceActivity = project.last_file_activity
    ? (Date.now() - project.last_file_activity.getTime()) / 86400000
    : 999;

  const recencyWeight =
    daysSinceActivity < 14 ? 3
    : daysSinceActivity < 30 ? 2.5
    : daysSinceActivity < 90 ? 1.5
    : 1;

  const memberNorm = project.max_members > 0
    ? (project.member_count / project.max_members) * 3
    : 0;

  const fileNorm = project.max_at_risk > 0
    ? (project.at_risk_file_count / project.max_at_risk) * 3
    : 0;

  return Math.round(((recencyWeight * 3) + (memberNorm * 2) + (fileNorm * 1)) / 6 * 100);
}
