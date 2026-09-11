// A user's "level" is a simple, deterministic reputation tier computed
// from things they've actually done — successful deployments plus people
// they've referred — not anything random or client-side.

const LEVELS = [
  { name: 'Platinum', min: 50 },
  { name: 'Gold', min: 25 },
  { name: 'Silver', min: 10 },
  { name: 'Bronze', min: 3 },
  { name: 'Starter', min: 0 },
];

function getLevel({ activeDeployments = 0, referralCount = 0 } = {}) {
  const score = activeDeployments * 2 + referralCount;
  const level = LEVELS.find((l) => score >= l.min) || LEVELS[LEVELS.length - 1];
  const currentIndex = LEVELS.indexOf(level);
  const next = currentIndex > 0 ? LEVELS[currentIndex - 1] : null;
  return {
    name: level.name,
    score,
    next: next ? { name: next.name, pointsNeeded: Math.max(0, next.min - score) } : null,
  };
}

module.exports = { getLevel };
