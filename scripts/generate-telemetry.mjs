#!/usr/bin/env node
// Regenerates assets/telemetry.svg from live GitHub data.
// Runs in CI (see .github/workflows/telemetry.yml) with GH_TOKEN set.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOGIN = 'hilfing';
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('GH_TOKEN is required');
  process.exit(1);
}

const QUERY = `query {
  user(login: "${LOGIN}") {
    repositories(first: 100, ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false) {
      totalCount
      nodes {
        stargazerCount
        languages(first: 6, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name } }
        }
      }
    }
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

const res = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: {
    Authorization: `bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': `${LOGIN}-telemetry`,
  },
  body: JSON.stringify({ query: QUERY }),
});
const json = await res.json();
if (!json.data?.user) {
  console.error('GraphQL error:', JSON.stringify(json.errors ?? json).slice(0, 500));
  process.exit(1);
}

const user = json.data.user;
const calendar = user.contributionsCollection.contributionCalendar;
const days = calendar.weeks.flatMap((w) => w.contributionDays);

// -- stats ------------------------------------------------------------------
const totalContribs = calendar.totalContributions;
const stars = user.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);
const repoCount = user.repositories.totalCount;

// streaks (current streak may still be alive if today has no commits yet)
let longest = 0;
let run = 0;
for (const d of days) {
  run = d.contributionCount > 0 ? run + 1 : 0;
  if (run > longest) longest = run;
}
let current = 0;
for (let i = days.length - 1; i >= 0; i--) {
  if (days[i].contributionCount > 0) current++;
  else if (i === days.length - 1) continue; // today empty so far — don't break the streak
  else break;
}

// top languages by aggregated byte size
const langBytes = new Map();
for (const repo of user.repositories.nodes) {
  for (const edge of repo.languages.edges) {
    langBytes.set(edge.node.name, (langBytes.get(edge.node.name) ?? 0) + edge.size);
  }
}
const langTotal = [...langBytes.values()].reduce((a, b) => a + b, 0) || 1;
const topLangs = [...langBytes.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([name, bytes]) => ({ name, pct: (bytes / langTotal) * 100 }));

// weekly activity wave
const weekly = calendar.weeks.map((w) =>
  w.contributionDays.reduce((s, d) => s + d.contributionCount, 0)
);

// -- svg --------------------------------------------------------------------
const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const today = new Date().toISOString().slice(0, 10);

const stats = [
  { label: 'CONTRIBUTIONS_365D', value: fmt(totalContribs) },
  { label: 'STARS_EARNED', value: fmt(stars) },
  { label: 'PUBLIC_REPOS', value: fmt(repoCount) },
  { label: 'STREAK_CUR/MAX', value: `${current}/${longest}d` },
];
const statBlocks = stats
  .map((s, i) => {
    const x = 30 + (i % 2) * 140;
    const y = 84 + Math.floor(i / 2) * 62;
    return `<text x="${x}" y="${y}" class="mono" font-size="9" letter-spacing="1.5" fill="#7c8b99">${s.label}</text>
    <text x="${x}" y="${y + 26}" class="mono" font-size="23" font-weight="700" fill="#00ff88">${s.value}</text>`;
  })
  .join('\n    ');

const BAR_W = 150;
const langRows = topLangs
  .map((l, i) => {
    const y = 84 + i * 27;
    const w = Math.max(3, Math.round((l.pct / 100) * BAR_W));
    return `<text x="330" y="${y}" class="mono" font-size="10" fill="#8b98a5">${esc(l.name)}</text>
    <text x="562" y="${y}" text-anchor="end" class="mono" font-size="10" fill="#00f0ff">${l.pct.toFixed(1)}%</text>
    <rect x="330" y="${y + 5}" width="${BAR_W + 82}" height="5" rx="2.5" fill="#0a2216" />
    <rect x="330" y="${y + 5}" width="${Math.round((w / BAR_W) * (BAR_W + 82))}" height="5" rx="2.5" fill="#00ff88" fill-opacity="${0.95 - i * 0.14}" />`;
  })
  .join('\n    ');

