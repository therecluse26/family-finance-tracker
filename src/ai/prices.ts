// The app's price table and the cost math (spec 08, Counting cost and Expected cost). This file
// imports only types, so the web app can tell which models need prices from a Member.

import type { AiProviderName } from "./ai-view.ts";

// A model's prices, each in millionths of a dollar per million tokens: $0.10 is 100_000. Whole
// numbers keep the math exact.
export type ModelPrice = { input: number; output: number; cacheRead: number; cacheWrite: number };

// Millionths of a dollar per million tokens, from dollars per million tokens.
export function perMillion(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

// Input and output from the spec. Cache reads from each AI provider's price page in November 2026:
// Haiku 5.5 $0.01 and Sonnet 5.5 $0.10 (0.05× input) on Anthropic; GPT-6 Luna $0.01 and GPT-6.1
// Terra $0.05 on OpenAI. A cache write is 1.25× input on both. Haiku 5.5 costs more for a prompt
// over 100,000 tokens; no prompt of the app's comes near that. Each release updates this table.
function price(input: number, output: number, cacheRead: number): ModelPrice {
  return {
    input: perMillion(input),
    output: perMillion(output),
    cacheRead: perMillion(cacheRead),
    cacheWrite: perMillion(input * 1.25),
  };
}

const HAIKU_5_5 = price(0.1, 0.5, 0.01);
const SONNET_5_5 = price(2, 10, 0.1);
const GPT_6_LUNA = price(0.1, 0.5, 0.01);
const GPT_6_1_TERRA = price(1, 5, 0.05);

// By each AI provider's own model ID. On OpenRouter, the reply's own cost replaces these. An
// OpenAI-compatible endpoint has none: the Member enters each model's prices.
export const PRICE_TABLE: Record<AiProviderName, Readonly<Record<string, ModelPrice>>> = {
  anthropic: { "claude-haiku-5-5": HAIKU_5_5, "claude-sonnet-5-5": SONNET_5_5 },
  openai: { "gpt-6-luna": GPT_6_LUNA, "gpt-6.1-terra": GPT_6_1_TERRA },
  openrouter: {
    "anthropic/claude-haiku-5.5": HAIKU_5_5,
    "anthropic/claude-sonnet-5.5": SONNET_5_5,
    "openai/gpt-6-luna": GPT_6_LUNA,
    "openai/gpt-6.1-terra": GPT_6_1_TERRA,
  },
  "openai-compatible": {},
};

export function tablePrice(provider: AiProviderName, model: string): ModelPrice | undefined {
  return Object.hasOwn(PRICE_TABLE[provider], model) ? PRICE_TABLE[provider][model] : undefined;
}

// For a model not in the table: cache reads and writes count at the input price.
export function memberPrice(input: number, output: number): ModelPrice {
  return { input, output, cacheRead: input, cacheWrite: input };
}

// One reply's tokens, by the AI SDK's usage: usage.inputTokenDetails.noCacheTokens,
// cacheReadTokens, and cacheWriteTokens, and the output tokens.
export type CallTokens = {
  noCacheTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

// A call's cost in billionths of a dollar: each token count times its price.
export function costOf(tokens: CallTokens, modelPrice: ModelPrice): number {
  const millionths =
    tokens.noCacheTokens * modelPrice.input +
    tokens.cacheReadTokens * modelPrice.cacheRead +
    tokens.cacheWriteTokens * modelPrice.cacheWrite +
    tokens.outputTokens * modelPrice.output;
  // Millionths of a dollar per million tokens is a trillionth of a dollar per token.
  return Math.round(millionths / 1000);
}

// OpenRouter's usage.cost, in dollars, in billionths of a dollar.
export function nanosOfDollars(dollars: number): number {
  return Math.round(dollars * 1_000_000_000);
}
