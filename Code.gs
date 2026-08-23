PROBE_LINE_1
PROBE_LINE_2
  indented(3);/**
 * Google Scholar Alerts -> Telegram
 * Google Apps Script. No server, no n8n.
 *
 * Setup:
 *  1. script.google.com -> New project, paste this file.
 *  2. Fill in CONFIG below.
 *  3. Add OPENAI_API_KEY in Project Settings -> Script Properties.
 *  4. Run setup() once. Grants Gmail + external request scopes,
 *     creates the label and the hourly trigger.
 *  5. Run dryRun() and read the Executions log. Nothing is sent.
 *
 * Reset dedup: resetSeen(). Remove the trigger: removeTriggers().
 */

var CONFIG = {
  // BotFather token, looks like 123456:AA...
  BOT_TOKEN: 'PUT_BOT_TOKEN_HERE',

  // Channel id: -100XXXXXXXXXX. The bot must be a channel admin.
  CHAT_ID: 'PUT_CHAT_ID_HERE',

  // Scholar alert sender. No need to change.
  QUERY: 'from:scholaralerts-noreply@google.com',

  // Label applied to processed threads.
  LABEL: 'scholar-sent',

  // How many days back to look on the first run.
  LOOKBACK_DAYS: 3,

  // Max email threads per run.
  MAX_THREADS: 20,

  // How many dedup keys to keep in script properties.
  MAX_SEEN: 5000,

  // Delay between messages, ms. Telegram dislikes more than ~20 per minute.
  SEND_DELAY_MS: 1500,

  // Short hashtag names instead of the whole query from the subject line.
  // If no substring matches, the tag is derived from the subject as before.
  TAG_ALIASES: [
    ['self-verification', 'agentloops'],
    ['code generation', 'codegen'],
    ['developer productivity', 'devprod'],
  ],

  // ---- LLM cards ----
  // true  = fetch the abstract and ask the model to write a card.
  // false = plain format (title + snippet from the email).
  USE_LLM: true,

  // The OpenAI key lives in Script Properties, not here.
  // Project Settings -> Script Properties -> OPENAI_API_KEY
  MODEL: 'gpt-5.6-luna',

  // none | low | medium | high | xhigh | max
  REASONING_EFFORT: 'low',

  // Contact address for polite OpenAlex usage (required by their API).
  CONTACT_EMAIL: 'you@example.com',

  // Max articles per run. Keeps execution inside the 6 minute limit.
  MAX_ARTICLES_PER_RUN: 25,

  // Forum group with topics instead of a channel: alert tag -> thread_id.
  // Example: {'agentic loop verification': 12, 'battery recycling': 34}
  // Empty object = everything goes into a single stream.
  TOPICS: {},
};

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function setup() {
  getLabel_();
  removeTriggers();
  ScriptApp.newTrigger('run').timeBased().everyHours(1).create();
  Logger.log('Done. Trigger: hourly. Label: ' + CONFIG.LABEL);
}

function run() {
  process_(false);
}

function dryRun() {
  process_(true);
}

function removeTriggers() {
  var t = ScriptApp.getProjectTriggers();
  for (var i = 0; i < t.length; i++) {
    if (t[i].getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t[i]);
  }
}

function resetSeen() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var n = 0;
  for (var k in all) {
    if (k.indexOf('s_') === 0) {
      props.deleteProperty(k);
      n++;
    }
  }
  Logger.log('Keys removed: ' + n);
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */

function process_(dry) {
  if (!dry && (CONFIG.BOT_TOKEN.indexOf('PUT_') === 0 || String(CONFIG.CHAT_ID).indexOf('PUT_') === 0)) {
    throw new Error('Fill in BOT_TOKEN and CHAT_ID in CONFIG.');
  }

  var label = getLabel_();
  var query =
    CONFIG.QUERY +
    ' -label:' +
    CONFIG.LABEL +
    ' newer_than:' +
    CONFIG.LOOKBACK_DAYS +
    'd';

  var threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS);
  Logger.log('Emails found: ' + threads.length + (dry ? ' (dry run)' : ''));

  var sent = 0;
  var skipped = 0;

  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    var ok = true;

    for (var m = 0; m < messages.length; m++) {
      var articles = parseAlert_(messages[m].getSubject(), messages[m].getBody());

      for (var a = 0; a < articles.length; a++) {
        var art = articles[a];

        if (isSeen_(art.key)) {
          skipped++;
          continue;
        }

        if (sent >= CONFIG.MAX_ARTICLES_PER_RUN) {
          Logger.log('Per-run article limit reached, the rest goes out next hour.');
          ok = false;
          break;
        }

        if (CONFIG.USE_LLM) art.message = buildCard_(art);

        if (dry) {
          Logger.log('--- ' + art.tag + ' ---\n' + art.message);
          sent++;
          continue;
        }

        if (sendTelegram_(art)) {
          markSeen_(art.key);
          sent++;
          Utilities.sleep(CONFIG.SEND_DELAY_MS);
        } else {
          ok = false;
        }
      }
    }

    // Label the thread only if every article went out without errors.
    if (!dry && ok) threads[i].addLabel(label);
  }

  pruneSeen_();
  Logger.log('Sent: ' + sent + ', duplicates skipped: ' + skipped);
}

