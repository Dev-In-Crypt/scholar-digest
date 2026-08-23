# scholar-digest

Turns Google Scholar email alerts into a clean Telegram feed of one-paragraph
research cards. Runs entirely on Google Apps Script: no server, no Docker, nothing to keep alive.
Runs entirely on Google Apps Script: no server, no container, nothing to keep alive.

<p align="center">
  <img alt="Apps Script" src="https://img.shields.io/badge/Google_Apps_Script-V8-4285F4?logo=google&logoColor=white">
  <img alt="Telegram" src="https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white">
  <img alt="OpenAI" src="https://img.shields.io/badge/OpenAI-Responses_API-412991?logo=openai&logoColor=white">
  <img alt="cost" src="https://img.shields.io/badge/hosting-free-2ea44f">
</p>

---

## Why

Google Scholar has no API and no RSS. The only machine-readable channel it
offers is the alert email, and that email is a wall of titles with two-line
snippets. This project treats the mailbox as the ingest layer and rebuilds the
missing feed on top of it.

## What it does

```
Gmail (Scholar alert)
   -> split the email into individual articles
   -> drop anything already sent (FNV hash of the title)
   -> fetch the real abstract   (arXiv API, OpenAlex fallback)
   -> write a card              (OpenAI Responses API)
   -> post to a Telegram channel
```

Every step degrades instead of failing. No abstract, no model answer, an API
outage: the article still ships in the plain title-and-snippet format. Nothing
is silently dropped.

## Features

| | |
|---|---|
| **One message per article** | The alert email is split on `<h3>`, so each paper gets its own post you can react to, forward or search. |
| **Real abstracts** | arXiv by id parsed out of the link, OpenAlex by title as fallback. The inverted index OpenAlex returns is rebuilt into text. |
| **Cards, not snippets** | The model gets the actual abstract and is instructed to never invent numbers. If the paper reports no measurements, the card says so. |
| **Two-layer dedup** | A Gmail label marks processed threads, a per-title hash catches the same paper arriving through overlapping alert queries. |
| **Short hashtags** | `TAG_ALIASES` maps a long alert query to `#agentloops`, `#codegen`, `#devprod`. |
| **No secrets in code** | The OpenAI key lives in Script Properties. |
| **Free to host** | Apps Script quotas on a consumer account are 20k Gmail reads and 20k outbound requests per day. This uses about a hundred. |

## Install

**1. Create the project**

Open [script.google.com](https://script.google.com), create a new project and
paste `Code.gs` into it.

**2. Fill in CONFIG**

```js
BOT_TOKEN: '123456:AA...',   // BotFather
CHAT_ID:   '-100...',        // the bot must be a channel admin
CONTACT_EMAIL: 'you@example.com',
```

**3. Add the OpenAI key**

Project Settings -> Script Properties -> Add script property

```
OPENAI_API_KEY = sk-...
```

**4. Authorize**

Run `setup()` once. Google will warn that the app is unverified: that check
exists for apps distributed to other people, and the developer shown is your own
account. Advanced -> Go to project. `setup()` creates the label and an hourly
trigger.

**5. Create the alerts**

On [scholar.google.com/scholar_alerts](https://scholar.google.com/scholar_alerts),
pointed at the same mailbox the script reads. Keep the queries narrow. Scholar
only emails when new results appear, so a broad query buries the channel within
a week.

**6. Verify**

```
testTelegram()  -> one message to the channel, no email involved
testCard()      -> abstract + model chain on a single paper, nothing sent
dryRun()        -> parses real emails, prints to the log, sends nothing
diagnose()      -> why zero emails were found
```

## Configuration

| Key | Default | Notes |
|---|---|---|
| `USE_LLM` | `true` | `false` returns the plain title-and-snippet format |
| `MODEL` | `gpt-5.6-luna` | Any Responses API model |
| `REASONING_EFFORT` | `low` | Summarizing an abstract is extraction, not reasoning |
| `LOOKBACK_DAYS` | `3` | Window for the first run |
| `MAX_ARTICLES_PER_RUN` | `25` | Keeps a run inside the 6 minute execution limit |
| `MAX_SEEN` | `5000` | Dedup keys kept; the property store caps at 500 KB |
| `SEND_DELAY_MS` | `1500` | Telegram tolerates roughly 20 messages a minute |
| `TOPICS` | `{}` | Map an alert tag to a forum `message_thread_id` |

## Notes

The hourly trigger is a polling interval, not a delivery schedule. Scholar sends
mail whenever new results show up, so checking once a day would add up to a day
of latency for no saving: 23 of 24 runs find nothing and finish in a second.

Dedup keys are a 32-bit FNV hash of the normalized title plus its length, about
20 bytes per entry. `pruneSeen_()` drops the oldest once the cap is reached.

The subject-line parser strips both the English and the Russian Scholar wording,
so it works regardless of the Gmail interface language.

The Scholar parser is one module. The collect, parse, enrich, filter, deliver structure works for any recurring source: job boards, tenders, regulatory feeds, competitor mentions. Swapping the parser and the delivery target is the only work involved.

## License

MIT
