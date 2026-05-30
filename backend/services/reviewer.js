import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, buildUserPrompt } from "../lib/prompts.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function generateReview(diff, contextChunks, prTitle, prAuthor) {
  const userPrompt = buildUserPrompt(diff, contextChunks, prTitle, prAuthor);

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1500,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const usage = response.usage;
  console.log(
    `[NiArgus] Token usage — input: ${usage.input_tokens}, output: ${usage.output_tokens}`
  );

  const review = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return review;
}
