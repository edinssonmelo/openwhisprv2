export function formatDurationMins(totalSeconds: number) {
  const m = Math.max(1, Math.round(totalSeconds / 60));
  return `${m} mins`;
}

export function formatSessionDateShort(value: number) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}
