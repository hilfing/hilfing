#!/usr/bin/env node
// Regenerates assets/telemetry.svg (dark) and assets/telemetry-light.svg
// from live GitHub data. Runs in CI (see .github/workflows/telemetry.yml)
// with GH_TOKEN set.

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

// -- palettes ---------------------------------------------------------------
const DARK = {
  bg: '#02040a',
  chrome: '#0a0f18',
  frame: '#00ff88', frameOp: 0.32,
  grid: '#00ff88', gridOp: 0.045,
  chromeLine: '#00ff88', chromeLineOp: 0.18,
  title: '#00ff88', titleOp: 0.55,
  caption: '#00f0ff', captionOp: 0.8,
  statLabel: '#7c8b99',
  statValue: '#00ff88',
  langName: '#8b98a5',
  langPct: '#00f0ff',
  barBg: '#0a2216',
  barFill: '#00ff88',
  wave: '#00ff88', waveGradOp: 0.35,
  endDot: '#00f0ff',
  axis: '#00ff88', axisOp: 0.25,
  footer: '#00ff88', footerOp: 0.45,
};
const LIGHT = {
  bg: '#f7faf8',
  chrome: '#e6f0ea',
  frame: '#067a47', frameOp: 0.5,
  grid: '#067a47', gridOp: 0.07,
  chromeLine: '#067a47', chromeLineOp: 0.25,
  title: '#0a6e44', titleOp: 0.8,
  caption: '#0e7490', captionOp: 1,
  statLabel: '#55636e',
  statValue: '#047857',
  langName: '#55636e',
  langPct: '#0e7490',
  barBg: '#dcece3',
  barFill: '#047857',
  wave: '#047857', waveGradOp: 0.3,
  endDot: '#0891b2',
  axis: '#067a47', axisOp: 0.3,
  footer: '#0a6e44', footerOp: 0.65,
};

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

function render(p) {
  const statBlocks = stats
    .map((s, i) => {
      const x = 30 + (i % 2) * 140;
      const y = 84 + Math.floor(i / 2) * 62;
      return `<text x="${x}" y="${y}" class="mono" font-size="9" letter-spacing="1.5" fill="${p.statLabel}">${s.label}</text>
    <text x="${x}" y="${y + 26}" class="mono" font-size="23" font-weight="700" fill="${p.statValue}">${s.value}</text>`;
    })
    .join('\n    ');

  const BAR_W = 232;
  const langRows = topLangs
    .map((l, i) => {
      const y = 84 + i * 27;
      const w = Math.max(4, Math.round((l.pct / 100) * BAR_W));
      return `<text x="330" y="${y}" class="mono" font-size="10" fill="${p.langName}">${esc(l.name)}</text>
    <text x="562" y="${y}" text-anchor="end" class="mono" font-size="10" fill="${p.langPct}">${l.pct.toFixed(1)}%</text>
    <rect x="330" y="${y + 5}" width="${BAR_W}" height="5" rx="2.5" fill="${p.barBg}" />
    <rect x="330" y="${y + 5}" width="${w}" height="5" rx="2.5" fill="${p.barFill}" fill-opacity="${(0.95 - i * 0.14).toFixed(2)}" />`;
    })
    .join('\n    ');

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
  const line = pts.map((pt) => pt.join(',')).join(' ');
  const area = `${SX},${SY + SH} ${line} ${SX + SW},${SY + SH}`;
  const [endX, endY] = pts[pts.length - 1];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="860" height="230" viewBox="0 0 860 230" role="img" aria-label="GitHub telemetry for ${LOGIN}: ${fmt(totalContribs)} contributions in the last year, ${fmt(stars)} stars, ${fmt(repoCount)} public repositories.">
  <style>
    .mono { font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; }
    .pulse { animation: pulse 2.4s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 0.9; } 50% { opacity: 0.25; } }
    @media (prefers-reduced-motion: reduce) { .pulse { animation: none !important; } }
  </style>
  <defs>
    <clipPath id="frame"><rect x="1" y="1" width="858" height="228" rx="12" /></clipPath>
    <linearGradient id="wave" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${p.wave}" stop-opacity="${p.waveGradOp}" />
      <stop offset="1" stop-color="${p.wave}" stop-opacity="0" />
    </linearGradient>
    <pattern id="grid" width="26" height="26" patternUnits="userSpaceOnUse">
      <path d="M26 0H0V26" stroke="${p.grid}" stroke-opacity="${p.gridOp}" fill="none" />
    </pattern>
  </defs>

  <rect x="1" y="1" width="858" height="228" rx="12" fill="${p.bg}" stroke="${p.frame}" stroke-opacity="${p.frameOp}" />
  <g clip-path="url(#frame)">
    <rect x="1" y="1" width="858" height="228" fill="url(#grid)" />
    <rect x="1" y="1" width="858" height="36" fill="${p.chrome}" />
    <line x1="1" y1="37" x2="859" y2="37" stroke="${p.chromeLine}" stroke-opacity="${p.chromeLineOp}" />
    <circle cx="26" cy="19" r="5.5" fill="#ff5f56" opacity="0.85" />
    <circle cx="46" cy="19" r="5.5" fill="#ffbd2e" opacity="0.85" />
    <circle cx="66" cy="19" r="5.5" fill="#27c93f" opacity="0.85" />
    <text x="430" y="23.5" text-anchor="middle" class="mono" font-size="11" fill="${p.title}" fill-opacity="${p.titleOp}" letter-spacing="2">hilfing@dev:~$ ./telemetry --range 365d</text>

    <text x="30" y="62" class="mono" font-size="10" letter-spacing="2" fill="${p.caption}" fill-opacity="${p.captionOp}">// SIGNALS</text>
    ${statBlocks}

    <text x="330" y="62" class="mono" font-size="10" letter-spacing="2" fill="${p.caption}" fill-opacity="${p.captionOp}">// TOP_LANGUAGES</text>
    ${langRows}

    <text x="592" y="62" class="mono" font-size="10" letter-spacing="2" fill="${p.caption}" fill-opacity="${p.captionOp}">// ACTIVITY_WAVE</text>
    <polygon points="${area}" fill="url(#wave)" />
    <polyline points="${line}" fill="none" stroke="${p.wave}" stroke-width="1.6" stroke-linejoin="round" />
    <circle cx="${endX}" cy="${endY}" r="3" fill="${p.endDot}" class="pulse" />
    <line x1="${SX}" y1="${SY + SH}" x2="${SX + SW}" y2="${SY + SH}" stroke="${p.axis}" stroke-opacity="${p.axisOp}" />

    <text x="838" y="216" text-anchor="end" class="mono" font-size="9" letter-spacing="1.5" fill="${p.footer}" fill-opacity="${p.footerOp}">LAST_SYNC: ${today} // SOURCE: GITHUB_GRAPHQL</text>
  </g>
</svg>
`;
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, 'assets'), { recursive: true });
writeFileSync(join(root, 'assets', 'telemetry.svg'), render(DARK));
writeFileSync(join(root, 'assets', 'telemetry-light.svg'), render(LIGHT));
console.log(
  `telemetry svgs written: ${fmt(totalContribs)} contribs, ${fmt(stars)} stars, ${repoCount} repos, streak ${current}/${longest}d, langs: ${topLangs.map((l) => l.name).join(', ')}`
);
