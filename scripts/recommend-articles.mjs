#!/usr/bin/env node
// Zenn / Qiita / Blog の全記事を、いいね・ストック・はてブ数と記事の新しさでスコアリングし、
// README.md の RECOMMENDED マーカー間を上位記事で置き換える。
// 使い方: node scripts/recommend-articles.mjs [--dry-run]
import { readFile, writeFile } from "node:fs/promises";

// ---- 調整用の係数 ----
const PICK_COUNT = 5;
const STOCK_WEIGHT = 0.5; // Qiita ストック 1 件 = いいね 0.5 件
const HATEBU_WEIGHT = 1.0; // はてブ 1 件 = いいね 1 件
const HALF_LIFE_DAYS = 365; // 新しさ補正が半分になるまでの日数
const FRESHNESS_FLOOR = 0.3; // どれだけ古くても残す新しさ補正の下限

const ZENN_USER = "ik11235";
const QIITA_USER = "ik-fib";
const BLOG_RSS = "https://ik-fib.com/rss.xml";
const README = new URL("../README.md", import.meta.url);
const START = "<!-- RECOMMENDED:START -->";
const END = "<!-- RECOMMENDED:END -->";
const LATEST_START = "<!-- BLOG-POST-LIST:START -->";
const LATEST_END = "<!-- BLOG-POST-LIST:END -->";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "profile-readme-recommender" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchZenn() {
  const articles = [];
  for (let page = 1; page; ) {
    const data = await fetchJson(
      `https://zenn.dev/api/articles?username=${ZENN_USER}&order=latest&page=${page}`,
    );
    for (const a of data.articles) {
      articles.push({
        source: "Zenn",
        title: a.title,
        url: `https://zenn.dev${a.path}`,
        publishedAt: new Date(a.published_at),
        likes: a.liked_count,
        stocks: 0,
      });
    }
    page = data.next_page;
  }
  return articles;
}

async function fetchQiita() {
  const items = await fetchJson(`https://qiita.com/api/v2/users/${QIITA_USER}/items?per_page=100`);
  return items.map((i) => ({
    source: "Qiita",
    title: i.title,
    url: i.url,
    publishedAt: new Date(i.created_at),
    likes: i.likes_count,
    stocks: i.stocks_count,
  }));
}

function decodeXml(s) {
  return s
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

async function fetchBlog() {
  const res = await fetch(BLOG_RSS);
  if (!res.ok) throw new Error(`${BLOG_RSS} -> HTTP ${res.status}`);
  const xml = await res.text();
  const tag = (item, name) => decodeXml(item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? "");
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
    source: "Blog",
    title: tag(item, "title"),
    url: tag(item, "link"),
    publishedAt: new Date(tag(item, "pubDate")),
    likes: 0,
    stocks: 0,
  }));
}

// はてブ数を一括取得（API は 1 リクエスト最大 50 URL）
async function fetchHatebu(urls) {
  const counts = {};
  for (let i = 0; i < urls.length; i += 50) {
    const query = urls.slice(i, i + 50).map((u) => `url=${encodeURIComponent(u)}`).join("&");
    Object.assign(counts, await fetchJson(`https://bookmark.hatenaapis.com/count/entries?${query}`));
  }
  return counts;
}

function score(article, now) {
  const engagement = article.likes + STOCK_WEIGHT * article.stocks + HATEBU_WEIGHT * article.hatebu;
  const ageDays = Math.max(0, (now - article.publishedAt) / 86_400_000);
  const freshness = FRESHNESS_FLOOR + (1 - FRESHNESS_FLOOR) * 0.5 ** (ageDays / HALF_LIFE_DAYS);
  return Math.log1p(engagement) * freshness;
}

const normalizeUrl = (u) => u.replace(/\/+$/, "");

function between(text, start, end) {
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s < 0 || e < s) throw new Error(`README にマーカー ${start} 〜 ${end} が見つかりません`);
  return { head: text.slice(0, s + start.length), body: text.slice(s + start.length, e), tail: text.slice(e) };
}

function formatLine(a) {
  const title = a.title.replace(/([[\]])/g, "\\$1");
  const stats = [a.source];
  if (a.likes) stats.push(`❤️ ${a.likes}`);
  if (a.hatebu) stats.push(`B! ${a.hatebu}`);
  return `- [${title}](${a.url}) <sub>(${stats.join(" · ")})</sub>`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const now = new Date();

  // どれか 1 つでも失敗したら README を更新せず終了する（部分的なデータでランキングを作らない）
  const articles = (await Promise.all([fetchZenn(), fetchQiita(), fetchBlog()])).flat();
  const hatebu = await fetchHatebu(articles.map((a) => a.url));
  for (const a of articles) {
    a.hatebu = hatebu[a.url] ?? 0;
    a.score = score(a, now);
  }

  const readme = await readFile(README, "utf8");
  const latestUrls = new Set(
    [...between(readme, LATEST_START, LATEST_END).body.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map(([, u]) =>
      normalizeUrl(u),
    ),
  );

  const ranked = articles.toSorted((a, b) => b.score - a.score);
  const picks = ranked.filter((a) => !latestUrls.has(normalizeUrl(a.url))).slice(0, PICK_COUNT);

  if (dryRun) {
    console.table(
      ranked.map((a) => ({
        pick: picks.includes(a) ? "★" : latestUrls.has(normalizeUrl(a.url)) ? "latest" : "",
        score: a.score.toFixed(3),
        src: a.source,
        likes: a.likes,
        stocks: a.stocks,
        hatebu: a.hatebu,
        date: a.publishedAt.toISOString().slice(0, 10),
        title: a.title.slice(0, 40),
      })),
    );
    return;
  }

  const { head, tail } = between(readme, START, END);
  const updated = `${head}\n${picks.map(formatLine).join("\n")}\n${tail}`;
  if (updated !== readme) await writeFile(README, updated);
  console.log(picks.map(formatLine).join("\n"));
}

await main();