// sparkline: 52 weeks -> polyline in a 240x86 box at (592, 78)
const SX = 592;
const SY = 78;
const SW = 240;
const SH = 86;
const maxWeek = Math.max(...weekly, 1);
const pts = weekly.map((v, i) => {
  const x = SX + (i / (weekly.length - 1)) * SW;
  const y = SY + SH - (v / maxWeek) * SH;
  return [x.toFixed(1), y.toFixed(1)];
});
const line = pts.map((p) => p.join(',')).join(' ');
const area = `${SX},${SY + SH} ${line} ${SX + SW},${SY + SH}`;
const [endX, endY] = pts[pts.length - 1];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="860" height="230" viewBox="0 0 860 230" role="img" aria-label="GitHub telemetry for ${LOGIN}: ${fmt(totalContribs)} contributions in the last year, ${fmt(stars)} stars, ${fmt(repoCount)} public repositories.">
  <style>
    .mono { font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; }
    .pulse { animation: pulse 2.4s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 0.9; } 50% { opacity: 0.25; } }
    @media (prefers-reduced-motion: reduce) { .pulse { animation: none !important; } }
  </style>
  <defs>
    <clipPath id="frame"><rect x="1" y="1" width="858" height="228" rx="12" /></clipPath>
    <linearGradient id="wave" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#00ff88" stop-opacity="0.35" />
      <stop offset="1" stop-color="#00ff88" stop-opacity="0" />
    </linearGradient>
    <pattern id="grid" width="26" height="26" patternUnits="userSpaceOnUse">
      <path d="M26 0H0V26" stroke="#00ff88" stroke-opacity="0.045" fill="none" />
    </pattern>
  </defs>

  <rect x="1" y="1" width="858" height="228" rx="12" fill="#02040a" stroke="#00ff88" stroke-opacity="0.32" />
  <g clip-path="url(#frame)">
    <rect x="1" y="1" width="858" height="228" fill="url(#grid)" />
    <rect x="1" y="1" width="858" height="36" fill="#0a0f18" />
    <line x1="1" y1="37" x2="859" y2="37" stroke="#00ff88" stroke-opacity="0.18" />
    <circle cx="26" cy="19" r="5.5" fill="#ff5f56" opacity="0.85" />
    <circle cx="46" cy="19" r="5.5" fill="#ffbd2e" opacity="0.85" />
    <circle cx="66" cy="19" r="5.5" fill="#27c93f" opacity="0.85" />
    <text x="430" y="23.5" text-anchor="middle" class="mono" font-size="11" fill="#00ff88" fill-opacity="0.55" letter-spacing="2">hilfing@dev:~$ ./telemetry --range 365d</text>

    <text x="30" y="62" class="mono" font-size="10" letter-spacing="2" fill="#00f0ff" fill-opacity="0.8">// SIGNALS</text>
    ${statBlocks}

    <text x="330" y="62" class="mono" font-size="10" letter-spacing="2" fill="#00f0ff" fill-opacity="0.8">// TOP_LANGUAGES</text>
    ${langRows}

    <text x="592" y="62" class="mono" font-size="10" letter-spacing="2" fill="#00f0ff" fill-opacity="0.8">// ACTIVITY_WAVE</text>
    <polygon points="${area}" fill="url(#wave)" />
    <polyline points="${line}" fill="none" stroke="#00ff88" stroke-width="1.6" stroke-linejoin="round" />
    <circle cx="${endX}" cy="${endY}" r="3" fill="#00f0ff" class="pulse" />
    <line x1="${SX}" y1="${SY + SH}" x2="${SX + SW}" y2="${SY + SH}" stroke="#00ff88" stroke-opacity="0.25" />

    <text x="838" y="216" text-anchor="end" class="mono" font-size="9" letter-spacing="1.5" fill="#00ff88" fill-opacity="0.45">LAST_SYNC: ${today} // SOURCE: GITHUB_GRAPHQL</text>
  </g>
</svg>
`;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, 'assets'), { recursive: true });
writeFileSync(join(root, 'assets', 'telemetry.svg'), svg);
console.log(
  `telemetry.svg written: ${fmt(totalContribs)} contribs, ${fmt(stars)} stars, ${repoCount} repos, streak ${current}/${longest}d, langs: ${topLangs.map((l) => l.name).join(', ')}`
);