/* ------------------------------------------------------------------ */
/* Scholar email parser                                                */
/* ------------------------------------------------------------------ */

var ENTITIES = {
  nbsp: ' ',
  quot: '"',
  apos: "'",
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  hellip: '\u2026',
  ndash: '-',
  mdash: '-',
  laquo: '\u00ab',
  raquo: '\u00bb',
  lt: '<',
  gt: '>',
};

function stripTags_(s) {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) {
      return String.fromCodePoint(parseInt(h, 16));
    })
    .replace(/&#(\d+);/g, function (m, d) {
      return String.fromCodePoint(parseInt(d, 10));
    })
    .replace(/&([a-z]+);/gi, function (m, name) {
      var key = name.toLowerCase();
      if (ENTITIES[key] !== undefined) return ENTITIES[key];
      return key === 'amp' ? '&' : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// parse_mode = HTML: escape the three reserved characters back.
function esc_(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clean_(s) {
  return esc_(stripTags_(s));
}

// scholar.google.com/scholar_url?url=<real link>&... -> real link
function unwrapUrl_(u) {
  var raw = u.replace(/&amp;/g, '&');
  var m = raw.match(/[?&]url=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]).replace(/\s/g, '%20');
    } catch (e) {
      return m[1];
    }
  }
  return raw;
}

function hashKey_(title) {
  var norm = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  var h = 2166136261;
  for (var i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8) + '_' + norm.length;
}

/**
 * Splits one Scholar email into individual articles.
 * @return {Array<{key, title, titleRaw, url, tag, hashtag, authors, snippet, message}>}
 */
