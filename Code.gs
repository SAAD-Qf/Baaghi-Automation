/**
 * Baaghi Scholor — scene-synchronized daily YouTube automation.
 *
 * Keep existing Script Properties. Do NOT paste secrets into this file.
 * Required Script Properties:
 * GEMINI_API_KEY, PIXABAY_API_KEY, GITHUB_TOKEN, GITHUB_OWNER,
 * GITHUB_REPO, WEBHOOK_SECRET, SPREADSHEET_ID (set by setup()).
 *
 * Deploy Web App as Execute as Me / Anyone for GitHub callback.
 */

const HEADERS = [
  "CreatedAt", "JobId", "Topic", "RomanUrduScript", "UrduVoiceScript",
  "Title", "Description", "Tags", "Status", "YouTubeURL", "Error"
];

function saveConfig() {
  // Add freshly rotated credentials here in Apps Script only.
  // Blank values are ignored, so existing Script Properties are preserved.
  const cfg = {
    GEMINI_API_KEY: "",
    PIXABAY_API_KEY: "",
    GITHUB_TOKEN: "",
    GITHUB_OWNER: "SAAD-Qf",
    GITHUB_REPO: "Baaghi-Automation",
    WEBHOOK_SECRET: ""
  };

  const updates = {};
  Object.keys(cfg).forEach(function (key) {
    const value = String(cfg[key] || "").trim();
    if (value) updates[key] = value;
  });

  if (Object.keys(updates).length) {
    PropertiesService.getScriptProperties().setProperties(updates, false);
  }
  Logger.log("Only non-empty config values were saved; blank values did not overwrite existing properties.");
}

function setup() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("Open this script from the target Google Sheet (Extensions > Apps Script).");
  }
  PropertiesService.getScriptProperties().setProperty("SPREADSHEET_ID", spreadsheet.getId());
  let sheet = spreadsheet.getSheetByName("Videos");
  if (!sheet) sheet = spreadsheet.insertSheet("Videos");
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  Logger.log("Ready. Spreadsheet ID: " + spreadsheet.getId());
}

