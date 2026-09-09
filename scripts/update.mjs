// Atualiza index.html com os dados mais recentes do ClickUp.
// Rodado pelo GitHub Actions (.github/workflows/update.yml).
//
// Requer a variável de ambiente CLICKUP_TOKEN (um Personal API Token do
// ClickUp — Settings > Apps > API Token — guardado como o secret
// CLICKUP_TOKEN no repositório).

const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN;
if (!CLICKUP_TOKEN) {
  console.error("CLICKUP_TOKEN não definido. Configure o secret no repositório.");
  process.exit(1);
}

const LIST_ID = "901705330213";
const ACTIVE_STATUSES = ["pending", "approved - ready to launch", "live", "final report"];
const FIELD_GUARANTEED_POSTS = "6805b812-8ca2-4c66-984a-f51ed1c1b048"; // #️⃣ Provider Guaranteed Posts
const FIELD_DELIVERED_POSTS = "c865c983-71cf-4414-9b63-965813d3be32"; // #️⃣ Provider Delivered Posts

const API_BASE = "https://api.clickup.com/api/v2";

async function clickup(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  const res = await fetch(url, { headers: { Authorization: CLICKUP_TOKEN } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ClickUp API ${res.status} em ${path}: ${body}`);
  }
  return res.json();
}

async function getActiveCampaigns() {
  let page = 0;
  let all = [];
  while (true) {
    const data = await clickup(`/list/${LIST_ID}/task`, {
      subtasks: "false",
      include_closed: "true",
      "statuses[]": ACTIVE_STATUSES,
      page,
    });
    all = all.concat(data.tasks || []);
    if (!data.has_more) break;
    page += 1;
  }
  return all;
}

async function getSubtaskRefs(taskId) {
  const data = await clickup(`/task/${taskId}`, { include_subtasks: "true" });
  return data.subtasks || [];
}

function fieldValue(customFields, fieldId) {
  const field = (customFields || []).find((f) => f.id === fieldId);
  if (!field || field.value === undefined || field.value === null || field.value === "") return 0;
  const n = Number(field.value);
  return Number.isFinite(n) ? n : 0;
}

async function getPostCounts(taskId) {
  const data = await clickup(`/task/${taskId}`);
  return {
    guaranteed: fieldValue(data.custom_fields, FIELD_GUARANTEED_POSTS),
    delivered: fieldValue(data.custom_fields, FIELD_DELIVERED_POSTS),
  };
}

function formatSaoPaulo(date) {
  const parts = new Intl.DateTimeFormat("es-ES", {
    timeZone: "America/Sao_Paulo",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  const month = get("month").replace(".", "");
  return `${get("day")} de ${month} de ${get("year")}, ${get("hour")}:${get("minute")}`;
}

function isoSaoPaulo(date) {
  // São Paulo não tem mais horário de verão (fixo UTC-03:00 desde 2019).
  const sp = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${sp.getUTCFullYear()}-${pad(sp.getUTCMonth() + 1)}-${pad(sp.getUTCDate())}` +
    `T${pad(sp.getUTCHours())}:${pad(sp.getUTCMinutes())}:${pad(sp.getUTCSeconds())}-03:00`
  );
}

async function main() {
  console.log("Buscando campanhas ativas...");
  const campaignTasks = await getActiveCampaigns();
  console.log(`${campaignTasks.length} campanhas ativas encontradas.`);

  const campaigns = [];
  for (const task of campaignTasks) {
    const subtaskRefs = await getSubtaskRefs(task.id);
    const subtasks = [];
    for (const ref of subtaskRefs) {
      const counts = await getPostCounts(ref.id);
      subtasks.push({
        name: ref.name,
        url: `https://app.clickup.com/t/${ref.id}`,
        status: (ref.status && ref.status.status) || "pending",
        guaranteed: counts.guaranteed,
        delivered: counts.delivered,
      });
    }
    campaigns.push({
      name: task.name,
      url: `https://app.clickup.com/t/${task.id}`,
      status: (task.status && task.status.status) || "pending",
      subtasks,
    });
  }

  const now = new Date();
  const dataObject = { generatedAt: isoSaoPaulo(now), campaigns };
  const dataLiteral = "var DATA = " + JSON.stringify(dataObject, null, 2) + ";";

  const fs = await import("node:fs/promises");
  let html = await fs.readFile("index.html", "utf8");

  const dataRe = /\/\* DATA_START \*\/[\s\S]*?\/\* DATA_END \*\//;
  if (!dataRe.test(html)) {
    throw new Error("Marcadores /* DATA_START */ ... /* DATA_END */ não encontrados em index.html");
  }
  html = html.replace(dataRe, `/* DATA_START */\n  ${dataLiteral}\n  /* DATA_END */`);

  const tsRe = /(<b id="updated-at"[^>]*>)([^<]*)(<\/b>)/;
  if (!tsRe.test(html)) {
    throw new Error('Elemento <b id="updated-at"> não encontrado em index.html');
  }
  html = html.replace(tsRe, `$1${formatSaoPaulo(now)}$3`);

  await fs.writeFile("index.html", html, "utf8");
  console.log("index.html atualizado com sucesso.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
