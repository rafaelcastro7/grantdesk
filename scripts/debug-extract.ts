// Throwaway probe: show what a provider actually returns for the extraction
// prompt, so a "failed caller validation" has a visible cause.
import { config } from "dotenv";
import { htmlToText, htmlTitle } from "../src/lib/html-text";
import { callLlm } from "../src/server/llm";

config({ path: ".env" });

const url = process.argv[2] ?? "https://www.marsdd.com/about/";
const response = await fetch(url, { headers: { "User-Agent": "GrantDesk/0.1" } });
const html = await response.text();
const text = htmlToText(html);

console.log(`fetched ${url}: HTTP ${response.status}, ${html.length} html, ${text.length} text`);
console.log("--- first 300 chars of text ---");
console.log(text.slice(0, 300));

const result = await callLlm({
  role: "extract",
  json: true,
  temperature: 0.1,
  messages: [
    { role: "system", content: "Reply with only a JSON object." },
    {
      role: "user",
      content: `Source: ${url}\nTitle: ${htmlTitle(html)}\n\n${text.slice(0, 4000)}\n\nReturn {"sectors":[],"jurisdictions":[],"stage":"","annualBudget":null,"currency":null,"capabilities":null,"beneficiaries":null,"confidence":0}`,
    },
  ],
});

console.log(`--- raw from ${result.provider}/${result.model} (${result.latencyMs}ms) ---`);
console.log(result.text.slice(0, 900));
