export interface SportDefinition {
  name: string;
  icon: string;
}

export const SPORTS: Record<string, SportDefinition> = {
  cycling: { name: 'Cycling', icon: 'directions_bike' },
  skiing: { name: 'Skiing', icon: 'downhill_skiing' },
  running: { name: 'Running', icon: 'directions_run' },
  swimming: { name: 'Swimming', icon: 'pool' },
};

export function getSportIcon(sport: string | null | undefined): string {
  if (!sport) return 'question_mark';
  const key = sport.toLowerCase();
  return SPORTS[key]?.icon || 'exercise';
}