function installDailyTrigger() {
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
    const scenes = content.scenes.map((scene, index) => {
      const footageUrl = findPixabayFootage_(cfg.PIXABAY_API_KEY, scene.footage_query);
      Utilities.sleep(250);
      return {
        scene_number: index + 1,
        roman_text: scene.roman_text,
        urdu_text: scene.urdu_text,
        footage_query: scene.footage_query,
        footage_url: footageUrl
      };
    });

    const romanScript = scenes.map(s => s.roman_text).join("\n\n");
    const urduVoiceScript = scenes.map(s => s.urdu_text).join("\n\n");
    const row = [
      new Date(), jobId, content.topic, romanScript, urduVoiceScript,
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
      roman_script: romanScript,
      urdu_script: urduVoiceScript,
      scenes: scenes,
      category_id: "27",
      privacy_status: "public"
    };

    dispatchToGitHub_(cfg, job);
    sheet.getRange(sheetRow, 9).setValue("DISPATCHED_TO_GITHUB");
    Logger.log("Dispatched scene-synchronized job " + jobId + " with " + scenes.length + " scenes.");
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
    "Create one original, responsible, engaging Islamic educational video package in natural Pakistani Roman Urdu.",
    "Narration target: 8–10 minutes, approximately 900–1100 spoken words.",
    "Create 12 to 16 meaningful sequential scenes. Each scene must be a coherent narration block, not a single short sentence.",
    "Each scene should contain approximately 55–90 Roman Urdu words. Keep scene order continuous and preserve one complete story/lesson.",
    "For every scene provide both roman_text (natural Pakistani Roman Urdu) and urdu_text (the exact same narration in natural Urdu script). Keep both versions semantically identical sentence by sentence.",
    "For every scene provide footage_query: 3–6 simple English keywords describing a literal, relevant visual suitable for Pixabay.",
    "Prefer relevant documentary visuals: mosques, Quran pages, Islamic architecture, prayer, libraries, deserts, mountains, historic architecture, peaceful nature, abstract light.",
    "Do not request footage depicting prophets, companions, or unverifiable sacred historical events. Never fabricate a visual reenactment.",
    "Avoid unrelated people, celebrities, politicians, or generic unrelated footage.",
    "Use respectful language. Avoid fabricated hadith, Quran quotations, references, dates, or scholarly claims.",
    "If citing Quran/hadith, include exact reference only when confident; otherwise do not invent references.",
    "No sectarian attacks, political persuasion, sensationalism, or false claims.",
    "Create a concise clickable Roman Urdu title, useful description, and 8–12 tags.",
    "No stage directions, headings, markdown, or sound-effect instructions inside narration.",
    "Return ONLY valid JSON with keys: topic, title, description, tags (array), scenes (array).",
    "Each scenes item must have exactly: roman_text, urdu_text, footage_query.",
    "Make sure joining all roman_text values in order forms the complete narration."
  ].join("\n");
  const data = geminiText_(apiKey, prompt, 12000);
  const obj = parseJsonObject_(data);
  ["topic", "title", "description", "tags", "scenes"].forEach(k => {
    if (!obj[k]) throw new Error("Gemini response missing field: " + k);
  });
  if (!Array.isArray(obj.scenes) || obj.scenes.length < 10 || obj.scenes.length > 16) {
    throw new Error("Gemini must return 10–16 scenes; received " +
      (Array.isArray(obj.scenes) ? obj.scenes.length : "invalid scene list"));
  }
  obj.scenes = obj.scenes.map((s, i) => {
    if (!s || !s.roman_text || !s.urdu_text || !s.footage_query) {
      throw new Error("Gemini scene " + (i + 1) + " is missing roman_text, urdu_text, or footage_query.");
    }
    if (String(s.roman_text).trim().length < 150 ||
        String(s.urdu_text).trim().length < 100) {
      throw new Error("Gemini scene " + (i + 1) + " is too short.");
    }
    return {
      roman_text: String(s.roman_text).trim(),
      urdu_text: String(s.urdu_text).trim(),
      footage_query: String(s.footage_query).trim().slice(0, 100)
    };
  });
  const fullScript = obj.scenes.map(s => s.roman_text).join(" ");
  if (fullScript.split(/\s+/).length < 750) {
    throw new Error("Combined narration is too short; refusing to dispatch.");
  }
  obj.tags = Array.isArray(obj.tags) ? obj.tags.slice(0, 15).map(String) : [];
  return obj;
}

function transliterateToUrdu_(apiKey, romanText) {
  const prompt = [
    "Convert the following Pakistani Roman Urdu narration into natural Urdu script for a Pakistani Urdu male text-to-speech voice.",
    "Preserve every sentence, meaning, and pronunciation. Do not summarize, rewrite, add, or omit content.",
    "Keep familiar English technical terms in Urdu transliteration where appropriate.",
    "Keep Quranic Arabic phrases as Arabic if already present. Output only Urdu-script text, no commentary.",
    "TEXT:",
    romanText
  ].join("\n\n");
  const result = geminiText_(apiKey, prompt, 2048).trim();
  if (result.length < 80) throw new Error("Urdu transliteration returned too little text.");
  return result;
}

// Stable Gemini API model fallback order.
// Keep this list to models supported by the Generative Language API endpoint below.
const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite"
];

