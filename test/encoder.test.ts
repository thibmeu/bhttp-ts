import { describe, expect, it } from "vitest";

import { BHttpEncoder } from "../src/encoder";
import { BHttpDecoder } from "../src/decoder";

describe("BHttpEncoder", () => {
  describe("POST", () => {
    it("should encode a POST request with over 16383 byte length content.", async () => {
      const req = new Request("https://www.example.com/hello.txt", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: (new Uint8Array(16384)).fill(0),
      });
      const encoder = new BHttpEncoder();
      const binReq = await encoder.encodeRequest(req);

      const decoder = new BHttpDecoder();
      const decodedReq = decoder.decodeRequest(binReq);

      // assert
      expect(decodedReq.method).toBe("POST");
      expect(decodedReq.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(decodedReq.url).toBe("https://www.example.com/hello.txt");
      const body = await decodedReq.arrayBuffer();
      expect(body.byteLength).toBe(16384);
    });

    it("should encode a POST request with over 1073741823 byte length content.", async () => {
      const req = new Request("https://www.example.com/hello.txt", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: (new Uint8Array(1073741824)).fill(0),
      });
      const encoder = new BHttpEncoder();
      const binReq = await encoder.encodeRequest(req);

      const decoder = new BHttpDecoder();
      const decodedReq = decoder.decodeRequest(binReq);

      // assert
      expect(decodedReq.method).toBe("POST");
      expect(decodedReq.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(decodedReq.url).toBe("https://www.example.com/hello.txt");
      const body = await decodedReq.arrayBuffer();
      expect(body.byteLength).toBe(1073741824);
    });
  });
});
