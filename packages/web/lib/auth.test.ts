import { describe, expect, it } from "vitest";

import { authToken, isAuthorized, mayEnter, passwordMatches } from "./auth";

describe("the password gate", () => {
  it("accepts the cookie made from the right password", async () => {
    expect(await isAuthorized(await authToken("hunter2"), "hunter2")).toBe(true);
  });

  it("rejects a cookie made from another password", async () => {
    expect(await isAuthorized(await authToken("guess"), "hunter2")).toBe(false);
  });

  it("never lets anyone in when no password is configured", async () => {
    expect(await isAuthorized(await authToken("x"), undefined)).toBe(false);
    expect(await isAuthorized(undefined, undefined)).toBe(false);
  });

  it("does not put the password in the cookie", async () => {
    expect(await authToken("hunter2")).not.toContain("hunter2");
  });

  it("checks a typed password", async () => {
    expect(await passwordMatches("hunter2", "hunter2")).toBe(true);
    expect(await passwordMatches("nope", "hunter2")).toBe(false);
    expect(await passwordMatches(42, "hunter2")).toBe(false);
  });
});

describe("mayEnter", () => {
  it("is open in development with no password, so a fresh clone just runs", async () => {
    expect(await mayEnter(undefined, undefined, "development")).toBe(true);
  });

  it("fails closed in production with no password, so a forgotten env var cannot publish the app", async () => {
    expect(await mayEnter(undefined, undefined, "production")).toBe(false);
  });

  it("requires the cookie once a password is set, even in development", async () => {
    expect(await mayEnter(undefined, "hunter2", "development")).toBe(false);
    expect(await mayEnter(await authToken("hunter2"), "hunter2", "development")).toBe(true);
  });
});
