export function formatTrajectory({ history, status }) {
  if (!history.length) return 'no passes yet';
  const scores = history.map(e => (typeof e === 'object' && e !== null ? e.score : e));
  const passes = scores.map((s, i) => `#${i}=${s}`).join(' ');
  // Guard the all-invalid case (e.g. a baseline-error run with score null): Math.max(...[null])
  // is 0 and indexOf(0) is -1, which would render a nonsensical 'best 0@-1'.
  const valid = scores.filter((s) => typeof s === 'number' && Number.isFinite(s));
  if (!valid.length) return `${passes} | best — | ${status}`;
  const bestScore = Math.max(...valid);
  const bestIdx = scores.indexOf(bestScore);
  return `${passes} | best ${bestScore}@${bestIdx} | ${status}`;
}