function parseAlert_(subject, html) {
  var out = [];
  if (!html) return out;

  // The subject line is the alert query itself. Turn it into a tag.
  // Both locale variants are stripped: Gmail may deliver either wording.
  var tag = stripTags_(subject || 'scholar')
    .replace(/\s*[\u2013\u2014-]\s*(new results|\u043d\u043e\u0432\u044b\u0435 \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442\u044b).*$/i, '')
    .replace(/^(new articles in|\u043d\u043e\u0432\u044b\u0435 \u0441\u0442\u0430\u0442\u044c\u0438 \u043f\u043e \u0437\u0430\u043f\u0440\u043e\u0441\u0443)\s*/i, '')
    .replace(/^["'\u00ab]+|["'\u00bb]+$/g, '')
    .trim();

  var alias = '';
  var low = tag.toLowerCase();
  for (var t = 0; t < CONFIG.TAG_ALIASES.length; t++) {
    if (low.indexOf(CONFIG.TAG_ALIASES[t][0].toLowerCase()) !== -1) {
      alias = CONFIG.TAG_ALIASES[t][1];
      break;
    }
  }

  var hashtag =
    '#' +
    (alias ||
      tag.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') ||
      'scholar').slice(0, 40);

  var seenHere = {};
  var chunks = html.split(/<h3\b/i).slice(1);

  for (var c = 0; c < chunks.length; c++) {
    var chunk = chunks[c];
    var aM = chunk.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aM) continue;

    var rawTitle = aM[2];
    var title = clean_(rawTitle);
    if (!title) continue;

    var key = hashKey_(stripTags_(rawTitle));
    if (seenHere[key]) continue;
    seenHere[key] = true;

    var after = chunk.slice(aM.index + aM[0].length);
    var metaM = after.match(/<div[^>]*>([\s\S]*?)<\/div>/i);
    var sniM = after.match(/class="gse_alrt_sni"[^>]*>([\s\S]*?)<\/div>/i);

    var authors = metaM ? clean_(metaM[1]) : '';
    var snippet = sniM ? clean_(sniM[1]) : '';
    var url = unwrapUrl_(aM[1]);

    var parts = ['<b>' + title + '</b>'];
    if (authors) parts.push(authors);
    if (snippet) parts.push(snippet);
    parts.push(hashtag + '\n' + url);

    out.push({
      key: key,
      title: title,
      titleRaw: stripTags_(rawTitle),
      hashtag: hashtag,
      url: url,
      tag: tag,
      authors: authors,
      snippet: snippet,
      message: parts.join('\n\n'),
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Dedup in ScriptProperties                                           */
/* ------------------------------------------------------------------ */

function isSeen_(key) {
  return PropertiesService.getScriptProperties().getProperty('s_' + key) !== null;
}

function markSeen_(key) {
  PropertiesService.getScriptProperties().setProperty(
    's_' + key,
    String(Math.floor(Date.now() / 86400000))
  );
}

// The script property store is capped at 500 KB. Keep at most MAX_SEEN keys
// and drop the oldest ones beyond that.
function pruneSeen_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var keys = [];

  for (var k in all) {
    if (k.indexOf('s_') === 0) keys.push([k, parseInt(all[k], 10) || 0]);
  }
  if (keys.length <= CONFIG.MAX_SEEN) return;

  keys.sort(function (a, b) {
    return a[1] - b[1];
  });

  var drop = keys.length - CONFIG.MAX_SEEN;
  for (var i = 0; i < drop; i++) props.deleteProperty(keys[i][0]);
  Logger.log('Prune: old keys removed ' + drop);
}

/* ------------------------------------------------------------------ */
/* Card: abstract from open APIs + LLM                                 */
/* ------------------------------------------------------------------ */

/**
 * Builds the final message text.
 * Any failure at any step falls back to the plain format,
 * so the article is never lost.
 */
function buildCard_(art) {
  try {
    var abstract = fetchAbstract_(art);
    if (!abstract || abstract.length < 200) return art.message;

    var card = llmCard_(art.titleRaw, abstract);
    if (!card) return art.message;

    return (
      '<b>' + art.title + '</b>\n\n' +
      esc_(card) + '\n\n' +
      art.hashtag + '\n' + art.url
    );
  } catch (e) {
    Logger.log('buildCard_ failed: ' + e);
    return art.message;
  }
}

/** arXiv by id from the link, OpenAlex by title otherwise. */
function fetchAbstract_(art) {
  var m = art.url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i);
  if (m) {
    var a = arxivAbstract_(m[1]);
    if (a) return a;
  }
  return openAlexAbstract_(art.titleRaw);
}

function arxivAbstract_(id) {
  var res = UrlFetchApp.fetch(
    'https://export.arxiv.org/api/query?id_list=' + id,
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) return '';

  var xml = res.getContentText();
  var m = xml.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
  return m ? stripTags_(m[1]) : '';
}

function openAlexAbstract_(title) {
  var url =
    'https://api.openalex.org/works?per-page=1&mailto=' +
    encodeURIComponent(CONFIG.CONTACT_EMAIL) +
    '&filter=title.search:' +
    encodeURIComponent(title.replace(/[^\p{L}\p{N} ]+/gu, ' '));

  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return '';

  var data = JSON.parse(res.getContentText());
  var work = data.results && data.results[0];
  if (!work || !work.abstract_inverted_index) return '';

  // OpenAlex returns an inverted index: word -> positions. Rebuild the text.
  var idx = work.abstract_inverted_index;
  var words = [];
  for (var w in idx) {
    var pos = idx[w];
    for (var i = 0; i < pos.length; i++) words[pos[i]] = w;
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

function llmCard_(title, abstract) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) {
    Logger.log('OPENAI_API_KEY missing in Script Properties, cards disabled.');
    return '';
  }

  var instructions =
    'You write short cards about research papers for an engineer looking for ' +
    'product ideas and testable hypotheses. Write in Russian, up to 200 words, ' +
    'plain text, no markdown, no heading, no links. ' +
    'Three consecutive blocks: what exactly the authors claim; what they ' +
    'evaluated it on and which numbers came out; what the work does NOT show ' +
    'or where its limits are. ' +
    'Never invent numbers: if the text has none, say plainly that no ' +
    'measurements are reported. Do not use em dashes.';

  var res = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: CONFIG.MODEL,
      reasoning: { effort: CONFIG.REASONING_EFFORT },
      instructions: instructions,
      input: 'Title: ' + title + '\n\nAbstract: ' + abstract.slice(0, 6000),
      // Headroom for reasoning tokens, which are spent before visible output.
      max_output_tokens: 2000,
    }),
  });

  if (res.getResponseCode() !== 200) {
    Logger.log('OpenAI ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
    return '';
  }

  var data = JSON.parse(res.getContentText());

  if (data.status === 'incomplete') {
    Logger.log('OpenAI: truncated response (' +
      ((data.incomplete_details && data.incomplete_details.reason) || '?') +
      '), raise max_output_tokens or lower the effort.');
    return '';
  }

  // Responses API returns an output array: reasoning first, message after.
  var text = '';
  var out = data.output || [];
  for (var i = 0; i < out.length; i++) {
    var parts = out[i].content || [];
    for (var j = 0; j < parts.length; j++) {
      if (parts[j].type === 'output_text' && parts[j].text) text += parts[j].text;
    }
  }
  return text.trim();
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

/** One-off check of the abstract + LLM chain on a single article. */
function testCard() {
  var art = {
    title: 'Veriguard: Enhancing llm agent safety via verified code generation',
    titleRaw: 'Veriguard: Enhancing llm agent safety via verified code generation',
    url: 'https://arxiv.org/abs/2510.05156',
    hashtag: '#test',
    message: 'fallback',
  };
  var abs = fetchAbstract_(art);
  Logger.log('Abstract, chars: ' + abs.length);
  Logger.log(abs.slice(0, 300));
  Logger.log('--- card ---');
  Logger.log(buildCard_(art));
}

/** Bot + channel check, no email involved. */
function testTelegram() {
  var ok = sendTelegram_({
    tag: 'test',
    message:
      '<b>Connection check</b>\n\nIf you see this in the channel, the token and chat id are correct.\n\n#test\nhttps://scholar.google.com/scholar_alerts',
  });
  Logger.log(ok ? 'Sent, check the channel.' : 'Not sent, see the error above.');
}

/** Why zero emails were found. */
function diagnose() {
  var probes = [
    'from:scholaralerts-noreply@google.com',
    'from:scholarcitations-noreply@google.com',
    'from:scholar-noreply@google.com',
    'from:google.com scholar',
    'scholar.google.com',
  ];

  for (var i = 0; i < probes.length; i++) {
    var q = probes[i] + ' in:anywhere';
    var n = GmailApp.search(q, 0, 50).length;
    Logger.log(q + '  ->  ' + n);
  }

  Logger.log('--- last 5 emails mentioning scholar ---');
  var t = GmailApp.search('scholar in:anywhere', 0, 5);
  for (var j = 0; j < t.length; j++) {
    var msg = t[j].getMessages()[0];
    Logger.log(msg.getDate() + ' | ' + msg.getFrom() + ' | ' + msg.getSubject());
  }

  Logger.log('Script mailbox: ' + Session.getActiveUser().getEmail());
}

/* ------------------------------------------------------------------ */
/* Telegram                                                            */
/* ------------------------------------------------------------------ */

function sendTelegram_(art) {
  var payload = {
    chat_id: String(CONFIG.CHAT_ID),
    text: art.message,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  var threadId = CONFIG.TOPICS[art.tag];
  if (threadId) payload.message_thread_id = threadId;

  for (var attempt = 0; attempt < 3; attempt++) {
    var res = UrlFetchApp.fetch(
      'https://api.telegram.org/bot' + CONFIG.BOT_TOKEN + '/sendMessage',
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      }
    );

    var code = res.getResponseCode();
    if (code === 200) return true;

    var body = {};
    try {
      body = JSON.parse(res.getContentText());
    } catch (e) {}

    if (code === 429) {
      var wait = ((body.parameters && body.parameters.retry_after) || 5) * 1000;
      Utilities.sleep(wait);
      continue;
    }

    // 400 usually means broken HTML markup. Resend as plain text instead.
    if (code === 400 && payload.parse_mode) {
      delete payload.parse_mode;
      payload.text = art.message.replace(/<\/?b>/g, '');
      continue;
    }

    Logger.log('Telegram ' + code + ': ' + res.getContentText());
    return false;
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

function getLabel_() {
  return GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL);
}
