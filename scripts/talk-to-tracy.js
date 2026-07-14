#!/usr/bin/env node
// talk-to-tracy — chat with Tracy from your terminal, no curl needed.
//
// Keeps conversation history across turns and lets you pick the surface she's on.
// This is also the seed of Tracy's desktop presence: a thin client that holds a
// conversation and talks to the same /chat endpoint every Interverse app uses.
//
// Usage:
//   node scripts/talk-to-tracy.js
//   node scripts/talk-to-tracy.js --surface babyresell --user alice
//   node scripts/talk-to-tracy.js --surface game:chesswars
//   node scripts/talk-to-tracy.js --server http://localhost:3000
//
// Requires the Tracy server running (npm start) in another terminal.
//
// In-chat commands:
//   /reset   clear conversation history
//   /surface print the current surface
//   /exit    quit (also Ctrl-C or Ctrl-D)

import readline from "readline";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const surface = flag("surface", "desktop");
const userId = flag("user", "cli-user");
const server = flag("server", "http://localhost:3000").replace(/\/$/, "");

// Conversation history, sent in full each turn (the server is stateless).
let messages = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "you › ",
});

function banner() {
  console.log(`\n  Tracy — Interverse assistant`);
  console.log(`  surface: ${surface}   user: ${userId}   server: ${server}`);
  console.log(`  commands: /reset  /surface  /exit\n`);
}

async function send(userText) {
  messages.push({ role: "user", content: userText });
  try {
    const res = await fetch(`${server}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surface, userId, messages }),
    });

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).error || "";
      } catch {
        /* ignore */
      }
      console.log(`\ntracy › [error ${res.status}] ${detail || res.statusText}\n`);
      // Drop the user turn we couldn't get a reply to, so history stays valid.
      messages.pop();
      return;
    }

    const data = await res.json();
    const reply = data.reply ?? "(no reply)";
    messages.push({ role: "assistant", content: reply });

    const usedNote =
      data.toolsUsed && data.toolsUsed.length
        ? `   [tools: ${data.toolsUsed.join(", ")}]`
        : "";
    console.log(`\ntracy › ${reply}${usedNote}\n`);
  } catch (err) {
    console.log(
      `\ntracy › [couldn't reach the server at ${server} — is it running? (npm start)]\n`
    );
    messages.pop();
  }
}

// Async iteration serializes one line at a time — each turn finishes (including
// the awaited server round-trip) before the next line is processed. Works for
// both interactive typing and piped/scripted input.
async function main() {
  banner();
  rl.prompt();

  for await (const line of rl) {
    const text = line.trim();

    if (text === "") {
      rl.prompt();
      continue;
    }
    if (text === "/exit") break;
    if (text === "/reset") {
      messages = [];
      console.log("\n[history cleared]\n");
      rl.prompt();
      continue;
    }
    if (text === "/surface") {
      console.log(`\n[surface: ${surface}]\n`);
      rl.prompt();
      continue;
    }

    await send(text);
    rl.prompt();
  }

  console.log("\nbye 👋");
  rl.close();
}

main();
