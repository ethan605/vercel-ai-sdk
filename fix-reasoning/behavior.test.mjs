import { createOpenAI } from "../packages/openai/dist/index.mjs";

const captured = [];
async function fakeFetch(url, init) {
  captured.push(JSON.parse(init.body));
  return new Response(JSON.stringify({
    id: "resp_test", object: "response", created_at: 0, status: "completed",
    model: "kimi-k3", output: [], usage: {
      input_tokens: 1, input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
    service_tier: null, error: null, incomplete_details: null,
    instructions: null, max_output_tokens: null,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const bifrost = createOpenAI({
  apiKey: "test", baseURL: "http://localhost:9/x",
  name: "bifrost", fetch: fakeFetch, // matches what OpenCode's loader passes (providerID)
});

async function roundtrip(label, options = {
  fixReasoning: true,
  reasoningEffort: "high",
  reasoningSummary: "auto",
}) {
  captured.length = 0;
  const model = bifrost.responses("kimi-k3");
  const result = await model.doGenerate({
    prompt: [{
      role: "assistant",
      content: [
        { type: "text", text: "prior answer" },
        { type: "reasoning", text: "I should think about this",
          providerOptions: { bifrost: { itemId: "rs_test123" } } },
      ],
    }, {
      role: "user",
      content: [{ type: "text", text: "follow up" }],
    }],
    ...(options == null ? {} : { providerOptions: { bifrost: options } }),
  });
  const body = captured[0];
  const reasoning = body.input.filter((i) => i.type === "reasoning");
  console.log(`[${label}] store=${body.store} reasoning=${JSON.stringify(body.reasoning)} reasoningItems=${JSON.stringify(reasoning.map(r => ({ id: r.id, hasEnc: r.encrypted_content != null })))}`);
  return { body, warnings: result.warnings };
}

// Test A: opt-in replays id-bearing reasoning, defaults to stateless mode, and enables reasoning options.
const { body: a, warnings: aWarnings } = await roundtrip("A replay");
if (a.store !== false) throw new Error("FAIL A: store should be explicitly false");
if (a.reasoning?.effort !== "high" || a.reasoning?.summary !== "auto") {
  throw new Error(`FAIL A: reasoning options missing: ${JSON.stringify(a.reasoning)}`);
}
if (!a.input.some((i) => i.type === "reasoning" && i.id === "rs_test123" && i.encrypted_content == null)) {
  throw new Error("FAIL A: id-bearing unencrypted reasoning item was dropped");
}
if (aWarnings.some((warning) => warning.message?.includes("Skipping reasoning parts"))) {
  throw new Error("FAIL A: emitted a false warning for id-bearing reasoning");
}

// Test B: without the opt-in, stock behavior omits store for an unrecognized model.
const { body: b } = await roundtrip("B stock", null);
if (Object.hasOwn(b, "store")) throw new Error(`FAIL B: store should be omitted, got ${b.store}`);

// Test C: id-less reasoning item is still dropped when the opt-in is enabled.
captured.length = 0;
const { warnings: cWarnings } = await bifrost.responses("kimi-k3").doGenerate({
  prompt: [{
    role: "assistant",
    content: [{ type: "reasoning", text: "orphan", providerOptions: { bifrost: { itemId: null } } }],
  }, { role: "user", content: [{ type: "text", text: "hi" }] }],
  providerOptions: { bifrost: { fixReasoning: true } },
});
const c = captured[0];
if (c.input.some((i) => i.type === "reasoning" && i.encrypted_content == null && i.id == null)) {
  throw new Error("FAIL C: id-less reasoning should be dropped");
}
if (!cWarnings.some((warning) => warning.message?.includes("Skipping reasoning part"))) {
  throw new Error("FAIL C: expected a warning for id-less reasoning");
}

console.log("ALL PASS");
