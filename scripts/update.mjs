// Refreshes the self-hosted profile cards and the auto sections of README.md.
// Runs daily from .github/workflows/refresh.yml. No dependencies: Node 20+.
//
// Token: GH_TOKEN. The default Actions token only sees public repos; a
// fine-grained PAT (stored as PROFILE_TOKEN) also folds private repos into
// the language totals. Private repos are never named in the output.

import { readFile, writeFile } from "node:fs/promises";

const LOGIN = process.env.PROFILE_LOGIN || "akashkottil";
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) throw new Error("GH_TOKEN is not set");

const headers = { Authorization: `bearer ${TOKEN}`, "User-Agent": LOGIN };

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function rest(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

const { user } = await gql(
  `query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount contributionLevel } }
        }
      }
      repositories(first: 100, ownerAffiliations: OWNER, isFork: false,
                   orderBy: { field: PUSHED_AT, direction: DESC }) {
        nodes {
          name description url isPrivate stargazerCount pushedAt
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        }
      }
    }
  }`,
  { login: LOGIN },
);

const calendar = user.contributionsCollection.contributionCalendar;
const repos = user.repositories.nodes;
const days = calendar.weeks.flatMap((w) => w.contributionDays);

// ---- numbers -------------------------------------------------------------

function streaks(list) {
  let longest = 0, run = 0;
  for (const d of list) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // Current streak may start yesterday: today often has no commits yet.
  let current = 0;
  const rev = [...list].reverse();
  const start = rev[0]?.contributionCount > 0 ? 0 : 1;
  for (const d of rev.slice(start)) {
    if (d.contributionCount === 0) break;
    current++;
  }
  return { current, longest };
}

const { current, longest } = streaks(days);
const activeDays = days.filter((d) => d.contributionCount > 0).length;

// Markup is left out: generated reports and static pages would otherwise
// outweigh the code itself.
const SKIP_LANGS = new Set(["HTML", "CSS", "SCSS"]);
const langBytes = new Map();
for (const r of repos) {
  for (const { size, node } of r.languages.edges) {
    if (SKIP_LANGS.has(node.name)) continue;
    const prev = langBytes.get(node.name) || { size: 0, color: node.color };
    prev.size += size;
    langBytes.set(node.name, prev);
  }
}
const langTotal = [...langBytes.values()].reduce((a, b) => a + b.size, 0) || 1;
const topLangs = [...langBytes.entries()]
  .sort((a, b) => b[1].size - a[1].size)
  .slice(0, 6)
  .map(([name, v]) => ({ name, color: v.color || "#888", pct: (v.size / langTotal) * 100 }));

// ---- activity card (SVG, light + dark) -----------------------------------

const THEMES = {
  dark: {
    bg: "#0d1117", border: "#30363d", text: "#e6edf3", muted: "#8b949e",
    accent: "#ff7a45",
    levels: ["#161b22", "#4a2516", "#8a3a1a", "#d2571f", "#ff8a4c"],
  },
  light: {
    bg: "#ffffff", border: "#d0d7de", text: "#1f2328", muted: "#656d76",
    accent: "#e2531a",
    levels: ["#eff2f5", "#ffd8c2", "#ffad80", "#f47a3c", "#d14f12"],
  },
};
const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => n.toLocaleString("en-US");

function card(t) {
  const W = 840, CELL = 11, GAP = 3, X0 = 28, Y0 = 108;
  const cells = calendar.weeks.map((w, wi) =>
    w.contributionDays.map((d) => {
      const row = new Date(d.date + "T00:00:00Z").getUTCDay();
      return `<rect x="${X0 + wi * (CELL + GAP)}" y="${Y0 + row * (CELL + GAP)}" width="${CELL}" height="${CELL}" rx="2.5" fill="${t.levels[LEVEL[d.contributionLevel] ?? 0]}"><title>${d.date}: ${d.contributionCount}</title></rect>`;
    }).join(""),
  ).join("");

  const stats = [
    [fmt(calendar.totalContributions), "contributions · last 12 months"],
    [fmt(activeDays), "active days"],
    [`${current}d`, "current streak"],
    [`${longest}d`, "longest streak"],
  ].map(([v, label], i) =>
    `<g transform="translate(${X0 + i * 200} 40)"><text class="v">${esc(v)}</text><text class="l" y="22">${esc(label)}</text></g>`,
  ).join("");

  // Stacked language bar + legend.
  const barY = 232, barW = W - X0 * 2;
  let x = X0;
  const bar = topLangs.map((l) => {
    const w = Math.max((l.pct / 100) * barW, 2);
    const r = `<rect x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="8" fill="${l.color}"/>`;
    x += w;
    return r;
  }).join("");
  const legend = topLangs.map((l, i) =>
    `<g transform="translate(${X0 + i * 132} ${barY + 30})"><circle r="4.5" cx="4.5" cy="-4" fill="${l.color}"/><text class="l" x="14">${esc(l.name)} ${l.pct.toFixed(1)}%</text></g>`,
  ).join("");

  const updated = new Date().toISOString().slice(0, 10);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="290" viewBox="0 0 ${W} 290" role="img" aria-label="${fmt(calendar.totalContributions)} contributions in the last 12 months">
<style>
text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:${t.text}}
.v{font-size:24px;font-weight:700;fill:${t.accent}}
.l{font-size:12px;fill:${t.muted}}
.h{font-size:11px;fill:${t.muted};letter-spacing:.08em}
</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="289" rx="12" fill="${t.bg}" stroke="${t.border}"/>
${stats}
${cells}
<clipPath id="bar"><rect x="${X0}" y="${barY}" width="${barW}" height="8" rx="4"/></clipPath>
<g clip-path="url(#bar)">${bar}</g>
${legend}
<text class="h" x="${W - X0}" y="${barY - 10}" text-anchor="end">LANGUAGES ACROSS MY REPOS (EXCL. HTML/CSS) · UPDATED ${updated}</text>
</svg>
`;
}

await writeFile("assets/activity-dark.svg", card(THEMES.dark));
await writeFile("assets/activity-light.svg", card(THEMES.light));

// ---- README sections -----------------------------------------------------

const ago = (iso) => {
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : `${Math.floor(d / 30)} mo ago`;
};

// Public open-source work, most-starred first. Skip forks, the profile repo
// itself and anything private.
const oss = repos
  .filter((r) => !r.isPrivate && r.name !== LOGIN && r.description)
  .sort((a, b) => b.stargazerCount - a.stargazerCount || b.pushedAt.localeCompare(a.pushedAt))
  .slice(0, 6)
  .map((r) => {
    const desc = r.description.length > 110 ? r.description.slice(0, 107).trimEnd() + "…" : r.description;
    return `| [**${esc(r.name)}**](${r.url}) | ${esc(desc).replace(/\|/g, "\\|")} | ★ ${r.stargazerCount} |`;
  });
const ossBlock = ["| Repo | What it does | Stars |", "|---|---|---|", ...oss].join("\n");

// Recent public activity from the events API. Private work is not listed.
const events = await rest(`/users/${LOGIN}/events/public?per_page=100`);
const seen = new Set();
const recent = [];
for (const e of events) {
  const repo = e.repo.name;
  const link = `[${repo}](https://github.com/${repo})`;
  let line = null;
  if (e.type === "PushEvent") line = `🔨 Pushed to ${link}`;
  else if (e.type === "PullRequestEvent" && e.payload.action === "opened") line = `🔀 Opened a PR in ${link}`;
  else if (e.type === "PullRequestEvent" && e.payload.pull_request?.merged) line = `✅ Merged a PR in ${link}`;
  else if (e.type === "CreateEvent" && e.payload.ref_type === "repository") line = `✨ Created ${link}`;
  else if (e.type === "ReleaseEvent") line = `🚀 Released ${e.payload.release?.tag_name ?? ""} of ${link}`;
  if (!line || seen.has(line)) continue;
  seen.add(line);
  recent.push(`- ${line} · <sub>${ago(e.created_at)}</sub>`);
  if (recent.length === 6) break;
}
const recentBlock = recent.length ? recent.join("\n") : "- Quiet on public repos lately. Most of my work is in private repos right now.";

function replaceBlock(src, name, body) {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(src)) throw new Error(`README is missing the ${name} markers`);
  return src.replace(re, `$1\n${body}\n$2`);
}

let readme = await readFile("README.md", "utf8");
readme = replaceBlock(readme, "OSS", ossBlock);
readme = replaceBlock(readme, "RECENT", recentBlock);
await writeFile("README.md", readme);

console.log(`contributions=${calendar.totalContributions} repos=${repos.length} oss=${oss.length} recent=${recent.length}`);
