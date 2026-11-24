/**
 * Baaghi Scholor — daily YouTube automation
 * Apps Script orchestrates Gemini + Sheets + GitHub Actions.
 *
 * 1) Fill CONFIG values in saveConfig() and run it once.
 * 2) Run setup() once, authorize Google permissions.
 * 3) Deploy as Web App (Execute as Me; access Anyone) for GitHub callback.
 * 4) Set GAS_WEB_APP_URL and GAS_WEBHOOK_SECRET in GitHub repo Actions secrets.
 * 5) Run testGenerateAndDispatch() once, then installDailyTrigger().
 */

const HEADERS = [
  "CreatedAt", "JobId", "Topic", "RomanUrduScript", "UrduVoiceScript",
  "Title", "Description", "Tags", "Status", "YouTubeURL", "Error"
];

function saveConfig() {
  const cfg = {
    GEMINI_API_KEY: "PASTE_GEMINI_API_KEY",
    PIXABAY_API_KEY: "PASTE_NEW_PIXABAY_API_KEY",
    GITHUB_TOKEN: "PASTE_GITHUB_FINE_GRAINED_PAT",
    GITHUB_OWNER: "YOUR_GITHUB_USERNAME_OR_ORG",
    GITHUB_REPO: "YOUR_PUBLIC_REPOSITORY_NAME",
    WEBHOOK_SECRET: "MAKE_A_LONG_RANDOM_SECRET"
  };
  PropertiesService.getScriptProperties().setProperties(cfg, false);
  Logger.log("Config saved. Replace every PASTE_/YOUR_ value before running.");
}

function setup() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("Open this script from the target Google Sheet (Extensions > Apps Script).");
  PropertiesService.getScriptProperties().setProperty("SPREADSHEET_ID", spreadsheet.getId());
  let sheet = spreadsheet.getSheetByName("Videos");
  if (!sheet) sheet = spreadsheet.insertSheet("Videos");
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  Logger.log("Ready. Spreadsheet ID: " + spreadsheet.getId());
}

function installDailyTrigger() {
  // Project Settings > Time zone must be Asia/Karachi.
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "generateAndDispatchDaily") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("generateAndDispatchDaily").timeBased().everyDays(1).atHour(10).create();
  Logger.log("Daily trigger installed for approximately 10:00 AM (project timezone).");
}

function testGenerateAndDispatch() {
  generateAndDispatchDaily();
}

function generateAndDispatchDaily() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error("Another daily run is already active.");
  try {
    const cfg = getConfig_();
    const sheet = getSheet_();
    const jobId = Utilities.getUuid();
    const content = generateContent_(cfg.GEMINI_API_KEY);
    const urduVoiceScript = transliterateToUrdu_(cfg.GEMINI_API_KEY, content.script);
    const footageUrl = findPixabayFootage_(cfg.PIXABAY_API_KEY, content.footage_query);
    const row = [
      new Date(), jobId, content.topic, content.script, urduVoiceScript,
      content.title, content.description, content.tags.join(", "),
      "QUEUED_FOR_RENDER", "", ""
    ];
    sheet.appendRow(row);
    const sheetRow = sheet.getLastRow();

    const job = {
      job_id: jobId,
      sheet_row: sheetRow,
      topic: content.topic,
      title: content.title,
      description: content.description,
      tags: content.tags,
      roman_script: content.script,
      urdu_script: urduVoiceScript,
      footage_url: footageUrl,
      category_id: "22",
      privacy_status: "public"
    };
    dispatchToGitHub_(cfg, job);
    sheet.getRange(sheetRow, 9).setValue("DISPATCHED_TO_GITHUB");
    Logger.log("Dispatched job " + jobId);
  } catch (err) {
    console.error(err.stack || err);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function generateContent_(apiKey) {
  const prompt = [
    "You are the researcher and scriptwriter for Baaghi Scholor, an Islamic educational YouTube channel.",
    "Create ONE original, responsible, engaging video package.",
    "Topic should be a specific Islamic educational topic, in Urdu.",
    "Write a detailed 8–10 minute narration script in natural Pakistani Roman Urdu.",
    "Use respectful language. Avoid fabricated hadith, Quran quotations, references, dates, or scholarly claims.",
    "If citing Quran/hadith, include exact reference only when confident; otherwise phrase as general reflection and do not invent references.",
    "No sectarian attacks, political persuasion, or sensational false claims.",
    "Create a concise clickable Roman Urdu/Urdu-friendly title, a useful description, and 8–12 tags.",
    "Also create footage_query: 3–6 short English keywords for Pixabay video search, related to the topic.",
    "The script must be suitable for a single male Urdu voiceover. No stage directions or markdown.",
    "Return ONLY valid JSON with keys: topic, script, title, description, tags (array of strings), footage_query.",
    "Script must be at least 900 words; do not shorten it."
  ].join("\n");
  const data = geminiText_(apiKey, prompt, 8192);
  const obj = parseJsonObject_(data);
  ["topic", "script", "title", "description", "tags", "footage_query"].forEach(k => {
    if (!obj[k]) throw new Error("Gemini response missing field: " + k);
  });
  if (String(obj.script).length < 2500) throw new Error("Gemini script is too short; refusing to publish.");
  obj.tags = Array.isArray(obj.tags) ? obj.tags.slice(0, 15).map(String) : [];
  return obj;
}

function transliterateToUrdu_(apiKey, romanScript) {
  const prompt = [
    "Convert the following Pakistani Roman Urdu narration into natural Urdu script for a Pakistani Urdu male text-to-speech voice.",
    "Preserve every sentence, meaning, paragraph, and pronunciation. Do not summarize, rewrite, add, or omit content.",
    "Keep English technical terms in familiar Urdu transliteration where appropriate.",
    "Keep Quranic Arabic phrases as Arabic if already present. Output only Urdu-script text, no commentary.",
    "TEXT:",
    romanScript
  ].join("\n\n");
  return geminiText_(apiKey, prompt, 8192).trim();
}

function geminiText_(apiKey, prompt, maxTokens) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" + encodeURIComponent(apiKey);
  const payload = {
    contents: [{parts: [{text: prompt}]}],
    generationConfig: {temperature: 0.7, maxOutputTokens: maxTokens}
  };
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const status = res.getResponseCode();
  const body = res.getContentText();
  if (status < 200 || status >= 300) throw new Error("Gemini API " + status + ": " + body.slice(0, 1200));
  const parsed = JSON.parse(body);
  const text = (((parsed.candidates || [])[0] || {}).content || {}).parts || [];
  const result = text.map(p => p.text || "").join("").trim();
  if (!result) throw new Error("Gemini returned empty text.");
  return result;
}

