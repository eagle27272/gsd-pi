// Project/App: gsd-pi
// File Purpose: Deterministic canonical-JSON serialization and sha256 hashing primitives.

import { createHash } from "node:crypto";

export type Sha256 = `sha256:${string}`;

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJsonValue(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical JSON requires strict JSON with finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("canonical JSON requires acyclic strict JSON");
    const keys = Object.keys(value);
    if (
      keys.length !== value.length
      || keys.some((key, index) => key !== String(index))
      || Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new Error("canonical JSON requires dense JSON arrays without extra keys");
    }
    ancestors.add(value);
    try {
      return `[${value.map((entry) => canonicalJsonValue(entry, ancestors)).join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value !== "object") {
    throw new Error("canonical JSON requires strict JSON values");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("canonical JSON requires plain JSON objects");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("canonical JSON requires strict JSON without symbol keys");
  }
  if (ancestors.has(value)) throw new Error("canonical JSON requires acyclic strict JSON");
  ancestors.add(value);
  try {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonValue(entry, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value, new Set());
}

export function hashBytes(value: string | Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashValue(value: unknown): Sha256 {
  return hashBytes(canonicalJson(value));
}
