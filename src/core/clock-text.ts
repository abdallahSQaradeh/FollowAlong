/** Time as the learner reads it in the status bar and the Lesson tree. */
const secondsPerMinute = 60;

/** `mm:ss`, with minutes past 59 kept as minutes (`65:30`). */
export function formatClock(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / secondsPerMinute);
  const rest = whole % secondsPerMinute;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