function parseJsonObject_(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Gemini did not return JSON: " + cleaned.slice(0, 500));
  return JSON.parse(cleaned.slice(start, end + 1));
}

function findPixabayFootage_(apiKey, topic) {
  const query = encodeURIComponent((topic + " mosque islamic architecture nature").slice(0, 100));
  const url = "https://pixabay.com/api/videos/?key=" + encodeURIComponent(apiKey) +
    "&q=" + query + "&lang=en&category=religion&per_page=10&safesearch=true&order=popular";
  const res = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
  if (res.getResponseCode() !== 200) throw new Error("Pixabay API error: " + res.getContentText().slice(0, 500));
  const data = JSON.parse(res.getContentText());
  const hits = data.hits || [];
  if (!hits.length) throw new Error("Pixabay returned no video footage for topic: " + topic);
  // Prefer large, then medium, then small. Pixabay video URLs are public download URLs.
  for (const hit of hits) {
    const videos = hit.videos || {};
    const candidate = videos.large || videos.medium || videos.small || videos.tiny;
    if (candidate && candidate.url) return candidate.url;
  }
  throw new Error("Pixabay results contained no downloadable video URL.");
}

function dispatchToGitHub_(cfg, job) {
  const url = "https://api.github.com/repos/" + encodeURIComponent(cfg.GITHUB_OWNER) +
    "/" + encodeURIComponent(cfg.GITHUB_REPO) + "/dispatches";
  const payload = {event_type: "baaghi-video-ready", client_payload: {job: job}};
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + cfg.GITHUB_TOKEN,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 204) {
    throw new Error("GitHub dispatch failed (" + res.getResponseCode() + "): " + res.getContentText().slice(0, 1000));
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const cfg = getConfig_();
    if (!body.secret || body.secret !== cfg.WEBHOOK_SECRET) {
      return jsonOutput_({ok: false, error: "Unauthorized"});
    }
    const sheet = getSheet_();
    const jobId = String(body.job_id || "");
    if (!jobId) return jsonOutput_({ok: false, error: "Missing job_id"});
    const values = sheet.getDataRange().getValues();
    let foundRow = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][1]) === jobId) { foundRow = i + 1; break; }
    }
    if (foundRow < 0) return jsonOutput_({ok: false, error: "Job not found"});
    sheet.getRange(foundRow, 9).setValue(body.status || "UNKNOWN");
    sheet.getRange(foundRow, 10).setValue(body.youtube_url || "");
    sheet.getRange(foundRow, 11).setValue(body.error || "");
    return jsonOutput_({ok: true});
  } catch (err) {
    return jsonOutput_({ok: false, error: String(err)});
  }
}

function getConfig_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const required = ["GEMINI_API_KEY", "PIXABAY_API_KEY", "GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO", "WEBHOOK_SECRET"];
  required.forEach(k => {
    if (!p[k] || /PASTE_|YOUR_/.test(p[k])) throw new Error("Missing Script Property: " + k + ". Edit saveConfig() first.");
  });
  return p;
}

function getSheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty("SPREADSHEET_ID");
  if (!id) {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) throw new Error("Run setup() from the target Google Sheet first.");
    id = active.getId();
    props.setProperty("SPREADSHEET_ID", id);
  }
  const ss = SpreadsheetApp.openById(id);
  let sh = ss.getSheetByName("Videos");
  if (!sh) { sh = ss.insertSheet("Videos"); sh.appendRow(HEADERS); }
  return sh;
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
