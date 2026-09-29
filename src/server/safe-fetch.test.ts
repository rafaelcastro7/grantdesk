import { describe, expect, it } from "vitest";
import { BlockedAddressError, isPrivateAddress, safeFetch } from "./safe-fetch";

describe("safe fetch", () => {
  it("treats loopback, private and link-local ranges as private", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("142.250.80.46")).toBe(false);
  });

  it("refuses to read this machine's own services", async () => {
    await expect(safeFetch("http://localhost:15532/")).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(safeFetch("http://127.0.0.1:15535/rest/v1/")).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
  });

  it("refuses non-http schemes", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow(/http/);
  });
});
