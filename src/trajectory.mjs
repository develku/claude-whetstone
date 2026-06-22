export function formatTrajectory({ history, status }) {
  if (!history.length) return 'no passes yet';
  const scores = history.map(e => (typeof e === 'object' && e !== null ? e.score : e));
  const passes = scores.map((s, i) => `#${i}=${s}`).join(' ');
  const bestScore = Math.max(...scores);
  const bestIdx = scores.indexOf(bestScore);
  return `${passes} | best ${bestScore}@${bestIdx} | ${status}`;
}