function geminiText_(apiKey, prompt, maxTokens) {
  const retryableStatuses = [404, 429, 500, 502, 503, 504];
  const errors = [];

  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      model + ":generateContent?key=" + encodeURIComponent(apiKey);
    const payload = {
      contents: [{parts: [{text: prompt}]}],
      generationConfig: {temperature: 0.65, maxOutputTokens: maxTokens}
    };

    try {
      const res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      const status = res.getResponseCode();
      const body = res.getContentText();

      if (status < 200 || status >= 300) {
        const detail = "Gemini model " + model + " returned HTTP " +
          status + ": " + body.slice(0, 900);
        errors.push(detail);

        // Try the next model only for model availability, quota, or server errors.
        if (retryableStatuses.indexOf(status) !== -1) {
          console.warn(detail + " — trying the next fallback model.");
          continue;
        }
        throw new Error(detail);
      }

      const parsed = JSON.parse(body);
      const parts = (((parsed.candidates || [])[0] || {}).content || {}).parts || [];
      const result = parts.map(p => p.text || "").join("").trim();

      if (!result) {
        const detail = "Gemini model " + model + " returned empty text.";
        errors.push(detail);
        console.warn(detail + " — trying the next fallback model.");
        continue;
      }

      Logger.log("Gemini response generated successfully with model: " + model);
      return result;

    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      if (message.indexOf("Gemini model ") === 0 &&
          retryableStatuses.some(function (status) {
            return message.indexOf("HTTP " + status) !== -1;
          })) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("All Gemini fallback models failed. " + errors.join(" || "));
}

function parseJsonObject_(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Gemini did not return JSON: " + cleaned.slice(0, 500));
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function findPixabayFootage_(apiKey, queryText) {
  const query = encodeURIComponent(String(queryText).slice(0, 100));
  const url = "https://pixabay.com/api/videos/?key=" + encodeURIComponent(apiKey) +
    "&q=" + query + "&lang=en&per_page=20&safesearch=true&order=popular";
  const res = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
  if (res.getResponseCode() !== 200) {
    throw new Error("Pixabay API error: " + res.getResponseCode() + " " +
      res.getContentText().slice(0, 500));
  }
  const data = JSON.parse(res.getContentText());
  const hits = data.hits || [];
  for (const hit of hits) {
    const videos = hit.videos || {};
    const candidate = videos.large || videos.medium || videos.small || videos.tiny;
    if (candidate && candidate.url) return candidate.url;
  }

  // A safe, relevant fallback search; never substitute unrelated people/celebrity footage.
  const fallbackQuery = encodeURIComponent("mosque islamic architecture nature");
  const fallbackUrl = "https://pixabay.com/api/videos/?key=" + encodeURIComponent(apiKey) +
    "&q=" + fallbackQuery + "&lang=en&per_page=20&safesearch=true&order=popular";
  const fallback = UrlFetchApp.fetch(fallbackUrl, {muteHttpExceptions: true});
  if (fallback.getResponseCode() !== 200) {
    throw new Error("Pixabay fallback API error: " + fallback.getResponseCode());
  }
  const fallbackHits = (JSON.parse(fallback.getContentText()).hits || []);
  for (const hit of fallbackHits) {
    const videos = hit.videos || {};
    const candidate = videos.large || videos.medium || videos.small || videos.tiny;
    if (candidate && candidate.url) return candidate.url;
  }
  throw new Error("Pixabay returned no suitable footage for scene query: " + queryText);
}

function dispatchToGitHub_(cfg, job) {
  const url = "https://api.github.com/repos/" +
    encodeURIComponent(cfg.GITHUB_OWNER) + "/" +
    encodeURIComponent(cfg.GITHUB_REPO) + "/dispatches";
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
    throw new Error("GitHub dispatch failed (" + res.getResponseCode() + "): " +
      res.getContentText().slice(0, 1000));
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
      if (String(values[i][1]) === jobId) {
        foundRow = i + 1;
        break;
      }
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
  const required = [
    "GEMINI_API_KEY", "PIXABAY_API_KEY", "GITHUB_TOKEN",
    "GITHUB_OWNER", "GITHUB_REPO", "WEBHOOK_SECRET"
  ];
  required.forEach(k => {
    if (!p[k] || /PASTE_|YOUR_/.test(p[k])) {
      throw new Error("Missing Script Property: " + k +
        ". Add it in Project Settings > Script Properties.");
    }
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
  if (!sh) {
    sh = ss.insertSheet("Videos");
    sh.appendRow(HEADERS);
  }
  return sh;
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
