import { test, expect, describe } from "bun:test";
import { isValidDomain, parseDomainList, rootOfHostname } from "../src/domain";

describe("isValidDomain", () => {
  test.each([
    "example.com",
    "a.co",
    "foo.bar.baz",
    "xn--n3h.com", // Punycode IDN
    "EXAMPLE.COM",
    "  example.com  ",
    "sub-domain.example.com",
  ])("accepts %s", (d) => {
    expect(isValidDomain(d)).toBe(true);
  });

  test.each([
    "",
    "example",
    ".example.com",
    "example.com.",
    "-bad.com",
    "bad-.com",
    "a..b",
    "a b.com",
    "a".repeat(64) + ".com", // label too long
    ("a".repeat(250) + ".co"), // total too long
    123 as unknown as string,
    null as unknown as string,
  ])("rejects %p", (d) => {
    expect(isValidDomain(d)).toBe(false);
  });
});

describe("parseDomainList", () => {
  test("handles comma, whitespace, and newline separators", () => {
    const { valid, invalid } = parseDomainList(
      "a.com,b.com\nc.org  d.net\n\n-bad.com",
    );
    expect(valid).toEqual(["a.com", "b.com", "c.org", "d.net"]);
    expect(invalid).toEqual(["-bad.com"]);
  });

  test("deduplicates (case-insensitive), preserves first-occurrence order", () => {
    const { valid } = parseDomainList("A.com,a.com,B.ORG,a.com,b.org");
    expect(valid).toEqual(["a.com", "b.org"]);
  });

  test("strips protocol and path", () => {
    const { valid } = parseDomainList(
      "https://a.com/foo,http://b.com/bar/baz",
    );
    expect(valid).toEqual(["a.com", "b.com"]);
  });

  test("empty/nil inputs", () => {
    expect(parseDomainList("")).toEqual({ valid: [], invalid: [] });
    expect(parseDomainList(null)).toEqual({ valid: [], invalid: [] });
    expect(parseDomainList(undefined)).toEqual({ valid: [], invalid: [] });
  });
});

describe("rootOfHostname", () => {
  test("collapses subdomain to registrable", () => {
    expect(rootOfHostname("www.example.com")).toBe("example.com");
    expect(rootOfHostname("a.b.c.example.org")).toBe("example.org");
  });
  test("returns null for invalid hosts", () => {
    expect(rootOfHostname("-bad")).toBeNull();
  });
});
